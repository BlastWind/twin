//! LiDAR chunk files: the manifest entry, and the decoder that pins the format.
//!
//! The chunks themselves are written by `scripts/lidar/build.py`, because the
//! EPT and orthoimagery clients live in Python. This module owns the Rust half
//! of the contract: the section numbering, a zero-copy view over one chunk, and
//! a test that decodes a file the script produced. Nothing here writes points.

use crate::manifest::{FileDTO, ManifestDTO};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use twin_core::schema::{FileHeaderSchema, SectionSchema, SECTION_ALIGN};

pub const MAGIC_LIDAR: [u8; 4] = *b"TWLD";
pub const VERSION_LIDAR: u32 = 1;

/// Section discriminants, in the >= 90 block reserved for lidar by the Phase 4
/// contract. They sit outside `twin_core::SectionKind` on purpose: no other
/// stage reads these files.
pub const KIND_XYZ: u32 = 90;
pub const KIND_RGB: u32 = 91;
pub const KIND_CLASS: u32 = 92;

/// `data/build/lidar/index.json`, the sidecar the script writes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LidarIndexDTO {
    pub version: u32,
    pub magic: String,
    pub pts_per_m2: f64,
    pub height_ref: String,
    pub source: LidarSourceDTO,
    pub totals: LidarTotalsDTO,
    pub chunks: BTreeMap<String, LidarChunkDTO>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LidarSourceDTO {
    pub ept_resource: String,
    pub imagery: String,
    pub license: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct LidarTotalsDTO {
    pub chunks: u64,
    pub points: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LidarChunkDTO {
    pub id: u32,
    pub file: String,
    pub bytes: u64,
    pub points: u64,
    pub ground_min: Option<f32>,
}

/// The `lidar` block of `manifest.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LidarInfoDTO {
    pub schema: u32,
    pub chunk_count: u64,
    pub point_count: u64,
    pub pts_per_m2: f64,
    pub ept_resource: String,
    pub imagery: String,
    pub license: String,
    pub height_ref: String,
}

impl From<&LidarIndexDTO> for LidarInfoDTO {
    fn from(i: &LidarIndexDTO) -> Self {
        Self {
            schema: VERSION_LIDAR,
            chunk_count: i.totals.chunks,
            point_count: i.totals.points,
            pts_per_m2: i.pts_per_m2,
            ept_resource: i.source.ept_resource.clone(),
            imagery: i.source.imagery.clone(),
            license: i.source.license.clone(),
            height_ref: i.height_ref.clone(),
        }
    }
}

/// Fold an existing `lidar/index.json` into the manifest. Pure apart from the
/// reads; the caller writes the manifest back.
pub fn attach(manifest: &mut ManifestDTO, build_dir: &Path) -> Result<LidarIndexDTO> {
    let path = build_dir.join("lidar/index.json");
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("reading {} — run scripts/lidar/build.py first", path.display()))?;
    let index: LidarIndexDTO = serde_json::from_str(&text)?;

    let mut rows = vec![FileDTO::of(
        "lidar/index.json",
        text.as_bytes(),
    )];
    for chunk in index.chunks.values() {
        let bytes = std::fs::read(build_dir.join(&chunk.file))
            .with_context(|| format!("reading {}", chunk.file))?;
        rows.push(FileDTO::of(chunk.file.clone(), &bytes));
    }
    manifest.upsert_files(rows);
    manifest.lidar = Some(LidarInfoDTO::from(&index));
    Ok(index)
}

/// Why a chunk failed to decode. Separate from `twin_core::SchemaError`
/// because the lidar sections are numbered outside `SectionKind`.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LidarError {
    #[error("buffer is not {SECTION_ALIGN}-byte aligned; wrap it in AlignedBytes")]
    Misaligned,
    #[error("buffer too short: need {need} bytes, have {have}")]
    Truncated { need: usize, have: usize },
    #[error("bad magic: expected {expected:?}, found {found:?}")]
    BadMagic { expected: [u8; 4], found: [u8; 4] },
    #[error("schema version {found} is not supported (expected {expected})")]
    BadVersion { expected: u32, found: u32 },
    #[error("missing section {0}")]
    MissingSection(u32),
    #[error("sections disagree on the point count")]
    InconsistentLength,
}

