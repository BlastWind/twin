//! `twin-pipeline` — turns raw open data into the binaries the browser loads.
//!
//! Phase 1 implements the `ingest-roads` stage of DESIGN.md section 4.

mod config;
mod manifest;
mod osm;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use config::{ConfigLayer, PathsLayer, PipelineConfig, RoadSource, RoadsLayer};
use manifest::*;
use std::path::{Path, PathBuf};
use std::time::Instant;
use twin_core::*;

#[derive(Parser, Debug)]
#[command(
    name = "twin-pipeline",
    about = "Build the twin data artifacts.",
    version
)]
struct Cli {
    /// Optional config file; missing is fine.
    #[arg(long, default_value = "twin.toml", global = true)]
    config: PathBuf,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Parse a road network, chunk it, and write graph/*.bin + manifest.json.
    IngestRoads(IngestRoadsFlags),
}

/// The CLI layer of the config stack: every field optional, so an unset flag
/// stays silent and lets `twin.toml` or the defaults speak.
#[derive(Args, Debug)]
struct IngestRoadsFlags {
    #[arg(long)]
    pbf: Option<PathBuf>,
    /// `w,s,e,n` in degrees.
    #[arg(long)]
    bbox: Option<String>,
    #[arg(long)]
    out: Option<PathBuf>,
    /// Grid cell size in metres.
    #[arg(long)]
    cell_m: Option<f64>,
    /// Build an N x N lattice instead of reading a PBF. Lets everything be
    /// exercised with no network and no data download.
    #[arg(long)]
    synthetic_grid: Option<u32>,
    #[arg(long)]
    keep_service: Option<bool>,
    #[arg(long)]
    simplify: Option<bool>,
}

impl From<&IngestRoadsFlags> for ConfigLayer {
    fn from(f: &IngestRoadsFlags) -> Self {
        Self {
            paths: PathsLayer {
                raw_dir: None,
                out_dir: f.out.clone(),
            },
            roads: RoadsLayer {
                pbf: f.pbf.clone(),
                bbox: f.bbox.clone(),
                cell_m: f.cell_m,
                simplify: f.simplify,
                keep_service: f.keep_service,
                synthetic_grid: f.synthetic_grid,
            },
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match &cli.command {
        Command::IngestRoads(flags) => {
            // Highest priority first: flags <- env <- twin.toml <- defaults.
            let cfg = PipelineConfig::resolve([
                ConfigLayer::from(flags),
                ConfigLayer::from_env()?,
                ConfigLayer::from_toml(&cli.config)?,
                ConfigLayer::defaults(),
            ])?;
            ingest_roads(&cfg)
        }
    }
}

/// Times one stage and reports it, keeping the timing plumbing out of the
/// stage bodies.
fn stage<T>(log: &mut Vec<StageDTO>, name: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let t0 = Instant::now();
    let out = f()?;
    let ms = t0.elapsed().as_millis();
    log.push(StageDTO {
        name: name.to_string(),
        ms,
    });
    eprintln!("  {name:<22} {ms:>7} ms");
    Ok(out)
}

fn ingest_roads(cfg: &PipelineConfig) -> Result<()> {
    eprintln!("ingest-roads");
    eprintln!("  source                 {:?}", cfg.source);
    eprintln!(
        "  bbox                   {},{},{},{}",
        cfg.bbox.west, cfg.bbox.south, cfg.bbox.east, cfg.bbox.north
    );
    let mut stages: Vec<StageDTO> = Vec::new();

    let parsed = stage(&mut stages, "parse", || match &cfg.source {
        RoadSource::SyntheticGrid(n) => Ok(RawGraph::synthetic_grid(*n, cfg.bbox)),
        RoadSource::Pbf(path) => {
            // A bare filename is looked up in the raw-data directory.
            let path = if path.exists() {
                path.clone()
            } else {
                cfg.raw_dir.join(path)
            };
            let (g, s) = osm::read_pbf(&path, cfg.bbox, cfg.keep_service)?;
            eprintln!(
                "    ways {} nodes {} segments {} dropped {}",
                s.ways_kept, s.nodes_resolved, s.segments, s.dropped_outside_bbox
            );
            Ok(g)
        }
    })?;
    eprintln!(
        "    parsed                 {} nodes, {} edges",
        parsed.nodes.len(),
        parsed.edges.len()
    );

    let simplified = stage(&mut stages, "simplify-degree2", || {
        let g = if cfg.simplify {
            simplify_degree2(&parsed)
        } else {
            parsed.clone()
        };
        Ok(osm::prune_isolated(&g))
    })?;
    eprintln!(
        "    simplified             {} nodes, {} edges",
        simplified.nodes.len(),
        simplified.edges.len()
    );

    let grid = GridSchema::cover(cfg.bbox, cfg.cell_m);
    let part = stage(&mut stages, "partition", || {
        Ok(partition(&simplified, &grid))
    })?;
    eprintln!(
        "    grid                   {}x{} cells, {} non-empty",
        grid.cols,
        grid.rows,
        part.chunks.len()
    );

    let (files, counts) = stage(&mut stages, "encode+write", || write_graph(cfg, &part))?;

    let man = ManifestDTO {
        manifest_version: 1,
        schema: SchemaVersionsDTO::default(),
        bbox: bbox_array(&cfg.bbox),
        grid: GridDTO::from(&part.grid),
        counts,
        stages: stages.clone(),
        files: files.clone(),
    };
    let man_path = cfg.out_dir.join("manifest.json");
    std::fs::write(&man_path, serde_json::to_vec_pretty(&man)?)
        .with_context(|| format!("writing {}", man_path.display()))?;

    let total: u64 = files.iter().map(|f| f.bytes).sum();
    eprintln!(
        "  wrote                  {} files, {} nodes, {} edges, {} chunks, {} border edges, {:.2} MiB",
        files.len(),
        counts.nodes,
        counts.edges,
        counts.chunks,
        counts.border_edges,
        total as f64 / (1024.0 * 1024.0)
    );
    eprintln!("  manifest               {}", man_path.display());
    Ok(())
}

/// Encode the index and every chunk, write them, and report sizes.
fn write_graph(cfg: &PipelineConfig, part: &Partition) -> Result<(Vec<FileDTO>, CountsDTO)> {
    let graph_dir = cfg.out_dir.join("graph");
    std::fs::create_dir_all(&graph_dir)
        .with_context(|| format!("creating {}", graph_dir.display()))?;

    let index_bytes = GraphIndexSchema::encode(&part.grid, &part.entries);
    let mut files = vec![write_file(
        &graph_dir.join("index.bin"),
        "graph/index.bin",
        &index_bytes,
    )?];

    let mut border_edges = 0u64;
    for (entry, build) in part.entries.iter().zip(&part.chunks) {
        let bytes = build.encode();
        let name = format!("chunk_{}_{}.bin", entry.cx, entry.cy);
        files.push(write_file(
            &graph_dir.join(&name),
            format!("graph/{name}"),
            &bytes,
        )?);
        border_edges += build.border_edge_count() as u64;
    }

    let counts = CountsDTO {
        nodes: part.entries.iter().map(|e| e.node_count as u64).sum(),
        edges: part.entries.iter().map(|e| e.edge_count as u64).sum(),
        chunks: part.chunks.len() as u64,
        // Each border edge is mirrored into both of its cells.
        border_edges: border_edges / 2,
    };
    Ok((files, counts))
}

fn write_file(path: &Path, rel: impl Into<String>, bytes: &[u8]) -> Result<FileDTO> {
    std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))?;
    Ok(FileDTO::of(rel, bytes))
}
