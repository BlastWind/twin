//! `demand.bin` — zones, their sparse origin-destination flows, and the 24-hour
//! profile that scales them. DESIGN.md section 5.

use crate::ids::{Hour, NodeId, ZoneId, HOURS_PER_DAY};
use crate::schema::*;
use bytemuck::{Pod, Zeroable};

/// Fixed part of `demand.bin`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Zeroable, Pod)]
#[repr(C)]
pub struct DemandMetaSchema {
    pub zone_count: u32,
    pub od_count: u32,
    /// First external zone. Zones `[0, external_zone_start)` are internal
    /// (census block groups); the rest sit on the study bbox and absorb
    /// through traffic.
    pub external_zone_start: u32,
    /// 1 when the flows came from real LODES data, 0 when they were synthesized
    /// by the gravity fallback. The dashboard says so out loud.
    pub is_synthetic: u32,
}

/// One sparse OD cell. Daily person-trips, before the hourly profile.
#[derive(Copy, Clone, Debug, PartialEq, Zeroable, Pod)]
#[repr(C)]
pub struct OdTripleSchema {
    pub origin: u16,
    pub dest: u16,
    pub trips: f32,
}

/// Decoded `demand.bin`, borrowed from the caller's bytes.
pub struct DemandSchema<'a> {
    pub meta: DemandMetaSchema,
    /// Global [`NodeId`] each zone centroid snapped to, one per zone.
    pub zone_node: &'a [u32],
    pub zone_lonlat: &'a [[f32; 2]],
    pub od: &'a [OdTripleSchema],
    pub hour_profile: &'a [f32],
}

impl<'a> DemandSchema<'a> {
    pub fn decode(bytes: &'a [u8]) -> Result<Self, SchemaError> {
        let f = FileView::parse(bytes, MAGIC_DEMAND, VERSION_DEMAND)?;
        let out = Self {
            meta: f.one(SectionKind::DemandMeta)?,
            zone_node: f.section(SectionKind::ZoneNode)?,
            zone_lonlat: f.section(SectionKind::ZoneLonLat)?,
            od: f.section(SectionKind::OdTriples)?,
            hour_profile: f.section(SectionKind::HourProfile)?,
        };
        out.validate()?;
        Ok(out)
    }

    fn validate(&self) -> Result<(), SchemaError> {
        let z = self.meta.zone_count as usize;
        if self.zone_node.len() != z || self.zone_lonlat.len() != z {
            return Err(SchemaError::InconsistentLength(SectionKind::ZoneNode));
        }
        if self.od.len() != self.meta.od_count as usize {
            return Err(SchemaError::InconsistentLength(SectionKind::OdTriples));
        }
        if self.hour_profile.len() != HOURS_PER_DAY {
            return Err(SchemaError::InconsistentLength(SectionKind::HourProfile));
        }
        let in_range = self
            .od
            .iter()
            .all(|t| (t.origin as usize) < z && (t.dest as usize) < z);
        if !in_range {
            return Err(SchemaError::InconsistentLength(SectionKind::OdTriples));
        }
        Ok(())
    }

    pub fn encode(
        meta: DemandMetaSchema,
        zone_node: &[u32],
        zone_lonlat: &[[f32; 2]],
        od: &[OdTripleSchema],
        hour_profile: &[f32; HOURS_PER_DAY],
    ) -> Vec<u8> {
        FileWriter::new()
            .push_one(SectionKind::DemandMeta, &meta)
            .push(SectionKind::ZoneNode, zone_node)
            .push(SectionKind::ZoneLonLat, zone_lonlat)
            .push(SectionKind::OdTriples, od)
            .push(SectionKind::HourProfile, hour_profile)
            .finish(MAGIC_DEMAND, VERSION_DEMAND, 0)
    }

    pub fn zone_count(&self) -> usize {
        self.meta.zone_count as usize
    }

    /// The graph node zone `z` loads onto.
    pub fn node_of(&self, z: ZoneId) -> Option<NodeId> {
        NodeId::new(*self.zone_node.get(z.index())?)
    }

    /// Trips leaving `origin` for `dest` in `hour`, after the profile.
    pub fn trips_at(&self, hour: Hour) -> impl Iterator<Item = (ZoneId, ZoneId, f32)> + '_ {
        let f = self.hour_profile[hour.index()];
        self.od
            .iter()
            .filter_map(move |t| Some((ZoneId::new(t.origin)?, ZoneId::new(t.dest)?, t.trips * f)))
    }
}

/// NHTS-style 24-hour split of daily vehicle trips, AM peak at 08:00 and a
/// broader PM peak at 17:00. Sums to 1.
pub const NHTS_HOUR_PROFILE: [f32; HOURS_PER_DAY] = [
    0.006, 0.004, 0.003, 0.003, 0.006, 0.017, 0.041, 0.070, 0.078, 0.055, 0.043, 0.043, 0.048,
    0.048, 0.051, 0.062, 0.082, 0.093, 0.078, 0.057, 0.041, 0.031, 0.023, 0.017,
];

/// The share of an hour's trips that are the *return* leg, i.e. loaded on the
/// reversed OD pair. Ramps from all-outbound in the morning to all-return in
/// the evening, which is what turns one home->work matrix into a plausible
/// 24-hour profile without a second data source.
pub fn return_share(hour: Hour) -> f32 {
    match hour.raw() {
        0..=9 => 0.10,
        10..=13 => 0.35,
        14..=15 => 0.55,
        16..=19 => 0.85,
        _ => 0.70,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_profile_is_a_distribution() {
        let sum: f32 = NHTS_HOUR_PROFILE.iter().sum();
        assert!((sum - 1.0).abs() < 1e-3, "profile sums to {sum}, not 1");
        let peak = NHTS_HOUR_PROFILE
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .expect("non-empty");
        assert_eq!(peak.0, 17, "PM peak is the fattest hour");
    }

    #[test]
    fn demand_round_trips() {
        let od = [
            OdTripleSchema {
                origin: 0,
                dest: 1,
                trips: 12.5,
            },
            OdTripleSchema {
                origin: 1,
                dest: 0,
                trips: 3.0,
            },
        ];
        let meta = DemandMetaSchema {
            zone_count: 2,
            od_count: od.len() as u32,
            external_zone_start: 2,
            is_synthetic: 0,
        };
        let bytes = AlignedBytes::adopt(DemandSchema::encode(
            meta,
            &[7, 9],
            &[[-77.1, 38.9], [-77.2, 38.8]],
            &od,
            &NHTS_HOUR_PROFILE,
        ));
        let d = DemandSchema::decode(&bytes).expect("decodes");
        assert_eq!(d.meta, meta);
        assert_eq!(d.od, od.as_slice());
        assert_eq!(d.node_of(ZoneId::from_index(1)), NodeId::new(9));
        let hour8: Vec<_> = d.trips_at(Hour::from_index(8)).collect();
        assert!((hour8[0].2 - 12.5 * NHTS_HOUR_PROFILE[8]).abs() < 1e-4);
    }

    #[test]
    fn an_out_of_range_zone_is_rejected() {
        let od = [OdTripleSchema {
            origin: 0,
            dest: 5,
            trips: 1.0,
        }];
        let meta = DemandMetaSchema {
            zone_count: 1,
            od_count: 1,
            external_zone_start: 1,
            is_synthetic: 1,
        };
        let bytes = AlignedBytes::adopt(DemandSchema::encode(
            meta,
            &[0],
            &[[0.0, 0.0]],
            &od,
            &NHTS_HOUR_PROFILE,
        ));
        assert!(DemandSchema::decode(&bytes).is_err());
    }
}
