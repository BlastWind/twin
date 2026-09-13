//! `manifest.json` — the one JSON file the browser reads. Everything else is
//! binary, so this stays small and is the single place schema versions, byte
//! sizes and content hashes are pinned.

use serde::Serialize;
use twin_core::schema::{VERSION_CHUNK, VERSION_INDEX};
use twin_core::{BBox, GridSchema};

#[derive(Debug, Clone, Serialize)]
pub struct ManifestDTO {
    pub manifest_version: u32,
    pub schema: SchemaVersionsDTO,
    pub bbox: [f64; 4],
    pub grid: GridDTO,
    pub counts: CountsDTO,
    pub stages: Vec<StageDTO>,
    pub files: Vec<FileDTO>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SchemaVersionsDTO {
    pub index: u32,
    pub chunk: u32,
}

impl Default for SchemaVersionsDTO {
    fn default() -> Self {
        Self {
            index: VERSION_INDEX,
            chunk: VERSION_CHUNK,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct CountsDTO {
    pub nodes: u64,
    pub edges: u64,
    pub chunks: u64,
    /// Directed edges with endpoints in two different cells; each is written
    /// into both chunk files.
    pub border_edges: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StageDTO {
    pub name: String,
    pub ms: u128,
}

#[derive(Debug, Clone, Serialize)]
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
