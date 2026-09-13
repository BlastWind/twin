//! Equilibrium tests on networks whose answer is known independently of the
//! solver: a two-route split solved by 1-D bisection, and Braess's paradox.

use twin_core::assign::{assign, AssignParams};
use twin_core::demand::{return_share, DemandMetaSchema, DemandSchema, OdTripleSchema};
use twin_core::graph_schema::GraphChunkSchema;
use twin_core::schema::AlignedBytes;
use twin_core::*;

/// A bbox small enough that one grid cell covers it, so global ids come out in
/// the order the raw nodes were declared and a test can name a node by index.
fn tiny_bbox() -> BBox {
    BBox::new(-77.31, 38.80, -77.30, 38.81).expect("bbox is well formed")
}

/// `speed_kph = 3.6` is exactly 1 m/s, so `len_m` *is* the free-flow time in
/// seconds and a test can state `t0` directly.
fn arc(from: u32, to: u32, t0_s: f32, capacity_vph: f32) -> RawEdge {
    RawEdge {
        from,
        to,
        len_m: t0_s,
        class: RoadClass::Primary,
        lanes: 1,
        speed_kph: 3.6,
        capacity_vph,
    }
}

struct Net {
    graph: RoadGraph,
    demand_bytes: AlignedBytes,
}

/// Assemble a hand-written network plus a one-cell demand matrix. `od` is in
/// raw node indices, which the single grid cell makes equal to global ids.
fn net(node_count: u32, edges: Vec<RawEdge>, od: &[(u32, u32, f32)]) -> Net {
    let b = tiny_bbox();
    let nodes: Vec<RawNode> = (0..node_count)
        .map(|i| RawNode {
            // Spread the nodes across the cell without leaving it.
            lon: b.west + 0.001 * (i % 3) as f64,
            lat: b.south + 0.001 * (i / 3) as f64,
        })
        .collect();
    let raw = RawGraph::new(nodes, edges);
    // One cell: 20 km dwarfs the 0.01-degree bbox.
    let grid = GridSchema::cover(b, 20_000.0);
    let part = partition(&raw, &grid);
    assert_eq!(part.chunks.len(), 1, "the whole network is one chunk");

    let encoded: Vec<AlignedBytes> = part
        .chunks
        .iter()
        .map(|c| AlignedBytes::adopt(c.encode()))
        .collect();
    let decoded: Vec<GraphChunkSchema<'_>> = encoded
        .iter()
        .map(|b| GraphChunkSchema::decode(b).expect("decodes"))
        .collect();
    let graph = RoadGraph::from_chunks(decoded.iter()).expect("assembles");

    // One zone per node named by the OD list, so a zone id is a node id.
    let zone_node: Vec<u32> = (0..node_count).collect();
    let zone_lonlat: Vec<[f32; 2]> = (0..node_count).map(|_| [0.0, 0.0]).collect();
    let triples: Vec<OdTripleSchema> = od
        .iter()
        .map(|&(o, d, trips)| OdTripleSchema {
            origin: o as u16,
            dest: d as u16,
            trips,
        })
        .collect();
    let meta = DemandMetaSchema {
        zone_count: node_count,
        od_count: triples.len() as u32,
        external_zone_start: node_count,
        is_synthetic: 1,
    };
    // A flat profile keeps the hour factor out of the arithmetic.
    let demand_bytes = AlignedBytes::adopt(DemandSchema::encode(
        meta,
        &zone_node,
        &zone_lonlat,
        &triples,
        &[1.0; HOURS_PER_DAY],
    ));
    Net {
        graph,
        demand_bytes,
    }
}

/// Volumes keyed by the `(from, to)` node pair, which is how the tests name
/// links. Parallel links are summed, so the two-route test names them by their
/// distinct endpoints instead.
fn run(net: &mut Net, scenario: &Scenario, hour: Hour) -> (Vec<f32>, Vec<(u32, u32)>, HourResult) {
    let params = AssignParams {
        // The analytic references below are exact, so give the solver room to
        // reach them rather than testing the 20-iteration production budget.
        max_iters: 60,
        gap_tol: 1.0e-6,
        ..AssignParams::default()
    };
    let view = ScenarioView::apply(net.graph.view(), scenario);
    let pairs: Vec<(u32, u32)> = (0..view.edge_count())
        .map(|e| {
            let g = view.graph();
            (
                g.nodes()[view.tail_of(e) as usize].id.raw(),
                g.nodes()[view.head_of(e) as usize].id.raw(),
            )
        })
        .collect();
    let demand = DemandSchema::decode(&net.demand_bytes).expect("demand decodes");
    let out = assign(&view, &demand, hour, None, &params);
    (out.volume.clone(), pairs, out)
}

