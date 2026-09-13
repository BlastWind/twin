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
| `stats()` | `{ nodes, edges, chunks, boundary_edges, chunks_available, wasm_bytes }`. |

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
