//! Thin `wasm-bindgen` wrapper around `twin-core`.
//!
//! The worker owns one [`TwinWorld`]. Chunk buffers arrive as transferred
//! `Uint8Array`s, are decoded zero-copy, folded into the `RoadGraph`, and then
//! dropped — the graph keeps its own flat arrays, so holding the wire buffer as
//! well would double the memory for no gain. `free_chunk` drops the chunk from
//! the graph.

use serde::{Deserialize, Serialize};
use twin_core::assign::{assign, AssignParams, HourResult};
use twin_core::demand::DemandSchema;
use twin_core::graph_schema::GraphChunkSchema;
use twin_core::schema::AlignedBytes;
use twin_core::{
    CchOrderSchema, ChunkEntrySchema, ChunkId, EdgeId, GraphIndexSchema, GridSchema, Hour,
    RoadGraph, Scenario, ScenarioView,
};
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
    /// Zones in the loaded `demand.bin`, or 0 before it arrives.
    pub zones: u32,
    /// Current size of the wasm linear memory in bytes.
    pub wasm_bytes: u32,
}

/// The scenario as the worker sends it. Mirrors the `Scenario` ADT; unknown
/// edit types are a parse error rather than a silent no-op.
#[derive(Debug, Clone, Deserialize)]
pub struct ScenarioDTO {
    #[serde(default)]
    pub edits: Vec<EditDTO>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum EditDTO {
    CloseEdge {
        edge: u32,
    },
    SetEdge {
        edge: u32,
        #[serde(default)]
        lanes: Option<u8>,
        #[serde(default)]
        speed_mps: Option<f32>,
        #[serde(default)]
        capacity_vph: Option<f32>,
    },
    AddEdge {
        from: u32,
        to: u32,
        #[serde(default)]
        lanes: Option<u8>,
        #[serde(default)]
        speed_mps: Option<f32>,
    },
}

impl TryFrom<ScenarioDTO> for Scenario {
    type Error = String;

    fn try_from(dto: ScenarioDTO) -> Result<Self, String> {
        let edits = dto
            .edits
            .into_iter()
            .map(|e| match e {
                EditDTO::CloseEdge { edge } => EdgeId::new(edge)
                    .map(twin_core::Edit::CloseEdge)
                    .ok_or_else(|| format!("edge {edge} is the reserved sentinel")),
                EditDTO::SetEdge {
                    edge,
                    lanes,
                    speed_mps,
                    capacity_vph,
                } => EdgeId::new(edge)
                    .map(|edge| twin_core::Edit::SetEdge {
                        edge,
                        lanes,
                        speed_mps,
                        capacity_vph,
                    })
                    .ok_or_else(|| format!("edge {edge} is the reserved sentinel")),
                EditDTO::AddEdge {
                    from,
                    to,
                    lanes,
                    speed_mps,
                } => {
                    let (Some(from), Some(to)) =
                        (twin_core::NodeId::new(from), twin_core::NodeId::new(to))
                    else {
                        return Err("AddEdge names the reserved sentinel node".into());
                    };
                    Ok(twin_core::Edit::AddEdge {
                        from,
                        to,
                        lanes: lanes.unwrap_or(1),
                        speed_mps: speed_mps.unwrap_or(11.0),
                    })
                }
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Scenario { edits })
    }
}

/// The KPI block `kpisJson` returns.
#[derive(Debug, Clone, Serialize)]
pub struct KpisDTO {
    pub vmt: f64,
    pub vht: f64,
    pub mean_delay_s: f32,
    pub top_edges: Vec<TopEdgeDTO>,
    /// Diagnostics the dev overlay shows; harmless for the UI to ignore.
    pub hour: u8,
    pub iterations: u32,
    pub rel_gap: f32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TopEdgeDTO {
    pub edge_id: u32,
    pub vc: f32,
}

/// The loaded world: index metadata plus whichever chunks are resident.
#[wasm_bindgen]
#[derive(Default)]
pub struct TwinWorld {
    grid: Option<GridSchema>,
    entries: Vec<ChunkEntrySchema>,
    graph: RoadGraph,
    demand: Option<AlignedBytes>,
    /// Contraction order in global node ids. Held for the skim queries; the
    /// equilibrium loop grows its own shortest-path trees.
    cch_rank: Vec<u32>,
    last: Option<LastRun>,
}

/// The previous run, kept so the next hour can warm-start from it and so
/// `kpisJson` has something to report.
struct LastRun {
    result: HourResult,
    warnings: Vec<String>,
}

#[wasm_bindgen]
impl TwinWorld {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        #[cfg(target_arch = "wasm32")]
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

