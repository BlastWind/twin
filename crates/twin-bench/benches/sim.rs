//! Criterion benches for the Phase 2 hot paths: CCH customization, one-to-many
//! skims, one equilibrium iteration and a whole hour.
//!
//! Fixtures are synthetic lattices at E ~= 10k / 50k / 200k (DESIGN.md section
//! 8) plus, when `data/build` exists, the real county graph and its LODES
//! demand.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use std::hint::black_box;
use std::path::Path;
use twin_core::assign::{all_or_nothing_pass, assign, free_flow_costs, AssignParams};
use twin_core::demand::{DemandMetaSchema, DemandSchema, OdTripleSchema, NHTS_HOUR_PROFILE};
use twin_core::graph_schema::GraphChunkSchema;
use twin_core::schema::AlignedBytes;
use twin_core::*;

/// `E = 4n(n-1)` for an `n * n` lattice, so n = 51 / 113 / 224.
const SIZES: [(&str, u32); 3] = [("e10k", 51), ("e50k", 113), ("e200k", 224)];

/// Zones per synthetic fixture. Held constant across sizes so the curves show
/// the graph's contribution, not the matrix's.
const SYNTHETIC_ZONES: usize = 100;

fn bbox() -> BBox {
    BBox::new(-77.54, 38.60, -77.04, 39.06).expect("bbox is well formed")
}

/// A graph, its demand, and the buffers both borrow from.
struct Fixture {
    graph: RoadGraph,
    demand_bytes: AlignedBytes,
    _chunks: Vec<AlignedBytes>,
}

impl Fixture {
    fn hour(&self) -> Hour {
        Hour::from_index(8)
    }
}

/// Every node id, spread evenly, becomes a zone; the matrix is uniform so no
/// single corridor dominates.
fn synthetic_demand(graph: &mut RoadGraph, zones: usize, trips_each: f32) -> AlignedBytes {
    let ids: Vec<u32> = {
        let view = graph.view();
        let n = view.nodes().len();
        let step = (n / zones).max(1);
        (0..zones)
            .filter_map(|k| view.nodes().get(k * step).map(|node| node.id.raw()))
            .collect()
    };
    let z = ids.len();
    let od: Vec<OdTripleSchema> = (0..z)
        .flat_map(|o| {
            (0..z).filter_map(move |d| {
                (o != d).then_some(OdTripleSchema {
                    origin: o as u16,
                    dest: d as u16,
                    trips: trips_each,
                })
            })
        })
        .collect();
    let meta = DemandMetaSchema {
        zone_count: z as u32,
        od_count: od.len() as u32,
        external_zone_start: z as u32,
        is_synthetic: 1,
    };
    AlignedBytes::adopt(DemandSchema::encode(
        meta,
        &ids,
        &vec![[0.0, 0.0]; z],
        &od,
        &NHTS_HOUR_PROFILE,
    ))
}

fn synthetic_fixture(n: u32) -> Fixture {
    let raw = RawGraph::synthetic_grid(n, bbox());
    let grid = GridSchema::cover(bbox(), DEFAULT_CELL_M);
    let part = partition(&raw, &grid);
    let chunks: Vec<AlignedBytes> = part
        .chunks
        .iter()
        .map(|c| AlignedBytes::adopt(c.encode()))
        .collect();
    let decoded: Vec<GraphChunkSchema<'_>> = chunks
        .iter()
        .map(|b| GraphChunkSchema::decode(b).expect("decodes"))
        .collect();
    let mut graph = RoadGraph::from_chunks(decoded.iter()).expect("assembles");
    let demand_bytes = synthetic_demand(&mut graph, SYNTHETIC_ZONES, 40.0);
    Fixture {
        graph,
        demand_bytes,
        _chunks: chunks,
    }
}

/// Where the pipeline's output lives. Criterion runs a bench with the crate
/// directory as the working directory, not the workspace root, so the manifest
/// path is the reliable anchor.
fn build_dir() -> Option<std::path::PathBuf> {
    [
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/build"),
        Path::new("data/build").to_path_buf(),
    ]
    .into_iter()
    .find(|p| p.join("graph/index.bin").exists())
}

/// The real build output, if `twin-pipeline` has been run.
fn county_fixture() -> Option<Fixture> {
    let out = build_dir()?;
    let index_bytes = AlignedBytes::adopt(std::fs::read(out.join("graph/index.bin")).ok()?);
    let entries = GraphIndexSchema::decode(&index_bytes).ok()?.chunks.to_vec();
    let chunks: Vec<AlignedBytes> = entries
        .iter()
        .map(|e| {
            std::fs::read(out.join(format!("graph/chunk_{}_{}.bin", e.cx, e.cy)))
                .ok()
                .map(AlignedBytes::adopt)
        })
        .collect::<Option<_>>()?;
    let mut graph = RoadGraph::new();
    for b in &chunks {
        graph.add_chunk(&GraphChunkSchema::decode(b).ok()?).ok()?;
    }
    let demand_bytes = AlignedBytes::adopt(std::fs::read(out.join("demand.bin")).ok()?);
    DemandSchema::decode(&demand_bytes).ok()?;
    Some(Fixture {
        graph,
        demand_bytes,
        _chunks: chunks,
    })
}