/// Same run, but on the production convergence budget of DESIGN.md section 6.
fn run_default(net: &mut Net, hour: Hour) -> (Vec<f32>, Vec<(u32, u32)>, HourResult) {
    let view = ScenarioView::apply(net.graph.view(), &Scenario::empty());
    let pairs: Vec<(u32, u32)> = (0..view.edge_count())
        .map(|e| {
            let g = view.graph();
            (
                g.nodes()[view.tail_of(e) as usize].id.raw(),
                g.nodes()[view.head_of(e) as usize].id.raw(),
            )
        })
        .collect();
    let demand = DemandSchema::decode(&net.demand_bytes).expect("demand decodes");
    let out = assign(&view, &demand, hour, None, &AssignParams::default());
    (out.volume.clone(), pairs, out)
}

fn volume_of(vols: &[f32], pairs: &[(u32, u32)], from: u32, to: u32) -> f32 {
    pairs
        .iter()
        .zip(vols)
        .filter(|(p, _)| **p == (from, to))
        .map(|(_, &v)| v)
        .sum()
}

/// BPR with the production alpha/beta.
fn bpr(t0: f32, cap: f32, x: f32) -> f32 {
    t0 * (1.0 + 0.15 * (x / cap).powi(4))
}

/// The demand that actually loads, once the hour's return share has been split
/// off onto a reversed pair that these directed networks cannot route.
fn effective(trips: f32, hour: Hour) -> f32 {
    trips * (1.0 - return_share(hour))
}

