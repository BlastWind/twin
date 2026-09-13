//! `ingest-gtfs` — Fairfax Connector, CUE and (with a key) WMATA into
//! `transit.bin`. DESIGN.md section 4.3.
//!
//! The timetable is compressed on the way in. A pattern is a distinct stop
//! sequence; its hop times are the median over the trips that run it, and its
//! service is a departure count per hour turned into a headway. That is
//! everything the isochrone reads, and it turns tens of megabytes of
//! `stop_times.txt` into tens of kilobytes.

use crate::graph_io::LoadedGraph;
use crate::snap::NodeIndex;
use anyhow::{Context, Result};
use gtfs_structures::{Gtfs, RouteType};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::path::Path;
use twin_core::transit::{
    compress_headways, Departure, PatternEntrySchema, TransitMetaSchema, TransitSchema,
};
use twin_core::{GridSchema, HOURS_PER_DAY};

/// A stop further than this from any modelled node is not walkable to it; the
/// stop is dropped rather than teleported onto a distant road.
const MAX_SNAP_M: f64 = 400.0;

/// The feeds we look for, in the order they are folded in. The name is both the
/// zip's basename under `raw/gtfs` and the `agency` written to the tiles.
pub const AGENCIES: [&str; 4] = ["connector", "cue", "wmata_bus", "wmata_rail"];

pub struct GtfsOutput {
    pub bytes: Vec<u8>,
    /// Line features for the `transit_routes` tile layer.
    pub routes_geojsonl: String,
    /// Point features for the `transit_stops` tile layer.
    pub stops_geojsonl: String,
    pub agencies: Vec<String>,
    pub stop_count: u32,
    pub pattern_count: u32,
    pub notes: Vec<String>,
}

/// A stop as we accumulate it, before snapping. Keyed by `agency:stop_id`
/// because two operators reuse the same short ids.
struct StopBuild {
    key: String,
    name: String,
    lon: f64,
    lat: f64,
}

/// A pattern under construction: the stop sequence, and every observed hop time
/// and departure so the medians and headways can be taken at the end.
#[derive(Default)]
struct PatternBuild {
    hops: Vec<Vec<f32>>,
    departures: Vec<f32>,
}

