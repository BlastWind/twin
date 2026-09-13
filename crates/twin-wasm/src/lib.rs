//! Thin `wasm-bindgen` wrapper around `twin-core`.
//!
//! The worker owns one [`TwinWorld`]. Chunk buffers arrive as transferred
//! `Uint8Array`s, are decoded zero-copy, folded into the `RoadGraph`, and then
//! dropped — the graph keeps its own flat arrays, so holding the wire buffer as
//! well would double the memory for no gain. `free_chunk` drops the chunk from
//! the graph.

use serde::Serialize;
use twin_core::graph_schema::GraphChunkSchema;
use twin_core::schema::AlignedBytes;
use twin_core::{ChunkEntrySchema, ChunkId, GraphIndexSchema, GridSchema, RoadGraph};
use wasm_bindgen::prelude::*;

/// What the worker reports to the UI. Mirrors the `stats()` shape in
/// DESIGN.md section 7.1.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct StatsDTO {
    pub nodes: u32,
    pub edges: u32,
    pub chunks: u32,
    /// Edges whose far end is in a chunk that is not loaded.
    pub boundary_edges: u32,
    /// Chunks the index knows about, loaded or not.
    pub chunks_available: u32,
    /// Current size of the wasm linear memory in bytes.
    pub wasm_bytes: u32,
}

/// The loaded world: index metadata plus whichever chunks are resident.
#[wasm_bindgen]
#[derive(Default)]
pub struct TwinWorld {
    grid: Option<GridSchema>,
    entries: Vec<ChunkEntrySchema>,
    graph: RoadGraph,
}

#[wasm_bindgen]
impl TwinWorld {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        console_error_panic_hook::set_once();
        Self::default()
    }

    /// Parse `graph/index.bin`. Copies only the small index tables.
    #[wasm_bindgen(js_name = loadIndex)]
    pub fn load_index(&mut self, bytes: Vec<u8>) -> Result<(), JsError> {
        let buf = AlignedBytes::adopt(bytes);
        let index = GraphIndexSchema::decode(&buf).map_err(js_err)?;
        self.grid = Some(index.grid);
        self.entries = index.chunks.to_vec();
        Ok(())
    }

    /// Take ownership of a transferred chunk buffer and fold it into the graph.
    ///
    /// `id` is the caller's expectation; a mismatch with the chunk's own header
    /// is an error rather than a silent relabel.
    #[wasm_bindgen(js_name = loadChunk)]
    pub fn load_chunk(&mut self, id: u32, bytes: Vec<u8>) -> Result<(), JsError> {
        let buf = AlignedBytes::adopt(bytes);
        let chunk = GraphChunkSchema::decode(&buf).map_err(js_err)?;
        if chunk.meta.chunk_id != id {
            return Err(JsError::new(&format!(
                "chunk id mismatch: caller said {id}, file says {}",
                chunk.meta.chunk_id
            )));
        }
        self.graph.add_chunk(&chunk).map_err(js_err)?;
        Ok(())
    }

    /// Evict a chunk. Returns whether it was loaded.
    #[wasm_bindgen(js_name = freeChunk)]
    pub fn free_chunk(&mut self, id: u32) -> bool {
        match ChunkId::new(id) {
            Some(c) => self.graph.remove_chunk(c),
            None => false,
        }
    }

    /// Ids of the currently loaded chunks, ascending.
    #[wasm_bindgen(js_name = loadedChunks)]
    pub fn loaded_chunks(&self) -> Vec<u32> {
        self.graph.loaded_chunks().map(ChunkId::raw).collect()
    }

    /// Takes `&mut self` because reading forces the pending chunk adds to be
    /// assembled; loading a batch of chunks then calling `stats` once costs a
    /// single rebuild.
    pub fn stats(&mut self) -> Result<JsValue, JsError> {
        let chunks_available = self.entries.len() as u32;
        let view = self.graph.view();
        let stats = StatsDTO {
            nodes: view.nodes().len() as u32,
            edges: view.edges().len() as u32,
            chunks: view.chunk_count() as u32,
            boundary_edges: view.boundary_edge_count() as u32,
            chunks_available,
            wasm_bytes: wasm_bytes(),
        };
        serde_wasm_bindgen::to_value(&stats).map_err(|e| JsError::new(&e.to_string()))
    }
}

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// Size of the wasm linear memory. Zero off-target, where there is no such
/// thing, so the native build of this crate still compiles for tests.
fn wasm_bytes() -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        (core::arch::wasm32::memory_size(0) as u32).saturating_mul(65_536)
    }
    #[cfg(not(target_arch = "wasm32"))]
    0
}
