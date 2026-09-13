//! The pipeline's in-memory graph before it is cut into chunks, plus the two
//! pure transforms that act on it: degree-2 simplification and partitioning.

use crate::graph_schema::{ChunkBuild, ChunkEdge, ChunkEntrySchema, ChunkNode, GeomCsr};
use crate::grid::{haversine_m, GridSchema};
use crate::ids::{ChunkId, EdgeId, NodeId, RoadClass};
use std::collections::HashMap;

/// A node before chunking. Coordinates stay `f64` until serialization.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct RawNode {
    pub lon: f64,
    pub lat: f64,
}

/// A directed edge before chunking; endpoints are indices into
/// [`RawGraph::nodes`].
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct RawEdge {
    pub from: u32,
    pub to: u32,
    pub len_m: f32,
    pub class: RoadClass,
    pub lanes: u8,
    pub speed_kph: f32,
    pub capacity_vph: f32,
}

impl RawEdge {
    /// Attribute defaults by class, per DESIGN.md section 9 (to be calibrated
    /// against VDOT counts later).
    pub fn with_defaults(
        from: u32,
        to: u32,
        len_m: f32,
        class: RoadClass,
        lanes: Option<u8>,
        speed_kph: Option<f32>,
    ) -> Self {
        let lanes = lanes.unwrap_or(class.default_lanes()).max(1);
        let speed_kph = speed_kph.unwrap_or(class.default_speed_kph());
        Self {
            from,
            to,
            len_m,
            class,
            lanes,
            speed_kph,
            capacity_vph: lanes as f32 * class.lane_capacity_vph(),
        }
    }

    /// Two edges may be fused across a degree-2 node only if they describe the
    /// same road.
    fn fusible_with(&self, other: &Self) -> bool {
        self.class == other.class
            && self.lanes == other.lanes
            && (self.speed_kph - other.speed_kph).abs() < 0.5
    }
}

/// One directed edge's polyline in lon/lat, tail-node-first, both endpoints
/// included.
pub type Polyline = Vec<[f32; 2]>;

#[derive(Clone, Debug, Default)]
pub struct RawGraph {
    pub nodes: Vec<RawNode>,
    pub edges: Vec<RawEdge>,
    /// Parallel to `edges`. Kept beside the edge rows rather than inside
    /// [`RawEdge`] so an edge row stays `Copy`.
    pub geom: Vec<Polyline>,
}

impl RawGraph {
    /// The graph whose every edge is drawn as the straight segment between its
    /// endpoints — the shape an unsimplified OSM segment already has.
    pub fn new(nodes: Vec<RawNode>, edges: Vec<RawEdge>) -> Self {
        let geom = edges
            .iter()
            .map(|e| vec![point(&nodes[e.from as usize]), point(&nodes[e.to as usize])])
            .collect();
        Self { nodes, edges, geom }
    }

    /// An `n * n` lattice spread evenly across `bbox`, both directions on every
    /// arc, so `E = 4n(n-1)`. Used by the benches and by `--synthetic-grid` so
    /// everything is testable without a PBF.
    pub fn synthetic_grid(n: u32, bbox: crate::grid::BBox) -> Self {
        let span = (n.saturating_sub(1)).max(1) as f64;
        let (dx, dy) = (
            (bbox.east - bbox.west) / span,
            (bbox.north - bbox.south) / span,
        );
        let idx = |x: u32, y: u32| y * n + x;
        let nodes = (0..n)
            .flat_map(|y| {
                (0..n).map(move |x| RawNode {
                    lon: bbox.west + x as f64 * dx,
                    lat: bbox.south + y as f64 * dy,
                })
            })
            .collect::<Vec<_>>();
        let mut edges = Vec::with_capacity(4 * (n as usize) * (n as usize));
        let mut push_pair = |a: u32, b: u32, nodes: &[RawNode]| {
            let (p, q) = (nodes[a as usize], nodes[b as usize]);
            let len = haversine_m(p.lon, p.lat, q.lon, q.lat) as f32;
            let class = RoadClass::Residential;
            edges.push(RawEdge::with_defaults(a, b, len, class, None, None));
            edges.push(RawEdge::with_defaults(b, a, len, class, None, None));
        };
        for y in 0..n {
            for x in 0..n {
                if x + 1 < n {
                    push_pair(idx(x, y), idx(x + 1, y), &nodes);
                }
                if y + 1 < n {
                    push_pair(idx(x, y), idx(x, y + 1), &nodes);
                }
            }
        }
        Self::new(nodes, edges)
    }
}