pub fn build_gtfs(
    raw_dir: &Path,
    loaded: &mut LoadedGraph,
    grid: GridSchema,
) -> Result<GtfsOutput> {
    let dir = raw_dir.join("gtfs");
    let mut notes = Vec::new();

    let mut stops: Vec<StopBuild> = Vec::new();
    let mut stop_of_key: HashMap<String, u32> = HashMap::new();
    // Keyed by the stop sequence so two branches of one route stay two
    // patterns and an identical sequence run by two routes stays one.
    let mut patterns: BTreeMap<Vec<u32>, PatternBuild> = BTreeMap::new();
    let mut routes_geo = String::new();
    let mut agencies: Vec<String> = Vec::new();

    for agency in AGENCIES {
        let zip = dir.join(format!("{agency}.zip"));
        if !zip.exists() {
            notes.push(match agency.starts_with("wmata") {
                true => format!("{agency}: no zip on disk (TWIN_WMATA_KEY unset?); skipped"),
                false => format!("{agency}: no zip on disk; skipped"),
            });
            continue;
        }
        let feed = Gtfs::from_path(zip.to_string_lossy().as_ref())
            .with_context(|| format!("parsing {}", zip.display()))?;
        agencies.push(agency.to_string());

        let mut add_stop = |id: &str, name: &str, lon: f64, lat: f64| -> u32 {
            let key = format!("{agency}:{id}");
            *stop_of_key.entry(key.clone()).or_insert_with(|| {
                stops.push(StopBuild {
                    key,
                    name: name.to_string(),
                    lon,
                    lat,
                });
                stops.len() as u32 - 1
            })
        };

        for trip in feed.trips.values() {
            if !runs_on_a_weekday(&feed, &trip.service_id) {
                continue;
            }
            let seq: Vec<u32> = trip
                .stop_times
                .iter()
                .filter_map(|st| {
                    let s = &st.stop;
                    let (lon, lat) = (s.longitude?, s.latitude?);
                    Some(add_stop(
                        &s.id,
                        &s.name.clone().unwrap_or_default(),
                        lon,
                        lat,
                    ))
                })
                .collect();
            if seq.len() < 2 {
                continue;
            }
            let entry = patterns.entry(seq.clone()).or_insert_with(|| PatternBuild {
                hops: vec![Vec::new(); seq.len()],
                departures: Vec::new(),
            });
            record_trip(entry, trip);
        }

        write_routes(&feed, agency, &mut routes_geo);
    }

    if stops.is_empty() {
        notes.push("no GTFS feeds ingested; transit.bin will be empty".into());
    }

    // --- snap, then renumber: a dropped stop shifts every index after it -----
    let index = NodeIndex::new(loaded.graph.view(), grid);
    let snapped: Vec<Option<u32>> = stops
        .iter()
        .map(|s| {
            index
                .nearest_within(s.lon, s.lat, MAX_SNAP_M)
                .map(|(dense, _)| index.view.nodes()[dense as usize].id.raw())
        })
        .collect();
    let dropped = snapped.iter().filter(|s| s.is_none()).count();
    if dropped > 0 {
        notes.push(format!(
            "{dropped} of {} stops had no graph node within {MAX_SNAP_M:.0} m and were dropped",
            stops.len()
        ));
    }

    let mut dense_of_old: Vec<Option<u32>> = vec![None; stops.len()];
    let (mut stop_node, mut stop_lonlat, mut stops_geo) = (Vec::new(), Vec::new(), String::new());
    for (old, node) in snapped.iter().enumerate() {
        let Some(node) = node else { continue };
        dense_of_old[old] = Some(stop_node.len() as u32);
        stop_node.push(*node);
        stop_lonlat.push([stops[old].lon as f32, stops[old].lat as f32]);
        let line = json!({
            "type": "Feature",
            "properties": { "stop_id": stops[old].key, "name": stops[old].name },
            "geometry": { "type": "Point", "coordinates": [stops[old].lon, stops[old].lat] },
        });
        let _ = writeln!(stops_geo, "{line}");
    }

    // --- flatten the patterns ------------------------------------------------
    let (mut table, mut pattern_stops, mut pattern_hop_s) = (Vec::new(), Vec::new(), Vec::new());
    let mut departures: Vec<Departure> = Vec::new();
    for (seq, build) in &patterns {
        // A stop that failed to snap is removed and its hop folded into the
        // previous surviving one, so the ride time along the pattern is
        // preserved rather than silently shortened.
        let mut kept: Vec<(u32, f32)> = Vec::with_capacity(seq.len());
        for (&old, samples) in seq.iter().zip(&build.hops) {
            let hop = median(samples);
            match dense_of_old[old as usize] {
                Some(dense) => kept.push((dense, hop)),
                None => {
                    if let Some(last) = kept.last_mut() {
                        last.1 += hop;
                    }
                }
            }
        }
        if kept.len() < 2 {
            continue;
        }
        let p = table.len() as u32;
        table.push(PatternEntrySchema {
            stop_start: pattern_stops.len() as u32,
            stop_len: kept.len() as u32,
        });
        for (stop, hop_s) in kept {
            pattern_stops.push(stop);
            pattern_hop_s.push(hop_s);
        }
        // The last stop has no onward hop.
        if let Some(last) = pattern_hop_s.last_mut() {
            *last = 0.0;
        }
        departures.extend(build.departures.iter().map(|&depart_s| Departure {
            pattern: p,
            depart_s,
        }));
    }
    let headways = compress_headways(table.len(), &departures);

    let meta = TransitMetaSchema {
        stop_count: stop_node.len() as u32,
        pattern_count: table.len() as u32,
        pattern_stop_count: pattern_stops.len() as u32,
        agency_count: agencies.len() as u32,
    };
    debug_assert_eq!(headways.len(), table.len() * HOURS_PER_DAY);
    Ok(GtfsOutput {
        bytes: TransitSchema::encode(
            meta,
            &stop_node,
            &stop_lonlat,
            &table,
            &pattern_stops,
            &pattern_hop_s,
            &headways,
        ),
        routes_geojsonl: routes_geo,
        stops_geojsonl: stops_geo,
        agencies,
        stop_count: meta.stop_count,
        pattern_count: meta.pattern_count,
        notes,
    })
}

