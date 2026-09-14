# Build plan

Phases are sequential; tracks within a phase are parallel and touch disjoint paths.

## Phase 1 — foundation
- Track R (Rust): workspace; `twin-core` ids, `GraphIndexSchema`/`GraphChunkSchema` (bytemuck, versioned header), chunk assembly into `RoadGraph`; `twin-pipeline` `ingest-roads` from OSM PBF (county bbox) -> chunked graph files + manifest; `cch` wasm32 build check (fallback `fast_paths`); `twin-wasm` exposing `load_index`, `load_chunk`, `free_chunk`, `stats`; `twin-bench` criterion for decode + chunk merge with synthetic grids.
- Track W (web): Vite+React+TS+Zustand; MapLibre + PMTiles protocol; Planetiler build script for county roads/buildings from the same PBF; layer registry with zoom LOD; `AssetLoader` (LRU, priority, abort, Cache Storage); worker host + DTO codecs with a stub worker; Playwright perf harness (first tile, first paint, fps path, heap) writing `bench/baselines.json`.

## Phase 2 — sim
- CCH order in pipeline; BFW assignment with BPR in `twin-core`; demand from LODES+ACS; `run_hour`/`run_all_hours` in wasm; result overlay in deck.gl; study-area selection; KPI dashboard.

## Phase 3 — county GIS + transit + feeds
- County buildings w/ heights, parcels, zoning into tiles; GTFS ingest + isochrones; VDOT counts + crashes; calibration view.

## Phase 2 outcome (2026-09-13)
- Real LODES demand (1,415 zones), CCH order, BFW solver, real wasm end to end. Default study area is a radius-4 chunk block around Fairfax City: hour-8 run 2.69 s in browser (36k edges). County-wide is 83 s in wasm, 8 s native 16-thread; UI warns above 60k edges.
- fps baselines are null: headless swiftshader cannot measure; needs a GPU run.

## Phase 2.5 — county-wide budget (before Phase 3)
1. CCH tree extraction (fork/extend `cch`) so AON loading uses one-to-many with parents; biggest win.
2. Zone aggregation to ~400 zones for county runs.
3. Threaded wasm via wasm-bindgen-rayon + COOP/COEP headers.
4. AddEdge support in the solver and editor.

## Phase 2.5 + Phase 3 contracts (2026-09-13)
Ownership: 2.5 agent owns `twin-core` solver/graph files, `twin-wasm/src/lib.rs`, `twin-bench`. Phase 3 pipeline agent owns `twin-pipeline`, `scripts/`, new files `twin-core/src/{transit,feeds,counts}.rs`, `twin-wasm/src/transit.rs`. Phase 3 web agent owns `web/`.

Tile layers (world.pmtiles): `buildings` (height m from county GIS, fallback OSM), `parcels` (parcel_id, zone, land_use, assessed_value, area_m2), `zoning` (zone, category), `transit_routes` (route_id, agency, short_name, color), `transit_stops` (stop_id, name), `crashes` (year, severity 1-5, lon/lat; z12+ points, `crash_grid` below), `counts` (station_id, aadt, year).

Binaries: `transit.bin` (TransitSchema: stops[node_id, lonlat], patterns[stop idx seq], per-pattern per-hour headway_s + run_s per hop), `counts.bin` (station_id, edge_id nearest, aadt), `feeds.bin` (crash points binned to grid + nearest edge). All via the existing header/section-table format; new section kinds ≥ 40.

wasm (transit.rs): `loadTransit(bytes)`, `isochrone(lon, lat, hour, budgetMin) -> Float32Array` of [node_id, seconds] pairs, `reachSummary() -> string` JSON `{nodes, population}`. `loadCounts(bytes)`, `calibration() -> string` JSON `[{station_id, edge_id, aadt, modeled_daily}]` computed from the last 24h results.

