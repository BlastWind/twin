//! LEHD LODES 8 home->work flows -> zones and an OD matrix.
//!
//! Three files, all gzipped CSV: `va_xwalk` maps every 2020 census block to its
//! block group and carries the block centroid (so no separate TIGER download);
//! `va_od_main` is the VA-resident commute; `va_od_aux` is the out-of-state
//! inflow, which for Fairfax is most of the Potomac crossings.

use anyhow::{Context, Result};
use flate2::read::GzDecoder;
use std::collections::HashMap;
use std::io::BufReader;
use std::path::Path;
use twin_core::grid::haversine_m;
use twin_core::BBox;

/// A 15-digit 2020 census block GEOID.
pub type BlockId = u64;
/// Its 12-digit block-group prefix.
pub type BlockGroupId = u64;
/// Index into [`DemandBuild::zones`].
pub type ZoneIx = u16;

/// A zone before it is snapped to a graph node.
#[derive(Clone, Debug)]
pub struct ZoneBuild {
    /// Block-group GEOID for internal zones; a synthetic `9_000_000_000_000 + k`
    /// for the external ring, so the id space stays one type.
    pub key: u64,
    pub lon: f64,
    pub lat: f64,
    pub external: bool,
}

/// Zones plus their daily vehicle-trip matrix, before the hourly profile.
pub struct DemandBuild {
    pub zones: Vec<ZoneBuild>,
    /// Sparse cells, `(origin, dest) -> daily vehicle trips`.
    pub od: HashMap<(ZoneIx, ZoneIx), f32>,
    pub is_synthetic: bool,
    pub notes: Vec<String>,
}

/// Approximate centroids of the states in Fairfax's commute shed, so an
/// out-of-state home block — which the VA crosswalk cannot place — still lands
/// on the right side of the ring. Anything else is counted and dropped.
const STATE_CENTROID: [(u64, f64, f64); 13] = [
    (11, -77.02, 38.90), // District of Columbia
    (24, -76.80, 39.05), // Maryland
    (54, -80.60, 38.60), // West Virginia
    (42, -77.60, 40.90), // Pennsylvania
    (10, -75.50, 39.00), // Delaware
    (34, -74.70, 40.20), // New Jersey
    (36, -75.50, 42.90), // New York
    (37, -79.40, 35.50), // North Carolina
    (45, -80.90, 33.90), // South Carolina
    (47, -86.70, 35.80), // Tennessee
    (21, -84.30, 37.50), // Kentucky
    (39, -82.80, 40.30), // Ohio
    (51, -78.80, 37.50), // Virginia
];

/// External zones evenly spaced around the bbox, walking the perimeter
/// clockwise from the south-west corner. Through traffic enters and leaves the
/// study area at whichever of these is nearest its real origin.
fn external_ring(bbox: BBox, count: u32) -> Vec<ZoneBuild> {
    let (w, s, e, n) = (bbox.west, bbox.south, bbox.east, bbox.north);
    let perimeter = 2.0 * ((e - w) + (n - s));
    (0..count)
        .map(|k| {
            // Walk the perimeter, subtracting each side as it is passed.
            let t = perimeter * k as f64 / count as f64;
            let (south, east, north) = (e - w, n - s, e - w);
            let (lon, lat) = match t {
                t if t < south => (w + t, s),
                t if t - south < east => (e, s + (t - south)),
                t if t - south - east < north => (e - (t - south - east), n),
                t => (w, n - (t - south - east - north)),
            };
            ZoneBuild {
                key: 9_000_000_000_000 + k as u64,
                lon,
                lat,
                external: true,
            }
        })
        .collect()
}

/// A gzipped CSV reader. The crosswalk quotes place names that contain commas,
/// so these files need a real CSV parser, not a `split(',')`.
fn open_csv(path: &Path) -> Result<csv::Reader<BufReader<GzDecoder<std::fs::File>>>> {
    let file = std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    Ok(csv::ReaderBuilder::new()
        .has_headers(true)
        .from_reader(BufReader::new(GzDecoder::new(file))))
}

/// Column indices by header name, so a schema shuffle upstream is caught rather
/// than silently mis-parsed.
fn header_index<R: std::io::Read>(rdr: &mut csv::Reader<R>, wanted: &[&str]) -> Result<Vec<usize>> {
    let header = rdr.headers()?.clone();
    wanted
        .iter()
        .map(|w| {
            header
                .iter()
                .position(|c| c.trim().eq_ignore_ascii_case(w))
                .with_context(|| format!("column `{w}` is missing; found {header:?}"))
        })
        .collect()
}

#[inline]
fn field<T: std::str::FromStr>(rec: &csv::StringRecord, i: usize) -> Option<T> {
    rec.get(i)?.trim().parse().ok()
}

