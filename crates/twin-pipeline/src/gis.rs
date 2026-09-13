//! `ingest-gis` — county buildings, parcels and zoning, normalised for the
//! tile build. DESIGN.md section 4.2.
//!
//! Nothing here goes into a `*.bin`: these layers are geometry the browser
//! reads out of `world.pmtiles`, so the stage's job is to rename the county's
//! fields onto the contract's, fix the units, join the two parcel tables, and
//! emit newline-delimited GeoJSON that `scripts/build-tiles.sh` feeds to
//! tippecanoe.
//!
//! Coverage is the county only. Fairfax City and Falls Church are independent
//! jurisdictions and are simply absent from these layers, which is the
//! documented MVP scope.

use crate::arcgis::{self, FeatureDTO};
use anyhow::{Context, Result};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufWriter, Write};
use std::path::Path;

/// County planimetric heights and elevations are in survey feet.
const FEET_TO_M: f64 = 0.3048;
/// Above this a "building height" is a digitising error, not a building. The
/// tallest building in the county is under 150 m.
const MAX_HEIGHT_M: f64 = 200.0;

/// What one normalised layer amounted to.
#[derive(Debug, Clone, Default)]
pub struct LayerCount {
    pub name: &'static str,
    pub features: u64,
    /// Features that kept the attribute the layer exists for (a height, an
    /// assessed value, a zone code).
    pub attributed: u64,
}

pub struct GisOutput {
    pub layers: Vec<LayerCount>,
    pub notes: Vec<String>,
}

/// Read `raw/gis/*`, write `build/gis/*.geojsonl`.
pub fn build_gis(raw_dir: &Path, out_dir: &Path) -> Result<GisOutput> {
    let src = raw_dir.join("gis");
    let dst = out_dir.join("gis");
    std::fs::create_dir_all(&dst).with_context(|| format!("creating {}", dst.display()))?;

    let mut notes = Vec::new();
    let values = parcel_values(&src.join("parcel_values"))?;
    if values.is_empty() {
        notes.push("no parcel assessed values on disk; parcels carry geometry only".into());
    }

    let layers = vec![
        normalise(
            &src.join("buildings"),
            &dst.join("buildings.geojsonl"),
            "buildings",
            building_props,
        )?,
        normalise(
            &src.join("parcels"),
            &dst.join("parcels.geojsonl"),
            "parcels",
            |f| parcel_props(f, &values),
        )?,
        normalise(
            &src.join("zoning"),
            &dst.join("zoning.geojsonl"),
            "zoning",
            zoning_props,
        )?,
    ];
    for l in &layers {
        if l.features == 0 {
            notes.push(format!(
                "{} is empty; run scripts/download-data.sh to fetch it",
                l.name
            ));
        }
    }
    Ok(GisOutput { layers, notes })
}

/// Stream one raw layer through a property mapper into newline-delimited
/// GeoJSON. `None` from the mapper drops the feature.
fn normalise(
    src: &Path,
    dst: &Path,
    name: &'static str,
    mut props: impl FnMut(&FeatureDTO) -> Option<Map<String, Value>>,
) -> Result<LayerCount> {
    let file = std::fs::File::create(dst).with_context(|| format!("writing {}", dst.display()))?;
    let mut out = BufWriter::new(file);
    let mut count = LayerCount {
        name,
        ..Default::default()
    };
    arcgis::for_each_feature(src, |f| {
        let (Some(p), Some(geometry)) = (props(&f), f.geometry.as_ref()) else {
            return Ok(());
        };
        count.features += 1;
        count.attributed += u64::from(p.values().any(|v| !v.is_null()));
        let line = json!({ "type": "Feature", "properties": p, "geometry": geometry });
        writeln!(out, "{line}")?;
        Ok(())
    })?;
    out.flush()?;
    Ok(count)
}

/// `height` in metres, from the LiDAR field when it is populated and from the
/// roof-minus-ground elevations when it is not: the 2024 planimetric batch left
/// `BLDG_HEIGHT` null on part of the county.
fn building_props(f: &FeatureDTO) -> Option<Map<String, Value>> {
    let elev_diff = || Some(f.num("TOP_ELEV")? - f.num("GROUND_ELEV")?);
    let height_m = f
        .num("BLDG_HEIGHT")
        .or_else(elev_diff)
        .map(|ft| ft * FEET_TO_M)
        .filter(|m| (1.0..=MAX_HEIGHT_M).contains(m));
    Some(
        json!({
            "height": height_m,
            "kind": f.text("TYPE"),
            "source": "fairfax-county",
        })
        .as_object()?
        .clone(),
    )
}

