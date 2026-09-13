# twin — Design

Digital twin of Fairfax County, Virginia (excluding the independent cities:
Fairfax City, Falls Church, Alexandria), for exploring city-management what-if
scenarios in the browser. Exploration project and MVP.

## 1. Problem and scope

**Goal.** A faithful 2.5D model of Fairfax County (roads, buildings with real
heights, parcels, zoning, transit) that a user can fly around, overlay real city data on,
and run traffic/transit what-if scenarios against, with results shown on the map
and in a dashboard.

**MVP functional scope.**

| Area | In MVP | Deferred |
|---|---|---|
| World | Fairfax County (~400 sq mi, ~1.15M people, ~350k buildings, ~200k+ road edges). Extruded buildings from county LiDAR-derived heights, roads, parcels, zoning, GTFS routes and stops. | Independent cities (Fairfax City, Falls Church, Alexandria), terrain, true 3D models. |
| Traffic what-if | Edit road network (close edge, add edge, change lanes/speed/capacity). Static traffic assignment over a 24h demand profile on a user-chosen **study area** (default: whole county). | Agent-based microsim, signal timing. |
| Transit what-if | Render GTFS. Walk+ride isochrones from any point. Add/remove/reroute a bus line. | Mode choice feeding back into car demand. |
| Dashboard | Sim KPIs baseline vs scenario. VDOT observed counts vs modeled. 311 / permits / crash layers with summaries. Land-use and zoning summaries. | Budget, utilities, services. |
| Persistence | Scenario in URL hash; drafts in IndexedDB. | Accounts, server-side store. |
| Hosting | Local dev only. | Cloudflare Pages + R2. |

**Non-functional requirements that drive the design.**

- First meaningful paint < 1.5 s on a laptop over a normal connection.
- Scenario run (one hour of assignment, county-wide) < 2 s; full 24h profile
  computed in the background. Requires customizable contraction hierarchies
  (CCH), not plain Dijkstra.
- 60 fps pan/tilt with all base layers and a sim result overlay visible at any
  zoom, including county-wide overview.
- App shell < 300 KB gzipped. Nothing county-sized is loaded as one blob: geometry,
  graph, demand and results are all tiled or chunked and streamed by viewport or
  on demand.
- Memory budget: < 1.5 GB in the main tab, < 1 GB in the sim worker, measured.
  Explicit eviction for off-viewport tiles and off-study-area graph chunks.
- Performance is tested, not hoped for: benchmark suites in CI with regression
  thresholds (section 8).
- No server required for the MVP. Every compute path must also be runnable
  natively so a server can be added without rewriting.
- Solo developer. Prefer fewer moving parts over generality.

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Compute core | Rust crate `twin-core`, compiled to WASM (`wasm-bindgen`) for the browser and linked natively by the pipeline and any future server. | One implementation of graph, assignment, transit routing, metrics. Runs in a Web Worker today, in a server tomorrow. |
| Data pipeline | Rust CLI `twin-pipeline` (native, uses `twin-core`). | Same types as the runtime; produces the binaries the browser loads. |
| Geometry delivery | PMTiles (vector tiles, MVT) built by the pipeline with Planetiler-style zoom LOD. | Single file, HTTP range requests, no tile server. |
| Shortest paths | `cch` crate (customizable contraction hierarchies), or `fast_paths` if `cch` won't build to wasm32. | Build the CH order once in the pipeline; recustomize per assignment iteration in ms. |
| Binary data | Custom struct-of-arrays layouts with `bytemuck`, versioned header. | Zero-copy into typed arrays on both sides. Smallest and fastest; we own the format. |
| Rendering | MapLibre GL JS (basemap, extrusions, camera) + deck.gl (GPU data layers). WebGL2. | Proven 2.5D map with tilt/rotate; deck.gl instances hundreds of thousands of primitives. |
| App | TypeScript, React, Vite, Zustand. | Largest ecosystem for map bindings and dashboard components. |
| Server (deferred) | Axum, linking `twin-core`, same DTOs over HTTP. | Designed for, not built. |
| Hosting (deferred) | Cloudflare Pages + R2. | Range-request friendly, no egress fees. |

Paradigm: Rust core is plain data + pure functions over slices. TypeScript app is
functional-style at boundaries (immutable state slices, pure selectors), React
for views. Not FP for its own sake.

## 3. Repository layout

