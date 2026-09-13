//! Fixed spatial grid over the study bbox.
//!
//! Cells are ~2 km on a side. The grid is stored verbatim in `graph/index.bin`,
//! so [`GridSchema`] is both the on-disk record and the in-memory type: there is
//! no second "domain" copy to keep in sync.

use crate::ids::ChunkId;
use bytemuck::{Pod, Zeroable};

/// Metres per degree of latitude (spherical earth, good to ~0.5 %).
const M_PER_DEG_LAT: f64 = 111_320.0;

/// Default cell size in metres, per DESIGN.md section 4.
pub const DEFAULT_CELL_M: f64 = 2000.0;

/// Geographic bounding box in degrees, `(west, south, east, north)`.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct BBox {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

impl BBox {
    /// Smart constructor: rejects inverted or degenerate boxes and anything off
    /// the globe.
    pub fn new(west: f64, south: f64, east: f64, north: f64) -> Option<Self> {
        let sane = west < east
            && south < north
            && (-180.0..=180.0).contains(&west)
            && (-180.0..=180.0).contains(&east)
            && (-90.0..=90.0).contains(&south)
            && (-90.0..=90.0).contains(&north);
        sane.then_some(Self {
            west,
            south,
            east,
            north,
        })
    }

    #[inline]
    pub fn contains(&self, lon: f64, lat: f64) -> bool {
        (self.west..=self.east).contains(&lon) && (self.south..=self.north).contains(&lat)
    }

    #[inline]
    pub fn mid_lat(&self) -> f64 {
        0.5 * (self.south + self.north)
    }
}

/// On-disk grid descriptor. Also the runtime grid type.
#[derive(Copy, Clone, Debug, PartialEq, Zeroable, Pod)]
#[repr(C)]
pub struct GridSchema {
    pub min_lon: f64,
    pub min_lat: f64,
    pub max_lon: f64,
    pub max_lat: f64,
    pub cell_lon_deg: f64,
    pub cell_lat_deg: f64,
    pub cols: u32,
    pub rows: u32,
}

impl GridSchema {
    /// Build a grid of roughly `cell_m`-square cells covering `bbox`.
    ///
    /// Cell width in degrees is computed at the bbox mid-latitude, so cells are
    /// near-square in metres across a county-sized extent.
    pub fn cover(bbox: BBox, cell_m: f64) -> Self {
        let cell_lat_deg = cell_m / M_PER_DEG_LAT;
        let cell_lon_deg = cell_m / (M_PER_DEG_LAT * bbox.mid_lat().to_radians().cos().abs());
        let cols = (((bbox.east - bbox.west) / cell_lon_deg).ceil() as u32).max(1);
        let rows = (((bbox.north - bbox.south) / cell_lat_deg).ceil() as u32).max(1);
        Self {
            min_lon: bbox.west,
            min_lat: bbox.south,
            max_lon: bbox.east,
            max_lat: bbox.north,
            cell_lon_deg,
            cell_lat_deg,
            cols,
            rows,
        }
    }

    #[inline]
    pub fn bbox(&self) -> BBox {
        BBox {
            west: self.min_lon,
            south: self.min_lat,
            east: self.max_lon,
            north: self.max_lat,
        }
    }

    #[inline]
    pub fn cell_count(&self) -> u32 {
        self.cols * self.rows
    }

    /// Cell column/row for a coordinate, clamped into the grid.
    #[inline]
    pub fn cell_xy(&self, lon: f64, lat: f64) -> (u32, u32) {
        let cx = ((lon - self.min_lon) / self.cell_lon_deg).floor();
        let cy = ((lat - self.min_lat) / self.cell_lat_deg).floor();
        (
            (cx.max(0.0) as u32).min(self.cols - 1),
            (cy.max(0.0) as u32).min(self.rows - 1),
        )
    }

    #[inline]
    pub fn chunk_at(&self, lon: f64, lat: f64) -> ChunkId {
        let (cx, cy) = self.cell_xy(lon, lat);
        self.chunk_of_xy(cx, cy)
    }

    #[inline]
    pub fn chunk_of_xy(&self, cx: u32, cy: u32) -> ChunkId {
        ChunkId::from_index(cy * self.cols + cx)
    }

    #[inline]
    pub fn xy_of_chunk(&self, id: ChunkId) -> (u32, u32) {
        (id.raw() % self.cols, id.raw() / self.cols)
    }
}

/// Great-circle-ish distance in metres between two lon/lat pairs
/// (equirectangular approximation; exact enough for edge lengths < 1 km).
#[inline]
pub fn haversine_m(lon_a: f64, lat_a: f64, lon_b: f64, lat_b: f64) -> f64 {
    let mid = 0.5 * (lat_a + lat_b);
    let dx = (lon_b - lon_a) * M_PER_DEG_LAT * mid.to_radians().cos();
    let dy = (lat_b - lat_a) * M_PER_DEG_LAT;
    (dx * dx + dy * dy).sqrt()
}