/// `PARID -> total assessed value`, from the tabular sibling of the parcel
/// polygons. Later tax years win, so a parcel reassessed twice reports the
/// current number.
fn parcel_values(dir: &Path) -> Result<HashMap<String, (u32, f64)>> {
    let mut out: HashMap<String, (u32, f64)> = HashMap::new();
    arcgis::for_each_feature(dir, |f| {
        let (Some(id), Some(total)) = (f.text("PARID"), f.num("APRTOT")) else {
            return Ok(());
        };
        let year = f.num("TAXYR").unwrap_or(0.0) as u32;
        let slot = out.entry(id.to_string()).or_insert((0, 0.0));
        if year >= slot.0 {
            *slot = (year, total);
        }
        Ok(())
    })?;
    Ok(out)
}

fn parcel_props(
    f: &FeatureDTO,
    values: &HashMap<String, (u32, f64)>,
) -> Option<Map<String, Value>> {
    let parcel_id = f.text("PARID")?;
    let assessed = values.get(parcel_id).map(|(_, v)| *v);
    Some(
        json!({
            "parcel_id": parcel_id,
            "zone": f.text("ZONING_DESC"),
            "land_use": f.text("LUC_DESC"),
            "assessed_value": assessed,
            "area_m2": polygon_area_m2(&f.points()).round(),
        })
        .as_object()?
        .clone(),
    )
}

fn zoning_props(f: &FeatureDTO) -> Option<Map<String, Value>> {
    let zone = f.text("ZONECODE")?;
    Some(
        json!({ "zone": zone, "category": f.text("ZONETYPE") })
            .as_object()?
            .clone(),
    )
}

/// Shoelace area of a ring, projected to a local equirectangular plane. Rings
/// after the first (holes, multipart) are ignored: parcels are simple, and a
/// few square metres either way does not change a land-use summary.
pub fn polygon_area_m2(points: &[(f64, f64)]) -> f64 {
    const M_PER_DEG_LAT: f64 = 111_320.0;
    let Some(&(_, lat0)) = points.first() else {
        return 0.0;
    };
    let k = lat0.to_radians().cos() * M_PER_DEG_LAT;
    let twice: f64 = points
        .windows(2)
        .map(|w| {
            let (a, b) = (w[0], w[1]);
            (a.0 * k) * (b.1 * M_PER_DEG_LAT) - (b.0 * k) * (a.1 * M_PER_DEG_LAT)
        })
        .sum();
    (twice / 2.0).abs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feature(json: &str) -> FeatureDTO {
        serde_json::from_str(json).expect("parses")
    }

    #[test]
    fn heights_come_from_feet_and_fall_back_to_the_elevations() {
        let direct = feature(r#"{"properties":{"BLDG_HEIGHT":32.8084,"TYPE":"SFR"}}"#);
        let h = building_props(&direct).expect("mapped")["height"]
            .as_f64()
            .expect("height");
        assert!((h - 10.0).abs() < 0.01, "32.8 ft is 10 m, got {h}");

        let fallback = feature(r#"{"properties":{"TOP_ELEV":355.3,"GROUND_ELEV":331.0}}"#);
        let h = building_props(&fallback).expect("mapped")["height"]
            .as_f64()
            .expect("height");
        assert!((h - 24.3 * FEET_TO_M).abs() < 0.05, "got {h}");

        let nonsense = feature(r#"{"properties":{"BLDG_HEIGHT":9000.0}}"#);
        assert!(building_props(&nonsense).expect("mapped")["height"].is_null());
    }

    #[test]
    fn a_parcel_joins_its_latest_assessment() {
        let values = HashMap::from([("0123 45".to_string(), (2025u32, 812_000.0f64))]);
        let f = feature(
            r#"{"properties":{"PARID":"0123 45","LUC_DESC":"Single Family","ZONING_DESC":"R-3"},
                "geometry":{"type":"Polygon","coordinates":[[[-77.30,38.85],[-77.2990,38.85],[-77.2990,38.8509],[-77.30,38.8509],[-77.30,38.85]]]}}"#,
        );
        let p = parcel_props(&f, &values).expect("mapped");
        assert_eq!(p["assessed_value"], json!(812_000.0));
        assert_eq!(p["zone"], json!("R-3"));
        let area = p["area_m2"].as_f64().expect("area");
        assert!((area - 8700.0).abs() < 400.0, "got {area} m2");
    }

    #[test]
    fn a_parcel_with_no_assessment_still_gets_a_row() {
        let f = feature(r#"{"properties":{"PARID":"9 9"}}"#);
        let p = parcel_props(&f, &HashMap::new()).expect("mapped");
        assert!(p["assessed_value"].is_null());
        assert!(parcel_props(&feature(r#"{"properties":{}}"#), &HashMap::new()).is_none());
    }
}
