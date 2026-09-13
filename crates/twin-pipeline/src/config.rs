//! Layered configuration: defaults <- `twin.toml` <- `TWIN_*` env <- CLI flags.
//!
//! Each layer is a tree of `Option`s; layers are folded right-to-left with
//! `or`, so a later layer only speaks where it has an opinion. The fold ends in
//! one immutable [`PipelineConfig`] that the rest of the pipeline reads.
//! Grouping into `[paths]` and `[roads]` keeps the flat top level from getting
//! clunky as stages are added.

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use twin_core::{BBox, DEFAULT_CELL_M};

/// Fairfax County, minus nothing — the independent-city holes are handled
/// downstream, not by the bbox. DESIGN.md section 1.
pub const FAIRFAX_BBOX: (f64, f64, f64, f64) = (-77.54, 38.60, -77.04, 39.06);

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct PathsLayer {
    pub raw_dir: Option<PathBuf>,
    pub out_dir: Option<PathBuf>,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct RoadsLayer {
    pub pbf: Option<PathBuf>,
    /// `w,s,e,n` in degrees.
    pub bbox: Option<String>,
    pub cell_m: Option<f64>,
    pub simplify: Option<bool>,
    pub keep_service: Option<bool>,
    /// Build an `n * n` lattice instead of reading a PBF.
    pub synthetic_grid: Option<u32>,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct ConfigLayer {
    pub paths: PathsLayer,
    pub roads: RoadsLayer,
}

impl ConfigLayer {
    pub fn defaults() -> Self {
        let (w, s, e, n) = FAIRFAX_BBOX;
        Self {
            paths: PathsLayer {
                raw_dir: Some("data/raw".into()),
                out_dir: Some("data/build".into()),
            },
            roads: RoadsLayer {
                pbf: None,
                bbox: Some(format!("{w},{s},{e},{n}")),
                cell_m: Some(DEFAULT_CELL_M),
                simplify: Some(true),
                keep_service: Some(false),
                synthetic_grid: None,
            },
        }
    }

    /// Missing file is not an error: `twin.toml` is optional.
    pub fn from_toml(path: &Path) -> Result<Self> {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Ok(Self::default());
        };
        toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))
    }

    pub fn from_env() -> Result<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let num = |k: &str| -> Result<Option<f64>> {
            var(k)
                .map(|v| v.parse().context(format!("{k} must be a number")))
                .transpose()
        };
        let flag = |k: &str| -> Result<Option<bool>> {
            var(k)
                .map(|v| v.parse().context(format!("{k} must be true/false")))
                .transpose()
        };
        Ok(Self {
            paths: PathsLayer {
                raw_dir: var("TWIN_RAW_DIR").map(PathBuf::from),
                out_dir: var("TWIN_OUT_DIR").map(PathBuf::from),
            },
            roads: RoadsLayer {
                pbf: var("TWIN_PBF").map(PathBuf::from),
                bbox: var("TWIN_BBOX"),
                cell_m: num("TWIN_CELL_M")?,
                simplify: flag("TWIN_SIMPLIFY")?,
                keep_service: flag("TWIN_KEEP_SERVICE")?,
                synthetic_grid: num("TWIN_SYNTHETIC_GRID")?.map(|v| v as u32),
            },
        })
    }

    /// `self` wins wherever it has a value; `base` fills the rest.
    pub fn over(self, base: Self) -> Self {
        Self {
            paths: PathsLayer {
                raw_dir: self.paths.raw_dir.or(base.paths.raw_dir),
                out_dir: self.paths.out_dir.or(base.paths.out_dir),
            },
            roads: RoadsLayer {
                pbf: self.roads.pbf.or(base.roads.pbf),
                bbox: self.roads.bbox.or(base.roads.bbox),
                cell_m: self.roads.cell_m.or(base.roads.cell_m),
                simplify: self.roads.simplify.or(base.roads.simplify),
                keep_service: self.roads.keep_service.or(base.roads.keep_service),
                synthetic_grid: self.roads.synthetic_grid.or(base.roads.synthetic_grid),
            },
        }
    }
}

/// The resolved, immutable configuration. Every field is present; nothing
/// downstream deals in `Option`.
#[derive(Debug, Clone)]
pub struct PipelineConfig {
    pub raw_dir: PathBuf,
    pub out_dir: PathBuf,
    pub source: RoadSource,
    pub bbox: BBox,
    pub cell_m: f64,
    pub simplify: bool,
    pub keep_service: bool,
}

