//! `feeds.bin` — point events (today: VDOT crashes) binned two ways: to a
//! coarse square grid for the heat layer, and to the nearest graph edge so the
//! dashboard can rank streets. DESIGN.md sections 4.5 and 5.
//!
//! Raw points are not kept here; they go into the tiles, where the renderer can
//! stream them by viewport. What the core needs is the aggregates.

use crate::ids::EdgeId;
use crate::schema::*;
use bytemuck::{Pod, Zeroable};

pub const MAGIC_FEEDS: [u8; 4] = *b"TWFD";
pub const VERSION_FEEDS: u32 = 1;

/// Side of a crash-grid cell in metres. ~250 m is a block or two: fine enough
/// to point at an intersection, coarse enough that the county fits in tens of
/// thousands of cells.
pub const CRASH_CELL_M: f64 = 250.0;

/// Severity as VDOT codes it, collapsed to the five KABCO levels. Stored as the
/// numeric level so the tiles and the core agree on one scale.
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Severity {
    PropertyDamage = 1,
    PossibleInjury = 2,
    NonVisibleInjury = 3,
    VisibleInjury = 4,
    Fatal = 5,
}

impl Severity {
    /// Smart constructor over the stored byte; unknown codes are not coerced.
    pub const fn from_u8(raw: u8) -> Option<Self> {
        match raw {
            1 => Some(Self::PropertyDamage),
            2 => Some(Self::PossibleInjury),
            3 => Some(Self::NonVisibleInjury),
            4 => Some(Self::VisibleInjury),
            5 => Some(Self::Fatal),
            _ => None,
        }
    }

    /// VDOT/TREDS `K A B C PDO` letters, which is how the open data spells it.
    pub fn from_kabco(letter: &str) -> Option<Self> {
        match letter.trim().to_ascii_uppercase().as_str() {
            "K" | "FATAL" => Some(Self::Fatal),
            "A" | "SEVERE INJURY" => Some(Self::VisibleInjury),
            "B" | "VISIBLE INJURY" => Some(Self::NonVisibleInjury),
            "C" | "NONVISIBLE INJURY" => Some(Self::PossibleInjury),
            "O" | "PDO" | "PROPERTY DAMAGE" => Some(Self::PropertyDamage),
            _ => None,
        }
    }

    pub const fn as_u8(self) -> u8 {
        self as u8
    }
}

/// Fixed part of `feeds.bin`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Zeroable, Pod)]
#[repr(C)]
pub struct FeedsMetaSchema {
    pub crash_count: u32,
    pub cell_count: u32,
    pub edge_count: u32,
    /// Cell side in metres, so a reader need not assume [`CRASH_CELL_M`].
    pub cell_m: u32,
    /// Inclusive year range the crashes cover.
    pub year_min: u32,
    pub year_max: u32,
}

/// Crashes in one grid cell. `cx`/`cy` index the crash grid, which is its own
/// grid at [`CRASH_CELL_M`], not the chunk grid.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Zeroable, Pod)]
#[repr(C)]
pub struct CrashCellSchema {
    pub cx: u32,
    pub cy: u32,
    pub count: u32,
    /// Summed [`Severity`] level; `severity_sum / count` is the mean level.
    pub severity_sum: u32,
}

/// Crashes snapped to one directed edge.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Zeroable, Pod)]
#[repr(C)]
pub struct CrashEdgeSchema {
    /// Global [`EdgeId`].
    pub edge: u32,
    pub count: u32,
    pub severity_sum: u32,
    pub fatal: u32,
}

/// Decoded `feeds.bin`.
pub struct FeedsSchema<'a> {
    pub meta: FeedsMetaSchema,
    pub cells: &'a [CrashCellSchema],
    pub edges: &'a [CrashEdgeSchema],
}

impl<'a> FeedsSchema<'a> {
    pub fn decode(bytes: &'a [u8]) -> Result<Self, SchemaError> {
        let f = FileView::parse(bytes, MAGIC_FEEDS, VERSION_FEEDS)?;
        let out = Self {
            meta: f.one(SectionKind::FeedsMeta)?,
            cells: f.section(SectionKind::CrashCells)?,
            edges: f.section(SectionKind::CrashEdges)?,
        };
        if out.cells.len() != out.meta.cell_count as usize {
            return Err(SchemaError::InconsistentLength(SectionKind::CrashCells));
        }
        if out.edges.len() != out.meta.edge_count as usize {
            return Err(SchemaError::InconsistentLength(SectionKind::CrashEdges));
        }
        Ok(out)
    }

    pub fn encode(
        meta: FeedsMetaSchema,
        cells: &[CrashCellSchema],
        edges: &[CrashEdgeSchema],
    ) -> Vec<u8> {
        FileWriter::new()
            .push_one(SectionKind::FeedsMeta, &meta)
            .push(SectionKind::CrashCells, cells)
            .push(SectionKind::CrashEdges, edges)
            .finish(MAGIC_FEEDS, VERSION_FEEDS, 0)
    }

