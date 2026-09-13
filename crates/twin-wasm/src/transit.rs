//! Transit and calibration, bolted onto the same [`TwinWorld`] the solver
//! exposes. Phase 3 contract: `loadTransit`, `isochrone`, `reachSummary`,
//! `loadCounts`, `calibration`.
//!
//! The state these methods need — `transit.bin`, `counts.bin`, the last reach,
//! and whatever hours have been run — lives in one thread-local rather than in
//! `TwinWorld`'s fields, so this module can be developed alongside the solver
//! without the two editing the same struct. A worker owns exactly one world, so
//! "thread-local" and "per world" are the same thing here.

use crate::TwinWorld;
use serde::Serialize;
use std::cell::RefCell;
use twin_core::counts::{modeled_daily, CountsSchema, DailySource};
use twin_core::demand::{DemandSchema, NHTS_HOUR_PROFILE};
use twin_core::schema::AlignedBytes;
use twin_core::transit::{isochrone, TransitSchema};
use twin_core::{Hour, HOURS_PER_DAY};
use wasm_bindgen::prelude::*;

/// Daily vehicle trips a resident generates. Turns the demand stage's per-zone
/// outbound trips back into the population behind them, which is the best
/// population estimate available without shipping a second file.
const TRIPS_PER_CAPITA: f32 = 3.0;

thread_local! {
    static STATE: RefCell<TransitState> = RefCell::new(TransitState::default());
}

#[derive(Default)]
struct TransitState {
    transit: Option<AlignedBytes>,
    counts: Option<AlignedBytes>,
    /// Per-hour edge volumes as `runHour` produced them, in the
    /// `loadedEdgeIds` order. Sparse: only the hours actually run.
    hourly: Vec<Option<Vec<f32>>>,
    last_reach: Option<ReachSummaryDTO>,
}

impl TransitState {
    fn hourly_slot(&mut self, hour: usize) -> &mut Option<Vec<f32>> {
        if self.hourly.len() < HOURS_PER_DAY {
            self.hourly.resize_with(HOURS_PER_DAY, || None);
        }
        &mut self.hourly[hour]
    }
}

/// What `reachSummary` returns.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct ReachSummaryDTO {
    /// Graph nodes within the budget.
    pub nodes: u32,
    /// Residents in the zones those nodes serve.
    pub population: f64,
    pub hour: u8,
    pub budget_min: f32,
}

/// One row of `calibration`.
#[derive(Debug, Clone, Serialize)]
pub struct CalibrationDTO {
    pub station_id: u32,
    pub edge_id: u32,
    pub aadt: f32,
    pub modeled_daily: f32,
    /// Metres from the published station to the edge it snapped to; a large
    /// value means the row is comparing two different roads.
    pub snap_m: f32,
    /// True when only some hours have been run and the daily figure was
    /// extrapolated from the hourly profile.
    pub scaled: bool,
}

#[wasm_bindgen]
impl TwinWorld {
    /// Take ownership of `transit.bin`. Returns the stop count.
    #[wasm_bindgen(js_name = loadTransit)]
    pub fn load_transit(&mut self, bytes: Vec<u8>) -> Result<u32, JsError> {
        let buf = AlignedBytes::adopt(bytes);
        let stops = TransitSchema::decode(&buf)
            .map_err(|e| JsError::new(&e.to_string()))?
            .stop_count() as u32;
        STATE.with_borrow_mut(|s| s.transit = Some(buf));
        Ok(stops)
    }

    /// Take ownership of `counts.bin`. Returns the station count.
    #[wasm_bindgen(js_name = loadCounts)]
    pub fn load_counts(&mut self, bytes: Vec<u8>) -> Result<u32, JsError> {
        let buf = AlignedBytes::adopt(bytes);
        let n = CountsSchema::decode(&buf)
            .map_err(|e| JsError::new(&e.to_string()))?
            .meta
            .station_count;
        STATE.with_borrow_mut(|s| s.counts = Some(buf));
        Ok(n)
    }

    /// Hand one hour's edge volumes — the first block of what `runHour`
    /// returned — to the calibration table. Optional: with no hours recorded
    /// `calibration` has nothing to compare and returns an empty list.
    #[wasm_bindgen(js_name = recordHour)]
    pub fn record_hour(&mut self, hour: u8, volumes: Vec<f32>) -> Result<(), JsError> {
        let h = Hour::new(hour).ok_or_else(|| JsError::new("hour must be 0..24"))?;
        STATE.with_borrow_mut(|s| *s.hourly_slot(h.index()) = Some(volumes));
        Ok(())
    }

