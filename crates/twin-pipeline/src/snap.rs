//! Snapping points onto the road graph.
//!
//! Both indices bucket into the chunk grid once and then walk outward ring by
//! ring, stopping as soon as the ring's inner distance exceeds the best hit —
//! so the answer is exact, not "good enough", and a miss costs a scan of the
//! grid rather than of the graph.

use twin_core::grid::haversine_m;
use twin_core::{GraphView, GridSchema};

use std::collections::HashMap;

/// The cells exactly `r` steps from `(cx, cy)` in Chebyshev distance, clipped
/// to the grid.
pub fn ring_cells(cx: u32, cy: u32, r: u32, cols: u32, rows: u32) -> Vec<(u32, u32)> {
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

/// Ring-by-ring search over a bucketed grid. Shared by both indices: they
/// differ only in what is in a bucket and how a candidate's distance is
/// measured.
fn nearest_bucketed(
    grid: &GridSchema,
    buckets: &HashMap<(u32, u32), Vec<u32>>,
    lon: f64,
    lat: f64,
    distance: impl Fn(u32) -> f64,
) -> Option<(u32, f64)> {
    let (cx, cy) = grid.cell_xy(lon, lat);
    let cell_m = grid.cell_lat_deg * 111_320.0;
    let mut best: Option<(f64, u32)> = None;
    for r in 0..=grid.cols.max(grid.rows) {
        if let Some((d, _)) = best {
            if d < (r.saturating_sub(1)) as f64 * cell_m {
                break;
            }
        }
        for (x, y) in ring_cells(cx, cy, r, grid.cols, grid.rows) {
            for &i in buckets.get(&(x, y)).map(Vec::as_slice).unwrap_or(&[]) {
                let d = distance(i);
                if best.is_none_or(|(bd, _)| d < bd) {
                    best = Some((d, i));
                }
            }
        }
    }
    best.map(|(d, i)| (i, d))
}

/// Nearest graph node to a point.
pub struct NodeIndex<'a> {
    pub view: GraphView<'a>,
    grid: GridSchema,
    buckets: HashMap<(u32, u32), Vec<u32>>,
}

impl<'a> NodeIndex<'a> {
    pub fn new(view: GraphView<'a>, grid: GridSchema) -> Self {
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

    /// Dense index of the nearest node, ignoring how far away it is.
    pub fn nearest(&self, lon: f64, lat: f64) -> Option<u32> {
        self.nearest_within(lon, lat, f64::INFINITY).map(|(i, _)| i)
    }

    /// Dense index and distance, or `None` when nothing is within `max_m`.
    pub fn nearest_within(&self, lon: f64, lat: f64, max_m: f64) -> Option<(u32, f64)> {
        let nodes = self.view.nodes();
        nearest_bucketed(&self.grid, &self.buckets, lon, lat, |i| {
            let n = &nodes[i as usize];
            haversine_m(lon, lat, n.lon as f64, n.lat as f64)
        })
        .filter(|&(_, d)| d <= max_m)
    }
}

/// Nearest graph edge to a point.
///
/// The graph drops per-edge polylines when it is assembled, so an edge is
/// measured as the straight segment between its endpoints. On a network already
/// split at every intersection that is within a few metres of the drawn
/// centreline, which is well inside the accuracy of a count station's own
/// coordinates.
pub struct EdgeIndex<'a> {
    pub view: GraphView<'a>,
    grid: GridSchema,
    buckets: HashMap<(u32, u32), Vec<u32>>,
}

impl<'a> EdgeIndex<'a> {
    pub fn new(view: GraphView<'a>, grid: GridSchema) -> Self {
        let mut buckets: HashMap<(u32, u32), Vec<u32>> = HashMap::new();
        let nodes = view.nodes();
        for (i, e) in view.edges().iter().enumerate() {
            // Both endpoints, so an edge crossing a cell border is findable
            // from either side.
            for end in [e.from, e.to] {
                let n = &nodes[end as usize];
                let cell = grid.cell_xy(n.lon as f64, n.lat as f64);
                let slot = buckets.entry(cell).or_default();
                if slot.last() != Some(&(i as u32)) {
                    slot.push(i as u32);
                }
            }
        }
        Self {
            view,
            grid,
            buckets,
        }
    }

    /// Dense edge index and its distance in metres, or `None` beyond `max_m`.
    pub fn nearest_within(&self, lon: f64, lat: f64, max_m: f64) -> Option<(u32, f64)> {
        let (nodes, edges) = (self.view.nodes(), self.view.edges());
        nearest_bucketed(&self.grid, &self.buckets, lon, lat, |i| {
            let e = &edges[i as usize];
            let a = &nodes[e.from as usize];
            let b = &nodes[e.to as usize];
            point_to_segment_m(
                (lon, lat),
                (a.lon as f64, a.lat as f64),
                (b.lon as f64, b.lat as f64),
            )
        })
        .filter(|&(_, d)| d <= max_m)
    }
}

/// Distance from a point to a segment, in metres.
///
/// Degrees are projected to a local equirectangular plane about the point,
/// which is exact enough over the hundred metres or so a snap ever spans.
pub fn point_to_segment_m(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    const M_PER_DEG_LAT: f64 = 111_320.0;
    let k = p.1.to_radians().cos() * M_PER_DEG_LAT;
    let to_xy = |q: (f64, f64)| ((q.0 - p.0) * k, (q.1 - p.1) * M_PER_DEG_LAT);
    let (ax, ay) = to_xy(a);
    let (bx, by) = to_xy(b);
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    // A zero-length edge is just its endpoint.
    let t = match len2 {
        0.0 => 0.0,
        l => (-(ax * dx + ay * dy) / l).clamp(0.0, 1.0),
    };
    let (cx, cy) = (ax + t * dx, ay + t * dy);
    (cx * cx + cy * cy).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_point_beside_a_segment_measures_its_perpendicular() {
        // ~111 m north of a segment running due east at 38.85 N.
        let d = point_to_segment_m((-77.30, 38.851), (-77.31, 38.85), (-77.29, 38.85));
        assert!((d - 111.3).abs() < 1.0, "got {d} m");
    }

    #[test]
    fn a_point_past_the_end_measures_to_the_endpoint() {
        let past = point_to_segment_m((-77.28, 38.85), (-77.31, 38.85), (-77.29, 38.85));
        let endpoint = point_to_segment_m((-77.28, 38.85), (-77.29, 38.85), (-77.29, 38.85));
        assert!((past - endpoint).abs() < 1.0, "clamped to t = 1");
        assert!(past > 800.0 && past < 900.0, "got {past} m");
    }
}
