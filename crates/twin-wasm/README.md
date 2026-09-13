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

### `scenarioJson`

```json
{ "edits": [
  { "type": "CloseEdge", "edge": 12345 },
  { "type": "SetEdge", "edge": 678, "lanes": 3, "speed_mps": 20.0, "capacity_vph": 4000.0 },
  { "type": "AddEdge", "from": 10, "to": 11, "lanes": 2, "speed_mps": 15.0 }
] }
```

Every field of `SetEdge` past `edge` is optional; omitted ones keep their base
value. `AddEdge` is accepted and ignored — the overlay cannot grow the node and
edge arrays without copying them — and says so on the console and in
`kpisJson().warnings`. Edits naming an edge outside the loaded study area warn
the same way rather than failing the run.

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
wasm-pack build crates/twin-wasm --target web --out-dir ../../web/public/wasm
```

Falls back to `crates/twin-wasm/pkg` when `web/` is not present. Requires
`rustup target add wasm32-unknown-unknown`, which `rust-toolchain.toml` already
pins.