wasm threads (2.5): if wasm-bindgen-rayon is adopted, the web app must serve `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; web agent adds these to vite config now.

## Phase 3 pipeline outcome (2026-09-13)
Real county data end to end. Buildings 282,839, about 90 % of them with a height
(LiDAR `BLDG_HEIGHT` in feet, or roof minus ground elevation where the 2024
planimetric batch left it null); parcels 369,395 joined across three tables on
the parcel id, effectively all with land use and assessed value; zoning 6,444.
Transit 3,304 stops and 218 patterns from Fairfax Connector and CUE; WMATA needs
`TWIN_WMATA_KEY` and is skipped without it. VDOT 2023 AADT 26,051 stations,
25,999 snapped within 250 m. TREDS crashes 79,626 for 2023-2026, 10,242 grid
cells, 26,003 edges. `world.pmtiles` is 98 MiB with all ten layers.

## Phase 2.5 outcome (2026-09-13)

County hour 08 went from 83.8 s serial / 13.3 s on 16 threads to 10.4 s / 2.5 s,
and to **1.7 s warm in the browser** on 8 threads with coarse zones (3.4 s
cold). The 2 s target is met only under those settings; full zoning in the
browser is 3.2 s warm at best, and the single-threaded build does not fit at any
zoning. `crates/twin-bench/README.md` has the table and the per-change
attribution.

1. CCH tree extraction: done without forking `cch`. A PHAST-style one-to-all
   sweep over the public `CchView`/`MetricView`, and the tree recovered from the
   distances (`dist[u] + w == dist[v]`, exact on integer weights) by a
   generation-stamped back-walk, so no shortcut is ever unpacked. 8.5 ms -> 1.0 ms
   per origin on the county.
2. Zone aggregation: `Zoning::Coarse`, ~400 clusters, exposed as
   `runHour`'s `{"zones": "full" | "coarse"}`. VMT moves 0.9 %.
3. Threads: `wasm-bindgen-rayon` behind a `threads` feature; both variants build
   to `web/public/wasm` and `web/public/wasm-mt`. COOP/COEP requirements are in
   `crates/twin-wasm/README.md`. ~5x out of 8 threads.
4. AddEdge: overlay edges with ids from a reserved range; the hierarchy is
   rebuilt for the new arc set (~100 ms) rather than approximated.

Still open: a cold county run is 3.4 s, of which ~0.6 s is the hierarchy build,
which nothing yet caches across sessions.

## Phase 2.5 / 3 outcome — web (2026-09-13)

Integration pass against the merged tree: both wasm builds rebuilt from it, the
real 98 MiB `world.pmtiles`, `transit.bin`, `counts.bin`, `feeds.bin`.

- All ten tile layers are probed from the archive's `vector_layers` and all nine
  registry layers report available; at z15 every one of them renders features
  (`crash_grid` is empty there by design — it hands over to the points at z12).
- `crossOriginIsolated` is true under the vite headers, `/wasm-mt/` loads and
  `threadCount()` reports 16. Isochrone, reach summary and calibration all run
  against the real backend; nothing in the app is on a stub any more.
- County (coarse), driven from the preset button: 165,545 edges, first hour
  7.7 s including the chunk load and the hierarchy build, warm hours 4.5 s.
  That is above the 1.7 s native figure — the browser is running under
  swiftshader on a shared machine — so the study-area estimate is anchored on
  the native numbers and the measured browser figure is recorded here.
- Two integration breakages, both fixed on the web side. `wasm-bindgen-rayon`'s
  worker helper imports `'../../..'` and expects a bundler to resolve it; served
  as plain files that 404s and the pool silently never starts, so
  `web/scripts/patch-wasm-mt.mjs` rewrites the specifier and the loader now
  falls back to the single-threaded build when the pool does not come up.
  `calibration()` returns all 6,889 stations including those on roads the study
  area does not model; 1,719 have a modelled volume and only those are scored.
- Open: the model reads well below the counts on a block study area (station
  240 AADT against 24 modelled) — expected when through traffic is truncated,
  but it means calibration is only meaningful county-wide.

## Phase 4 — Tier 1 realism (2026-09-13)
Ownership: web agent owns `web/`; lidar agent owns `scripts/lidar/`, `data/`, and `crates/twin-pipeline` only for a `lidar` manifest entry.

- Imagery: raster basemap under the extrusions from VGIN (Virginia orthoimagery) or NAIP, as a MapLibre raster source. Prefer a direct WMTS/XYZ endpoint; if only ArcGIS ImageServer export is available, add a tiny dev proxy in vite config and note the production plan (pre-rendered raster PMTiles z10–z16 for the county via gdal2tiles + pmtiles convert, estimated size recorded).
- LiDAR: USGS 3DEP via the public Entwine EPT bucket (`s3://usgs-lidar-public`, https endpoint), county bbox, thinned to ~1 pt/m² for z16 and ~4 pt/m² for z17+, colorized from the same orthoimagery, classification kept. Output per graph chunk: `data/build/lidar/chunk_{x}_{y}.bin` = header (existing format, section kinds 90/91/92) + `xyz: f32[N*3]` (lon, lat, height m) + `rgb: u8[N*3]` + `class: u8[N]`, plus `lidar/index.json` {chunk -> bytes, points}. Manifest `lidar` entry.
- Web: `PointCloudLayer` for lidar chunks in the viewport at z ≥ 16, loaded via AssetLoader at viewport priority, evicted with LRU; toggle in Layers → Base; buildings extrusion auto-dims when lidar is on. Roof shapes from OSM `roof:shape` are optional, only if cheap.
