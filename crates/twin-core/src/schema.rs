//! Binary file layouts (`*Schema`) per DESIGN.md section 5.
//!
//! Every file is
//!
//! ```text
//! [FileHeaderSchema : 16 bytes]
//! [SectionSchema    : 24 bytes] * header.count
//! [section payloads : each 8-byte aligned, struct-of-arrays]
//! ```
//!
//! Decoding is zero-copy: a decoded value is a bundle of `&[T]` slices borrowed
//! from the caller's byte buffer. Encoding is a pure function from slices to a
//! fresh `Vec<u8>`; nothing here touches the filesystem.

use bytemuck::{Pod, Zeroable};
use std::ops::Deref;

/// Every section payload starts on this boundary, so an 8-aligned buffer makes
/// every `&[T]` view well-aligned.
pub const SECTION_ALIGN: usize = 8;

pub const MAGIC_INDEX: [u8; 4] = *b"TWIX";
pub const MAGIC_CHUNK: [u8; 4] = *b"TWCH";
pub const MAGIC_DEMAND: [u8; 4] = *b"TWDM";
pub const MAGIC_CCH_ORDER: [u8; 4] = *b"TWCO";

/// Breaking-change counter. Bumping either invalidates existing build output;
/// `manifest.json` pins both and the app refuses a mismatch.
pub const VERSION_INDEX: u32 = 1;
pub const VERSION_CHUNK: u32 = 2;
pub const VERSION_DEMAND: u32 = 1;
pub const VERSION_CCH_ORDER: u32 = 1;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SchemaError {
    #[error("buffer too short: need {need} bytes, have {have}")]
    Truncated { need: usize, have: usize },
    #[error("bad magic: expected {expected:?}, found {found:?}")]
    BadMagic { expected: [u8; 4], found: [u8; 4] },
    #[error("schema version {found} is not supported (expected {expected})")]
    BadVersion { expected: u32, found: u32 },
    #[error("missing section {0:?}")]
    MissingSection(SectionKind),
    #[error("section {kind:?} has element size {found}, expected {expected}")]
    BadElemSize {
        kind: SectionKind,
        expected: usize,
        found: u32,
    },
    #[error("buffer is not {SECTION_ALIGN}-byte aligned; wrap it in AlignedBytes")]
    Misaligned,
    #[error("section {0:?} has an inconsistent length")]
    InconsistentLength(SectionKind),
}

type Result<T> = std::result::Result<T, SchemaError>;

/// A byte buffer guaranteed to start on a [`SECTION_ALIGN`] boundary, which is
/// what makes the `&[T]` views in a decoded schema legal.
///
/// The one copy happens here, at load time, not in the hot decode path.
pub struct AlignedBytes {
    words: Vec<u64>,
    len: usize,
}

impl AlignedBytes {
    pub fn from_slice(bytes: &[u8]) -> Self {
        let mut words = vec![0u64; bytes.len().div_ceil(8)];
        bytemuck::cast_slice_mut::<u64, u8>(&mut words)[..bytes.len()].copy_from_slice(bytes);
        Self {
            words,
            len: bytes.len(),
        }
    }

    /// Reuse the allocation when it already happens to be aligned; otherwise
    /// copy. Cheap enough to call on every transferred browser buffer.
    pub fn adopt(bytes: Vec<u8>) -> Self {
        Self::from_slice(&bytes)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &bytemuck::cast_slice::<u64, u8>(&self.words)[..self.len]
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl Deref for AlignedBytes {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        self.as_bytes()
    }
}

/// 16-byte file header.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Zeroable, Pod)]
#[repr(C)]
pub struct FileHeaderSchema {
    pub magic: [u8; 4],
    pub version: u32,
    pub flags: u32,
    /// Number of [`SectionSchema`] entries that follow.
    pub count: u32,
}

/// One 24-byte entry of the section table.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Zeroable, Pod)]
#[repr(C)]
pub struct SectionSchema {
    pub kind: u32,
    pub elem_size: u32,
    /// Element count, not byte count.
    pub len: u32,
    pub _pad: u32,
    pub offset: u64,
}

/// Section discriminants. Stable across versions: append, never renumber.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum SectionKind {
    Grid = 1,
    ChunkTable = 2,
    ChunkMeta = 10,
    NodeLonLat = 11,
    NodeGid = 12,
    NodeChunk = 13,
    EdgeFrom = 20,
    EdgeTo = 21,
    EdgeGid = 22,
    EdgeLenM = 23,
    EdgeFfSpeedKph = 24,
    EdgeCapacityVph = 25,
    EdgeLanes = 26,
    EdgeClass = 27,
    EdgeGeomOffsets = 28,
    EdgeGeomLonLat = 29,
    OutOffsets = 30,
    OutEdges = 31,
    DemandMeta = 40,
    ZoneNode = 41,
    ZoneLonLat = 42,
    OdTriples = 43,
    HourProfile = 44,
    CchOrderMeta = 50,
    CchOrderRank = 51,
    TransitMeta = 60,
    StopNode = 61,
    StopLonLat = 62,
    PatternTable = 63,
    PatternStops = 64,
    PatternHopS = 65,
    PatternHeadwayS = 66,
    CountsMeta = 70,
    CountStations = 71,
    FeedsMeta = 80,
    CrashCells = 81,
    CrashEdges = 82,
}

