//! `twin-pipeline` — turns raw open data into the binaries the browser loads.
//!
//! Implements the `ingest-roads`, `cch-order` and `demand` stages of
//! DESIGN.md section 4.

mod arcgis;
mod config;
mod counts;
mod crashes;
mod gis;
mod graph_io;
mod gtfs;
mod lodes;
mod manifest;
mod osm;
mod snap;
mod stages;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use config::{ConfigLayer, DemandLayer, PathsLayer, PipelineConfig, RoadSource, RoadsLayer};
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
    /// Compute the nested-dissection contraction order over the whole graph.
    CchOrder(CommonFlags),
    /// Build zones and the OD matrix, and write demand.bin.
    Demand(DemandFlags),
    /// Normalise county buildings, parcels and zoning for the tile build.
    IngestGis(CommonFlags),
    /// Fold the GTFS feeds into transit.bin.
    IngestGtfs(CommonFlags),
    /// Snap VDOT count stations to edges and write counts.bin.
    IngestCounts(CommonFlags),
    /// Bin VDOT crashes to the grid and to edges, and write feeds.bin.
    IngestCrashes(CommonFlags),
}

/// Flags every post-ingest stage shares: they all read the built graph.
#[derive(Args, Debug)]
struct CommonFlags {
    #[arg(long)]
    out: Option<PathBuf>,
}

#[derive(Args, Debug)]
struct DemandFlags {
    #[command(flatten)]
    common: CommonFlags,
    #[arg(long)]
    raw_dir: Option<PathBuf>,
    /// External zones ringing the study bbox.
    #[arg(long)]
    external_zones: Option<u32>,
    /// Vehicle trips per LODES job.
    #[arg(long)]
    auto_factor: Option<f64>,
    /// Skip LODES and synthesize a gravity model.
    #[arg(long)]
    synthetic: bool,
}

impl From<&CommonFlags> for ConfigLayer {
    fn from(f: &CommonFlags) -> Self {
        Self {
            paths: PathsLayer {
                raw_dir: None,
                out_dir: f.out.clone(),
            },
            ..Default::default()
        }
    }
}

impl From<&DemandFlags> for ConfigLayer {
    fn from(f: &DemandFlags) -> Self {
        Self {
            paths: PathsLayer {
                raw_dir: f.raw_dir.clone(),
                out_dir: f.common.out.clone(),
            },
            demand: DemandLayer {
                external_zones: f.external_zones,
                auto_factor: f.auto_factor,
                // A bare `--synthetic` is an opinion; its absence is not.
                synthetic: f.synthetic.then_some(true),
                ..Default::default()
            },
            ..Default::default()
        }
    }
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
            demand: DemandLayer::default(),
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
    // Highest priority first: flags <- env <- twin.toml <- defaults.
    let resolve = |top: ConfigLayer| -> Result<PipelineConfig> {
        PipelineConfig::resolve([
            top,
            ConfigLayer::from_env()?,
            ConfigLayer::from_toml(&cli.config)?,
            ConfigLayer::defaults(),
        ])
    };
    match &cli.command {
        Command::IngestRoads(flags) => ingest_roads(&resolve(flags.into())?),
        Command::CchOrder(flags) => cch_order(&resolve(flags.into())?),
        Command::Demand(flags) => demand(&resolve(flags.into())?),
        Command::IngestGis(flags) => ingest_gis(&resolve(flags.into())?),
        Command::IngestGtfs(flags) => ingest_gtfs(&resolve(flags.into())?),
        Command::IngestCounts(flags) => ingest_counts(&resolve(flags.into())?),
        Command::IngestCrashes(flags) => ingest_crashes(&resolve(flags.into())?),
    }
}

/// Load the built graph, run one stage over it, and fold the result into the
/// existing manifest rather than rewriting it.
fn post_ingest_stage<T>(
    cfg: &PipelineConfig,
    name: &str,
    run: impl FnOnce(&mut Vec<StageDTO>, &mut graph_io::LoadedGraph) -> Result<(T, FileDTO)>,
    record: impl FnOnce(&mut ManifestDTO, &T),
) -> Result<()> {
    eprintln!("{name}");
    let mut stages: Vec<StageDTO> = Vec::new();
    let mut loaded = stage(&mut stages, "load-graph", || {
        graph_io::load_all(&cfg.out_dir)
    })?;
    eprintln!(
        "    graph                  {} nodes, {} edges, {} chunks",
        loaded.graph.view().nodes().len(),
        loaded.graph.view().edges().len(),
        loaded.entries.len()
    );
    let (out, file) = run(&mut stages, &mut loaded)?;

    let man_path = cfg.out_dir.join("manifest.json");
    let mut man = ManifestDTO::load(&man_path)?;
    man.schema = SchemaVersionsDTO::default();
    man.upsert_files(vec![file]);
    man.upsert_stages(stages);
    record(&mut man, &out);
    man.write(&man_path)?;
    eprintln!("  manifest               {}", man_path.display());
    Ok(())
}

