//! `graph/index.bin` and `graph/chunk_{x}_{y}.bin` layouts.

use crate::grid::GridSchema;
use crate::ids::{ChunkId, EdgeId, NodeId, RoadClass};
use crate::schema::*;
use bytemuck::{Pod, Zeroable};

/// One row of the index's chunk table.
///
/// `node_gid_offset` / `edge_gid_offset` are the first global id owned by the
/// chunk. Ids are handed out contiguously per chunk, so a global id stays
/// stable no matter which subset of chunks is loaded.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Zeroable, Pod)]
#[repr(C)]
pub struct ChunkEntrySchema {
    pub chunk_id: u32,
    pub cx: u32,
    pub cy: u32,
    pub node_count: u32,
    pub edge_count: u32,
    pub node_gid_offset: u32,
    pub edge_gid_offset: u32,
    pub _pad: u32,
}

/// Fixed part of a chunk file.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Zeroable, Pod)]
#[repr(C)]
pub struct ChunkMetaSchema {
    pub chunk_id: u32,
    /// Total rows in the node arrays, owned plus ghost.
    pub node_count: u32,
    pub edge_count: u32,
    /// Nodes whose `node_chunk` is some other cell: the far ends of border
    /// edges, carried so this chunk stands alone.
    pub ghost_node_count: u32,
}

/// Decoded `graph/index.bin`, borrowed from the caller's bytes.
pub struct GraphIndexSchema<'a> {
    pub grid: GridSchema,
    pub chunks: &'a [ChunkEntrySchema],
}

impl<'a> GraphIndexSchema<'a> {
    /// Zero-copy decode.
    pub fn decode(bytes: &'a [u8]) -> Result<Self, SchemaError> {
        let file = FileView::parse(bytes, MAGIC_INDEX, VERSION_INDEX)?;
        Ok(Self {
            grid: file.one(SectionKind::Grid)?,
            chunks: file.section(SectionKind::ChunkTable)?,
        })
    }

    pub fn encode(grid: &GridSchema, chunks: &[ChunkEntrySchema]) -> Vec<u8> {
        FileWriter::new()
            .push_one(SectionKind::Grid, grid)
            .push(SectionKind::ChunkTable, chunks)
            .finish(MAGIC_INDEX, VERSION_INDEX, 0)
    }

    pub fn entry(&self, chunk: ChunkId) -> Option<&ChunkEntrySchema> {
        self.chunks.iter().find(|c| c.chunk_id == chunk.raw())
    }

    pub fn total_nodes(&self) -> u64 {
        self.chunks.iter().map(|c| c.node_count as u64).sum()
    }

    pub fn total_edges(&self) -> u64 {
        self.chunks.iter().map(|c| c.edge_count as u64).sum()
    }
}

/// Decoded `graph/chunk_*.bin`, borrowed from the caller's bytes.
///
/// All `edge_*` arrays are parallel and `E` long; all `node_*` arrays are
/// parallel and `N` long; `edge_from`/`edge_to` index into the node arrays.
pub struct GraphChunkSchema<'a> {
    pub meta: ChunkMetaSchema,
    pub node_lonlat: &'a [[f32; 2]],
    pub node_gid: &'a [u32],
    pub node_chunk: &'a [u32],
    pub edge_from: &'a [u32],
    pub edge_to: &'a [u32],
    pub edge_gid: &'a [u32],
    pub edge_len_m: &'a [f32],
    pub edge_ff_speed_kph: &'a [f32],
    pub edge_capacity_vph: &'a [f32],
    pub edge_lanes: &'a [u8],
    pub edge_class: &'a [u8],
    /// CSR over the edge polylines: edge `i` owns
    /// `geom_lonlat[geom_offsets[i] .. geom_offsets[i + 1]]`, in the chunk's
    /// own edge order. Length `E + 1`.
    pub geom_offsets: &'a [u32],
    /// Every polyline point of every edge, concatenated. Each edge's run runs
    /// tail-node-first and includes both endpoints.
    pub geom_lonlat: &'a [[f32; 2]],
    pub out_offsets: &'a [u32],
    pub out_edges: &'a [u32],
}

impl<'a> GraphChunkSchema<'a> {
    /// Zero-copy decode: every field is a slice over `bytes`.
    pub fn decode(bytes: &'a [u8]) -> Result<Self, SchemaError> {
        let f = FileView::parse(bytes, MAGIC_CHUNK, VERSION_CHUNK)?;
        let out = Self {
            meta: f.one(SectionKind::ChunkMeta)?,
            node_lonlat: f.section(SectionKind::NodeLonLat)?,
            node_gid: f.section(SectionKind::NodeGid)?,
            node_chunk: f.section(SectionKind::NodeChunk)?,
            edge_from: f.section(SectionKind::EdgeFrom)?,
            edge_to: f.section(SectionKind::EdgeTo)?,
            edge_gid: f.section(SectionKind::EdgeGid)?,
            edge_len_m: f.section(SectionKind::EdgeLenM)?,
            edge_ff_speed_kph: f.section(SectionKind::EdgeFfSpeedKph)?,
            edge_capacity_vph: f.section(SectionKind::EdgeCapacityVph)?,
            edge_lanes: f.section(SectionKind::EdgeLanes)?,
            edge_class: f.section(SectionKind::EdgeClass)?,
            geom_offsets: f.section(SectionKind::EdgeGeomOffsets)?,
            geom_lonlat: f.section(SectionKind::EdgeGeomLonLat)?,
            out_offsets: f.section(SectionKind::OutOffsets)?,
            out_edges: f.section(SectionKind::OutEdges)?,
        };
        out.validate()?;
        Ok(out)
    }

