//! `RoadGraph`: a graph assembled from an arbitrary subset of loaded chunks.
//!
//! Global ids are stable — a node or edge keeps the same `NodeId`/`EdgeId`
//! whichever chunks happen to be resident — while the dense indices used by the
//! CSR are local to the current assembly and change on every add/remove.

use crate::graph_schema::{build_csr, ChunkBuild, ChunkEdge, ChunkNode, GeomCsr, GraphChunkSchema};
use crate::ids::{ChunkId, EdgeId, NodeId, RoadClass};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum GraphError {
    #[error("chunk {0:?} is already loaded")]
    AlreadyLoaded(ChunkId),
    #[error("chunk file declares class byte {0}, which is not a RoadClass")]
    BadRoadClass(u8),
}

/// A node in the assembled graph.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct GraphNode {
    pub id: NodeId,
    pub lon: f32,
    pub lat: f32,
    pub chunk: ChunkId,
    /// False when this node only exists as the far end of a border edge whose
    /// owning chunk is not loaded.
    pub resident: bool,
}

/// A directed edge in the assembled graph. `from`/`to` are dense indices into
/// [`RoadGraph::nodes`].
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct GraphEdge {
    pub id: EdgeId,
    pub from: u32,
    pub to: u32,
    pub len_m: f32,
    pub ff_speed_kph: f32,
    pub capacity_vph: f32,
    pub lanes: u8,
    pub class: RoadClass,
    /// True when either endpoint is not resident: traffic leaving through this
    /// edge exits the loaded world.
    pub boundary: bool,
}

impl GraphEdge {
    /// Free-flow traversal time in seconds.
    #[inline]
    pub fn free_flow_s(&self) -> f32 {
        self.len_m / (self.ff_speed_kph * 1000.0 / 3600.0).max(f32::EPSILON)
    }
}

/// Chunks in, one graph out.
///
/// Mutation is cheap: `add_chunk` and `remove_chunk` only touch the chunk map
/// and set a dirty flag. The dense node/edge arrays and the CSR are rebuilt
/// once, lazily, when [`RoadGraph::view`] is next called — so streaming N
/// chunks in as they arrive costs one rebuild, not N.
///
/// Reads live on [`GraphView`] rather than on `RoadGraph` so that laziness is
/// enforced by the borrow checker: there is no way to observe a stale
/// assembly.
#[derive(Default, Clone)]
pub struct RoadGraph {
    /// Ordered so assembly is deterministic regardless of load order.
    chunks: BTreeMap<ChunkId, ChunkBuild>,
    dirty: bool,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    index_of_node: HashMap<NodeId, u32>,
    out_offsets: Vec<u32>,
    out_edges: Vec<u32>,
}

impl RoadGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_chunks<'a>(
        chunks: impl IntoIterator<Item = &'a GraphChunkSchema<'a>>,
    ) -> Result<Self, GraphError> {
        chunks
            .into_iter()
            .try_fold(Self::new(), |mut g, c| g.add_chunk(c).map(|_| g))
    }

    /// Copy a decoded chunk into the graph. Decoding stays zero-copy; this is
    /// where the caller's buffer stops being needed.
    pub fn add_chunk(&mut self, chunk: &GraphChunkSchema<'_>) -> Result<ChunkId, GraphError> {
        let id = chunk.chunk_id();
        if self.chunks.contains_key(&id) {
            return Err(GraphError::AlreadyLoaded(id));
        }
        self.chunks.insert(id, owned_chunk(chunk)?);
        self.dirty = true;
        Ok(id)
    }

    /// Drop a chunk. Returns whether it was loaded.
    pub fn remove_chunk(&mut self, id: ChunkId) -> bool {
        let removed = self.chunks.remove(&id).is_some();
        self.dirty |= removed;
        removed
    }

    pub fn loaded_chunks(&self) -> impl Iterator<Item = ChunkId> + '_ {
        self.chunks.keys().copied()
    }

    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    /// Bring the dense arrays up to date if needed, then hand out a reader.
    pub fn view(&mut self) -> GraphView<'_> {
        if self.dirty {
            self.rebuild();
            self.dirty = false;
        }
        GraphView { g: self }
    }

    /// Deterministic rebuild of the dense arrays from the loaded chunks.
    ///
    /// Nodes are deduplicated by global id; edges are deduplicated by global
    /// id, so a border edge written into both of its chunks appears once.
    fn rebuild(&mut self) {
        let loaded: Vec<ChunkId> = self.chunks.keys().copied().collect();
        let is_loaded = |c: ChunkId| loaded.binary_search(&c).is_ok();

        self.nodes.clear();
        self.edges.clear();
        self.index_of_node.clear();

        for build in self.chunks.values() {
            for n in &build.nodes {
                let next = self.nodes.len() as u32;
                let entry = self.index_of_node.entry(n.gid);
                if let std::collections::hash_map::Entry::Vacant(slot) = entry {
                    slot.insert(next);
                    self.nodes.push(GraphNode {
                        id: n.gid,
                        lon: n.lon,
                        lat: n.lat,
                        chunk: n.chunk,
                        resident: is_loaded(n.chunk),
                    });
                }
            }
        }

        let mut seen_edges: HashSet<EdgeId> = HashSet::new();
        for build in self.chunks.values() {
            for e in &build.edges {
                if !seen_edges.insert(e.gid) {
                    continue;
                }
                let from = self.index_of_node[&build.nodes[e.from as usize].gid];
                let to = self.index_of_node[&build.nodes[e.to as usize].gid];
                let boundary =
                    !self.nodes[from as usize].resident || !self.nodes[to as usize].resident;
                self.edges.push(GraphEdge {
                    id: e.gid,
                    from,
                    to,
                    len_m: e.len_m,
                    ff_speed_kph: e.ff_speed_kph,
                    capacity_vph: e.capacity_vph,
                    lanes: e.lanes,
                    class: e.class,
                    boundary,
                });
            }
        }

        let (offsets, targets) = build_csr(self.nodes.len(), self.edges.iter().map(|e| e.from));
        self.out_offsets = offsets;
        self.out_edges = targets;
    }
}