/// The `gis` stage writes GeoJSON for the tile build, not a `*.bin`, so it does
/// not need the graph and does not go through `post_ingest_stage`.
fn ingest_gis(cfg: &PipelineConfig) -> Result<()> {
    eprintln!("ingest-gis");
    let mut stages: Vec<StageDTO> = Vec::new();
    let out = stage(&mut stages, "normalise", || {
        gis::build_gis(&cfg.raw_dir, &cfg.out_dir)
    })?;
    for l in &out.layers {
        eprintln!(
            "    {:<22} {} features, {} attributed",
            l.name, l.features, l.attributed
        );
    }
    for note in &out.notes {
        eprintln!("    {note}");
    }
    let man_path = cfg.out_dir.join("manifest.json");
    let mut man = ManifestDTO::load(&man_path)?;
    man.upsert_stages(stages);
    man.gis = Some(GisInfoDTO {
        layers: out
            .layers
            .iter()
            .map(|l| GisLayerDTO {
                name: l.name.to_string(),
                features: l.features,
                attributed: l.attributed,
            })
            .collect(),
        notes: out.notes,
    });
    man.write(&man_path)?;
    eprintln!("  manifest               {}", man_path.display());
    Ok(())
}

/// Write one GeoJSON sidecar for the tile build next to the binaries.
fn write_geojsonl(cfg: &PipelineConfig, name: &str, body: &str) -> Result<()> {
    let dir = cfg.out_dir.join("gis");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let path = dir.join(format!("{name}.geojsonl"));
    std::fs::write(&path, body).with_context(|| format!("writing {}", path.display()))
}

fn ingest_gtfs(cfg: &PipelineConfig) -> Result<()> {
    post_ingest_stage(
        cfg,
        "ingest-gtfs",
        |stages, loaded| {
            let grid = loaded.grid;
            let out = stage(stages, "patterns+headways", || {
                gtfs::build_gtfs(&cfg.raw_dir, loaded, grid)
            })?;
            for note in &out.notes {
                eprintln!("    {note}");
            }
            eprintln!(
                "    transit                {} stops, {} patterns, agencies [{}], {:.2} MiB",
                out.stop_count,
                out.pattern_count,
                out.agencies.join(", "),
                out.bytes.len() as f64 / (1024.0 * 1024.0)
            );
            let path = cfg.out_dir.join("transit.bin");
            std::fs::write(&path, &out.bytes)
                .with_context(|| format!("writing {}", path.display()))?;
            write_geojsonl(cfg, "transit_routes", &out.routes_geojsonl)?;
            write_geojsonl(cfg, "transit_stops", &out.stops_geojsonl)?;
            let file = FileDTO::of("transit.bin", &out.bytes);
            Ok((out, file))
        },
        |man, out| {
            man.transit = Some(TransitInfoDTO {
                stop_count: out.stop_count,
                pattern_count: out.pattern_count,
                agencies: out.agencies.clone(),
                notes: out.notes.clone(),
            })
        },
    )
}

fn ingest_counts(cfg: &PipelineConfig) -> Result<()> {
    post_ingest_stage(
        cfg,
        "ingest-counts",
        |stages, loaded| {
            let grid = loaded.grid;
            let out = stage(stages, "snap-stations", || {
                counts::build_counts(&cfg.raw_dir, loaded, grid)
            })?;
            for note in &out.notes {
                eprintln!("    {note}");
            }
            eprintln!(
                "    counts                 {} stations, {} snapped, {} vintage",
                out.station_count, out.snapped, out.year
            );
            let path = cfg.out_dir.join("counts.bin");
            std::fs::write(&path, &out.bytes)
                .with_context(|| format!("writing {}", path.display()))?;
            write_geojsonl(cfg, "counts", &out.geojsonl)?;
            let file = FileDTO::of("counts.bin", &out.bytes);
            Ok((out, file))
        },
        |man, out| {
            man.traffic_counts = Some(CountsInfoDTO {
                station_count: out.station_count,
                snapped: out.snapped,
                year: out.year,
                notes: out.notes.clone(),
            })
        },
    )
}

