//! One-off timing of an hour against the real `data/build` output.
//!
//!   cargo run --release -p twin-bench --bin hour [study-area radius in chunks]
//!
//! With no argument the whole county is loaded. With `r`, only the
//! `(2r+1) x (2r+1)` block of chunks around the densest cell is, which is how
//! the default study area was sized. Prints a small table; the criterion suite
//! in `benches/` is the regression gate.

use std::time::Instant;
use twin_core::assign::{assign, AssignParams};
use twin_core::demand::DemandSchema;
use twin_core::graph_schema::GraphChunkSchema;
use twin_core::schema::AlignedBytes;
use twin_core::*;

fn main() {
    let out = std::path::Path::new("data/build");
    let index_bytes =
        AlignedBytes::adopt(std::fs::read(out.join("graph/index.bin")).expect("index.bin"));
    let index = GraphIndexSchema::decode(&index_bytes).expect("index decodes");
    let entries = index.chunks.to_vec();

    // Optional study area: the square block of chunks around the densest cell.
    let radius: Option<u32> = std::env::args().nth(1).and_then(|a| a.parse().ok());
    let centre = entries
        .iter()
        .max_by_key(|e| e.node_count)
        .expect("the index has chunks");
    let wanted: Vec<&ChunkEntrySchema> = entries
        .iter()
        .filter(|e| match radius {
            None => true,
            Some(r) => e.cx.abs_diff(centre.cx) <= r && e.cy.abs_diff(centre.cy) <= r,
        })
        .collect();

    let t0 = Instant::now();
    let mut graph = RoadGraph::new();
    let buffers: Vec<AlignedBytes> = wanted
        .iter()
        .map(|e| {
            AlignedBytes::adopt(
                std::fs::read(out.join(format!("graph/chunk_{}_{}.bin", e.cx, e.cy)))
                    .expect("chunk"),
            )
        })
        .collect();
    for b in &buffers {
        graph
            .add_chunk(&GraphChunkSchema::decode(b).expect("chunk decodes"))
            .expect("adds");
    }
    let load_ms = t0.elapsed().as_secs_f64() * 1e3;

    let demand_bytes = AlignedBytes::adopt(std::fs::read(out.join("demand.bin")).expect("demand"));
    let demand = DemandSchema::decode(&demand_bytes).expect("demand decodes");

    let view = ScenarioView::apply(graph.view(), &Scenario::empty());
    println!(
        "study area: {} of {} chunks{}",
        wanted.len(),
        entries.len(),
        radius.map_or(String::new(), |r| format!(
            " (radius {r} around cell {},{})",
            centre.cx, centre.cy
        ))
    );
    println!(
        "graph {} nodes {} edges | demand {} zones {} od cells | load {load_ms:.0} ms",
        view.node_count(),
        view.edge_count(),
        demand.zone_count(),
        demand.od.len()
    );

    let mut warm: Option<Vec<f32>> = None;
    for hour in [
        Hour::from_index(8),
        Hour::from_index(9),
        Hour::from_index(17),
    ] {
        let t = Instant::now();
        let r = assign(
            &view,
            &demand,
            hour,
            warm.as_deref(),
            &AssignParams::default(),
        );
        println!(
            "hour {:>2}  {:>7.0} ms  {} iters  gap {:.2e}  vmt {:.0}  vht {:.0}  mean delay {:.1} s",
            hour.raw(),
            t.elapsed().as_secs_f64() * 1e3,
            r.iterations,
            r.rel_gap,
            r.kpis.vmt,
            r.kpis.vht,
            r.kpis.mean_delay_s
        );
        warm = Some(r.volume);
    }
}
