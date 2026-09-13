//! `transit.bin` — stops snapped to graph nodes, patterns as stop sequences,
//! and a timetable compressed to a per-hour headway plus a per-hop run time.
//! DESIGN.md sections 5 and 6.
//!
//! A pattern is a distinct stop sequence, not a GTFS route: two branches of the
//! same route are two patterns. The compression is deliberate — a full
//! stop-times table is tens of megabytes and the isochrone only ever asks
//! "how long until the next vehicle, and how long does it take from here".

use crate::grid::{haversine_m, GridSchema};
use crate::ids::{NodeId, HOURS_PER_DAY};
use crate::schema::*;
use bytemuck::{Pod, Zeroable};

pub const MAGIC_TRANSIT: [u8; 4] = *b"TWTR";
pub const VERSION_TRANSIT: u32 = 1;

/// Index into [`TransitSchema::stop_node`].
pub type StopIdx = u32;
/// Index into [`TransitSchema::patterns`].
pub type PatternIdx = u32;

/// Headway sentinel: no service in this hour. Finite so the array stays plain
/// `f32` data, large enough that no boarding ever beats walking.
pub const NO_SERVICE_S: f32 = 86_400.0;

/// Fixed part of `transit.bin`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Zeroable, Pod)]
#[repr(C)]
pub struct TransitMetaSchema {
    pub stop_count: u32,
    pub pattern_count: u32,
    /// Total entries in `pattern_stops`, summed over patterns.
    pub pattern_stop_count: u32,
    /// Agencies folded into this file; reported, not indexed.
    pub agency_count: u32,
}

/// One pattern: a slice of `pattern_stops` and the parallel slice of hop run
/// times. `hop_s[i]` is the ride from `stops[i]` to `stops[i + 1]`, so the last
/// stop's slot is unused and written as zero.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Zeroable, Pod)]
#[repr(C)]
pub struct PatternEntrySchema {
    pub stop_start: u32,
    pub stop_len: u32,
}

/// Decoded `transit.bin`, borrowed from the caller's bytes.
pub struct TransitSchema<'a> {
    pub meta: TransitMetaSchema,
    /// Global [`NodeId`] each stop snapped to.
    pub stop_node: &'a [u32],
    pub stop_lonlat: &'a [[f32; 2]],
    pub patterns: &'a [PatternEntrySchema],
    /// Flattened stop-index sequences, indexed by [`PatternEntrySchema`].
    pub pattern_stops: &'a [StopIdx],
    /// Parallel to `pattern_stops`: seconds from this stop to the next.
    pub pattern_hop_s: &'a [f32],
    /// `pattern_count * 24`, row-major by pattern. [`NO_SERVICE_S`] where the
    /// pattern does not run.
    pub pattern_headway_s: &'a [f32],
}

impl<'a> TransitSchema<'a> {
    pub fn decode(bytes: &'a [u8]) -> Result<Self, SchemaError> {
        let f = FileView::parse(bytes, MAGIC_TRANSIT, VERSION_TRANSIT)?;
        let out = Self {
            meta: f.one(SectionKind::TransitMeta)?,
            stop_node: f.section(SectionKind::StopNode)?,
            stop_lonlat: f.section(SectionKind::StopLonLat)?,
            patterns: f.section(SectionKind::PatternTable)?,
            pattern_stops: f.section(SectionKind::PatternStops)?,
            pattern_hop_s: f.section(SectionKind::PatternHopS)?,
            pattern_headway_s: f.section(SectionKind::PatternHeadwayS)?,
        };
        out.validate()?;
        Ok(out)
    }

    fn validate(&self) -> Result<(), SchemaError> {
        let s = self.meta.stop_count as usize;
        let p = self.meta.pattern_count as usize;
        let ps = self.meta.pattern_stop_count as usize;
        let bad = |k| Err(SchemaError::InconsistentLength(k));
        if self.stop_node.len() != s || self.stop_lonlat.len() != s {
            return bad(SectionKind::StopNode);
        }
        if self.patterns.len() != p {
            return bad(SectionKind::PatternTable);
        }
        if self.pattern_stops.len() != ps || self.pattern_hop_s.len() != ps {
            return bad(SectionKind::PatternStops);
        }
        if self.pattern_headway_s.len() != p * HOURS_PER_DAY {
            return bad(SectionKind::PatternHeadwayS);
        }
        if self.pattern_stops.iter().any(|&i| i as usize >= s) {
            return bad(SectionKind::PatternStops);
        }
        let in_range = self
            .patterns
            .iter()
            .all(|e| e.stop_start as usize + e.stop_len as usize <= ps);
        if !in_range {
            return bad(SectionKind::PatternTable);
        }
        Ok(())
    }

