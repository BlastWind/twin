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