/// Two parallel routes between the same pair, with different free-flow times
/// and capacities. The split is pinned by Wardrop's condition
/// `t_fast(x) = t_slow(Q - x)`, which is a monotone scalar equation: bisect it
/// to get a reference the solver had no hand in.
#[test]
fn two_routes_split_at_the_wardrop_point() {
    let hour = Hour::from_index(8);
    let q = 3000.0f32;
    // 0 -> 1 -> 3 is the fast, tight route; 0 -> 2 -> 3 the slow, roomy one.
    let (t_fast, c_fast) = (60.0f32, 1200.0f32);
    let (t_slow, c_slow) = (110.0f32, 3000.0f32);
    let edges = vec![
        arc(0, 1, t_fast, c_fast),
        arc(1, 3, 0.001, 1.0e9),
        arc(0, 2, t_slow, c_slow),
        arc(2, 3, 0.001, 1.0e9),
    ];
    let mut n = net(4, edges, &[(0, 3, q / (1.0 - return_share(hour)))]);
    let load = effective(q / (1.0 - return_share(hour)), hour);

    let (mut lo, mut hi) = (0.0f32, load);
    for _ in 0..80 {
        let mid = 0.5 * (lo + hi);
        if bpr(t_fast, c_fast, mid) < bpr(t_slow, c_slow, load - mid) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let expected_fast = 0.5 * (lo + hi);

    let (vols, pairs, out) = run(&mut n, &Scenario::empty(), hour);
    let got_fast = volume_of(&vols, &pairs, 0, 1);
    assert!(
        (got_fast - expected_fast).abs() / expected_fast < 0.01,
        "fast route carried {got_fast}, Wardrop says {expected_fast} (gap {})",
        out.rel_gap
    );
    let got_slow = volume_of(&vols, &pairs, 0, 2);
    assert!(
        (got_fast + got_slow - load).abs() < 1.0,
        "all trips are loaded"
    );

    // The shipped budget must land within 1 % too, or the browser sees a
    // different answer from the tests.
    let (vols, pairs, budgeted) = run_default(&mut n, hour);
    let got_fast = volume_of(&vols, &pairs, 0, 1);
    assert!(
        (got_fast - expected_fast).abs() / expected_fast < 0.01,
        "20 iterations gave {got_fast}, Wardrop says {expected_fast}"
    );
    assert!(
        budgeted.rel_gap < 1.0e-3,
        "the default budget converged to {}",
        budgeted.rel_gap
    );
}

/// Braess: adding a free link makes everyone slower. The network is the
/// textbook one, with BPR standing in for the linear cost functions, and the
/// scenario editor is what removes the link again.
#[test]
fn braess_link_makes_everyone_slower() {
    let hour = Hour::from_index(8);
    let q = 4000.0f32;
    // 0 -> 1 and 2 -> 3 congest; 0 -> 2 and 1 -> 3 are fixed 45 s.
    let edges = vec![
        arc(0, 1, 1.0, 1000.0),
        arc(2, 3, 1.0, 1000.0),
        arc(0, 2, 45.0, 1.0e9),
        arc(1, 3, 45.0, 1.0e9),
        arc(1, 2, 0.1, 1.0e9),
    ];
    let mut n = net(4, edges, &[(0, 3, q / (1.0 - return_share(hour)))]);
    let load = effective(q / (1.0 - return_share(hour)), hour);

    let (vols, pairs, with_link) = run(&mut n, &Scenario::empty(), hour);
    let shortcut = volume_of(&vols, &pairs, 1, 2);
    assert!(
        (shortcut - load).abs() / load < 0.01,
        "everyone takes the shortcut: {shortcut} of {load}"
    );

    // Analytic: 1 + 0.15 * (4000/1000)^4 seconds twice, plus the free link.
    let expected_time = 2.0 * bpr(1.0, 1000.0, load) + 0.1;
    let got_time = (with_link.kpis.vht * 3600.0 / load as f64) as f32;
    assert!(
        (got_time - expected_time).abs() / expected_time < 0.01,
        "with the link a trip takes {got_time} s, analytically {expected_time} s"
    );

    // Close it and the split-equilibrium answer comes back: half on each arm.
    let closed_edge = pairs
        .iter()
        .position(|&p| p == (1, 2))
        .map(|i| EdgeId::from_index(i as u32))
        .expect("the shortcut is loaded");
    let scenario = Scenario {
        edits: vec![Edit::CloseEdge(closed_edge)],
    };
    let (vols, pairs, without_link) = run(&mut n, &scenario, hour);
    let half = volume_of(&vols, &pairs, 0, 1);
    assert!(
        (half - load / 2.0).abs() / (load / 2.0) < 0.01,
        "the arms split evenly: {half} of {load}"
    );
    let expected_time = bpr(1.0, 1000.0, load / 2.0) + 45.0;
    let got_time = (without_link.kpis.vht * 3600.0 / load as f64) as f32;
    assert!(
        (got_time - expected_time).abs() / expected_time < 0.01,
        "without the link a trip takes {got_time} s, analytically {expected_time} s"
    );
    assert!(
        without_link.kpis.vht < with_link.kpis.vht,
        "that is the paradox: {} vs {} vehicle-hours",
        without_link.kpis.vht,
        with_link.kpis.vht
    );
}

/// A `SetEdge` widening pulls traffic onto the edge it widens.
#[test]
fn widening_a_route_attracts_traffic() {
    let hour = Hour::from_index(8);
    let edges = vec![
        arc(0, 1, 60.0, 1200.0),
        arc(1, 3, 0.001, 1.0e9),
        arc(0, 2, 110.0, 3000.0),
        arc(2, 3, 0.001, 1.0e9),
    ];
    let mut n = net(4, edges, &[(0, 3, 4000.0)]);
    let (vols, pairs, _) = run(&mut n, &Scenario::empty(), hour);
    let before = volume_of(&vols, &pairs, 0, 1);

    let widened = pairs
        .iter()
        .position(|&p| p == (0, 1))
        .map(|i| EdgeId::from_index(i as u32))
        .expect("the fast route is loaded");
    let scenario = Scenario {
        edits: vec![Edit::SetEdge {
            edge: widened,
            lanes: None,
            speed_mps: None,
            capacity_vph: Some(4000.0),
        }],
    };
    let (vols, pairs, _) = run(&mut n, &scenario, hour);
    let after = volume_of(&vols, &pairs, 0, 1);
    assert!(after > before * 1.2, "{before} -> {after}");
}