/// Where the road network comes from. An ADT rather than a nullable `pbf`
/// field, so "neither given" and "both given" are unrepresentable downstream.
#[derive(Debug, Clone, PartialEq)]
pub enum RoadSource {
    Pbf(PathBuf),
    SyntheticGrid(u32),
}

impl PipelineConfig {
    /// Collapse the layer stack. Highest-priority layer first.
    pub fn resolve(layers: impl IntoIterator<Item = ConfigLayer>) -> Result<Self> {
        let merged = layers
            .into_iter()
            .fold(ConfigLayer::default(), |acc, next| acc.over(next));
        let miss = |k: &str| anyhow::anyhow!("config key `{k}` is unset and has no default");

        let source = match (&merged.roads.pbf, merged.roads.synthetic_grid) {
            (Some(_), Some(_)) => bail!("give either roads.pbf or roads.synthetic_grid, not both"),
            (Some(p), None) => RoadSource::Pbf(p.clone()),
            (None, Some(n)) if n >= 2 => RoadSource::SyntheticGrid(n),
            (None, Some(n)) => bail!("roads.synthetic_grid must be at least 2, got {n}"),
            (None, None) => bail!("set roads.pbf or roads.synthetic_grid"),
        };
        Ok(Self {
            raw_dir: merged.paths.raw_dir.ok_or_else(|| miss("paths.raw_dir"))?,
            out_dir: merged.paths.out_dir.ok_or_else(|| miss("paths.out_dir"))?,
            source,
            bbox: parse_bbox(&merged.roads.bbox.ok_or_else(|| miss("roads.bbox"))?)?,
            cell_m: merged.roads.cell_m.ok_or_else(|| miss("roads.cell_m"))?,
            simplify: merged
                .roads
                .simplify
                .ok_or_else(|| miss("roads.simplify"))?,
            keep_service: merged
                .roads
                .keep_service
                .ok_or_else(|| miss("roads.keep_service"))?,
        })
    }
}

/// `w,s,e,n` -> [`BBox`], via the bbox smart constructor.
pub fn parse_bbox(text: &str) -> Result<BBox> {
    let parts: Vec<f64> = text
        .split(',')
        .map(|p| p.trim().parse::<f64>())
        .collect::<Result<_, _>>()
        .with_context(|| format!("bbox `{text}` must be four numbers"))?;
    let [w, s, e, n] = parts[..] else {
        bail!("bbox `{text}` must be `w,s,e,n`");
    };
    BBox::new(w, s, e, n).ok_or_else(|| anyhow::anyhow!("bbox `{text}` is not a sane extent"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer_with_cell(cell_m: f64) -> ConfigLayer {
        ConfigLayer {
            roads: RoadsLayer {
                cell_m: Some(cell_m),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn later_layers_only_speak_where_they_have_a_value() {
        let cfg = PipelineConfig::resolve([
            layer_with_cell(500.0),
            ConfigLayer {
                roads: RoadsLayer {
                    synthetic_grid: Some(8),
                    ..Default::default()
                },
                ..Default::default()
            },
            ConfigLayer::defaults(),
        ])
        .expect("resolves");
        assert_eq!(cfg.cell_m, 500.0, "the top layer wins");
        assert_eq!(cfg.source, RoadSource::SyntheticGrid(8));
        assert_eq!(cfg.out_dir, PathBuf::from("data/build"), "default survives");
        assert!(cfg.simplify, "default survives");
    }

    #[test]
    fn a_source_is_required_and_exclusive() {
        assert!(PipelineConfig::resolve([ConfigLayer::defaults()]).is_err());
        let both = ConfigLayer {
            roads: RoadsLayer {
                pbf: Some("a.pbf".into()),
                synthetic_grid: Some(4),
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(PipelineConfig::resolve([both, ConfigLayer::defaults()]).is_err());
    }

    #[test]
    fn bbox_parsing_rejects_nonsense() {
        let b = parse_bbox(" -77.54, 38.60 ,-77.04,39.06").expect("parses with spaces");
        assert_eq!((b.west, b.north), (-77.54, 39.06));
        assert!(
            parse_bbox("-77,38,-78,39").is_err(),
            "west must precede east"
        );
        assert!(parse_bbox("1,2,3").is_err(), "needs four numbers");
    }

    #[test]
    fn a_missing_toml_is_not_an_error() {
        let layer = ConfigLayer::from_toml(Path::new("/nonexistent/twin.toml")).expect("silent");
        assert!(layer.roads.bbox.is_none());
    }

    #[test]
    fn the_project_toml_parses() {
        let layer = ConfigLayer::from_toml(Path::new("../../twin.toml")).expect("parses");
        assert_eq!(layer.roads.cell_m, Some(DEFAULT_CELL_M));
    }
}
