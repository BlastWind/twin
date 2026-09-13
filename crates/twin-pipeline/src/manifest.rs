//! `manifest.json` — the one JSON file the browser reads. Everything else is
//! binary, so this stays small and is the single place schema versions, byte
//! sizes and content hashes are pinned.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use twin_core::counts::VERSION_COUNTS;
use twin_core::feeds::VERSION_FEEDS;
use twin_core::schema::{VERSION_CCH_ORDER, VERSION_CHUNK, VERSION_DEMAND, VERSION_INDEX};
use twin_core::transit::VERSION_TRANSIT;
use twin_core::{BBox, GridSchema};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestDTO {
    pub manifest_version: u32,
    pub schema: SchemaVersionsDTO,
    pub bbox: [f64; 4],
    pub grid: GridDTO,
    pub counts: CountsDTO,
    pub stages: Vec<StageDTO>,
    pub files: Vec<FileDTO>,
    /// Present once the `demand` stage has run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demand: Option<DemandInfoDTO>,
    /// Present once the `cch-order` stage has run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cch_order: Option<CchOrderInfoDTO>,
    /// Present once `ingest-gis` has run. Tile inputs, not a binary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gis: Option<GisInfoDTO>,
    /// Present once `ingest-gtfs` has run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transit: Option<TransitInfoDTO>,
    /// Present once `ingest-counts` has run. Named apart from `counts`, which
    /// is the graph's own node/edge tally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traffic_counts: Option<CountsInfoDTO>,
    /// Present once `ingest-crashes` has run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feeds: Option<FeedsInfoDTO>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GisInfoDTO {
    pub layers: Vec<GisLayerDTO>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GisLayerDTO {
    pub name: String,
    pub features: u64,
    /// Features carrying the attribute the layer exists for.
    pub attributed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransitInfoDTO {
    pub stop_count: u32,
    pub pattern_count: u32,
    /// The feeds actually folded in; WMATA is absent without a key.
    pub agencies: Vec<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CountsInfoDTO {
    pub station_count: u32,
    /// Stations that found an edge to snap to.
    pub snapped: u32,
    pub year: u32,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedsInfoDTO {
    pub crash_count: u32,
    pub cell_count: u32,
    pub edge_count: u32,
    pub year_min: u32,
    pub year_max: u32,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DemandInfoDTO {
    pub zone_count: u32,
    /// First external zone; zones below it are census block groups.
    pub external_zone_start: u32,
    pub od_count: u32,
    /// True when no LODES data was read and the flows are a gravity model.
    pub is_synthetic: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CchOrderInfoDTO {
    pub node_count: u32,
    pub kind: String,
}

impl ManifestDTO {
    /// Read the manifest a previous stage wrote, so a later stage adds to it
    /// instead of clobbering it.
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading {} — run `ingest-roads` first", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
    }

    pub fn write(&self, path: &Path) -> Result<()> {
        std::fs::write(path, serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("writing {}", path.display()))
    }

    /// Replace the rows for the files this stage rewrote, keeping the rest.
    pub fn upsert_files(&mut self, rows: Vec<FileDTO>) {
        for row in rows {
            match self.files.iter_mut().find(|f| f.path == row.path) {
                Some(slot) => *slot = row,
                None => self.files.push(row),
            }
        }
        self.files.sort_by(|a, b| a.path.cmp(&b.path));
    }

    /// Same, for the stage timing log.
    pub fn upsert_stages(&mut self, rows: Vec<StageDTO>) {
        for row in rows {
            match self.stages.iter_mut().find(|s| s.name == row.name) {
                Some(slot) => *slot = row,
                None => self.stages.push(row),
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaVersionsDTO {
    pub index: u32,
    pub chunk: u32,
    pub demand: u32,
    pub cch_order: u32,
    pub transit: u32,
    pub counts: u32,
    pub feeds: u32,
}

impl Default for SchemaVersionsDTO {
    fn default() -> Self {
        Self {
            index: VERSION_INDEX,
            chunk: VERSION_CHUNK,
            demand: VERSION_DEMAND,
            cch_order: VERSION_CCH_ORDER,
            transit: VERSION_TRANSIT,
            counts: VERSION_COUNTS,
            feeds: VERSION_FEEDS,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridDTO {
    pub cols: u32,
    pub rows: u32,
    pub cell_lon_deg: f64,
    pub cell_lat_deg: f64,
    pub min_lon: f64,
    pub min_lat: f64,
}

impl From<&GridSchema> for GridDTO {
    fn from(g: &GridSchema) -> Self {
        Self {
            cols: g.cols,
            rows: g.rows,
            cell_lon_deg: g.cell_lon_deg,
            cell_lat_deg: g.cell_lat_deg,
            min_lon: g.min_lon,
            min_lat: g.min_lat,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct CountsDTO {
    pub nodes: u64,
    pub edges: u64,
    pub chunks: u64,
    /// Directed edges with endpoints in two different cells; each is written
    /// into both chunk files.
    pub border_edges: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageDTO {
    pub name: String,
    pub ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDTO {
    /// Path relative to the build directory, forward-slashed.
    pub path: String,
    pub bytes: u64,
    /// blake3, hex. The web `AssetLoader` keys its cache on this.
    pub hash: String,
}

impl FileDTO {
    pub fn of(path: impl Into<String>, bytes: &[u8]) -> Self {
        Self {
            path: path.into(),
            bytes: bytes.len() as u64,
            hash: blake3::hash(bytes).to_hex().to_string(),
        }
    }
}

pub fn bbox_array(b: &BBox) -> [f64; 4] {
    [b.west, b.south, b.east, b.north]
}