/// Every VA block's centroid. Kept for the whole state, not just the bbox: a
/// commute from Prince William has to be placed on the ring, which needs its
/// real position.
fn read_block_positions(path: &Path) -> Result<HashMap<BlockId, (f64, f64)>> {
    let mut rdr = open_csv(path)?;
    let [c_blk, c_lat, c_lon] =
        header_index(&mut rdr, &["tabblk2020", "blklatdd", "blklondd"])?[..]
    else {
        unreachable!("three names in, three indices out")
    };
    let mut out = HashMap::new();
    for rec in rdr.records() {
        let rec = rec.with_context(|| format!("reading {}", path.display()))?;
        let (Some(blk), Some(lat), Some(lon)) = (
            field::<u64>(&rec, c_blk),
            field::<f64>(&rec, c_lat),
            field::<f64>(&rec, c_lon),
        ) else {
            continue;
        };
        out.insert(blk, (lon, lat));
    }
    Ok(out)
}

#[inline]
fn block_group_of(block: BlockId) -> BlockGroupId {
    block / 1000
}

#[inline]
fn state_of(block: BlockId) -> u64 {
    block / 10_000_000_000_000
}

/// Nearest ring zone to a coordinate. The ring is small (a dozen), so a linear
/// scan beats any structure.
fn nearest_external(ring: &[ZoneBuild], offset: usize, lon: f64, lat: f64) -> ZoneIx {
    let best = ring
        .iter()
        .enumerate()
        .min_by(|a, b| {
            haversine_m(lon, lat, a.1.lon, a.1.lat)
                .total_cmp(&haversine_m(lon, lat, b.1.lon, b.1.lat))
        })
        .map(|(i, _)| i)
        .unwrap_or(0);
    (offset + best) as ZoneIx
}

/// Build zones and the OD matrix from the three LODES files.
pub fn from_lodes(
    xwalk: &Path,
    od_main: &Path,
    od_aux: &Path,
    bbox: BBox,
    external_zones: u32,
    auto_factor: f64,
) -> Result<DemandBuild> {
    let block_pos = read_block_positions(xwalk)?;

    // Internal zones: every block group with at least one block in the bbox,
    // placed at the mean of the blocks that are actually inside.
    let mut acc: HashMap<BlockGroupId, (f64, f64, u32)> = HashMap::new();
    for (&blk, &(lon, lat)) in &block_pos {
        if bbox.contains(lon, lat) {
            let e = acc.entry(block_group_of(blk)).or_insert((0.0, 0.0, 0));
            e.0 += lon;
            e.1 += lat;
            e.2 += 1;
        }
    }
    let mut internal: Vec<(BlockGroupId, (f64, f64, u32))> = acc.into_iter().collect();
    internal.sort_unstable_by_key(|(bg, _)| *bg);
    let zone_of_bg: HashMap<BlockGroupId, ZoneIx> = internal
        .iter()
        .enumerate()
        .map(|(i, (bg, _))| (*bg, i as ZoneIx))
        .collect();
    let mut zones: Vec<ZoneBuild> = internal
        .iter()
        .map(|(bg, (slon, slat, n))| ZoneBuild {
            key: *bg,
            lon: slon / *n as f64,
            lat: slat / *n as f64,
            external: false,
        })
        .collect();
    let external_start = zones.len() as u32;
    let ring = external_ring(bbox, external_zones);
    zones.extend(ring.iter().cloned());

    let state_pos: HashMap<u64, (f64, f64)> = STATE_CENTROID
        .iter()
        .map(|&(fips, lon, lat)| (fips, (lon, lat)))
        .collect();
    let place = |blk: BlockId| -> Option<ZoneIx> {
        if let Some(&z) = zone_of_bg.get(&block_group_of(blk)) {
            return Some(z);
        }
        let (lon, lat) = block_pos
            .get(&blk)
            .copied()
            .or_else(|| state_pos.get(&state_of(blk)).copied())?;
        Some(nearest_external(&ring, external_start as usize, lon, lat))
    };

    let mut od: HashMap<(ZoneIx, ZoneIx), f32> = HashMap::new();
    let mut unplaced = 0u64;
    let mut jobs = 0f64;
    for path in [od_main, od_aux] {
        let mut rdr = open_csv(path)?;
        let [c_w, c_h, c_s] = header_index(&mut rdr, &["w_geocode", "h_geocode", "S000"])?[..]
        else {
            unreachable!("three names in, three indices out")
        };
        for rec in rdr.records() {
            let rec = rec.with_context(|| format!("reading {}", path.display()))?;
            let (Some(w), Some(h), Some(s)) = (
                field::<BlockId>(&rec, c_w),
                field::<BlockId>(&rec, c_h),
                field::<f64>(&rec, c_s),
            ) else {
                continue;
            };
            let (Some(o), Some(d)) = (place(h), place(w)) else {
                unplaced += 1;
                continue;
            };
            // Both ends external means the trip never enters the study area.
            if o == d || (o >= external_start as u16 && d >= external_start as u16) {
                continue;
            }
            jobs += s;
            *od.entry((o, d)).or_insert(0.0) += (s * auto_factor) as f32;
        }
    }
    // Cells under half a vehicle a day are noise, and there are a lot of them.
    od.retain(|_, v| *v >= 0.5);

    let notes = vec![
        format!(
            "LODES 8 (2023): {} internal block groups, {} external ring zones, {} OD cells, {jobs:.0} commutes placed",
            external_start,
            external_zones,
            od.len()
        ),
        format!("{unplaced} rows dropped: home or work block could not be placed"),
    ];
    Ok(DemandBuild {
        zones,
        od,
        is_synthetic: false,
        notes,
    })
}

