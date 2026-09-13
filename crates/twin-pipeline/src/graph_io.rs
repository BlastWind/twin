//! Reading back what `ingest-roads` wrote. The `demand` and `cch-order` stages
//! run over the whole county graph, so they load every chunk.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use twin_core::graph_schema::GraphChunkSchema;
use twin_core::schema::AlignedBytes;
use twin_core::{ChunkEntrySchema, GraphIndexSchema, GridSchema, RoadGraph};

/// The county graph, assembled from every chunk in `graph/`.
pub struct LoadedGraph {
    pub grid: GridSchema,
    pub entries: Vec<ChunkEntrySchema>,
    pub graph: RoadGraph,
}

pub fn graph_dir(out_dir: &Path) -> PathBuf {
    out_dir.join("graph")
}

/// `chunk_{cx}_{cy}.bin`, the name `ingest-roads` writes.
pub fn chunk_path(out_dir: &Path, e: &ChunkEntrySchema) -> PathBuf {
    graph_dir(out_dir).join(format!("chunk_{}_{}.bin", e.cx, e.cy))
}

pub fn load_all(out_dir: &Path) -> Result<LoadedGraph> {
    let index_path = graph_dir(out_dir).join("index.bin");
    if !index_path.exists() {
        bail!(
            "{} is missing; run `twin-pipeline ingest-roads` first",
            index_path.display()
        );
    }
    let index_bytes = AlignedBytes::adopt(
        std::fs::read(&index_path).with_context(|| format!("reading {}", index_path.display()))?,
    );
    let index = GraphIndexSchema::decode(&index_bytes)?;
    let entries = index.chunks.to_vec();
    let grid = index.grid;

    let mut graph = RoadGraph::new();
    for e in &entries {
        let path = chunk_path(out_dir, e);
        let bytes = AlignedBytes::adopt(
            std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?,
        );
        let chunk = GraphChunkSchema::decode(&bytes)?;
        graph.add_chunk(&chunk)?;
    }
    Ok(LoadedGraph {
        grid,
        entries,
        graph,
    })
}