```
twin/
  Cargo.toml              # workspace
  crates/
    twin-core/            # pure library, no I/O
    twin-bench/           # criterion benches + perf fixtures
    twin-pipeline/        # CLI: ingest -> world.pmtiles, graph.bin, demand.bin, transit.bin, feeds.bin
    twin-wasm/            # thin wasm-bindgen wrapper around twin-core
    twin-server/          # (deferred) Axum
  web/                    # Vite + React app
    src/map/              # MapLibre + deck.gl layers, LOD, loading
    src/sim/              # worker host, DTOs, result caches
    src/ui/               # scenario editor, dashboard, layer panel
    src/state/            # Zustand stores
    public/data/          # dev-time symlink to build output
  data/
    raw/                  # gitignored downloads
    build/                # gitignored pipeline output + manifest.json
  DESIGN.md
```

## 4. Data sources and pipeline

Inputs (all public):

| Dataset | Use |
|---|---|
| Fairfax County GIS Open Data (primary) | Building footprints with LiDAR-derived heights, parcels with assessed values, zoning, planning areas, county boundary, address points, road centerlines for attribute enrichment. |
| Overture Maps transportation segments + OSM PBF (county bbox with buffer) | Road network topology and attributes (class, lanes, speed, oneway, access). Overture buildings fill any county gaps. |
| GTFS: Fairfax Connector (+RT), WMATA bus/rail, CUE | Routes, stops, trips, stop times. |
| VDOT traffic counts (AADT by segment) | Calibration view. |
| Census ACS block-level population; LEHD LODES OD flows | Origin-destination demand. |
| VDOT crash data, city 311 / permits (where available) | Feed layers and dashboard summaries. |

Pipeline stages (each a pure function from parsed inputs to an in-memory
`twin-core` model, then serialized):

1. `ingest-roads`: parse Overture segments / OSM PBF, build `RoadGraph` (nodes,
   directed edges with lanes, free-flow speed, capacity by class, geometry).
   Simplify degree-2 chains. Assign stable `EdgeId`. Partition the graph into
   spatial **chunks** (a fixed grid, ~2 km cells) so the browser can load only
   the study area; edges crossing chunk borders are recorded in both.
   Compute the CCH nested-dissection order and store it.
2. `ingest-gis`: county buildings (footprint, height, elevation), parcels and
   zoning polygons with `ParcelId`, zone code, area, value.
3. `ingest-gtfs`: `TransitNetwork` (stops snapped to graph nodes, routes,
   patterns, timetable compressed to headways per hour).
4. `demand`: zones = census blocks intersected with city + commuter shed.
   LODES home→work flows aggregated to zones, scaled by ACS population, yields
   one base OD matrix. An hourly profile (24 factors, default NHTS-style curve)
   scales it. Zone centroids snapped to graph nodes (connectors).
5. `feeds`: point events (311, permits, crashes) binned to a grid and to
   nearest edge/parcel, with per-category counts.
6. `tiles`: emit `world.pmtiles` with layers `buildings`, `roads`, `parcels`,
   `zoning`, `transit_routes`, `transit_stops`, `feeds`. Per-zoom LOD:
   buildings from z13 (footprints merged/simplified below z15), parcels from
   z14, roads by class (motorway/primary at all zooms, residential from z13,
   service from z15). Road features carry `edge_id` so sim results join on the
   GPU side.
7. `emit`: write `graph/index.bin` + `graph/chunk_{x}_{y}.bin`, `cch_order.bin`,
   `demand.bin`, `transit.bin`, `feeds.bin`, `counts.bin`, and `manifest.json`
   (content hashes, byte sizes, schema versions, bbox, chunk grid).

Config layering for the pipeline (ArgParser pattern): defaults in code ←
`twin.toml` ← environment (`TWIN_*`) ← CLI flags. Resolved into one immutable
`PipelineConfig`.

## 5. Binary formats (`*Schema` types)

All files: 16-byte header `{ magic: [u8;4], version: u32, flags: u32, count: u32 }`
followed by struct-of-arrays sections, each 8-byte aligned, described by a
section table right after the header. Rust structs are `#[repr(C)] Pod`
(`bytemuck`) so the browser views them as typed arrays without parsing.

- `GraphIndexSchema` (`graph/index.bin`): chunk grid, per-chunk node/edge
  counts and global id offsets, so global `NodeId`/`EdgeId` are stable and
  chunks can be loaded in any subset.
- `GraphChunkSchema` (`graph/chunk_*.bin`): `node_lonlat: [f32;2][N]`, `edge_from: u32[E]`,
  `edge_to: u32[E]`, `edge_len_m: f32[E]`, `edge_ff_speed: f32[E]`,
  `edge_capacity_vph: f32[E]`, `edge_lanes: u8[E]`, `edge_class: u8[E]`,
  CSR adjacency `out_offsets: u32[N+1]`, `out_edges: u32[sum]`.