    pub fn encode(
        meta: TransitMetaSchema,
        stop_node: &[u32],
        stop_lonlat: &[[f32; 2]],
        patterns: &[PatternEntrySchema],
        pattern_stops: &[StopIdx],
        pattern_hop_s: &[f32],
        pattern_headway_s: &[f32],
    ) -> Vec<u8> {
        FileWriter::new()
            .push_one(SectionKind::TransitMeta, &meta)
            .push(SectionKind::StopNode, stop_node)
            .push(SectionKind::StopLonLat, stop_lonlat)
            .push(SectionKind::PatternTable, patterns)
            .push(SectionKind::PatternStops, pattern_stops)
            .push(SectionKind::PatternHopS, pattern_hop_s)
            .push(SectionKind::PatternHeadwayS, pattern_headway_s)
            .finish(MAGIC_TRANSIT, VERSION_TRANSIT, 0)
    }

    pub fn stop_count(&self) -> usize {
        self.meta.stop_count as usize
    }

    pub fn node_of(&self, stop: StopIdx) -> Option<NodeId> {
        NodeId::new(*self.stop_node.get(stop as usize)?)
    }

    /// The stop sequence of one pattern, with each stop's onward run time.
    pub fn pattern_hops(&self, p: PatternIdx) -> impl Iterator<Item = (StopIdx, f32)> + '_ {
        let e = self.patterns[p as usize];
        let (a, b) = (e.stop_start as usize, (e.stop_start + e.stop_len) as usize);
        self.pattern_stops[a..b]
            .iter()
            .copied()
            .zip(self.pattern_hop_s[a..b].iter().copied())
    }

    /// Headway of `p` in `hour`, or `None` when it does not run.
    pub fn headway_s(&self, p: PatternIdx, hour: crate::ids::Hour) -> Option<f32> {
        let h = self.pattern_headway_s[p as usize * HOURS_PER_DAY + hour.index()];
        (h < NO_SERVICE_S).then_some(h)
    }
}

// --- headway compression ----------------------------------------------------

/// One observed departure: the pattern it serves and the second of the day it
/// leaves the pattern's first stop at.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Departure {
    pub pattern: PatternIdx,
    pub depart_s: f32,
}

/// Departures -> a headway per hour, per pattern.
///
/// The headway of an hour with `n` departures is `3600 / n`: it is the wait a
/// rider actually experiences, which is what the isochrone needs, and it stays
/// right when a pattern's departures are clumped at an hour boundary. Hours
/// with no departure get [`NO_SERVICE_S`].
pub fn compress_headways(pattern_count: usize, departures: &[Departure]) -> Vec<f32> {
    let mut counts = vec![0u32; pattern_count * HOURS_PER_DAY];
    for d in departures {
        // Trips after midnight wrap; GTFS allows `25:10:00`.
        let hour = (d.depart_s / 3600.0).floor().rem_euclid(24.0) as usize;
        let slot = d.pattern as usize * HOURS_PER_DAY + hour;
        if let Some(c) = counts.get_mut(slot) {
            *c += 1;
        }
    }
    counts
        .into_iter()
        .map(|n| match n {
            0 => NO_SERVICE_S,
            n => 3600.0 / n as f32,
        })
        .collect()
}

// --- isochrone --------------------------------------------------------------

/// Walking speed used by the isochrone, metres per second (~4.9 km/h).
pub const WALK_SPEED_MPS: f32 = 1.35;
/// Boardings allowed. Two transfers covers every realistic county bus trip and
/// bounds the work at three Dijkstra passes.
pub const MAX_ROUNDS: usize = 3;

/// What [`isochrone`] found: per reached node, the seconds it took.
pub struct ReachResult {
    /// Dense node index -> arrival seconds. `f32::INFINITY` where unreached.
    pub seconds: Vec<f32>,
    pub reached: u32,
}

