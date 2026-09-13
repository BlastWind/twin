//! Criterion benches for the Phase 1 hot paths, on synthetic grids sized to
//! DESIGN.md section 8: E ~= 10k / 50k / 200k.
//!
//! `E = 4n(n-1)` for an `n * n` lattice, so n = 51 / 113 / 224.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use std::hint::black_box;
use twin_core::graph_schema::{build_csr, GraphChunkSchema};
use twin_core::schema::AlignedBytes;
use twin_core::*;

/// (label, lattice side) pairs giving roughly the target edge counts.
const SIZES: [(&str, u32); 3] = [("e10k", 51), ("e50k", 113), ("e200k", 224)];

fn bbox() -> BBox {
    BBox::new(-77.54, 38.60, -77.04, 39.06).expect("bbox is well formed")
}

struct Fixture {
    encoded: Vec<AlignedBytes>,
    edge_count: u64,
}

fn fixture(n: u32) -> Fixture {
    let raw = RawGraph::synthetic_grid(n, bbox());
    let grid = GridSchema::cover(bbox(), DEFAULT_CELL_M);
    let part = partition(&raw, &grid);
    let encoded = part
        .chunks
        .iter()
        .map(|c| AlignedBytes::adopt(c.encode()))
        .collect();
    Fixture {
        edge_count: raw.edges.len() as u64,
        encoded,
    }
}

/// Decode every chunk of the build. Should be ~free: it only walks section
/// tables and forms slices.
fn bench_decode(c: &mut Criterion) {
    let mut group = c.benchmark_group("schema_decode");
    for (label, n) in SIZES {
        let f = fixture(n);
        group.throughput(Throughput::Elements(f.edge_count));
        group.bench_with_input(BenchmarkId::from_parameter(label), &f, |b, f| {
            b.iter(|| {
                for buf in &f.encoded {
                    black_box(GraphChunkSchema::decode(buf).expect("decodes"));
                }
            })
        });
    }
    group.finish();
}

/// Full assembly: decode every chunk and fold it into a `RoadGraph`. This is
/// the browser's cold-load path.
fn bench_chunk_add(c: &mut Criterion) {
    let mut group = c.benchmark_group("chunk_add_all");
    group.sample_size(20);
    for (label, n) in SIZES {
        let f = fixture(n);
        group.throughput(Throughput::Elements(f.edge_count));
        group.bench_with_input(BenchmarkId::from_parameter(label), &f, |b, f| {
            b.iter(|| {
                let mut g = RoadGraph::new();
                for buf in &f.encoded {
                    let chunk = GraphChunkSchema::decode(buf).expect("decodes");
                    g.add_chunk(&chunk).expect("adds");
                }
                black_box(g.view().edges().len())
            })
        });
    }
    group.finish();
}

/// Evicting one chunk from a fully loaded graph and putting it back: the
/// study-area churn path.
fn bench_chunk_remove(c: &mut Criterion) {
    let mut group = c.benchmark_group("chunk_remove_add_one");
    group.sample_size(20);
    for (label, n) in SIZES {
        let f = fixture(n);
        let decoded: Vec<GraphChunkSchema> = f
            .encoded
            .iter()
            .map(|b| GraphChunkSchema::decode(b).expect("decodes"))
            .collect();
        let mut base = RoadGraph::from_chunks(decoded.iter()).expect("assembles");
        base.view();
        let victim = decoded[decoded.len() / 2].chunk_id();
        group.throughput(Throughput::Elements(f.edge_count));
        group.bench_function(BenchmarkId::from_parameter(label), |b| {
            b.iter_batched(
                || base.clone(),
                |mut g| {
                    g.remove_chunk(victim);
                    g.add_chunk(&decoded[decoded.len() / 2]).expect("re-adds");
                    black_box(g.view().boundary_edge_count())
                },
                criterion::BatchSize::SmallInput,
            )
        });
    }
    group.finish();
}

/// The counting-sort CSR build in isolation.
fn bench_csr(c: &mut Criterion) {
    let mut group = c.benchmark_group("csr_build");
    for (label, n) in SIZES {
        let raw = RawGraph::synthetic_grid(n, bbox());
        let tails: Vec<u32> = raw.edges.iter().map(|e| e.from).collect();
        let node_count = raw.nodes.len();
        group.throughput(Throughput::Elements(tails.len() as u64));
        group.bench_function(BenchmarkId::from_parameter(label), |b| {
            b.iter(|| black_box(build_csr(node_count, tails.iter().copied())))
        });
    }
    group.finish();
}

/// Degree-2 simplification, the pipeline's dominant CPU cost after parsing.
fn bench_simplify(c: &mut Criterion) {
    let mut group = c.benchmark_group("simplify_degree2");
    group.sample_size(20);
    for (label, n) in SIZES {
        let raw = RawGraph::synthetic_grid(n, bbox());
        group.throughput(Throughput::Elements(raw.edges.len() as u64));
        group.bench_function(BenchmarkId::from_parameter(label), |b| {
            b.iter(|| black_box(simplify_degree2(&raw).nodes.len()))
        });
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_decode,
    bench_chunk_add,
    bench_chunk_remove,
    bench_csr,
    bench_simplify
);
criterion_main!(benches);