    fn validate(&self) -> Result<(), SchemaError> {
        let n = self.meta.node_count as usize;
        let e = self.meta.edge_count as usize;
        let node_ok = [self.node_gid.len(), self.node_chunk.len()]
            .iter()
            .all(|&l| l == n)
            && self.node_lonlat.len() == n;
        if !node_ok {
            return Err(SchemaError::InconsistentLength(SectionKind::NodeGid));
        }
        let edge_ok = [
            self.edge_from.len(),
            self.edge_to.len(),
            self.edge_gid.len(),
            self.edge_len_m.len(),
            self.edge_ff_speed_kph.len(),
            self.edge_capacity_vph.len(),
            self.edge_lanes.len(),
            self.edge_class.len(),
        ]
        .iter()
        .all(|&l| l == e);
        if !edge_ok {
            return Err(SchemaError::InconsistentLength(SectionKind::EdgeFrom));
        }
        if self.out_offsets.len() != n + 1 || self.out_edges.len() != e {
            return Err(SchemaError::InconsistentLength(SectionKind::OutOffsets));
        }
        let geom_ok = self.geom_offsets.len() == e + 1
            && self.geom_offsets.last().copied().unwrap_or(0) as usize == self.geom_lonlat.len()
            && self.geom_offsets.windows(2).all(|w| w[0] <= w[1]);
        if !geom_ok {
            return Err(SchemaError::InconsistentLength(
                SectionKind::EdgeGeomOffsets,
            ));
        }
        Ok(())
    }

    pub fn chunk_id(&self) -> ChunkId {
        ChunkId::from_index(self.meta.chunk_id)
    }

    /// Polyline of local edge `e`, tail-node-first.
    pub fn geom_of(&self, e: usize) -> &'a [[f32; 2]] {
        let (a, b) = (
            self.geom_offsets[e] as usize,
            self.geom_offsets[e + 1] as usize,
        );
        &self.geom_lonlat[a..b]
    }

    /// Local edge indices leaving local node `n`.
    pub fn out_edges_of(&self, n: usize) -> &'a [u32] {
        let (a, b) = (
            self.out_offsets[n] as usize,
            self.out_offsets[n + 1] as usize,
        );
        &self.out_edges[a..b]
    }
}

/// A node row before serialization. `chunk` is the owning cell, which differs
/// from the file's own chunk exactly for ghost nodes.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct ChunkNode {
    pub gid: NodeId,
    pub lon: f32,
    pub lat: f32,
    pub chunk: ChunkId,
}

/// A directed edge row before serialization; `from`/`to` are local indices.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct ChunkEdge {
    pub gid: EdgeId,
    pub from: u32,
    pub to: u32,
    pub len_m: f32,
    pub ff_speed_kph: f32,
    pub capacity_vph: f32,
    pub lanes: u8,
    pub class: RoadClass,
}

/// Edge polylines in the same CSR shape the file uses, so encoding is a copy
/// and nothing has to be re-flattened.
///
/// Kept beside `ChunkBuild::edges` rather than inside `ChunkEdge` so an edge
/// row stays `Copy` and the runtime, which never draws anything, can hold a
/// graph with [`GeomCsr::none`] and pay nothing for geometry.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GeomCsr {
    pub offsets: Vec<u32>,
    pub points: Vec<[f32; 2]>,
}

impl GeomCsr {
    /// Flatten one polyline per edge.
    pub fn from_polylines(polylines: &[Vec<[f32; 2]>]) -> Self {
        let mut offsets = Vec::with_capacity(polylines.len() + 1);
        let mut points = Vec::with_capacity(polylines.iter().map(Vec::len).sum());
        offsets.push(0);
        for line in polylines {
            points.extend_from_slice(line);
            offsets.push(points.len() as u32);
        }
        Self { offsets, points }
    }

    /// The empty polyline for every one of `edge_count` edges.
    pub fn none(edge_count: usize) -> Self {
        Self {
            offsets: vec![0; edge_count + 1],
            points: Vec::new(),
        }
    }

    pub fn of(&self, e: usize) -> &[[f32; 2]] {
        &self.points[self.offsets[e] as usize..self.offsets[e + 1] as usize]
    }
}