impl ReachResult {
    /// `[node_id, seconds]` pairs for the reached nodes, ready for the wire.
    pub fn pairs(&self, node_id: impl Fn(usize) -> u32) -> Vec<f32> {
        self.seconds
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_finite())
            .flat_map(|(i, s)| [node_id(i) as f32, *s])
            .collect()
    }
}

/// Walk + ride reach from `origin` (a dense node index) at `hour`.
///
/// A round is one multi-source Dijkstra over the walk network followed by one
/// boarding relaxation over every pattern; `MAX_ROUNDS` rounds allow
/// `MAX_ROUNDS - 1` transfers. Waiting costs half the headway, the standard
/// random-arrival expectation.
pub fn isochrone(
    view: &crate::graph::GraphView<'_>,
    transit: &TransitSchema<'_>,
    origin: u32,
    hour: crate::ids::Hour,
    budget_s: f32,
) -> ReachResult {
    let n = view.nodes().len();
    let mut seconds = vec![f32::INFINITY; n];
    seconds[origin as usize] = 0.0;

    // Stops resolve to dense indices once; unloaded chunks simply have none.
    let stop_dense: Vec<Option<u32>> = (0..transit.stop_count())
        .map(|s| transit.node_of(s as StopIdx).and_then(|id| view.index_of(id)))
        .collect();

    for _ in 0..MAX_ROUNDS {
        walk_relax(view, &mut seconds, budget_s);
        if !ride_relax(transit, &stop_dense, &mut seconds, hour, budget_s) {
            break;
        }
    }
    walk_relax(view, &mut seconds, budget_s);

    let reached = seconds.iter().filter(|s| s.is_finite()).count() as u32;
    ReachResult { seconds, reached }
}

/// Multi-source Dijkstra over walk times, in place: every finite label is a
/// source. Labels above `budget_s` are pruned rather than expanded.
fn walk_relax(view: &crate::graph::GraphView<'_>, seconds: &mut [f32], budget_s: f32) {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    let mut heap: BinaryHeap<Reverse<(ordered::OrdF32, u32)>> = seconds
        .iter()
        .enumerate()
        .filter(|(_, s)| s.is_finite())
        .map(|(i, s)| Reverse((ordered::OrdF32(*s), i as u32)))
        .collect();

    while let Some(Reverse((ordered::OrdF32(t), v))) = heap.pop() {
        if t > seconds[v as usize] {
            continue;
        }
        for &ei in view.out_edges_of(v as usize) {
            let e = &view.edges()[ei as usize];
            let walk_s = e.len_m / WALK_SPEED_MPS;
            let cand = t + walk_s;
            if cand > budget_s || cand >= seconds[e.to as usize] {
                continue;
            }
            seconds[e.to as usize] = cand;
            heap.push(Reverse((ordered::OrdF32(cand), e.to)));
        }
    }
}

/// One boarding round. Returns whether anything improved, so a network with no
/// service in this hour costs one pass rather than `MAX_ROUNDS`.
fn ride_relax(
    transit: &TransitSchema<'_>,
    stop_dense: &[Option<u32>],
    seconds: &mut [f32],
    hour: crate::ids::Hour,
    budget_s: f32,
) -> bool {
    let mut improved = false;
    for p in 0..transit.meta.pattern_count {
        let Some(headway) = transit.headway_s(p, hour) else {
            continue;
        };
        // Sweep the pattern once: `onboard` is the arrival time of the best
        // vehicle a rider could be sitting in by this stop.
        let mut onboard = f32::INFINITY;
        for (stop, hop_s) in transit.pattern_hops(p) {
            let Some(dense) = stop_dense[stop as usize] else {
                onboard = f32::INFINITY;
                continue;
            };
            let here = seconds[dense as usize];
            if here.is_finite() {
                onboard = onboard.min(here + headway * 0.5);
            }
            if onboard < here && onboard <= budget_s {
                seconds[dense as usize] = onboard;
                improved = true;
            }
            onboard += hop_s;
        }
    }
    improved
}

/// Total ordering over the finite `f32` costs a priority queue needs.
mod ordered {
    #[derive(Copy, Clone, PartialEq)]
    pub struct OrdF32(pub f32);
    impl Eq for OrdF32 {}
    impl PartialOrd for OrdF32 {
        fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
            Some(self.cmp(other))
        }
    }
    impl Ord for OrdF32 {
        fn cmp(&self, other: &Self) -> std::cmp::Ordering {
            self.0.total_cmp(&other.0)
        }
    }
}