    /// Crashes on one edge, if any were snapped to it.
    pub fn on_edge(&self, edge: EdgeId) -> Option<&CrashEdgeSchema> {
        let raw = edge.raw();
        self.edges
            .binary_search_by_key(&raw, |e| e.edge)
            .ok()
            .map(|i| &self.edges[i])
    }
}

/// One crash as the ingest stage has parsed it.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct CrashPoint {
    pub lon: f64,
    pub lat: f64,
    pub year: u16,
    pub severity: Severity,
    /// Nearest global edge id, or `None` when nothing was close enough.
    pub edge: Option<EdgeId>,
}

/// Points in, aggregates out. Pure, so the ingest stage is a thin shell around
/// a download and this is what the tests exercise.
///
/// `cell_of` maps a point to its crash-grid cell; the caller owns the grid so
/// the same function serves the tile builder.
pub fn aggregate(
    points: &[CrashPoint],
    cell_of: impl Fn(f64, f64) -> (u32, u32),
) -> (FeedsMetaSchema, Vec<CrashCellSchema>, Vec<CrashEdgeSchema>) {
    use std::collections::BTreeMap;

    let mut cells: BTreeMap<(u32, u32), (u32, u32)> = BTreeMap::new();
    let mut edges: BTreeMap<u32, (u32, u32, u32)> = BTreeMap::new();
    for p in points {
        let sev = p.severity.as_u8() as u32;
        let c = cells.entry(cell_of(p.lon, p.lat)).or_insert((0, 0));
        *c = (c.0 + 1, c.1 + sev);
        if let Some(e) = p.edge {
            let slot = edges.entry(e.raw()).or_insert((0, 0, 0));
            *slot = (
                slot.0 + 1,
                slot.1 + sev,
                slot.2 + u32::from(p.severity == Severity::Fatal),
            );
        }
    }

    let cells: Vec<CrashCellSchema> = cells
        .into_iter()
        .map(|((cx, cy), (count, severity_sum))| CrashCellSchema {
            cx,
            cy,
            count,
            severity_sum,
        })
        .collect();
    let edges: Vec<CrashEdgeSchema> = edges
        .into_iter()
        .map(|(edge, (count, severity_sum, fatal))| CrashEdgeSchema {
            edge,
            count,
            severity_sum,
            fatal,
        })
        .collect();
    let years = || points.iter().map(|p| p.year as u32);
    let meta = FeedsMetaSchema {
        crash_count: points.len() as u32,
        cell_count: cells.len() as u32,
        edge_count: edges.len() as u32,
        cell_m: CRASH_CELL_M as u32,
        year_min: years().min().unwrap_or(0),
        year_max: years().max().unwrap_or(0),
    };
    (meta, cells, edges)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crash(lon: f64, severity: Severity, edge: Option<u32>) -> CrashPoint {
        CrashPoint {
            lon,
            lat: 38.85,
            year: 2024,
            severity,
            edge: edge.and_then(EdgeId::new),
        }
    }

    #[test]
    fn binning_groups_by_cell_and_by_edge() {
        let points = [
            crash(-77.30, Severity::Fatal, Some(5)),
            crash(-77.30, Severity::PropertyDamage, Some(5)),
            crash(-77.20, Severity::VisibleInjury, None),
        ];
        // 0.05 degrees of longitude per cell puts the first two together.
        let (meta, cells, edges) =
            aggregate(&points, |lon, _| (((lon + 78.0) / 0.05).floor() as u32, 0));
        assert_eq!(meta.crash_count, 3);
        assert_eq!(cells.len(), 2);
        assert_eq!(cells[0].count, 2);
        assert_eq!(cells[0].severity_sum, 5 + 1);
        assert_eq!(
            edges.len(),
            1,
            "the unsnapped crash contributes no edge row"
        );
        assert_eq!((edges[0].edge, edges[0].count, edges[0].fatal), (5, 2, 1));
    }

    #[test]
    fn feeds_round_trip() {
        let (meta, cells, edges) = aggregate(
            &[crash(-77.3, Severity::PossibleInjury, Some(9))],
            |_, _| (3, 4),
        );
        let bytes = AlignedBytes::adopt(FeedsSchema::encode(meta, &cells, &edges));
        let f = FeedsSchema::decode(&bytes).expect("decodes");
        assert_eq!(f.meta, meta);
        assert_eq!(f.cells, cells.as_slice());
        assert_eq!(f.on_edge(EdgeId::from_index(9)).map(|e| e.count), Some(1));
        assert_eq!(f.on_edge(EdgeId::from_index(11)), None);
    }

    #[test]
    fn kabco_letters_map_onto_the_numeric_scale() {
        assert_eq!(Severity::from_kabco("K"), Some(Severity::Fatal));
        assert_eq!(Severity::from_kabco(" o "), Some(Severity::PropertyDamage));
        assert_eq!(Severity::from_kabco("Z"), None);
        assert_eq!(Severity::from_u8(5), Some(Severity::Fatal));
        assert_eq!(Severity::from_u8(9), None);
    }
}