- `DemandSchema` (`demand.bin`): `zone_node: u32[Z]`, sparse OD triples
  `(o: u16, d: u16, trips: f32)[K]`, `hour_profile: f32[24]`.
- `TransitSchema` (`transit.bin`): stops with node ids, patterns as stop-index
  sequences, per-hour headway and run time per pattern.
- `FeedsSchema`, `CountsSchema`: analogous flat arrays.

Schema version bumps are breaking; the manifest pins them and the app refuses
mismatches.

## 6. Core engine (`twin-core`)

Pure library. Key types use aliases for magic ids: `NodeId(u32)`,
`EdgeId(u32)`, `ZoneId(u16)`, `Hour(u8)` with smart constructors.

- `RoadGraph`: immutable base graph assembled from any set of loaded
  `GraphChunkSchema`s. Unloaded chunks are absent; edges into them are boundary
  edges. A `StudyArea` (set of chunk ids) selects the loaded set; boundary
  zones absorb through-traffic.
- `Scenario`: an ADT of edits applied on top of the base:
  `CloseEdge(EdgeId)`, `AddEdge{from,to,lanes,speed,geometry}`,
  `SetEdge{id, lanes?, speed?, capacity?}`, `TransitEdit(…)`. Applying a
  scenario yields a `GraphView` (base + overlay, no copy of base arrays).
- `assign(view, demand, hour, warm: Option<&PathSet>) -> HourResult`:
  static user-equilibrium assignment. Biconjugate Frank-Wolfe with BPR
  volume-delay (ported from AequilibraE). All-or-nothing via CCH one-to-many
  queries per origin zone; the CCH is recustomized with the new edge costs each
  iteration (ms), the order is never rebuilt at runtime. Converges at relative
  gap < 1e-3 or 20 iterations. Warm start reuses previous hour's flows.
  Memory: flows and costs are `f32[E]` per hour; per-hour results for 24h ×
  baseline+scenario ≈ 48 × E × 12 bytes, ~120 MB at E=200k, kept in the worker
  and transferred to the main thread only for the selected hour.
- `HourResult`: `volume: f32[E]`, `vc: f32[E]`, `delay_s: f32[E]`, plus
  aggregate KPIs (VMT, VHT, mean delay, top congested edges).
- `isochrone(transit, graph, origin, depart_hour, budget_min) -> ReachResult`:
  walk + ride reach via a simple RAPTOR-style pass over headways, returns
  reachable node set with times and reachable population.
- `metrics`: diffs baseline vs scenario, calibration error vs counts.

`twin-wasm` exposes: `load(graph, demand, transit, feeds) `, `run_hour(scenario, hour)`,
`run_all_hours(scenario)` (streams per-hour callbacks), `isochrone(...)`,
returning typed arrays via shared `Float32Array` views to avoid copies.

## 7. Web app

### 7.1 Loading sequence

1. HTML shell + critical CSS + app bundle (< 300 KB gz). Map container paints
   with a solid background and camera at Fairfax.
2. MapLibre style loads; base tiles from `world.pmtiles` stream by viewport via
   the PMTiles protocol (range requests). Buildings/roads visible at this point
   (target < 1.5 s).
3. Web Worker starts, fetches `manifest.json`, `graph/index.bin`,
   `cch_order.bin`, `demand.bin` (idle priority), instantiates WASM. Graph
   chunks for the current study area are fetched in parallel (concurrency 6)
   and passed to WASM as they arrive; `load` is incremental. Chunks outside the
   study area are evicted from WASM memory.
4. `transit.bin`, `feeds.bin`, `counts.bin` fetched lazily when their layer or
   panel is first enabled, or after idle.
5. Baseline `run_hour(empty, 8)` runs immediately after load so the first
   scenario has a diff target; remaining hours run in the background.

All fetches go through one `AssetLoader` keyed by manifest hash with an
in-memory LRU (byte-budgeted), `Cache Storage` persistence, priority queue
(viewport > study area > idle prefetch), and abort on viewport change. No JSON
larger than the manifest. Every buffer handed to WASM is transferred, never
copied; WASM memory is a single `SharedArrayBuffer`-backed linear memory sized
by the study area with explicit `free_chunk`.

### 7.2 Rendering

- MapLibre: basemap layers from `world.pmtiles`, `fill-extrusion` for
  buildings, `line` for roads, `fill` for parcels/zoning, symbol layers for
  stops. Style is generated in TS from a typed layer registry.
- deck.gl (via `MapboxOverlay`, interleaved): result layers. Roads colored by
  V/C use a `PathLayer`/`TripsLayer` fed from a `Float32Array` attribute
  updated in place per hour; only the attribute buffer re-uploads. Isochrones as
  a `PolygonLayer` or `HeatmapLayer`. Feeds as `ScatterplotLayer`/`GridLayer`.
