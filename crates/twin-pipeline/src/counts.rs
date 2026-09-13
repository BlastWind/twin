//! `ingest-counts` — VDOT traffic-volume stations snapped to the road graph.
//! DESIGN.md section 4; the calibration half lives in `twin-core::counts`.
//!
//! VDOT publishes AADT on route segments, not as points, so a "station" here is
//! the midpoint of one published segment. That is what gets snapped, and the
//! snap distance is kept in the file so the dashboard can drop the ones that
//! landed on the wrong road.

use crate::arcgis;
use crate::graph_io::LoadedGraph;
use crate::snap::EdgeIndex;
use anyhow::Result;
use serde_json::json;
use std::io::{BufWriter, Write};
use std::path::Path;
use twin_core::counts::{CountsMetaSchema, CountsSchema, StationSchema};
use twin_core::ids::NONE_U32;
use twin_core::GridSchema;

/// Beyond this a station is not describing any road we modelled — usually a
/// segment on a road below our class cutoff. Kept, but flagged by `snap_m`.
const MAX_SNAP_M: f64 = 250.0;

pub struct CountsOutput {
    pub bytes: Vec<u8>,
    /// Point features for the `counts` tile layer.
    pub geojsonl: String,
    pub station_count: u32,
    pub snapped: u32,
    pub year: u32,
    pub notes: Vec<String>,
}

pub fn build_counts(raw_dir: &Path, loaded: &mut LoadedGraph, grid: GridSchema) -> Result<CountsOutput> {
    let dir = raw_dir.join("gis").join("counts");
    let index = EdgeIndex::new(loaded.graph.view(), grid);

    let mut stations: Vec<StationSchema> = Vec::new();
    let mut geo = BufWriter::new(Vec::new());
    let mut year = 0u32;
    arcgis::for_each_feature(&dir, |f| {
        let (Some(id), Some(aadt)) = (f.num("OBJECTID"), f.num("ADT")) else {
            return Ok(());
        };
        let Some((lon, lat)) = midpoint(&f.points()) else {
            return Ok(());
        };
        // `DATA_DATE` is epoch milliseconds; the vintage is the modal year.
        year = year.max(epoch_ms_year(f.num("DATA_DATE")).unwrap_or(0));
        let hit = index.nearest_within(lon, lat, MAX_SNAP_M);
        let (edge, snap_m) = match hit {
            Some((dense, d)) => (index.view.edges()[dense as usize].id.raw(), d as f32),
            None => (NONE_U32, f32::INFINITY),
        };
        stations.push(StationSchema {
            station_id: id as u32,
            edge,
            aadt: aadt as f32,
            lon: lon as f32,
            lat: lat as f32,
            snap_m,
        });
        let line = json!({
            "type": "Feature",
            "properties": {
                "station_id": id as u32,
                "aadt": aadt,
                "year": year,
                "route": f.text("ROUTE_COMMON_NAME"),
            },
            "geometry": { "type": "Point", "coordinates": [lon, lat] },
        });
        writeln!(geo, "{line}")?;
        Ok(())
    })?;

    // Ascending by station so the file is diffable and lookups can bisect.
    stations.sort_unstable_by_key(|s| s.station_id);
    let snapped = stations.iter().filter(|s| s.edge != NONE_U32).count() as u32;
    let mut notes = Vec::new();
    if stations.is_empty() {
        notes.push("no VDOT count pages on disk; run scripts/download-data.sh".into());
    } else if snapped < stations.len() as u32 {
        notes.push(format!(
            "{} of {} stations found no edge within {MAX_SNAP_M:.0} m",
            stations.len() as u32 - snapped,
            stations.len()
        ));
    }
    let meta = CountsMetaSchema {
        station_count: stations.len() as u32,
        year,
    };
    Ok(CountsOutput {
        bytes: CountsSchema::encode(meta, &stations),
        geojsonl: String::from_utf8(geo.into_inner()?).unwrap_or_default(),
        station_count: meta.station_count,
        snapped,
        year,
        notes,
    })
}

/// Midpoint by vertex count — good enough to land on the right road, and it
/// avoids carrying a length-weighted interpolation for a point that only feeds
/// a nearest-edge query.
fn midpoint(points: &[(f64, f64)]) -> Option<(f64, f64)> {
    match points.len() {
        0 => None,
        n => Some(points[n / 2]),
    }
}

/// ArcGIS dates are epoch milliseconds; we only want the year.
fn epoch_ms_year(ms: Option<f64>) -> Option<u32> {
    let secs = ms? / 1000.0;
    // Civil-from-days, good from 1970 on, which every VDOT vintage is.
    let days = (secs / 86_400.0).floor() as i64;
    Some((1970 + (days * 400) / 146_097) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_midpoint_is_a_real_vertex() {
        assert_eq!(midpoint(&[]), None);
        assert_eq!(midpoint(&[(1.0, 2.0)]), Some((1.0, 2.0)));
        assert_eq!(
            midpoint(&[(0.0, 0.0), (1.0, 1.0), (2.0, 2.0)]),
            Some((1.0, 1.0))
        );
    }

    #[test]
    fn epoch_millis_become_a_plausible_year() {
        // 2024-07-01
        assert_eq!(epoch_ms_year(Some(1_719_792_000_000.0)), Some(2024));
        assert_eq!(epoch_ms_year(None), None);
    }
}