/// Every fixture to bench: the three lattices, plus the county when it exists.
fn fixtures() -> Vec<(String, Fixture)> {
    let mut all: Vec<(String, Fixture)> = SIZES
        .iter()
        .map(|(label, n)| (label.to_string(), synthetic_fixture(*n)))
        .collect();
    if let Some(f) = county_fixture() {
        all.push(("county".to_string(), f));
    }
    all
}

/// Re-pricing the hierarchy, which an equilibrium iteration would do once.
fn bench_cch_customize(c: &mut Criterion) {
    let mut group = c.benchmark_group("cch_customize");
    group.sample_size(10);
    for (label, mut f) in fixtures() {
        let view = ScenarioView::apply(f.graph.view(), &Scenario::empty());
        let order = order_for(&view);
        let mut skim = Skim::build(&view, &order);
        let cost = free_flow_costs(&view);
        group.bench_with_input(BenchmarkId::from_parameter(&label), &cost, |b, cost| {
            b.iter(|| skim.customize_seconds(black_box(cost)))
        });
    }
    group.finish();
}

/// One-to-many from a single origin to every zone node.
fn bench_cch_one_to_many(c: &mut Criterion) {
    let mut group = c.benchmark_group("cch_one_to_many");
    group.sample_size(20);
    for (label, mut f) in fixtures() {
        let demand = DemandSchema::decode(&f.demand_bytes).expect("demand decodes");
        let view = ScenarioView::apply(f.graph.view(), &Scenario::empty());
        let order = order_for(&view);
        let mut skim = Skim::build(&view, &order);
        skim.customize_seconds(&free_flow_costs(&view));
        let targets: Vec<u32> = demand
            .zone_node
            .iter()
            .filter_map(|&gid| NodeId::new(gid).and_then(|n| view.index_of_node(n)))
            .collect();
        let source = targets.first().copied().unwrap_or(0);
        group.bench_with_input(BenchmarkId::from_parameter(&label), &targets, |b, t| {
            b.iter(|| black_box(skim.distances(source, t)))
        });
    }
    group.finish();
}

/// One all-or-nothing pass: the inner half of a Frank-Wolfe iteration, and the
/// part that scales with the zone count.
fn bench_aon(c: &mut Criterion) {
    let mut group = c.benchmark_group("aon_pass");
    group.sample_size(10);
    for (label, mut f) in fixtures() {
        let hour = f.hour();
        let demand = DemandSchema::decode(&f.demand_bytes).expect("demand decodes");
        let view = ScenarioView::apply(f.graph.view(), &Scenario::empty());
        let cost = free_flow_costs(&view);
        group.bench_function(BenchmarkId::from_parameter(&label), |b| {
            b.iter(|| black_box(all_or_nothing_pass(&view, &demand, hour, &cost)))
        });
    }
    group.finish();
}

/// One equilibrium iteration: the seeding pass plus one descent step.
fn bench_bfw_iteration(c: &mut Criterion) {
    let mut group = c.benchmark_group("bfw_iteration");
    group.sample_size(10);
    let params = AssignParams {
        max_iters: 1,
        gap_tol: 0.0,
        ..AssignParams::default()
    };
    for (label, mut f) in fixtures() {
        let hour = f.hour();
        let demand = DemandSchema::decode(&f.demand_bytes).expect("demand decodes");
        let view = ScenarioView::apply(f.graph.view(), &Scenario::empty());
        group.bench_function(BenchmarkId::from_parameter(&label), |b| {
            b.iter(|| black_box(assign(&view, &demand, hour, None, &params)))
        });
    }
    group.finish();
}

/// A whole hour on the shipped budget: what a scenario run costs.
fn bench_hour(c: &mut Criterion) {
    let mut group = c.benchmark_group("hour_assignment");
    group.sample_size(10);
    for (label, mut f) in fixtures() {
        let hour = f.hour();
        let demand = DemandSchema::decode(&f.demand_bytes).expect("demand decodes");
        let view = ScenarioView::apply(f.graph.view(), &Scenario::empty());
        group.bench_function(BenchmarkId::from_parameter(&label), |b| {
            b.iter(|| black_box(assign(&view, &demand, hour, None, &AssignParams::default())))
        });
    }
    group.finish();
}

/// The pipeline stores an order in global ids; a bench just recomputes one over
/// the dense ids it has.
fn order_for(view: &ScenarioView<'_>) -> Vec<u32> {
    let g = view.graph();
    let (lon, lat): (Vec<f32>, Vec<f32>) = g.nodes().iter().map(|n| (n.lon, n.lat)).unzip();
    let (tail, head): (Vec<u32>, Vec<u32>) = g.edges().iter().map(|e| (e.from, e.to)).unzip();
    nested_dissection_order(g.nodes().len() as u32, &tail, &head, &lat, &lon)
}

criterion_group!(
    benches,
    bench_cch_customize,
    bench_cch_one_to_many,
    bench_aon,
    bench_bfw_iteration,
    bench_hour
);
criterion_main!(benches);