    /// Take ownership of `demand.bin`. Kept as bytes and decoded per run, so
    /// the zero-copy views never outlive a borrow of the buffer.
    #[wasm_bindgen(js_name = loadDemand)]
    pub fn load_demand(&mut self, bytes: Vec<u8>) -> Result<u32, JsError> {
        let buf = AlignedBytes::adopt(bytes);
        let zones = DemandSchema::decode(&buf).map_err(js_err)?.zone_count() as u32;
        self.demand = Some(buf);
        Ok(zones)
    }

    /// Parse `cch_order.bin`. Returns the node count the order covers.
    #[wasm_bindgen(js_name = loadCchOrder)]
    pub fn load_cch_order(&mut self, bytes: Vec<u8>) -> Result<u32, JsError> {
        let buf = AlignedBytes::adopt(bytes);
        let order = CchOrderSchema::decode(&buf).map_err(js_err)?;
        self.cch_rank = order.rank.to_vec();
        Ok(self.cch_rank.len() as u32)
    }

    /// Global edge ids of the loaded edges, ascending. This is the order every
    /// result array is laid out in.
    #[wasm_bindgen(js_name = loadedEdgeIds)]
    pub fn loaded_edge_ids(&mut self) -> Vec<u32> {
        let view = self.graph.view();
        let mut ids: Vec<u32> = view.edges().iter().map(|e| e.id.raw()).collect();
        ids.sort_unstable();
        ids
    }

    /// Assign one hour under `scenario_json`, and return
    /// `[volume | vc | delay_s]` concatenated, each block `E_loaded` long and
    /// in the order [`Self::loaded_edge_ids`] reports.
    ///
    /// Warm-starts from the previous run whenever the edge set is unchanged, so
    /// stepping through the 24-hour profile costs less than the first hour did.
    #[wasm_bindgen(js_name = runHour)]
    pub fn run_hour(&mut self, scenario_json: &str, hour: u8) -> Result<Vec<f32>, JsError> {
        let hour = Hour::new(hour)
            .ok_or_else(|| JsError::new(&format!("hour {hour} is outside 0..24")))?;
        let dto: ScenarioDTO = serde_json::from_str(scenario_json)
            .map_err(|e| JsError::new(&format!("scenario JSON: {e}")))?;
        let scenario: Scenario = dto.try_into().map_err(js_err)?;
        let demand_bytes = self
            .demand
            .as_ref()
            .ok_or_else(|| JsError::new("call loadDemand before runHour"))?;
        let demand = DemandSchema::decode(demand_bytes).map_err(js_err)?;

        let warm = self
            .last
            .as_ref()
            .map(|l| l.result.volume.clone())
            .filter(|v| v.len() == self.graph.view().edges().len());
        let view = ScenarioView::apply(self.graph.view(), &scenario);
        let warnings = view.warnings().to_vec();
        for w in &warnings {
            web_sys_warn(w);
        }
        let result = assign(
            &view,
            &demand,
            hour,
            warm.as_deref(),
            &AssignParams::default(),
        );

        // Global-id order, so the caller can join against `loadedEdgeIds`
        // without knowing anything about chunk assembly.
        let mut order: Vec<usize> = (0..view.edge_count()).collect();
        order.sort_unstable_by_key(|&i| view.edge_id(i).raw());
        let mut out = Vec::with_capacity(3 * order.len());
        for block in [&result.volume, &result.vc, &result.delay_s] {
            out.extend(order.iter().map(|&i| block[i]));
        }
        self.last = Some(LastRun { result, warnings });
        Ok(out)
    }

    /// KPIs for the last [`Self::run_hour`]. `null` before the first run.
    #[wasm_bindgen(js_name = kpisJson)]
    pub fn kpis_json(&self) -> String {
        let Some(last) = &self.last else {
            return "null".to_string();
        };
        let k = &last.result.kpis;
        let dto = KpisDTO {
            vmt: k.vmt,
            vht: k.vht,
            mean_delay_s: k.mean_delay_s,
            top_edges: k
                .top_edges
                .iter()
                .map(|&(id, vc)| TopEdgeDTO {
                    edge_id: id.raw(),
                    vc,
                })
                .collect(),
            hour: last.result.hour.raw(),
            iterations: last.result.iterations,
            rel_gap: last.result.rel_gap,
            warnings: last.warnings.clone(),
        };
        serde_json::to_string(&dto).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
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
            zones: self.zone_count(),
            chunks_available,
            wasm_bytes: wasm_bytes(),
        };
        serde_wasm_bindgen::to_value(&stats).map_err(|e| JsError::new(&e.to_string()))
    }
}

/// One line to the browser console, and to stderr in the native test build.
fn web_sys_warn(message: &str) {
    #[cfg(target_arch = "wasm32")]
    web_sys::console::warn_1(&JsValue::from_str(message));
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("warn: {message}");
}

impl TwinWorld {
    fn zone_count(&self) -> u32 {
        self.demand
            .as_ref()
            .and_then(|b| DemandSchema::decode(b).ok())
            .map(|d| d.zone_count() as u32)
            .unwrap_or(0)
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