/// A node as a serialized polyline point.
#[inline]
fn point(n: &RawNode) -> [f32; 2] {
    [n.lon as f32, n.lat as f32]
}

/// Collapse chains of degree-2 nodes into single edges.
///
/// A node is collapsible when, viewed undirected, it has exactly two distinct
/// neighbours and every incident edge shares the same class, lane count and
/// speed. Chains that form a closed loop of collapsible nodes are left alone,
/// since there is no endpoint to attach the merged edge to.
pub fn simplify_degree2(graph: &RawGraph) -> RawGraph {
    let n = graph.nodes.len();
    let mut neighbours: Vec<Vec<u32>> = vec![Vec::new(); n];
    let mut incident: Vec<Vec<u32>> = vec![Vec::new(); n];
    for (i, e) in graph.edges.iter().enumerate() {
        incident[e.from as usize].push(i as u32);
        incident[e.to as usize].push(i as u32);
        neighbours[e.from as usize].push(e.to);
        neighbours[e.to as usize].push(e.from);
    }
    for list in neighbours.iter_mut() {
        list.sort_unstable();
        list.dedup();
    }

    let mut collapsible: Vec<bool> = (0..n)
        .map(|v| {
            neighbours[v].len() == 2
                && !neighbours[v].contains(&(v as u32))
                && incident[v]
                    .windows(2)
                    .all(|w| graph.edges[w[0] as usize].fusible_with(&graph.edges[w[1] as usize]))
        })
        .collect();

    // Walk each chain from a non-collapsible seed and emit the merged edges.
    let mut merged: Vec<(RawEdge, Polyline)> = Vec::new();
    let mut visited = vec![false; n];
    let has_edge: HashMap<(u32, u32), u32> = graph
        .edges
        .iter()
        .enumerate()
        .map(|(i, e)| ((e.from, e.to), i as u32))
        .collect();

    for seed in 0..n {
        if collapsible[seed] {
            continue;
        }
        for &first in &neighbours[seed] {
            if !collapsible[first as usize] || visited[first as usize] {
                continue;
            }
            let chain = walk_chain(seed as u32, first, &neighbours, &collapsible);
            for &v in &chain[1..chain.len() - 1] {
                visited[v as usize] = true;
            }
            merged.extend(merge_chain(&chain, &has_edge, graph));
            merged.extend(merge_chain(
                &chain.iter().rev().copied().collect::<Vec<_>>(),
                &has_edge,
                graph,
            ));
        }
    }

    // Collapsible nodes never reached from a seed form pure cycles: keep them.
    for v in 0..n {
        if collapsible[v] && !visited[v] {
            collapsible[v] = false;
        }
    }

    let keep: Vec<u32> = (0..n as u32)
        .filter(|&v| !collapsible[v as usize])
        .collect();
    let remap: HashMap<u32, u32> = keep
        .iter()
        .enumerate()
        .map(|(i, &v)| (v, i as u32))
        .collect();
    let nodes: Vec<RawNode> = keep.iter().map(|&v| graph.nodes[v as usize]).collect();
    let survivors = graph
        .edges
        .iter()
        .zip(graph.geom.iter())
        .chain(merged.iter().map(|(e, g)| (e, g)));
    let (edges, geom): (Vec<RawEdge>, Vec<Polyline>) = survivors
        .filter_map(|(e, g)| {
            let from = *remap.get(&e.from)?;
            let to = *remap.get(&e.to)?;
            (from != to).then(|| (RawEdge { from, to, ..*e }, g.clone()))
        })
        .unzip();
    RawGraph { nodes, edges, geom }
}