/// One trip's contribution: a hop time per leg and one departure.
fn record_trip(entry: &mut PatternBuild, trip: &gtfs_structures::Trip) {
    let times: Vec<(Option<u32>, Option<u32>)> = trip
        .stop_times
        .iter()
        .map(|st| (st.arrival_time, st.departure_time))
        .collect();
    for (i, w) in times.windows(2).enumerate() {
        let (Some(depart), Some(arrive)) = (w[0].1.or(w[0].0), w[1].0.or(w[1].1)) else {
            continue;
        };
        // Clamp: a few feeds carry non-monotonic times.
        let hop = arrive.saturating_sub(depart) as f32;
        if let Some(slot) = entry.hops.get_mut(i) {
            slot.push(hop);
        }
    }
    if let Some(first) = times.first().and_then(|t| t.1.or(t.0)) {
        entry.departures.push(first as f32);
    }
}

/// Median, which is what we want over a mean: a handful of trips stuck in a
/// once-a-week incident should not stretch every rider's hop.
fn median(samples: &[f32]) -> f32 {
    match samples.len() {
        0 => 0.0,
        n => {
            let mut v = samples.to_vec();
            v.sort_by(f32::total_cmp);
            v[n / 2]
        }
    }
}

/// Whether a service runs on a typical weekday. Feeds that express service only
/// through `calendar_dates` are taken as running: dropping them would silently
/// delete whole operators.
fn runs_on_a_weekday(feed: &Gtfs, service_id: &str) -> bool {
    feed.calendar
        .get(service_id)
        .is_none_or(|c| c.monday || c.tuesday || c.wednesday)
}

/// Route shapes for the `transit_routes` tile layer, one line per route. The
/// longest trip's shape stands in for the route.
fn write_routes(feed: &Gtfs, agency: &str, out: &mut String) {
    let mut longest: HashMap<&str, (usize, Option<&str>)> = HashMap::new();
    for trip in feed.trips.values() {
        let slot = longest.entry(&trip.route_id).or_insert((0, None));
        if trip.stop_times.len() > slot.0 {
            *slot = (trip.stop_times.len(), trip.shape_id.as_deref());
        }
    }
    for (route_id, (_, shape_id)) in longest {
        let Some(coords) = shape_id.and_then(|s| feed.shapes.get(s)).map(|pts| {
            pts.iter()
                .map(|p| [p.longitude, p.latitude])
                .collect::<Vec<_>>()
        }) else {
            continue;
        };
        if coords.len() < 2 {
            continue;
        }
        let route = feed.routes.get(route_id);
        let line = json!({
            "type": "Feature",
            "properties": {
                "route_id": format!("{agency}:{route_id}"),
                "agency": agency,
                "short_name": route.map(|r| r.short_name.clone().unwrap_or_default()),
                "color": route.map(|r| r.color.to_string()),
                "rail": route.is_some_and(|r| r.route_type == RouteType::Subway),
            },
            "geometry": { "type": "LineString", "coordinates": coords },
        });
        let _ = writeln!(out, "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_median_hop_ignores_one_bad_trip() {
        assert_eq!(median(&[]), 0.0);
        assert_eq!(median(&[120.0, 130.0, 3600.0]), 130.0);
        assert_eq!(median(&[60.0]), 60.0);
    }
}