/// A decoded chunk: three borrowed slices over the caller's aligned bytes.
#[derive(Debug)]
pub struct LidarChunkView<'a> {
    /// Interleaved `(lon, lat, height_m)`, so `xyz.len() == 3 * points`.
    pub xyz: &'a [f32],
    pub rgb: &'a [u8],
    pub class: &'a [u8],
}

impl<'a> LidarChunkView<'a> {
    pub fn points(&self) -> usize {
        self.class.len()
    }

    pub fn parse(bytes: &'a [u8]) -> Result<Self, LidarError> {
        if !(bytes.as_ptr() as usize).is_multiple_of(SECTION_ALIGN) {
            return Err(LidarError::Misaligned);
        }
        let head_len = size_of::<FileHeaderSchema>();
        let head = bytes.get(..head_len).ok_or(LidarError::Truncated {
            need: head_len,
            have: bytes.len(),
        })?;
        let header: FileHeaderSchema = *bytemuck::from_bytes(head);
        if header.magic != MAGIC_LIDAR {
            return Err(LidarError::BadMagic {
                expected: MAGIC_LIDAR,
                found: header.magic,
            });
        }
        if header.version != VERSION_LIDAR {
            return Err(LidarError::BadVersion {
                expected: VERSION_LIDAR,
                found: header.version,
            });
        }
        let table_end = head_len + header.count as usize * size_of::<SectionSchema>();
        let table: &[SectionSchema] = bytemuck::cast_slice(bytes.get(head_len..table_end).ok_or(
            LidarError::Truncated {
                need: table_end,
                have: bytes.len(),
            },
        )?);

        let payload = |kind: u32, elem: usize| -> Result<&'a [u8], LidarError> {
            let entry = table
                .iter()
                .find(|s| s.kind == kind)
                .ok_or(LidarError::MissingSection(kind))?;
            let start = entry.offset as usize;
            let end = start + entry.len as usize * elem;
            bytes.get(start..end).ok_or(LidarError::Truncated {
                need: end,
                have: bytes.len(),
            })
        };

        let xyz: &[f32] =
            bytemuck::try_cast_slice(payload(KIND_XYZ, 4)?).map_err(|_| LidarError::Misaligned)?;
        let rgb = payload(KIND_RGB, 1)?;
        let class = payload(KIND_CLASS, 1)?;
        if xyz.len() != class.len() * 3 || rgb.len() != class.len() * 3 {
            return Err(LidarError::InconsistentLength);
        }
        Ok(Self { xyz, rgb, class })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use twin_core::schema::AlignedBytes;

    /// Decodes a chunk the Python encoder produced. Skips when the build has
    /// not been run — the point cloud is far too large to commit.
    #[test]
    fn decodes_a_produced_chunk() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/build/lidar");
        let Some(path) = std::fs::read_dir(&dir).ok().and_then(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .find(|p| {
                    p.extension().is_some_and(|e| e == "bin")
                        && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("chunk_"))
                })
        }) else {
            eprintln!("no lidar chunk in {}; skipping", dir.display());
            return;
        };

        let bytes = AlignedBytes::from_slice(&std::fs::read(&path).unwrap());
        let view = LidarChunkView::parse(&bytes).unwrap();
        assert!(view.points() > 0, "{} is empty", path.display());

        let (lon, lat, h) = (view.xyz[0], view.xyz[1], view.xyz[2]);
        assert!((-77.6..-77.0).contains(&lon), "lon {lon} outside the county");
        assert!((38.5..39.1).contains(&lat), "lat {lat} outside the county");
        assert!((-100.0..1000.0).contains(&h), "height {h} m is not plausible");
        assert!(
            view.class.iter().all(|c| matches!(c, 2 | 3 | 4 | 5 | 6)),
            "unexpected classification survived the filter"
        );
    }
}
