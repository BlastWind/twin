//! Magic-id newtypes with smart constructors.
//!
//! Every id in the core is a distinct type so a `NodeId` can never be passed
//! where an `EdgeId` is expected. Construction goes through `new`, which is the
//! single place a raw integer is admitted into the domain.

use bytemuck::{Pod, Zeroable};

/// Sentinel used in the binary layouts for "no such id".
pub const NONE_U32: u32 = u32::MAX;

macro_rules! magic_id {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
        #[repr(transparent)]
        pub struct $name(u32);

        unsafe impl Zeroable for $name {}
        unsafe impl Pod for $name {}

        impl $name {
            /// Smart constructor: rejects the reserved sentinel value.
            #[inline]
            pub const fn new(raw: u32) -> Option<Self> {
                match raw {
                    NONE_U32 => None,
                    v => Some(Self(v)),
                }
            }

            /// Construct from a value known to be in range (e.g. a loop index).
            ///
            /// # Panics
            /// Panics if `raw` is the reserved sentinel.
            #[inline]
            pub const fn from_index(raw: u32) -> Self {
                assert!(raw != NONE_U32, "reserved sentinel id");
                Self(raw)
            }

            #[inline]
            pub const fn raw(self) -> u32 {
                self.0
            }

            #[inline]
            pub const fn index(self) -> usize {
                self.0 as usize
            }
        }

        impl From<$name> for u32 {
            #[inline]
            fn from(v: $name) -> u32 {
                v.0
            }
        }
    };
}

magic_id!(NodeId, "Globally stable node id, unique across all chunks.");
magic_id!(
    EdgeId,
    "Globally stable directed-edge id, unique across all chunks."
);
impl EdgeId {
    /// First id handed to a scenario's added edges. The pipeline numbers base
    /// edges from 0 and the county is four orders of magnitude short of this,
    /// so an overlay id can never collide with a real one — and a result array
    /// carrying one is recognisably not a road that exists.
    pub const OVERLAY_START: u32 = 0xF000_0000;

    /// Whether this id names an edge a scenario added rather than a base edge.
    #[inline]
    pub const fn is_overlay(self) -> bool {
        self.raw() >= Self::OVERLAY_START
    }
}

magic_id!(
    ChunkId,
    "Linear id of a grid cell: `cy * cols + cx`. See [`crate::grid::ChunkGrid`]."
);

/// Hours in a day; the length of every hourly profile in the core.
pub const HOURS_PER_DAY: usize = 24;

/// Traffic-analysis zone. `u16` because the county has hundreds of block
/// groups, not millions, and the OD triples are the biggest array in
/// `demand.bin`.
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
#[repr(transparent)]
pub struct ZoneId(u16);

unsafe impl Zeroable for ZoneId {}
unsafe impl Pod for ZoneId {}

impl ZoneId {
    /// Smart constructor: rejects the reserved sentinel value.
    #[inline]
    pub const fn new(raw: u16) -> Option<Self> {
        match raw {
            u16::MAX => None,
            v => Some(Self(v)),
        }
    }

    /// # Panics
    /// Panics if `raw` is the reserved sentinel.
    #[inline]
    pub const fn from_index(raw: u16) -> Self {
        assert!(raw != u16::MAX, "reserved sentinel id");
        Self(raw)
    }

    #[inline]
    pub const fn raw(self) -> u16 {
        self.0
    }

    #[inline]
    pub const fn index(self) -> usize {
        self.0 as usize
    }
}

/// An hour of the day, `0..24`. Correctness by construction: nothing
/// downstream range-checks a profile lookup.
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
#[repr(transparent)]
pub struct Hour(u8);

impl Hour {
    #[inline]
    pub const fn new(raw: u8) -> Option<Self> {
        match raw {
            0..=23 => Some(Self(raw)),
            _ => None,
        }
    }

    /// # Panics
    /// Panics outside `0..24`.
    #[inline]
    pub const fn from_index(raw: u8) -> Self {
        assert!((raw as usize) < HOURS_PER_DAY, "hour out of range");
        Self(raw)
    }

