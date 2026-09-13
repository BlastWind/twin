//! `counts.bin` — VDOT traffic-count stations snapped to the nearest graph
//! edge, and the calibration arithmetic that compares them to modelled flow.
//! DESIGN.md sections 5 and 6.

use crate::ids::{EdgeId, Hour, HOURS_PER_DAY};
use crate::schema::*;
use bytemuck::{Pod, Zeroable};

pub const MAGIC_COUNTS: [u8; 4] = *b"TWCT";
pub const VERSION_COUNTS: u32 = 1;

/// Fixed part of `counts.bin`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Zeroable, Pod)]
#[repr(C)]
pub struct CountsMetaSchema {
    pub station_count: u32,
    /// Publication year of the AADT vintage, e.g. 2024.
    pub year: u32,
}

/// One count station. `aadt` is bidirectional annual average daily traffic as
/// VDOT publishes it; `edge` is the single directed edge it snapped to, so
/// calibration sums both directions itself.
#[derive(Copy, Clone, Debug, PartialEq, Zeroable, Pod)]
#[repr(C)]
pub struct StationSchema {
    pub station_id: u32,
    /// Global [`EdgeId`], or [`crate::ids::NONE_U32`] when nothing was near.
    pub edge: u32,
    pub aadt: f32,
    pub lon: f32,
    pub lat: f32,
    /// Great-circle metres from the station point to the snapped edge.
    pub snap_m: f32,
}

/// Decoded `counts.bin`.
pub struct CountsSchema<'a> {
    pub meta: CountsMetaSchema,
    pub stations: &'a [StationSchema],
}

impl<'a> CountsSchema<'a> {
    pub fn decode(bytes: &'a [u8]) -> Result<Self, SchemaError> {
        let f = FileView::parse(bytes, MAGIC_COUNTS, VERSION_COUNTS)?;
        let out = Self {
            meta: f.one(SectionKind::CountsMeta)?,
            stations: f.section(SectionKind::CountStations)?,
        };
        if out.stations.len() != out.meta.station_count as usize {
            return Err(SchemaError::InconsistentLength(SectionKind::CountStations));
        }
        Ok(out)
    }

    pub fn encode(meta: CountsMetaSchema, stations: &[StationSchema]) -> Vec<u8> {
        FileWriter::new()
            .push_one(SectionKind::CountsMeta, &meta)
            .push(SectionKind::CountStations, stations)
            .finish(MAGIC_COUNTS, VERSION_COUNTS, 0)
    }

    pub fn edge_of(&self, i: usize) -> Option<EdgeId> {
        EdgeId::new(self.stations.get(i)?.edge)
    }
}

/// One row of the calibration table.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct CalibrationRow {
    pub station_id: u32,
    pub edge: EdgeId,
    pub aadt: f32,
    pub modeled_daily: f32,
}

/// How the modelled daily volume was arrived at, so the dashboard can say when
/// it is an extrapolation rather than a sum.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum DailySource {
    /// All 24 hours were run and summed.
    FullDay,
    /// One hour was run and divided by its share of the daily profile.
    ScaledFromHour(Hour),
}

/// Daily volume per edge from whatever hours have been run.
///
/// `hourly[h]` is `Some(volume_of_edge)` for the hours that exist. With a full
/// day the answer is the plain sum; with a single hour it is that hour divided
/// by its share of `profile`, which the caller is expected to flag.
pub fn modeled_daily(
    hourly: &[Option<&[f32]>; HOURS_PER_DAY],
    profile: &[f32; HOURS_PER_DAY],
    edge_dense: usize,
) -> Option<(f32, DailySource)> {
    let present: Vec<(usize, f32)> = hourly
        .iter()
        .enumerate()
        .filter_map(|(h, v)| Some((h, *(*v)?.get(edge_dense)?)))
        .collect();
    match present.as_slice() {
        [] => None,
        [(h, v)] => {
            let share = profile[*h].max(f32::EPSILON);
            Some((
                v / share,
                DailySource::ScaledFromHour(Hour::from_index(*h as u8)),
            ))
        }
        many => Some((many.iter().map(|(_, v)| v).sum(), DailySource::FullDay)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_round_trip() {
        let stations = [StationSchema {
            station_id: 42,
            edge: 7,
            aadt: 18_500.0,
            lon: -77.3,
            lat: 38.85,
            snap_m: 12.5,
        }];
        let meta = CountsMetaSchema {
            station_count: 1,
            year: 2024,
        };
        let bytes = AlignedBytes::adopt(CountsSchema::encode(meta, &stations));
        let c = CountsSchema::decode(&bytes).expect("decodes");
        assert_eq!(c.meta, meta);
        assert_eq!(c.stations, stations.as_slice());
        assert_eq!(c.edge_of(0), EdgeId::new(7));
    }

    #[test]
    fn a_short_station_table_is_rejected() {
        let bytes = AlignedBytes::adopt(CountsSchema::encode(
            CountsMetaSchema {
                station_count: 3,
                year: 2024,
            },
            &[],
        ));
        assert!(CountsSchema::decode(&bytes).is_err());
    }

    #[test]
    fn one_hour_is_scaled_and_a_full_day_is_summed() {
        let profile = [1.0 / 24.0; HOURS_PER_DAY];
        let hour8 = [100.0f32];
        let mut only_one: [Option<&[f32]>; HOURS_PER_DAY] = [None; HOURS_PER_DAY];
        only_one[8] = Some(&hour8);
        assert_eq!(
            modeled_daily(&only_one, &profile, 0),
            Some((2400.0, DailySource::ScaledFromHour(Hour::from_index(8))))
        );

        let all: [Option<&[f32]>; HOURS_PER_DAY] = [Some(&hour8 as &[f32]); HOURS_PER_DAY];
        let (v, src) = modeled_daily(&all, &profile, 0).expect("some");
        assert_eq!((v, src), (2400.0, DailySource::FullDay));

        let none: [Option<&[f32]>; HOURS_PER_DAY] = [None; HOURS_PER_DAY];
        assert_eq!(modeled_daily(&none, &profile, 0), None);
    }
}