/// Follow collapsible nodes from `start` through `first` until a
/// non-collapsible node (or a repeat) is hit. Returns the full node sequence
/// including both endpoints.
fn walk_chain(start: u32, first: u32, neighbours: &[Vec<u32>], collapsible: &[bool]) -> Vec<u32> {
    let mut chain = vec![start, first];
    let mut prev = start;
    let mut cur = first;
    while collapsible[cur as usize] {
        let Some(&next) = neighbours[cur as usize].iter().find(|&&x| x != prev) else {
            break;
        };
        if chain.contains(&next) {
            break;
        }
        chain.push(next);
        prev = cur;
        cur = next;
    }
    chain
}

/// Fuse a directed traversal of `chain`, if every consecutive arc exists.
fn merge_chain(
    chain: &[u32],
    has_edge: &HashMap<(u32, u32), u32>,
    graph: &RawGraph,
) -> Option<(RawEdge, Polyline)> {
    let arcs: Option<Vec<&RawEdge>> = chain
        .windows(2)
        .map(|w| {
            has_edge
                .get(&(w[0], w[1]))
                .map(|&i| &graph.edges[i as usize])
        })
        .collect();
    let arcs = arcs?;
    let first = *arcs.first()?;
    let fused = RawEdge {
        from: chain[0],
        to: chain[chain.len() - 1],
        len_m: arcs.iter().map(|e| e.len_m).sum(),
        ..*first
    };
    // The fused shape is the chain itself: every node it swallowed becomes an
    // interior polyline point, so nothing is lost visually by simplification.
    let line = chain
        .iter()
        .map(|&v| point(&graph.nodes[v as usize]))
        .collect();
    Some((fused, line))
}

/// Output of [`partition`]: the index rows and the chunk payloads, both in
/// ascending `ChunkId` order.
pub struct Partition {
    pub grid: GridSchema,
    pub entries: Vec<ChunkEntrySchema>,
    pub chunks: Vec<ChunkBuild>,
}