    /// Every hour of the day, ascending.
    pub fn all() -> impl Iterator<Item = Hour> {
        (0..HOURS_PER_DAY as u8).map(Hour)
    }

    #[inline]
    pub const fn raw(self) -> u8 {
        self.0
    }

    #[inline]
    pub const fn index(self) -> usize {
        self.0 as usize
    }
}

/// OSM-derived road class. `u8` repr so it round-trips through the binary
/// layouts as a plain byte array.
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
#[repr(u8)]
pub enum RoadClass {
    Motorway = 0,
    Trunk = 1,
    Primary = 2,
    Secondary = 3,
    Tertiary = 4,
    Residential = 5,
    Unclassified = 6,
    Service = 7,
    Living = 8,
    #[default]
    Other = 9,
}

impl RoadClass {
    pub const ALL: [RoadClass; 10] = [
        RoadClass::Motorway,
        RoadClass::Trunk,
        RoadClass::Primary,
        RoadClass::Secondary,
        RoadClass::Tertiary,
        RoadClass::Residential,
        RoadClass::Unclassified,
        RoadClass::Service,
        RoadClass::Living,
        RoadClass::Other,
    ];

    /// Smart constructor from the stored byte; unknown bytes are not silently
    /// coerced.
    #[inline]
    pub const fn from_u8(raw: u8) -> Option<Self> {
        match raw {
            0 => Some(Self::Motorway),
            1 => Some(Self::Trunk),
            2 => Some(Self::Primary),
            3 => Some(Self::Secondary),
            4 => Some(Self::Tertiary),
            5 => Some(Self::Residential),
            6 => Some(Self::Unclassified),
            7 => Some(Self::Service),
            8 => Some(Self::Living),
            9 => Some(Self::Other),
            _ => None,
        }
    }

    /// Parse an OSM `highway=*` tag value. `_link` variants fold into their
    /// parent class.
    pub fn from_osm_highway(tag: &str) -> Option<Self> {
        let base = tag.strip_suffix("_link").unwrap_or(tag);
        match base {
            "motorway" => Some(Self::Motorway),
            "trunk" => Some(Self::Trunk),
            "primary" => Some(Self::Primary),
            "secondary" => Some(Self::Secondary),
            "tertiary" => Some(Self::Tertiary),
            "residential" => Some(Self::Residential),
            "unclassified" | "road" => Some(Self::Unclassified),
            "service" => Some(Self::Service),
            "living_street" => Some(Self::Living),
            _ => None,
        }
    }

    #[inline]
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    /// Default free-flow speed in km/h when OSM has no `maxspeed`.
    #[inline]
    pub const fn default_speed_kph(self) -> f32 {
        match self {
            Self::Motorway => 105.0,
            Self::Trunk => 90.0,
            Self::Primary => 72.0,
            Self::Secondary => 56.0,
            Self::Tertiary => 48.0,
            Self::Residential => 40.0,
            Self::Unclassified => 40.0,
            Self::Service => 24.0,
            Self::Living => 16.0,
            Self::Other => 32.0,
        }
    }

    /// Default lane count per direction when OSM has no `lanes`.
    #[inline]
    pub const fn default_lanes(self) -> u8 {
        match self {
            Self::Motorway => 3,
            Self::Trunk | Self::Primary => 2,
            _ => 1,
        }
    }

    /// Default per-lane capacity in vehicles per hour.
    #[inline]
    pub const fn lane_capacity_vph(self) -> f32 {
        match self {
            Self::Motorway => 2200.0,
            Self::Trunk => 1900.0,
            Self::Primary => 1600.0,
            Self::Secondary => 1400.0,
            Self::Tertiary => 1200.0,
            Self::Residential => 800.0,
            Self::Unclassified => 800.0,
            Self::Service => 400.0,
            Self::Living => 300.0,
            Self::Other => 600.0,
        }
    }
}