/// Read side of an up-to-date [`RoadGraph`]. Holding one proves the dense
/// arrays match the loaded chunk set.
pub struct GraphView<'a> {
    g: &'a RoadGraph,
}

impl<'a> GraphView<'a> {
    pub fn nodes(&self) -> &'a [GraphNode] {
        &self.g.nodes
    }

    pub fn edges(&self) -> &'a [GraphEdge] {
        &self.g.edges
    }

    pub fn index_of(&self, id: NodeId) -> Option<u32> {
        self.g.index_of_node.get(&id).copied()
    }

    /// Dense edge indices leaving dense node `n`.
    pub fn out_edges_of(&self, n: usize) -> &'a [u32] {
        let (a, b) = (
            self.g.out_offsets[n] as usize,
            self.g.out_offsets[n + 1] as usize,
        );
        &self.g.out_edges[a..b]
    }

    /// Edges with at least one non-resident endpoint: traffic leaving through
    /// one of these exits the loaded world.
    pub fn boundary_edges(&self) -> impl Iterator<Item = &'a GraphEdge> {
        self.g.edges.iter().filter(|e| e.boundary)
    }

    pub fn boundary_edge_count(&self) -> usize {
        self.g.edges.iter().filter(|e| e.boundary).count()
    }

    pub fn chunk_count(&self) -> usize {
        self.g.chunks.len()
    }
}

fn owned_chunk(c: &GraphChunkSchema<'_>) -> Result<ChunkBuild, GraphError> {
    let nodes = (0..c.meta.node_count as usize)
        .map(|i| ChunkNode {
            gid: NodeId::from_index(c.node_gid[i]),
            lon: c.node_lonlat[i][0],
            lat: c.node_lonlat[i][1],
            chunk: ChunkId::from_index(c.node_chunk[i]),
        })
        .collect();
    let edges = (0..c.meta.edge_count as usize)
        .map(|i| {
            let class = RoadClass::from_u8(c.edge_class[i])
                .ok_or(GraphError::BadRoadClass(c.edge_class[i]))?;
            Ok(ChunkEdge {
                gid: EdgeId::from_index(c.edge_gid[i]),
                from: c.edge_from[i],
                to: c.edge_to[i],
                len_m: c.edge_len_m[i],
                ff_speed_kph: c.edge_ff_speed_kph[i],
                capacity_vph: c.edge_capacity_vph[i],
                lanes: c.edge_lanes[i],
                class,
            })
        })
        .collect::<Result<Vec<_>, GraphError>>()?;
    // The runtime never draws, so the polylines stay in the wire buffer and are
    // dropped with it rather than being copied into wasm memory.
    let geom = GeomCsr::none(edges.len());
    Ok(ChunkBuild::new(c.chunk_id(), nodes, edges, geom))
}