/// Population reached, summed over the zones whose loading node the isochrone
/// touched.
///
/// `zone_pop` is the demand stage's per-zone mass; the caller decides what that
/// means (see `reach_population` in `twin-wasm`, which derives it from daily
/// outbound trips).
pub fn reach_population(
    reach: &ReachResult,
    zone_dense: impl Iterator<Item = (usize, Option<u32>)>,
    zone_pop: &[f32],
) -> f64 {
    zone_dense
        .filter_map(|(z, dense)| {
            let d = dense? as usize;
            reach.seconds.get(d)?.is_finite().then(|| zone_pop[z] as f64)
        })
        .sum()
}

/// Nearest stop to a point, by great-circle distance. Linear: the county has
/// thousands of stops, not millions, and this runs once per isochrone.
pub fn nearest_stop(transit: &TransitSchema<'_>, lon: f64, lat: f64) -> Option<StopIdx> {
    transit
        .stop_lonlat
        .iter()
        .enumerate()
        .map(|(i, p)| (haversine_m(lon, lat, p[0] as f64, p[1] as f64), i as StopIdx))
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, i)| i)
}

/// Grid cell of a stop, for the tile builder's convenience.
pub fn stop_cell(grid: &GridSchema, lonlat: [f32; 2]) -> (u32, u32) {
    grid.cell_xy(lonlat[0] as f64, lonlat[1] as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Hour;

    fn toy() -> Vec<u8> {
        // Two stops on one pattern, 300 s apart, every 10 minutes all day.
        let headways = vec![600.0f32; HOURS_PER_DAY];
        TransitSchema::encode(
            TransitMetaSchema {
                stop_count: 2,
                pattern_count: 1,
                pattern_stop_count: 2,
                agency_count: 1,
            },
            &[10, 20],
            &[[-77.30, 38.85], [-77.25, 38.85]],
            &[PatternEntrySchema {
                stop_start: 0,
                stop_len: 2,
            }],
            &[0, 1],
            &[300.0, 0.0],
            &headways,
        )
    }

    #[test]
    fn transit_round_trips() {
        let bytes = AlignedBytes::adopt(toy());
        let t = TransitSchema::decode(&bytes).expect("decodes");
        assert_eq!(t.stop_count(), 2);
        assert_eq!(t.node_of(1), NodeId::new(20));
        assert_eq!(t.headway_s(0, Hour::from_index(8)), Some(600.0));
        let hops: Vec<_> = t.pattern_hops(0).collect();
        assert_eq!(hops, vec![(0, 300.0), (1, 0.0)]);
    }

    #[test]
    fn a_pattern_pointing_past_the_end_is_rejected() {
        let bytes = AlignedBytes::adopt(TransitSchema::encode(
            TransitMetaSchema {
                stop_count: 2,
                pattern_count: 1,
                pattern_stop_count: 2,
                agency_count: 1,
            },
            &[10, 20],
            &[[0.0, 0.0], [0.0, 0.0]],
            &[PatternEntrySchema {
                stop_start: 1,
                stop_len: 4,
            }],
            &[0, 1],
            &[0.0, 0.0],
            &vec![600.0; HOURS_PER_DAY],
        ));
        assert!(TransitSchema::decode(&bytes).is_err());
    }

    #[test]
    fn headways_are_the_wait_a_rider_experiences() {
        let deps = [
            Departure {
                pattern: 0,
                depart_s: 8.0 * 3600.0,
            },
            Departure {
                pattern: 0,
                depart_s: 8.0 * 3600.0 + 900.0,
            },
            Departure {
                pattern: 0,
                depart_s: 8.0 * 3600.0 + 1800.0,
            },
            Departure {
                pattern: 0,
                depart_s: 8.0 * 3600.0 + 2700.0,
            },
            // 25:30 is 01:30 the next morning, not hour 25.
            Departure {
                pattern: 0,
                depart_s: 25.5 * 3600.0,
            },
        ];
        let h = compress_headways(1, &deps);
        assert_eq!(h.len(), HOURS_PER_DAY);
        assert_eq!(h[8], 900.0, "four departures in the hour is a 15 min wait");
        assert_eq!(h[1], 3600.0, "the after-midnight trip wraps to hour 1");
        assert_eq!(h[3], NO_SERVICE_S);
    }
}
