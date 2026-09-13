//! The `demand` and `cch-order` stages of DESIGN.md section 4.

use crate::config::PipelineConfig;
use crate::graph_io::LoadedGraph;
use crate::lodes::{self, DemandBuild};
use anyhow::Result;
use std::collections::HashMap;
use twin_core::grid::haversine_m;
use twin_core::{
    demand::{DemandMetaSchema, DemandSchema, OdTripleSchema, NHTS_HOUR_PROFILE},
    nested_dissection_order, CchOrderSchema, GraphView, GridSchema, OrderKind,
};

/// Daily vehicle trips the gravity fallback spreads over the study area. Sized
/// for a county of ~1.15 M people at ~3 trips a day, half of them internal.
const SYNTHETIC_DAILY_TRIPS: f64 = 1_500_000.0;

/// Nearest graph node to each zone centroid.
///
/// Nodes are bucketed into the chunk grid once; a lookup then walks outward
/// ring by ring and stops as soon as the ring's inner distance exceeds the best
/// hit, so the answer is exact rather than "good enough".
struct NodeIndex<'a> {
    view: GraphView<'a>,
    grid: GridSchema,
    buckets: HashMap<(u32, u32), Vec<u32>>,
}

impl<'a> NodeIndex<'a> {
    fn new(view: GraphView<'a>, grid: GridSchema) -> Self {
        let mut buckets: HashMap<(u32, u32), Vec<u32>> = HashMap::new();
        for (i, n) in view.nodes().iter().enumerate() {
            buckets
                .entry(grid.cell_xy(n.lon as f64, n.lat as f64))
                .or_default()
                .push(i as u32);
        }
        Self {
            view,
            grid,
            buckets,
        }
    }

    fn nearest(&self, lon: f64, lat: f64) -> Option<u32> {
        let (cx, cy) = self.grid.cell_xy(lon, lat);
        let cell_m = self.grid.cell_lat_deg * 111_320.0;
        let mut best: Option<(f64, u32)> = None;
        for r in 0..=self.grid.cols.max(self.grid.rows) {
            // Everything in this ring is at least (r - 1) cells away, so once
            // that floor beats the best hit there is nothing left to find.
            if let Some((d, _)) = best {
                if d < (r.saturating_sub(1)) as f64 * cell_m {
                    break;
                }
            }
            for (x, y) in ring_cells(cx, cy, r, self.grid.cols, self.grid.rows) {
                for &i in self.buckets.get(&(x, y)).map(Vec::as_slice).unwrap_or(&[]) {
                    let n = &self.view.nodes()[i as usize];
                    let d = haversine_m(lon, lat, n.lon as f64, n.lat as f64);
                    if best.is_none_or(|(bd, _)| d < bd) {
                        best = Some((d, i));
                    }
                }
            }
        }
        best.map(|(_, i)| i)
    }
}

/// The cells exactly `r` steps from `(cx, cy)` in Chebyshev distance, clipped
/// to the grid.
fn ring_cells(cx: u32, cy: u32, r: u32, cols: u32, rows: u32) -> Vec<(u32, u32)> {
    let (cx, cy, r) = (cx as i64, cy as i64, r as i64);
    let mut out = Vec::new();
    for dy in -r..=r {
        for dx in -r..=r {
            if dx.abs() != r && dy.abs() != r {
                continue;
            }
            let (x, y) = (cx + dx, cy + dy);
            if (0..cols as i64).contains(&x) && (0..rows as i64).contains(&y) {
                out.push((x as u32, y as u32));
            }
        }
    }
    out
}

/// A zone centroid and the node count behind it: `(lon, lat, mass)`.
type Cell = (f64, f64, u32);

/// Zone centroids from the graph's own chunk cells, for the gravity fallback.
fn cells_from_graph(view: &GraphView<'_>, grid: &GridSchema) -> Vec<Cell> {
    let mut acc: HashMap<(u32, u32), Cell> = HashMap::new();
    for n in view.nodes() {
        let e = acc
            .entry(grid.cell_xy(n.lon as f64, n.lat as f64))
            .or_insert((0.0, 0.0, 0));
        e.0 += n.lon as f64;
        e.1 += n.lat as f64;
        e.2 += 1;
    }
    let mut cells: Vec<((u32, u32), Cell)> = acc.into_iter().collect();
    cells.sort_unstable_by_key(|(k, _)| *k);
    cells
        .into_iter()
        .map(|(_, (slon, slat, n))| (slon / n as f64, slat / n as f64, n))
        .collect()
}

/// What the `demand` stage produced, for the manifest and the log.
pub struct DemandOutput {
    pub bytes: Vec<u8>,
    /// `zone index,key,lon,lat,node` — the audit trail from a zone back to its
    /// census block group, which calibration in Phase 3 will need.
    pub zones_csv: String,
    pub zone_count: u32,
    pub external_start: u32,
    pub od_count: u32,
    pub is_synthetic: bool,
    pub notes: Vec<String>,
}

