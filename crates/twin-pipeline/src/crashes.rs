//! `ingest-crashes` — VDOT TREDS crash points for the county bbox, binned to a
//! ~250 m grid and to the nearest graph edge. DESIGN.md section 4.5.

use crate::arcgis::{self, FeatureDTO};
use crate::graph_io::LoadedGraph;
use crate::snap::EdgeIndex;
use anyhow::Result;
use serde_json::json;
use std::io::{BufWriter, Write};
use std::path::Path;
use twin_core::feeds::{aggregate, CrashPoint, FeedsSchema, Severity, CRASH_CELL_M};
use twin_core::{BBox, EdgeId, GridSchema};

/// A crash more than this from any modelled edge is still counted in the grid,
/// but is not blamed on a street.
const MAX_SNAP_M: f64 = 120.0;

pub struct CrashesOutput {
    pub bytes: Vec<u8>,
    /// Point features for the `crashes` tile layer.
    pub points_geojsonl: String,
    /// Cell-centre features for the `crash_grid` tile layer.
    pub grid_geojsonl: String,
    pub crash_count: u32,
    pub cell_count: u32,
    pub edge_count: u32,
    pub years: (u32, u32),
    pub notes: Vec<String>,
}

pub fn build_crashes(
    raw_dir: &Path,
    loaded: &mut LoadedGraph,
    bbox: BBox,
    chunk_grid: GridSchema,
) -> Result<CrashesOutput> {
    let dir = raw_dir.join("gis").join("crashes");
    // The crash grid is its own, finer grid; the chunk grid only indexes the
    // edge search.
    let crash_grid = GridSchema::cover(bbox, CRASH_CELL_M);
    let index = EdgeIndex::new(loaded.graph.view(), chunk_grid);

    let mut points: Vec<CrashPoint> = Vec::new();
    let mut geo = BufWriter::new(Vec::new());
    arcgis::for_each_feature(&dir, |f| {
        let Some((lon, lat)) = crash_lonlat(&f) else {
            return Ok(());
        };
        if !bbox.contains(lon, lat) {
            return Ok(());
        }
        let Some(severity) = crash_severity(&f) else {
            return Ok(());
        };
        let year = f.num("CRASH_YEAR").unwrap_or(0.0) as u16;
        let edge = index
            .nearest_within(lon, lat, MAX_SNAP_M)
            .and_then(|(dense, _)| EdgeId::new(index.view.edges()[dense as usize].id.raw()));
        points.push(CrashPoint {
            lon,
            lat,
            year,
            severity,
            edge,
        });
        let line = json!({
            "type": "Feature",
            "properties": { "year": year, "severity": severity.as_u8() },
            "geometry": { "type": "Point", "coordinates": [lon, lat] },
        });
        writeln!(geo, "{line}")?;
        Ok(())
    })?;

    let (meta, cells, edges) = aggregate(&points, |lon, lat| crash_grid.cell_xy(lon, lat));
    let grid_geojsonl = cells
        .iter()
        .map(|c| {
            let lon = crash_grid.min_lon + (c.cx as f64 + 0.5) * crash_grid.cell_lon_deg;
            let lat = crash_grid.min_lat + (c.cy as f64 + 0.5) * crash_grid.cell_lat_deg;
            let line = json!({
                "type": "Feature",
                "properties": {
                    "count": c.count,
                    "mean_severity": c.severity_sum as f64 / c.count.max(1) as f64,
                },
                "geometry": { "type": "Point", "coordinates": [lon, lat] },
            });
            format!("{line}\n")
        })
        .collect();

    let mut notes = Vec::new();
    if points.is_empty() {
        notes.push("no crash pages on disk; run scripts/download-data.sh".into());
    }
    let unsnapped = points.iter().filter(|p| p.edge.is_none()).count();
    if unsnapped > 0 {
        notes.push(format!(
            "{unsnapped} of {} crashes found no edge within {MAX_SNAP_M:.0} m; they are in the grid but on no street",
            points.len()
        ));
    }
    Ok(CrashesOutput {
        bytes: FeedsSchema::encode(meta, &cells, &edges),
        points_geojsonl: String::from_utf8(geo.into_inner()?).unwrap_or_default(),
        grid_geojsonl,
        crash_count: meta.crash_count,
        cell_count: meta.cell_count,
        edge_count: meta.edge_count,
        years: (meta.year_min, meta.year_max),
        notes,
    })
}

/// TREDS carries the position twice: in the geometry and in `LAT`/`LON`. Some
/// rows have one and not the other.
fn crash_lonlat(f: &FeatureDTO) -> Option<(f64, f64)> {
    f.first_point().or_else(|| {
        let (lon, lat) = (f.num("LON")?, f.num("LAT")?);
        (lon != 0.0 && lat != 0.0).then_some((lon, lat))
    })
}

/// `CRASH_SEVERITY` comes through as a KABCO letter, a coded string like
/// `3: Visible Injury`, or a bare number, depending on the vintage.
fn crash_severity(f: &FeatureDTO) -> Option<Severity> {
    if let Some(n) = f.num("CRASH_SEVERITY") {
        return Severity::from_u8(n as u8);
    }
    let text = f.text("CRASH_SEVERITY")?;
    let head = text.split(':').next().unwrap_or(text).trim();
    Severity::from_u8(head.parse().unwrap_or(0)).or_else(|| Severity::from_kabco(head))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feature(json: &str) -> FeatureDTO {
        serde_json::from_str(json).expect("parses")
    }

    #[test]
    fn severity_survives_all_three_spellings() {
        assert_eq!(
            crash_severity(&feature(r#"{"properties":{"CRASH_SEVERITY":5}}"#)),
            Some(Severity::Fatal)
        );
        assert_eq!(
            crash_severity(&feature(r#"{"properties":{"CRASH_SEVERITY":"K"}}"#)),
            Some(Severity::Fatal)
        );
        assert_eq!(
            crash_severity(&feature(
                r#"{"properties":{"CRASH_SEVERITY":"3: Visible Injury"}}"#
            )),
            Some(Severity::NonVisibleInjury)
        );
        assert_eq!(
            crash_severity(&feature(r#"{"properties":{"CRASH_SEVERITY":"unknown"}}"#)),
            None
        );
    }

    #[test]
    fn a_position_is_taken_from_whichever_field_has_one() {
        let geom = feature(r#"{"geometry":{"type":"Point","coordinates":[-77.3,38.85]}}"#);
        assert_eq!(crash_lonlat(&geom), Some((-77.3, 38.85)));
        let cols = feature(r#"{"properties":{"LON":-77.2,"LAT":38.9}}"#);
        assert_eq!(crash_lonlat(&cols), Some((-77.2, 38.9)));
        let nulls = feature(r#"{"properties":{"LON":0,"LAT":0}}"#);
        assert_eq!(crash_lonlat(&nulls), None);
    }
}