fn ingest_crashes(cfg: &PipelineConfig) -> Result<()> {
    let bbox = cfg.bbox;
    post_ingest_stage(
        cfg,
        "ingest-crashes",
        |stages, loaded| {
            let grid = loaded.grid;
            let out = stage(stages, "bin-crashes", || {
                crashes::build_crashes(&cfg.raw_dir, loaded, bbox, grid)
            })?;
            for note in &out.notes {
                eprintln!("    {note}");
            }
            eprintln!(
                "    crashes                {} points {}-{}, {} cells, {} edges",
                out.crash_count, out.years.0, out.years.1, out.cell_count, out.edge_count
            );
            let path = cfg.out_dir.join("feeds.bin");
            std::fs::write(&path, &out.bytes)
                .with_context(|| format!("writing {}", path.display()))?;
            write_geojsonl(cfg, "crashes", &out.points_geojsonl)?;
            write_geojsonl(cfg, "crash_grid", &out.grid_geojsonl)?;
            let file = FileDTO::of("feeds.bin", &out.bytes);
            Ok((out, file))
        },
        |man, out| {
            man.feeds = Some(FeedsInfoDTO {
                crash_count: out.crash_count,
                cell_count: out.cell_count,
                edge_count: out.edge_count,
                year_min: out.years.0,
                year_max: out.years.1,
                notes: out.notes.clone(),
            })
        },
    )
}

fn cch_order(cfg: &PipelineConfig) -> Result<()> {
    post_ingest_stage(
        cfg,
        "cch-order",
        |stages, loaded| {
            let out = stage(stages, "nested-dissection", || {
                stages::build_cch_order(loaded)
            })?;
            let path = cfg.out_dir.join("cch_order.bin");
            std::fs::write(&path, &out.bytes)
                .with_context(|| format!("writing {}", path.display()))?;
            eprintln!(
                "    order                  {} nodes, {:?}, {:.2} MiB",
                out.node_count,
                out.kind,
                out.bytes.len() as f64 / (1024.0 * 1024.0)
            );
            let file = FileDTO::of("cch_order.bin", &out.bytes);
            Ok((out, file))
        },
        |man, out| {
            man.cch_order = Some(CchOrderInfoDTO {
                node_count: out.node_count,
                kind: format!("{:?}", out.kind),
            })
        },
    )
}

fn demand(cfg: &PipelineConfig) -> Result<()> {
    post_ingest_stage(
        cfg,
        "demand",
        |stages, loaded| {
            let out = stage(stages, "zones+od", || stages::build_demand(cfg, loaded))?;
            for note in &out.notes {
                eprintln!("    {note}");
            }
            let path = cfg.out_dir.join("demand.bin");
            std::fs::write(&path, &out.bytes)
                .with_context(|| format!("writing {}", path.display()))?;
            let zones_path = cfg.out_dir.join("zones.csv");
            std::fs::write(&zones_path, &out.zones_csv)
                .with_context(|| format!("writing {}", zones_path.display()))?;
            eprintln!(
                "    demand                 {} zones ({} internal), {} OD cells, {:.2} MiB{}",
                out.zone_count,
                out.external_start,
                out.od_count,
                out.bytes.len() as f64 / (1024.0 * 1024.0),
                if out.is_synthetic { " [SYNTHETIC]" } else { "" }
            );
            let file = FileDTO::of("demand.bin", &out.bytes);
            Ok((out, file))
        },
        |man, out| {
            man.demand = Some(DemandInfoDTO {
                zone_count: out.zone_count,
                external_zone_start: out.external_start,
                od_count: out.od_count,
                is_synthetic: out.is_synthetic,
                notes: out.notes.clone(),
            })
        },
    )
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
    let source = cfg.road_source()?;
    eprintln!("  source                 {source:?}");
    eprintln!(
        "  bbox                   {},{},{},{}",
        cfg.bbox.west, cfg.bbox.south, cfg.bbox.east, cfg.bbox.north
    );
    let mut stages: Vec<StageDTO> = Vec::new();

    let parsed = stage(&mut stages, "parse", || match source {
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
        // A fresh network invalidates both; they are rebuilt by their stages.
        demand: None,
        cch_order: None,
        gis: None,
        transit: None,
        traffic_counts: None,
        feeds: None,
    };
    let man_path = cfg.out_dir.join("manifest.json");
    man.write(&man_path)?;

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