/// Read LODES if it is on disk, otherwise synthesize; then snap every zone to a
/// graph node and encode `demand.bin`.
pub fn build_demand(cfg: &PipelineConfig, loaded: &mut LoadedGraph) -> Result<DemandOutput> {
    let d = &cfg.demand;
    let raw = |p: &std::path::Path| match p.exists() {
        true => p.to_path_buf(),
        false => cfg.raw_dir.join(p),
    };
    let (xwalk, od_main, od_aux) = (raw(&d.xwalk), raw(&d.od_main), raw(&d.od_aux));
    let have_lodes = xwalk.exists() && od_main.exists() && od_aux.exists();

    let grid = loaded.grid;
    let mut build: DemandBuild = match (d.synthetic, have_lodes) {
        (false, true) => lodes::from_lodes(
            &xwalk,
            &od_main,
            &od_aux,
            grid.bbox(),
            d.external_zones,
            d.auto_factor,
        )?,
        (forced, _) => {
            let cells = cells_from_graph(&loaded.graph.view(), &grid);
            let mut b = lodes::synthetic_gravity(
                &cells,
                grid.bbox(),
                d.external_zones,
                SYNTHETIC_DAILY_TRIPS,
            );
            if !forced {
                b.notes.insert(
                    0,
                    format!(
                        "LODES files not found under {} — falling back to a synthetic gravity model.",
                        cfg.raw_dir.display()
                    ),
                );
            }
            b
        }
    };

    let index = NodeIndex::new(loaded.graph.view(), grid);
    let mut snapped: Vec<Option<u32>> = Vec::with_capacity(build.zones.len());
    for z in &build.zones {
        snapped.push(index.nearest(z.lon, z.lat));
    }
    let dropped = snapped.iter().filter(|s| s.is_none()).count();

    // Zones with no reachable node are dropped, which renumbers everything
    // after them; do it once, up front, so the OD ids stay consistent.
    let mut keep_of_old: Vec<Option<u16>> = vec![None; build.zones.len()];
    let mut zone_node: Vec<u32> = Vec::new();
    let mut zone_lonlat: Vec<[f32; 2]> = Vec::new();
    let mut external_start = 0u32;
    for (old, node) in snapped.iter().enumerate() {
        let Some(dense) = node else { continue };
        keep_of_old[old] = Some(zone_node.len() as u16);
        if !build.zones[old].external {
            external_start = zone_node.len() as u32 + 1;
        }
        zone_node.push(index.view.nodes()[*dense as usize].id.raw());
        zone_lonlat.push([build.zones[old].lon as f32, build.zones[old].lat as f32]);
    }

    let mut od: Vec<OdTripleSchema> = build
        .od
        .iter()
        .filter_map(|(&(o, d), &trips)| {
            Some(OdTripleSchema {
                origin: keep_of_old[o as usize]?,
                dest: keep_of_old[d as usize]?,
                trips,
            })
        })
        .collect();
    od.sort_unstable_by_key(|t| (t.origin, t.dest));

    let meta = DemandMetaSchema {
        zone_count: zone_node.len() as u32,
        od_count: od.len() as u32,
        external_zone_start: external_start,
        is_synthetic: u32::from(build.is_synthetic),
    };
    if dropped > 0 {
        build
            .notes
            .push(format!("{dropped} zones dropped: no graph node to snap to"));
    }
    let zones_csv = std::iter::once("zone,key,lon,lat,node\n".to_string())
        .chain(
            keep_of_old
                .iter()
                .enumerate()
                .filter_map(|(old, slot)| slot.map(|z| (old, z)))
                .map(|(old, z)| {
                    let zb = &build.zones[old];
                    format!(
                        "{z},{},{:.6},{:.6},{}\n",
                        zb.key, zb.lon, zb.lat, zone_node[z as usize]
                    )
                }),
        )
        .collect();
    Ok(DemandOutput {
        bytes: DemandSchema::encode(meta, &zone_node, &zone_lonlat, &od, &NHTS_HOUR_PROFILE),
        zones_csv,
        zone_count: meta.zone_count,
        external_start,
        od_count: meta.od_count,
        is_synthetic: build.is_synthetic,
        notes: build.notes,
    })
}

pub struct OrderOutput {
    pub bytes: Vec<u8>,
    pub node_count: u32,
    pub kind: OrderKind,
}

/// Nested-dissection contraction order over the whole county graph, in global
/// node ids so a study area can restrict it without recomputing.
pub fn build_cch_order(loaded: &mut LoadedGraph) -> Result<OrderOutput> {
    let view = loaded.graph.view();
    let nodes = view.nodes();
    let (lon, lat): (Vec<f32>, Vec<f32>) = nodes.iter().map(|n| (n.lon, n.lat)).unzip();
    let (tail, head): (Vec<u32>, Vec<u32>) = view.edges().iter().map(|e| (e.from, e.to)).unzip();
    let dense_order = nested_dissection_order(nodes.len() as u32, &tail, &head, &lat, &lon);
    let rank: Vec<u32> = dense_order
        .iter()
        .map(|&v| nodes[v as usize].id.raw())
        .collect();
    Ok(OrderOutput {
        bytes: CchOrderSchema::encode(OrderKind::InertialFlow, &rank),
        node_count: rank.len() as u32,
        kind: OrderKind::InertialFlow,
    })
}