    /// Walk + ride reach from a point, as `[node_id, seconds]` pairs.
    ///
    /// Also stashes the summary, so `reachSummary` can report the population
    /// behind the same call without recomputing it.
    #[wasm_bindgen(js_name = isochrone)]
    pub fn isochrone(
        &mut self,
        lon: f64,
        lat: f64,
        hour: u8,
        budget_min: f32,
    ) -> Result<Vec<f32>, JsError> {
        let hour = Hour::new(hour).ok_or_else(|| JsError::new("hour must be 0..24"))?;
        let budget_s = budget_min * 60.0;
        let view = self.graph.view();
        let origin = nearest_node(&view, lon, lat)
            .ok_or_else(|| JsError::new("no graph node near that point; load a chunk first"))?;

        STATE.with_borrow_mut(|state| {
            let bytes = state
                .transit
                .as_ref()
                .ok_or_else(|| JsError::new("call loadTransit first"))?;
            let transit = TransitSchema::decode(bytes).map_err(|e| JsError::new(&e.to_string()))?;
            let reach = isochrone(&view, &transit, origin, hour, budget_s);
            let nodes = view.nodes();
            let pairs = reach.pairs(|i| nodes[i].id.raw());
            state.last_reach = Some(ReachSummaryDTO {
                nodes: reach.reached,
                population: population_reached(self.demand.as_ref(), &view, &reach.seconds),
                hour: hour.raw(),
                budget_min,
            });
            Ok(pairs)
        })
    }

    /// `{ nodes, population, hour, budget_min }` for the last `isochrone`.
    #[wasm_bindgen(js_name = reachSummary)]
    pub fn reach_summary(&self) -> String {
        STATE.with_borrow(|s| {
            serde_json::to_string(&s.last_reach.unwrap_or_default()).unwrap_or_else(|_| "{}".into())
        })
    }

    /// Observed AADT against modelled daily volume, one row per station that
    /// snapped onto an edge the loaded study area contains.
    ///
    /// With all 24 hours recorded the modelled figure is their sum. With only
    /// some, it is scaled up by the hourly profile and the row says so.
    #[wasm_bindgen(js_name = calibration)]
    pub fn calibration(&mut self) -> String {
        let edge_ids = self.loaded_edge_ids();
        STATE.with_borrow(|state| {
            let Some(bytes) = state.counts.as_ref() else {
                return "[]".to_string();
            };
            let Ok(counts) = CountsSchema::decode(bytes) else {
                return "[]".to_string();
            };
            let hourly = borrow_hours(&state.hourly);
            let rows: Vec<CalibrationDTO> = counts
                .stations
                .iter()
                .filter_map(|s| {
                    // `runHour` lays its result out in ascending edge id, so
                    // that sorted list is the index into the volumes.
                    let dense = edge_ids.binary_search(&s.edge).ok()?;
                    let (daily, source) = modeled_daily(&hourly, &NHTS_HOUR_PROFILE, dense)?;
                    Some(CalibrationDTO {
                        station_id: s.station_id,
                        edge_id: s.edge,
                        aadt: s.aadt,
                        modeled_daily: daily,
                        snap_m: s.snap_m,
                        scaled: !matches!(source, DailySource::FullDay),
                    })
                })
                .collect();
            serde_json::to_string(&rows).unwrap_or_else(|_| "[]".into())
        })
    }
}

/// `&[Option<Vec<f32>>]` -> the fixed-size array of borrows `modeled_daily`
/// takes, so the hour table is borrowed once for the whole station sweep.
fn borrow_hours(hourly: &[Option<Vec<f32>>]) -> [Option<&[f32]>; HOURS_PER_DAY] {
    let mut out: [Option<&[f32]>; HOURS_PER_DAY] = [None; HOURS_PER_DAY];
    for (slot, run) in out.iter_mut().zip(hourly) {
        *slot = run.as_deref();
    }
    out
}

/// Nearest loaded node to a point, by squared degrees. Linear, but it runs once
/// per isochrone against a study area of tens of thousands of nodes.
fn nearest_node(view: &twin_core::GraphView<'_>, lon: f64, lat: f64) -> Option<u32> {
    let (lon, lat) = (lon as f32, lat as f32);
    view.nodes()
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let (dx, dy) = ((n.lon - lon) * 0.78, n.lat - lat);
            (dx * dx + dy * dy, i as u32)
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, i)| i)
}

/// Residents in the zones whose loading node the reach touched.
fn population_reached(
    demand: Option<&AlignedBytes>,
    view: &twin_core::GraphView<'_>,
    seconds: &[f32],
) -> f64 {
    let Some(Ok(d)) = demand.map(|b| DemandSchema::decode(b)) else {
        return 0.0;
    };
    // Outbound daily trips are the only per-zone mass `demand.bin` carries;
    // dividing by trips per capita turns them back into people.
    let mut mass = vec![0.0f32; d.zone_count()];
    for t in d.od {
        if let Some(slot) = mass.get_mut(t.origin as usize) {
            *slot += t.trips;
        }
    }
    d.zone_node
        .iter()
        .enumerate()
        .filter_map(|(z, &node)| {
            let dense = view.index_of(twin_core::NodeId::new(node)?)? as usize;
            seconds
                .get(dense)?
                .is_finite()
                .then(|| (mass[z] / TRIPS_PER_CAPITA) as f64)
        })
        .sum()
}
