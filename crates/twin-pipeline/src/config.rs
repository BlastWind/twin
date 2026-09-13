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
pub struct DemandLayer {
    /// LODES 8 filenames, looked up in `paths.raw_dir`.
    pub od_main: Option<PathBuf>,
    pub od_aux: Option<PathBuf>,
    pub xwalk: Option<PathBuf>,
    /// External zones ringing the bbox, absorbing through traffic.
    pub external_zones: Option<u32>,
    /// Vehicle trips per LODES job: auto mode share over vehicle occupancy.
    pub auto_factor: Option<f64>,
    /// Skip LODES entirely and synthesize a gravity model.
    pub synthetic: Option<bool>,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct ConfigLayer {
    pub paths: PathsLayer,
    pub roads: RoadsLayer,
    pub demand: DemandLayer,
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
            demand: DemandLayer {
                od_main: Some("va_od_main_JT00_2023.csv.gz".into()),
                od_aux: Some("va_od_aux_JT00_2023.csv.gz".into()),
                xwalk: Some("va_xwalk.csv.gz".into()),
                external_zones: Some(12),
                // ~88 % auto mode share over ~1.1 occupants per commute
                // vehicle. DESIGN.md section 9 leaves this to calibration.
                auto_factor: Some(0.8),
                synthetic: Some(false),
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
            demand: DemandLayer {
                od_main: var("TWIN_OD_MAIN").map(PathBuf::from),
                od_aux: var("TWIN_OD_AUX").map(PathBuf::from),
                xwalk: var("TWIN_XWALK").map(PathBuf::from),
                external_zones: num("TWIN_EXTERNAL_ZONES")?.map(|v| v as u32),
                auto_factor: num("TWIN_AUTO_FACTOR")?,
                synthetic: flag("TWIN_SYNTHETIC_DEMAND")?,
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
            demand: DemandLayer {
                od_main: self.demand.od_main.or(base.demand.od_main),
                od_aux: self.demand.od_aux.or(base.demand.od_aux),
                xwalk: self.demand.xwalk.or(base.demand.xwalk),
                external_zones: self.demand.external_zones.or(base.demand.external_zones),
                auto_factor: self.demand.auto_factor.or(base.demand.auto_factor),
                synthetic: self.demand.synthetic.or(base.demand.synthetic),
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
    /// `None` when no road source was given. Only `ingest-roads` needs one, so
    /// resolving without one is not an error — asking for it is.
    source: Option<RoadSource>,
    pub bbox: BBox,
    pub cell_m: f64,
    pub simplify: bool,
    pub keep_service: bool,
    pub demand: DemandConfig,
}

/// The resolved `demand` group.
#[derive(Debug, Clone)]
pub struct DemandConfig {
    pub od_main: PathBuf,
    pub od_aux: PathBuf,
    pub xwalk: PathBuf,
    pub external_zones: u32,
    pub auto_factor: f64,
    pub synthetic: bool,
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
            (Some(p), None) => Some(RoadSource::Pbf(p.clone())),
            (None, Some(n)) if n >= 2 => Some(RoadSource::SyntheticGrid(n)),
            (None, Some(n)) => bail!("roads.synthetic_grid must be at least 2, got {n}"),
            (None, None) => None,
        };
        let d = merged.demand;
        let demand = DemandConfig {
            od_main: d.od_main.ok_or_else(|| miss("demand.od_main"))?,
            od_aux: d.od_aux.ok_or_else(|| miss("demand.od_aux"))?,
            xwalk: d.xwalk.ok_or_else(|| miss("demand.xwalk"))?,
            external_zones: d
                .external_zones
                .ok_or_else(|| miss("demand.external_zones"))?,
            auto_factor: d.auto_factor.ok_or_else(|| miss("demand.auto_factor"))?,
            synthetic: d.synthetic.ok_or_else(|| miss("demand.synthetic"))?,
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
            demand,
        })
    }

    /// The road source, or the error `ingest-roads` should print.
    pub fn road_source(&self) -> Result<&RoadSource> {
        self.source
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("set roads.pbf or roads.synthetic_grid"))
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
        assert_eq!(cfg.road_source().ok(), Some(&RoadSource::SyntheticGrid(8)));
        assert_eq!(cfg.out_dir, PathBuf::from("data/build"), "default survives");
        assert!(cfg.simplify, "default survives");
    }

    #[test]
    fn a_source_is_required_and_exclusive() {
        let no_source = PipelineConfig::resolve([ConfigLayer::defaults()]).expect("resolves");
        assert!(
            no_source.road_source().is_err(),
            "only ingest-roads needs a source, and it asks for one"
        );
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