/// Owned chunk contents. Building one computes the CSR; encoding is then a
/// straight copy of flat arrays.
#[derive(Clone, Debug)]
pub struct ChunkBuild {
    pub chunk_id: ChunkId,
    pub nodes: Vec<ChunkNode>,
    pub edges: Vec<ChunkEdge>,
    pub geom: GeomCsr,
    out_offsets: Vec<u32>,
    out_edges: Vec<u32>,
}

impl ChunkBuild {
    /// Pure constructor: sorts nothing, copies nothing twice, derives CSR by
    /// counting sort over `edges`.
    pub fn new(
        chunk_id: ChunkId,
        nodes: Vec<ChunkNode>,
        edges: Vec<ChunkEdge>,
        geom: GeomCsr,
    ) -> Self {
        debug_assert_eq!(geom.offsets.len(), edges.len() + 1, "one polyline per edge");
        let (out_offsets, out_edges) = build_csr(nodes.len(), edges.iter().map(|e| e.from));
        Self {
            chunk_id,
            nodes,
            edges,
            geom,
            out_offsets,
            out_edges,
        }
    }

    pub fn ghost_node_count(&self) -> u32 {
        self.nodes
            .iter()
            .filter(|n| n.chunk != self.chunk_id)
            .count() as u32
    }

    /// Edges in this file whose two endpoints sit in different cells. Each such
    /// edge is written into both cells, so summing this over all chunks
    /// double-counts.
    pub fn border_edge_count(&self) -> u32 {
        self.edges
            .iter()
            .filter(|e| self.nodes[e.from as usize].chunk != self.nodes[e.to as usize].chunk)
            .count() as u32
    }

    pub fn encode(&self) -> Vec<u8> {
        let lonlat: Vec<[f32; 2]> = self.nodes.iter().map(|n| [n.lon, n.lat]).collect();
        let node_gid: Vec<u32> = self.nodes.iter().map(|n| n.gid.raw()).collect();
        let node_chunk: Vec<u32> = self.nodes.iter().map(|n| n.chunk.raw()).collect();
        let meta = ChunkMetaSchema {
            chunk_id: self.chunk_id.raw(),
            node_count: self.nodes.len() as u32,
            edge_count: self.edges.len() as u32,
            ghost_node_count: self.ghost_node_count(),
        };
        FileWriter::new()
            .push_one(SectionKind::ChunkMeta, &meta)
            .push(SectionKind::NodeLonLat, &lonlat)
            .push(SectionKind::NodeGid, &node_gid)
            .push(SectionKind::NodeChunk, &node_chunk)
            .push(SectionKind::EdgeFrom, &collect_u32(&self.edges, |e| e.from))
            .push(SectionKind::EdgeTo, &collect_u32(&self.edges, |e| e.to))
            .push(
                SectionKind::EdgeGid,
                &collect_u32(&self.edges, |e| e.gid.raw()),
            )
            .push(
                SectionKind::EdgeLenM,
                &collect_f32(&self.edges, |e| e.len_m),
            )
            .push(
                SectionKind::EdgeFfSpeedKph,
                &collect_f32(&self.edges, |e| e.ff_speed_kph),
            )
            .push(
                SectionKind::EdgeCapacityVph,
                &collect_f32(&self.edges, |e| e.capacity_vph),
            )
            .push(
                SectionKind::EdgeLanes,
                &self.edges.iter().map(|e| e.lanes).collect::<Vec<u8>>(),
            )
            .push(
                SectionKind::EdgeClass,
                &self
                    .edges
                    .iter()
                    .map(|e| e.class.as_u8())
                    .collect::<Vec<u8>>(),
            )
            .push(SectionKind::EdgeGeomOffsets, &self.geom.offsets)
            .push(SectionKind::EdgeGeomLonLat, &self.geom.points)
            .push(SectionKind::OutOffsets, &self.out_offsets)
            .push(SectionKind::OutEdges, &self.out_edges)
            .finish(MAGIC_CHUNK, VERSION_CHUNK, 0)
    }
}

fn collect_u32(edges: &[ChunkEdge], f: impl Fn(&ChunkEdge) -> u32) -> Vec<u32> {
    edges.iter().map(f).collect()
}

fn collect_f32(edges: &[ChunkEdge], f: impl Fn(&ChunkEdge) -> f32) -> Vec<f32> {
    edges.iter().map(f).collect()
}

/// Counting-sort CSR build: `(offsets[n+1], targets[e])` where `targets` holds
/// edge indices grouped by tail node, in ascending edge order.
pub fn build_csr(
    node_count: usize,
    tails: impl Iterator<Item = u32> + Clone,
) -> (Vec<u32>, Vec<u32>) {
    let mut offsets = vec![0u32; node_count + 1];
    for t in tails.clone() {
        offsets[t as usize + 1] += 1;
    }
    for i in 0..node_count {
        offsets[i + 1] += offsets[i];
    }
    let total = offsets[node_count] as usize;
    let mut cursor = offsets.clone();
    let mut targets = vec![0u32; total];
    for (edge_idx, t) in tails.enumerate() {
        let slot = &mut cursor[t as usize];
        targets[*slot as usize] = edge_idx as u32;
        *slot += 1;
    }
    (offsets, targets)
}