/// A borrowed, decoded file: the header plus the section table, over the
/// caller's bytes.
pub struct FileView<'a> {
    pub header: FileHeaderSchema,
    table: &'a [SectionSchema],
    bytes: &'a [u8],
}

impl<'a> FileView<'a> {
    pub fn parse(bytes: &'a [u8], magic: [u8; 4], version: u32) -> Result<Self> {
        if !(bytes.as_ptr() as usize).is_multiple_of(SECTION_ALIGN) {
            return Err(SchemaError::Misaligned);
        }
        let head_len = size_of::<FileHeaderSchema>();
        if bytes.len() < head_len {
            return Err(SchemaError::Truncated {
                need: head_len,
                have: bytes.len(),
            });
        }
        let header: FileHeaderSchema = *bytemuck::from_bytes(&bytes[..head_len]);
        if header.magic != magic {
            return Err(SchemaError::BadMagic {
                expected: magic,
                found: header.magic,
            });
        }
        if header.version != version {
            return Err(SchemaError::BadVersion {
                expected: version,
                found: header.version,
            });
        }
        let table_end = head_len + header.count as usize * size_of::<SectionSchema>();
        if bytes.len() < table_end {
            return Err(SchemaError::Truncated {
                need: table_end,
                have: bytes.len(),
            });
        }
        let table = bytemuck::cast_slice(&bytes[head_len..table_end]);
        Ok(Self {
            header,
            table,
            bytes,
        })
    }

    /// Borrow one section as a typed slice. No copy, no parse.
    pub fn section<T: Pod>(&self, kind: SectionKind) -> Result<&'a [T]> {
        let entry = self
            .table
            .iter()
            .find(|s| s.kind == kind as u32)
            .ok_or(SchemaError::MissingSection(kind))?;
        if entry.elem_size as usize != size_of::<T>() {
            return Err(SchemaError::BadElemSize {
                kind,
                expected: size_of::<T>(),
                found: entry.elem_size,
            });
        }
        let start = entry.offset as usize;
        let end = start + entry.len as usize * size_of::<T>();
        if self.bytes.len() < end {
            return Err(SchemaError::Truncated {
                need: end,
                have: self.bytes.len(),
            });
        }
        bytemuck::try_cast_slice(&self.bytes[start..end]).map_err(|_| SchemaError::Misaligned)
    }

    pub fn one<T: Pod>(&self, kind: SectionKind) -> Result<T> {
        self.section::<T>(kind)?
            .first()
            .copied()
            .ok_or(SchemaError::InconsistentLength(kind))
    }
}

/// Accumulates sections, then lays out a whole file. Pure: in slices, out bytes.
#[derive(Default)]
pub struct FileWriter {
    sections: Vec<(SectionKind, u32, u32, Vec<u8>)>,
}

impl FileWriter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push<T: Pod>(mut self, kind: SectionKind, values: &[T]) -> Self {
        self.sections.push((
            kind,
            size_of::<T>() as u32,
            values.len() as u32,
            bytemuck::cast_slice(values).to_vec(),
        ));
        self
    }

    pub fn push_one<T: Pod>(self, kind: SectionKind, value: &T) -> Self {
        self.push(kind, std::slice::from_ref(value))
    }

    pub fn finish(self, magic: [u8; 4], version: u32, flags: u32) -> Vec<u8> {
        let header = FileHeaderSchema {
            magic,
            version,
            flags,
            count: self.sections.len() as u32,
        };
        let head_len = size_of::<FileHeaderSchema>();
        let table_len = self.sections.len() * size_of::<SectionSchema>();
        let mut cursor = align_up(head_len + table_len);

        let table: Vec<SectionSchema> = self
            .sections
            .iter()
            .map(|(kind, elem_size, len, payload)| {
                let entry = SectionSchema {
                    kind: *kind as u32,
                    elem_size: *elem_size,
                    len: *len,
                    _pad: 0,
                    offset: cursor as u64,
                };
                cursor = align_up(cursor + payload.len());
                entry
            })
            .collect();

        let mut out = Vec::with_capacity(cursor);
        out.extend_from_slice(bytemuck::bytes_of(&header));
        out.extend_from_slice(bytemuck::cast_slice(&table));
        for ((_, _, _, payload), entry) in self.sections.iter().zip(&table) {
            out.resize(entry.offset as usize, 0);
            out.extend_from_slice(payload);
        }
        out.resize(cursor, 0);
        out
    }
}

#[inline]
const fn align_up(n: usize) -> usize {
    n.div_ceil(SECTION_ALIGN) * SECTION_ALIGN
}