/// Cut a graph into grid cells.
///
/// A node belongs to the cell containing it. An edge is *owned* by the cell of
/// its tail node, and is written into the cell of its head node as well when
/// they differ, so a border edge appears in both files and either chunk can be
/// loaded alone. Global ids are handed out contiguously per chunk, which is what
/// makes them stable across subsets.
pub fn partition(graph: &RawGraph, grid: &GridSchema) -> Partition {
    let node_chunk: Vec<ChunkId> = graph
        .nodes
        .iter()
        .map(|n| grid.chunk_at(n.lon, n.lat))
        .collect();

    let mut owned_nodes: HashMap<ChunkId, Vec<u32>> = HashMap::new();
    for (i, c) in node_chunk.iter().enumerate() {
        owned_nodes.entry(*c).or_default().push(i as u32);
    }
    let mut order: Vec<ChunkId> = owned_nodes.keys().copied().collect();
    order.sort_unstable();

    // Contiguous global ids, chunk by chunk.
    let mut gid_of_node = vec![0u32; graph.nodes.len()];
    let mut node_offset = 0u32;
    for c in &order {
        for (k, &v) in owned_nodes[c].iter().enumerate() {
            gid_of_node[v as usize] = node_offset + k as u32;
        }
        node_offset += owned_nodes[c].len() as u32;
    }

    let mut owned_edges: HashMap<ChunkId, Vec<u32>> = HashMap::new();
    for (i, e) in graph.edges.iter().enumerate() {
        owned_edges
            .entry(node_chunk[e.from as usize])
            .or_default()
            .push(i as u32);
    }
    let mut gid_of_edge = vec![0u32; graph.edges.len()];
    let mut edge_offset = 0u32;
    let mut edge_offsets: HashMap<ChunkId, u32> = HashMap::new();
    for c in &order {
        edge_offsets.insert(*c, edge_offset);
        let owned = owned_edges.get(c).map(Vec::as_slice).unwrap_or(&[]);
        for (k, &e) in owned.iter().enumerate() {
            gid_of_edge[e as usize] = edge_offset + k as u32;
        }
        edge_offset += owned.len() as u32;
    }

    // Border edges are mirrored into the head node's chunk.
    let mut member_edges: HashMap<ChunkId, Vec<u32>> = owned_edges.clone();
    for (i, e) in graph.edges.iter().enumerate() {
        let (a, b) = (node_chunk[e.from as usize], node_chunk[e.to as usize]);
        if a != b {
            member_edges.entry(b).or_default().push(i as u32);
        }
    }

    let mut entries = Vec::with_capacity(order.len());
    let mut chunks = Vec::with_capacity(order.len());
    for c in &order {
        let edge_ids = member_edges.get(c).map(Vec::as_slice).unwrap_or(&[]);
        let (build, local_of) = build_chunk(
            *c,
            &owned_nodes[c],
            edge_ids,
            graph,
            &node_chunk,
            &gid_of_node,
            &gid_of_edge,
        );
        debug_assert_eq!(local_of.len(), build.nodes.len());
        let (cx, cy) = grid.xy_of_chunk(*c);
        entries.push(ChunkEntrySchema {
            chunk_id: c.raw(),
            cx,
            cy,
            node_count: owned_nodes[c].len() as u32,
            edge_count: owned_edges.get(c).map(Vec::len).unwrap_or(0) as u32,
            node_gid_offset: gid_of_node[owned_nodes[c][0] as usize],
            edge_gid_offset: edge_offsets[c],
            _pad: 0,
        });
        chunks.push(build);
    }

    Partition {
        grid: *grid,
        entries,
        chunks,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_chunk(
    chunk: ChunkId,
    owned: &[u32],
    edge_ids: &[u32],
    graph: &RawGraph,
    node_chunk: &[ChunkId],
    gid_of_node: &[u32],
    gid_of_edge: &[u32],
) -> (ChunkBuild, HashMap<u32, u32>) {
    let mut local_of: HashMap<u32, u32> = HashMap::with_capacity(owned.len() * 2);
    let mut nodes: Vec<ChunkNode> = Vec::with_capacity(owned.len());
    let intern = |v: u32, nodes: &mut Vec<ChunkNode>, local_of: &mut HashMap<u32, u32>| -> u32 {
        *local_of.entry(v).or_insert_with(|| {
            let n = &graph.nodes[v as usize];
            nodes.push(ChunkNode {
                gid: NodeId::from_index(gid_of_node[v as usize]),
                lon: n.lon as f32,
                lat: n.lat as f32,
                chunk: node_chunk[v as usize],
            });
            nodes.len() as u32 - 1
        })
    };
    for &v in owned {
        intern(v, &mut nodes, &mut local_of);
    }
    let geom = GeomCsr::from_polylines(
        &edge_ids
            .iter()
            .map(|&i| graph.geom[i as usize].clone())
            .collect::<Vec<_>>(),
    );
    let edges = edge_ids
        .iter()
        .map(|&i| {
            let e = &graph.edges[i as usize];
            ChunkEdge {
                gid: EdgeId::from_index(gid_of_edge[i as usize]),
                from: intern(e.from, &mut nodes, &mut local_of),
                to: intern(e.to, &mut nodes, &mut local_of),
                len_m: e.len_m,
                ff_speed_kph: e.speed_kph,
                capacity_vph: e.capacity_vph,
                lanes: e.lanes,
                class: e.class,
            }
        })
        .collect();
    (ChunkBuild::new(chunk, nodes, edges, geom), local_of)
}