- LOD: buildings hidden below z13 and rendered as simplified merged blocks
  z13–z14, full footprints from z15; parcels from z14; feed points aggregate
  to grid below z13; residential/service roads by zoom as in the tile LOD.
  County-wide overview shows only motorway/primary/secondary with sim colors,
  which keeps the deck.gl attribute upload bounded (~20k edges) at low zoom.
  Zoom-driven layer visibility lives in the registry.
- Result overlay: the worker returns per-edge arrays only for edges in the
  currently rendered tiles' id range (the map reports visible `edge_id`s), so
  the main thread never holds the full county result.

### 7.3 State and boundaries

Zustand stores: `worldStore` (manifest, load state), `scenarioStore` (current
`Scenario`, undo stack, dirty flag), `simStore` (per-hour `HourResult` caches
for baseline and scenario, run status), `uiStore` (selected hour, layers,
panels, selection).

Worker protocol (`DTO` types, `postMessage` with transferables):

```ts
type ScenarioDTO = { edits: EditDTO[] }           // mirrors Scenario ADT
type RunRequestDTO = { id: RunId; scenario: ScenarioDTO; hours: Hour[] }
type HourResultDTO = { id: RunId; hour: Hour; volume: Float32Array; vc: Float32Array; delay: Float32Array; kpis: KpiDTO }
type IsochroneRequestDTO / ReachResultDTO
```

The worker serializes `ScenarioDTO` into the WASM call; results come back as
transferred buffers. The UI never touches WASM directly.

Scenario persistence: `ScenarioDTO` → CBOR → base64url in the URL hash.
IndexedDB holds named drafts keyed by manifest hash.

### 7.4 UI

- Layer panel (toggle registry layers, hour scrubber with 24h play).
- Scenario editor: select edge → close / edit; draw new edge snapped to nodes;
  transit line editor (pick stops in order).
- Dashboard: KPI cards (baseline vs scenario delta), top-corridor table,
  calibration scatter (observed AADT vs modeled daily volume), feed summaries,
  zoning summary for current viewport or selected parcels.

## 8. Cross-cutting

- Errors: Rust returns `Result<_, CoreError>` (an enum); the WASM layer maps to
  a `WorkerErrorDTO`; the UI shows a toast and keeps the last good result.
- Observability: `performance.mark` around each load stage and sim run; dev
  overlay shows stage timings and fps. Pipeline logs stage timings and output
  sizes.
- Testing (correctness): Rust unit tests on assignment (known small networks
  with analytic equilibria, Braess), property tests on schema round-trips and
  chunk merging. Vitest for DTO codecs and stores. Playwright smoke test for
  load-to-first-result.
- Testing (performance), run in CI on every PR against fixed fixtures with
  regression thresholds (fail at > 15% slower or > 10% more memory than the
  stored baseline):
  - `twin-bench` (criterion): CCH customize, one-to-many query, one FW
    iteration, full hour assignment, chunk load/merge, schema decode. Fixtures:
    synthetic grid graphs at E = 10k / 50k / 200k plus a committed
    county-subset fixture.
  - Pipeline: wall time and output bytes per stage, logged and asserted.
  - Browser (Playwright + CDP tracing, headless Chromium): time to first tile,
    time to first paint, time to first baseline result, fps during a scripted
    pan/tilt/zoom path at three zoom levels, JS heap and WASM memory after
    load and after a 24h run, transfer bytes on load. Lighthouse budget for
    the shell.
  - Worker: message round-trip and buffer transfer sizes per request type.
  Baselines live in `bench/baselines.json`; updating them is a deliberate
  commit.
- Auth: none.

## 9. Open questions and deferred decisions

- Exact capacity/speed defaults per OSM highway class; calibrate against VDOT
  counts once the pipeline runs.
- External zones for through traffic on I-66 / I-495 / I-95 / Rt 28 / Rt 7,
  with demand inferred from VDOT counts at the county boundary.
- `cch` wasm32 build; fallback is `fast_paths` with per-iteration rebuild,
  which likely breaks the 2 s budget county-wide and would force a smaller
  default study area.
- Independent cities (Fairfax City, Falls Church, Alexandria) are holes in the
  county data; roads and transit still pass through them via Overture/OSM, but
  buildings and parcels there are out of scope for MVP.
- Point-event feeds: VDOT crashes are confirmed; county 311 and permits via
  Building Records PLUS to be verified.
- Server (`twin-server`) trigger: only if a scenario type needs > 2 s or shared
  scenarios need a store.
- Hosting on Cloudflare Pages + R2 when publishing.
