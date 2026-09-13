# twin-wasm

`wasm-bindgen` wrapper around `twin-core`, loaded by the web app's sim worker.

## API

| Export | Meaning |
|---|---|
| `new TwinWorld()` | Empty world; installs the panic hook. |
| `loadIndex(bytes)` | Parse `graph/index.bin`; keeps the grid and chunk table. |
| `loadChunk(id, bytes)` | Take ownership of a transferred chunk buffer and fold it into the graph. Errors if the header's chunk id disagrees with `id`. |
| `freeChunk(id)` | Evict a chunk. Returns whether it was loaded. |
| `loadedChunks()` | Resident chunk ids, ascending. |
| `stats()` | `{ nodes, edges, chunks, boundary_edges, chunks_available, zones, wasm_bytes }`. |
| `loadDemand(bytes)` | Take ownership of `demand.bin`. Returns the zone count. |
| `loadCchOrder(bytes)` | Parse `cch_order.bin`. Returns the node count the order covers. |
| `loadedEdgeIds()` | `Uint32Array` of the loaded global edge ids, ascending. This is the layout of every result array. |
| `runHour(scenarioJson, hour)` | Assign one hour. Returns a `Float32Array` of length `3 * E_loaded`: `[volume | vc | delay_s]`, each block in `loadedEdgeIds()` order. |
| `kpisJson()` | JSON for the last run, or `"null"`. |
| `threadCount()` | Threads the all-or-nothing loop will fork over: 1 on the single-threaded build, and 1 on the threaded one until `initThreadPool` has resolved. |
| `initThreadPool(n)` | **Threaded build only.** Starts the worker pool. Must be awaited before the first `runHour`; its absence is how the worker feature-detects the build. |

### `scenarioJson`

```json
{ "edits": [
  { "type": "CloseEdge", "edge": 12345 },
  { "type": "SetEdge", "edge": 678, "lanes": 3, "speed_mps": 20.0, "capacity_vph": 4000.0 },
  { "type": "AddEdge", "from": 10, "to": 11, "lanes": 2, "speed_mps": 15.0,
    "capacity_vph": 3200.0, "geometry": [[-77.31, 38.80], [-77.30, 38.81]] }
],
  "zones": "full" }
```

Every field of `SetEdge` past `edge` is optional; omitted ones keep their base
value. Edits naming an edge outside the loaded study area are collected as
warnings — on the console and in `kpisJson().warnings` — rather than failing
the run: a scenario is a user document, and half of it applying is more useful
than none of it.

`AddEdge` joins the graph as an overlay edge after every base edge, with an id
from a reserved range (`0xF000_0000` up) so a result row carrying one is
recognisably not a road that exists. `capacity_vph` defaults to an arterial
lane's, `geometry` (`[[lon, lat], ...]`) gives the length and falls back to the
straight line between the two nodes, and both endpoints must already be loaded.
Adding a link changes the arc set the contraction hierarchy was built over, so
the first run after one rebuilds it — about 100 ms on the county.

`zones` is `"full"` (default; every block group loads at its own centroid) or
`"coarse"` (they merge to ~400 loading points). Every all-or-nothing pass costs
one one-to-all sweep per loading point, so this is the single biggest lever on
run time; county-wide runs want `"coarse"`, and a study area of a few tens of
thousands of edges does not need it.

### `kpisJson()`

```json
{ "vmt": 1030997.0, "vht": 21678.0, "mean_delay_s": 0.5,
  "top_edges": [{ "edge_id": 41234, "vc": 1.42 }],
  "hour": 8, "iterations": 6, "rel_gap": 0.00083, "warnings": [] }
```

`runHour` warm-starts from the previous run whenever the loaded edge set is
unchanged, so walking the 24-hour profile costs much less than the first hour.

`loadChunk` decodes zero-copy, copies the arrays into the graph, and drops the
wire buffer — the graph holds its own storage, so keeping the buffer as well
would double the memory for no gain.

Graph assembly is lazy: a run of `loadChunk` calls costs one rebuild, performed
on the next `stats()`. So load a batch, then read.

## Build

```sh
scripts/build-wasm.sh
```

That emits both variants: `web/public/wasm` (single-threaded, stable
toolchain) and `web/public/wasm-mt` (threaded). The threaded one is skipped
with a note if no nightly toolchain is installed, or with `SKIP_THREADED=1`.
Either variant alone is a complete build of the API above.

### The threaded variant

`wasm-bindgen-rayon` puts rayon's pool on Web Workers over a shared linear
memory, so the build needs the atomics ABI, which means a standard library
rebuilt for it, which means nightly:

```sh
rustup toolchain install nightly --component rust-src --target wasm32-unknown-unknown
```

The flag set is in `scripts/build-wasm.sh`. Three parts of it are load-bearing
and each fails in its own confusing way if dropped:

- `-C target-feature=+atomics,+bulk-memory` with `-Z build-std=panic_abort,std`
  — without the std rebuild nothing links.
- `-C link-arg=--shared-memory --import-memory --max-memory=…` — without these
  the memory is not shared and `initThreadPool` dies with *"#\<Memory\> could
  not be cloned"*.
- `-C link-arg=--export=__wasm_init_tls` and the three other `__tls_*` symbols
  — lld garbage-collects them, and `wasm-bindgen` then fails with *"failed to
  prepare module for threading"*.

`wasm-opt` also has to be told about the threads proposal, which
`Cargo.toml`'s `[package.metadata.wasm-pack.profile.release]` does; otherwise
it rewrites the shared memory back into a plain one.

### Required headers: COOP and COEP

The threaded build uses `SharedArrayBuffer`, which the browser only hands to a
**cross-origin isolated** page. Every document that loads `wasm-mt` — the app
page, not just the worker — must be served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Under `require-corp` every cross-origin subresource must opt in with
`Cross-Origin-Resource-Policy: cross-origin` (or CORS), so a third-party tile
or font host that does not send it will stop loading. Same-origin assets are
unaffected. `crossOriginIsolated` in the page says whether it worked; the web
app should fall back to `web/public/wasm` when it is false, which also covers
browsers without the headers in place.

The dev server needs the same two headers (the web app sets them in its Vite
config); `crates/twin-bench/wasm-hour-mt.mjs` serves them itself, which is how
the threaded timings below were measured.
