//! Reading what `scripts/download-data.sh` paged out of an ArcGIS
//! FeatureServer: a directory of `page_NNNNN.geojson` files.
//!
//! Pages are read one at a time and handed to a callback, so a 280 000-feature
//! layer costs one page of memory rather than a gigabyte of `serde_json::Value`.

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// One GeoJSON feature, as ArcGIS emits it. Fields we do not name are kept in
/// `properties` rather than dropped, because each layer wants different ones.
#[derive(Debug, Clone, Deserialize)]
pub struct FeatureDTO {
    #[serde(default)]
    pub properties: Map<String, Value>,
    #[serde(default)]
    pub geometry: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct PageDTO {
    #[serde(default)]
    features: Vec<FeatureDTO>,
}

impl FeatureDTO {
    /// A property as a number, whichever of the several ways ArcGIS spelled it.
    pub fn num(&self, key: &str) -> Option<f64> {
        match self.properties.get(key)? {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }
    }

    /// A property as a trimmed, non-empty string.
    pub fn text(&self, key: &str) -> Option<&str> {
        match self.properties.get(key)? {
            Value::String(s) => Some(s.trim()).filter(|s| !s.is_empty()),
            _ => None,
        }
    }

    /// The first coordinate pair anywhere in the geometry — the whole answer
    /// for a point layer, and a usable anchor for anything else.
    pub fn first_point(&self) -> Option<(f64, f64)> {
        first_pair(self.geometry.as_ref()?)
    }

    /// Every coordinate pair in the geometry, in document order.
    pub fn points(&self) -> Vec<(f64, f64)> {
        let mut out = Vec::new();
        if let Some(g) = self.geometry.as_ref().and_then(|g| g.get("coordinates")) {
            collect_pairs(g, &mut out);
        }
        out
    }
}

fn first_pair(geometry: &Value) -> Option<(f64, f64)> {
    let mut out = Vec::new();
    collect_pairs(geometry.get("coordinates")?, &mut out);
    out.first().copied()
}

fn collect_pairs(v: &Value, out: &mut Vec<(f64, f64)>) {
    let Value::Array(a) = v else { return };
    match (a.first(), a.get(1)) {
        (Some(Value::Number(x)), Some(Value::Number(y))) => {
            if let (Some(x), Some(y)) = (x.as_f64(), y.as_f64()) {
                out.push((x, y));
            }
        }
        _ => a.iter().for_each(|e| collect_pairs(e, out)),
    }
}

/// The page files of one layer, in order. Empty when the layer was not
/// downloaded, which every caller treats as "skip this dataset".
pub fn pages(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "geojson"))
        .collect();
    out.sort();
    out
}

/// Stream every feature of a layer through `f`. Returns how many there were.
pub fn for_each_feature(dir: &Path, f: impl FnMut(FeatureDTO) -> Result<()>) -> Result<usize> {
    for_each_feature_in(&[dir.to_path_buf()], f)
}

/// The same, over several page directories — a layer sharded across parallel
/// downloads is several directories of one layer.
pub fn for_each_feature_in(
    dirs: &[PathBuf],
    mut f: impl FnMut(FeatureDTO) -> Result<()>,
) -> Result<usize> {
    let mut n = 0;
    for path in dirs.iter().flat_map(|d| pages(d)) {
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let page: PageDTO =
            serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        for feature in page.features {
            f(feature)?;
            n += 1;
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feature(json: &str) -> FeatureDTO {
        serde_json::from_str(json).expect("parses")
    }

    #[test]
    fn numbers_survive_being_quoted() {
        let f = feature(r#"{"properties":{"ADT":"18500","APRTOT":250000.5,"X":null}}"#);
        assert_eq!(f.num("ADT"), Some(18500.0));
        assert_eq!(f.num("APRTOT"), Some(250000.5));
        assert_eq!(f.num("X"), None);
        assert_eq!(f.num("MISSING"), None);
    }

    #[test]
    fn coordinates_are_found_at_any_nesting_depth() {
        let point = feature(r#"{"geometry":{"type":"Point","coordinates":[-77.3,38.85]}}"#);
        assert_eq!(point.first_point(), Some((-77.3, 38.85)));
        let poly = feature(
            r#"{"geometry":{"type":"MultiPolygon","coordinates":[[[[-77.3,38.8],[-77.2,38.9]]]]}}"#,
        );
        assert_eq!(poly.points().len(), 2);
        assert_eq!(poly.first_point(), Some((-77.3, 38.8)));
        assert_eq!(feature(r#"{"properties":{}}"#).first_point(), None);
    }
}