/// Gravity-model fallback for when LODES is not on disk.
///
/// Zones are the graph's own chunk cells, mass is the node count in each, and
/// trips fall off with the square of the distance. It is plausible, not real,
/// and `DemandMetaSchema::is_synthetic` says so.
pub fn synthetic_gravity(
    cells: &[(f64, f64, u32)],
    bbox: BBox,
    external_zones: u32,
    total_daily_trips: f64,
) -> DemandBuild {
    let mut zones: Vec<ZoneBuild> = cells
        .iter()
        .enumerate()
        .map(|(i, &(lon, lat, _))| ZoneBuild {
            key: i as u64,
            lon,
            lat,
            external: false,
        })
        .collect();
    let external_start = zones.len() as u32;
    zones.extend(external_ring(bbox, external_zones));

    let mass: Vec<f64> = cells.iter().map(|&(_, _, n)| n as f64).collect();
    let mut raw: HashMap<(ZoneIx, ZoneIx), f64> = HashMap::new();
    let mut total = 0.0;
    for i in 0..cells.len() {
        for j in 0..cells.len() {
            if i == j {
                continue;
            }
            let d = haversine_m(cells[i].0, cells[i].1, cells[j].0, cells[j].1).max(500.0);
            let v = mass[i] * mass[j] / (d / 1000.0).powi(2);
            total += v;
            raw.insert((i as ZoneIx, j as ZoneIx), v);
        }
    }
    let scale = match total > 0.0 {
        true => total_daily_trips / total,
        false => 0.0,
    };
    let mut od: HashMap<(ZoneIx, ZoneIx), f32> = raw
        .into_iter()
        .map(|(k, v)| (k, (v * scale) as f32))
        .collect();
    od.retain(|_, v| *v >= 0.5);

    let notes = vec![format!(
        "SYNTHETIC gravity demand: {} zones from graph chunks, {} OD cells, {total_daily_trips:.0} daily trips. No LODES data was read.",
        external_start,
        od.len()
    )];
    DemandBuild {
        zones,
        od,
        is_synthetic: true,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bbox() -> BBox {
        BBox::new(-77.54, 38.60, -77.04, 39.06).expect("bbox is well formed")
    }

    #[test]
    fn the_ring_stays_on_the_boundary() {
        let ring = external_ring(bbox(), 12);
        assert_eq!(ring.len(), 12);
        for z in &ring {
            let on_edge = (z.lon - bbox().west).abs() < 1e-9
                || (z.lon - bbox().east).abs() < 1e-9
                || (z.lat - bbox().south).abs() < 1e-9
                || (z.lat - bbox().north).abs() < 1e-9;
            assert!(on_edge, "{z:?} is not on the bbox boundary");
        }
    }

    #[test]
    fn a_maryland_block_lands_on_the_northern_ring() {
        let ring = external_ring(bbox(), 12);
        let (lon, lat) = STATE_CENTROID
            .iter()
            .find(|(f, _, _)| *f == 24)
            .map(|&(_, lon, lat)| (lon, lat))
            .expect("Maryland is in the table");
        let z = nearest_external(&ring, 0, lon, lat) as usize;
        assert!(
            ring[z].lat > bbox().mid_lat(),
            "Maryland is north, got {:?}",
            ring[z]
        );
    }

    #[test]
    fn block_groups_are_the_block_without_its_last_three_digits() {
        assert_eq!(block_group_of(510594801011011), 510594801011);
        assert_eq!(state_of(510594801011011), 51);
        assert_eq!(state_of(240450106043075), 24);
    }
}
