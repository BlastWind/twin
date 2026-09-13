# twin-core

Pure compute core: ids, binary layouts, chunked graph assembly. No I/O, no
globals, so the same object code runs natively in `twin-pipeline` and in
`wasm32-unknown-unknown` via `twin-wasm`.

## Modules

| Module | Contents |
|---|---|
| `ids` | `NodeId`, `EdgeId`, `ChunkId` (u32 newtypes, sentinel-rejecting smart constructors), `RoadClass` (`#[repr(u8)]`) with OSM tag parsing and lane/speed/capacity defaults. |
| `schema` | Versioned 16-byte header + 24-byte section table, `FileWriter` (encode) / `FileView` (zero-copy decode), `AlignedBytes`. |
| `graph_schema` | `GraphIndexSchema` (`graph/index.bin`), `GraphChunkSchema` (`graph/chunk_{x}_{y}.bin`), `ChunkBuild`. |
| `grid` | `BBox`, `GridSchema` — a fixed ~2 km cell grid over the study bbox. |
| `assembly` | `RawGraph`, `simplify_degree2`, `partition`, `RawGraph::synthetic_grid`. |
| `graph` | `RoadGraph`: assemble any subset of chunks, dedup border edges, detect boundary edges, rebuild CSR. |
| `demand` | `DemandSchema` (`demand.bin`): zone centroids snapped to nodes, sparse OD triples, the NHTS-style 24-hour profile and the outbound/return split. |
| `cch_order` | `CchOrderSchema` (`cch_order.bin`): the metric-independent contraction order, in global node ids. |
| `scenario` | `Scenario` (an ADT of edits) and `ScenarioView`, a sparse overlay over a `GraphView`, including `AddEdge` overlay edges with ids from `EdgeId::OVERLAY_START`. |
| `assign` | Biconjugate Frank-Wolfe user equilibrium over BPR, `HourResult`, KPIs. `AssignPlan` carries the knobs, the `Loader` (Dijkstra or CCH) and the `Zoning`. |
| `routing` | `Skim`: CCH build/customize/one-to-many over the loaded study area; `OneToAll`, the PHAST sweep and tree walk all-or-nothing loading runs on; `nested_dissection_order` and `restrict_order`. |

## Alignment note

`FileView::parse` refuses a buffer that does not start on an 8-byte boundary,
because the decoded `&[T]` views alias the caller's bytes directly. Wrap
incoming buffers in `schema::AlignedBytes` (one copy, at load time); decoding
itself stays copy-free.

## Shortest-path solver: `wasm32-unknown-unknown` build check

**Result: `cch` v0.3.0 builds and links for `wasm32-unknown-unknown`. No
fallback to `fast_paths` is needed.**

Verified on 2026-09-13 with rustc 1.98.1 (48a229cea 2026-09-01), target
`wasm32-unknown-unknown` installed via `rustup target add
wasm32-unknown-unknown` (also pinned in `rust-toolchain.toml`).

| Item | Value |
|---|---|
| Crate | `cch = "0.3.0"` (crates.io; repository <https://github.com/Rodeapps/cch>) |
| Command | `cargo build --target wasm32-unknown-unknown --release` on a `cdylib` probe |
| API exercised | `Cch::build`, `cch.customizer().customize(weights)`, `cch::distance(&cch.view(), &metric.view(), s, t)` |
| Outcome | Clean compile **and link**; 133,420-byte `.wasm` |

The probe deliberately calls through the real code path rather than only naming
a type, so the result covers linking, not just type checking. Transitive
dependencies `rayon`, `rayon-core`, `crossbeam-*` and `memmap2` all compile for
wasm32.

Caveat for Phase 2: `rayon`'s parallel customization needs threads, which
`wasm32-unknown-unknown` does not provide without the atomics/bulk-memory ABI
and a worker pool. It compiles because rayon degrades to a single-threaded
fallback, so customization in the browser will be serial. Budget the
recustomize step accordingly, or gate the parallel path behind a feature that is
off for wasm.

`cch::graph::Graph` is CSR with `u32` weights (`first_out`, `head`, `weight`),
which matches `GraphChunkSchema`'s `out_offsets` / `out_edges` layout, so
feeding it from a `RoadGraph` needs no structural conversion. ### Where the CCH is used (Phase 2.5)

`routing::Skim` wraps `cch` for zone-to-zone skims and point-to-point queries,
and `routing::OneToAll` uses the same hierarchy for all-or-nothing loading,
which is where nearly all of an hour goes.

Phase 2 concluded that it could not: loading needs a whole shortest-path *tree*
per origin and a CCH one-to-many returns distances to pinned targets. Both
halves of that turned out to be avoidable without forking `cch`.

- **Distances to every node**, not to pinned targets, come from a PHAST-style
  sweep: walk the source's elimination tree to the root relaxing up-arcs, then
  one linear pass down over all nodes in decreasing rank. No priority queue.
  `CchView` and `MetricView` publish the elimination tree, both CSR halves and
  both weight arrays, so this is ~40 lines against the public API.
- **The tree** never has to be materialised, and no shortcut ever has to be
  unpacked. An arc `u -> v` is on a shortest path exactly when `dist[u] + w ==
  dist[v]`, which is exact because the weights are integers, so each
  destination walks back to the source resolving predecessors on demand, under
  a generation stamp so the shared trunk is resolved once per origin.

On the county that is 1.0 ms per origin against 8.5 ms for a Dijkstra tree.
Re-customization is 39 ms an iteration, which the sweep repays many times over;
`crates/twin-bench/README.md` has the numbers. `Loader::Dijkstra` is still there
and still correct — the equilibrium tests run under both and assert they agree —
and it remains the better choice for a small study area, where building a
hierarchy costs more than it saves.

### Zoning

Every all-or-nothing pass costs one sweep per loading point, so the zone count
is the solver's biggest single lever. `Zoning::Coarse` merges the 1,415 LODES
block groups into ~400 clusters with a weighted Lloyd's algorithm seeded by the
heaviest zones — deterministic, and the seeds land where the trips are. Each
cluster loads at its heaviest member's centroid, which is already snapped to a
node. County VMT moves 0.9 %.
