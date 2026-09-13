//! The isochrone on a network whose answer can be worked out by hand: a
//! straight chain of nodes 500 m apart, with a bus line that skips four of
//! them.

use twin_core::graph_schema::GraphChunkSchema;
use twin_core::ids::HOURS_PER_DAY;
use twin_core::schema::AlignedBytes;
use twin_core::transit::{
    isochrone, PatternEntrySchema, TransitMetaSchema, TransitSchema, NO_SERVICE_S, WALK_SPEED_MPS,
};
use twin_core::*;

/// Metres between consecutive nodes of the chain.
const SPACING_M: f32 = 500.0;
const CHAIN: u32 = 9;

/// A chain `0 - 1 - ... - 8`, walkable in both directions. Speeds are
/// irrelevant: the isochrone walks, so only `len_m` matters.
fn chain() -> (RoadGraph, Vec<AlignedBytes>) {
    let b = BBox::new(-77.31, 38.80, -77.20, 38.81).expect("bbox is well formed");
    // 500 m of longitude at 38.8 N, so the drawn geometry agrees with len_m.
    let step = 500.0 / (111_320.0 * 38.8_f64.to_radians().cos());
    let nodes: Vec<RawNode> = (0..CHAIN)
        .map(|i| RawNode {
            lon: b.west + step * i as f64,
            lat: b.south + 0.0005,
        })
        .collect();
    let edges: Vec<RawEdge> = (0..CHAIN - 1)
        .flat_map(|i| [(i, i + 1), (i + 1, i)])
        .map(|(from, to)| RawEdge {
            from,
            to,
            len_m: SPACING_M,
            class: RoadClass::Residential,
            lanes: 1,
            speed_kph: 40.0,
            capacity_vph: 800.0,
        })
        .collect();

    let grid = GridSchema::cover(b, 20_000.0);
    let part = partition(&RawGraph::new(nodes, edges), &grid);
    let encoded: Vec<AlignedBytes> = part
        .chunks
        .iter()
        .map(|c| AlignedBytes::adopt(c.encode()))
        .collect();
    let mut graph = RoadGraph::new();
    for bytes in &encoded {
        graph
            .add_chunk(&GraphChunkSchema::decode(bytes).expect("decodes"))
            .expect("adds");
    }
    (graph, encoded)
}

/// One pattern from node 0 to node 8, 120 s of ride, at the given headway in
/// the peak hour and no service otherwise.
fn bus(peak_headway_s: f32) -> Vec<u8> {
    let mut headways = vec![NO_SERVICE_S; HOURS_PER_DAY];
    headways[8] = peak_headway_s;
    TransitSchema::encode(
        TransitMetaSchema {
            stop_count: 2,
            pattern_count: 1,
            pattern_stop_count: 2,
            agency_count: 1,
        },
        &[0, 8],
        &[[-77.31, 38.8005], [-77.26, 38.8005]],
        &[PatternEntrySchema {
            stop_start: 0,
            stop_len: 2,
        }],
        &[0, 1],
        &[120.0, 0.0],
        &headways,
    )
}

fn reach_at(
    graph: &mut RoadGraph,
    transit_bytes: &AlignedBytes,
    hour: u8,
    budget_min: f32,
) -> Vec<f32> {
    let view = graph.view();
    let transit = TransitSchema::decode(transit_bytes).expect("decodes");
    let origin = view
        .index_of(NodeId::from_index(0))
        .expect("node 0 is loaded");
    isochrone(
        &view,
        &transit,
        origin,
        Hour::from_index(hour),
        budget_min * 60.0,
    )
    .seconds
}

#[test]
fn walking_alone_reaches_exactly_as_far_as_the_budget_allows() {
    let (mut graph, _keep) = chain();
    let transit = AlignedBytes::adopt(bus(600.0));
    // 10 minutes at 1.35 m/s is 810 m: node 1 (500 m) yes, node 2 (1000 m) no.
    let seconds = reach_at(&mut graph, &transit, 3, 10.0);
    let reached: Vec<usize> = seconds
        .iter()
        .enumerate()
        .filter(|(_, s)| s.is_finite())
        .map(|(i, _)| i)
        .collect();
    assert_eq!(
        reached,
        vec![0, 1],
        "no service at 03:00, so this is a walk"
    );
    let expected = SPACING_M / WALK_SPEED_MPS;
    assert!((seconds[1] - expected).abs() < 1.0, "got {}", seconds[1]);
}

#[test]
fn the_bus_carries_the_rider_past_where_walking_stops() {
    let (mut graph, _keep) = chain();
    let transit = AlignedBytes::adopt(bus(600.0));
    // Board at node 0: 300 s of expected wait plus 120 s of ride puts node 8
    // at 420 s, well inside a 15-minute budget that walking covers 1.2 km of.
    let seconds = reach_at(&mut graph, &transit, 8, 15.0);
    assert!(seconds[8].is_finite(), "the far end is reachable by bus");
    assert!(
        (seconds[8] - 420.0).abs() < 1.0,
        "half the headway plus the ride, got {}",
        seconds[8]
    );
    // And having arrived, the rider walks back from node 8 to node 7.
    assert!(
        (seconds[7] - (420.0 + SPACING_M / WALK_SPEED_MPS)).abs() < 1.0,
        "got {}",
        seconds[7]
    );
}

#[test]
fn a_wider_headway_costs_the_rider_half_the_difference() {
    let (mut graph, _keep) = chain();
    let frequent = AlignedBytes::adopt(bus(600.0));
    let sparse = AlignedBytes::adopt(bus(1800.0));
    let a = reach_at(&mut graph, &frequent, 8, 60.0)[8];
    let b = reach_at(&mut graph, &sparse, 8, 60.0)[8];
    assert!((b - a - 600.0).abs() < 1.0, "{a} -> {b}");
}

#[test]
fn an_unreachable_network_is_empty_rather_than_wrong() {
    let (mut graph, _keep) = chain();
    let transit = AlignedBytes::adopt(bus(600.0));
    let seconds = reach_at(&mut graph, &transit, 8, 0.0);
    assert_eq!(
        seconds.iter().filter(|s| s.is_finite()).count(),
        1,
        "a zero budget reaches only the origin"
    );
}
