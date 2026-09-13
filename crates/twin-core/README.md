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
feeding it from a `RoadGraph` needs no structural conversion. The solver is
**not** integrated yet; that is Phase 2.
