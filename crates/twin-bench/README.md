# twin-bench

Criterion benches and one-off timing harnesses for the compute core.

```sh
cargo bench -p twin-bench                       # everything
cargo bench -p twin-bench --bench sim -- county # just the real county graph
cargo run --release -p twin-bench --bin hour    # one-off, prints KPIs too
cargo run --release -p twin-bench --bin hour 4  # ...on a radius-4 study area
```

`benches/graph.rs` covers Phase 1 (schema decode, chunk merge).
`benches/sim.rs` covers Phase 2: `cch_customize`, `cch_one_to_many`,
`aon_pass`, `bfw_iteration` (the seeding pass plus one descent step) and
`hour_assignment`. Fixtures are `n x n` lattices at E ~= 10k / 50k / 200k with
100 zones each, plus the real county build when `data/build` exists.

## Phase 2 results

Measured 2026-09-13 on a 16-core x86-64 Linux box, `--release`. The county
fixture is the real build: 75,705 nodes, 165,545 directed edges, 1,415 zones
(1,403 LODES block groups + 12 external), 322,423 OD cells.

| Bench | e10k | e50k | e200k | county |
|---|---|---|---|---|
| `cch_customize` | 10.5 ms | 47.2 ms | 271 ms | **38.7 ms** |
| `cch_one_to_many` | 154 µs | 880 µs | 4.17 ms | **939 µs** |
| `aon_pass` | 10.3 ms | 42.3 ms | 170 ms | **1.71 s** |
| `bfw_iteration` | 18.7 ms | 85.7 ms | 319 ms | **3.52 s** |
| `hour_assignment` | 26.6 ms | 113 ms | 216 ms | **12.7 s** |

The county beats the E=200k lattice on the CCH benches and loses badly on the
assignment ones, and both for the same reason: a road network has far better
nested dissection than a lattice (so customization is cheap), while the county
carries 14x the zones of the synthetic fixtures (so all-or-nothing is dear).
All-or-nothing scales with `zones x nodes`; it is ~95 % of an hour.

## Does a county-wide hour fit in 2 s? No.

| Configuration | One hour (hour 08) |
|---|---|
| County, native, 16 threads | **8.1 s** (6 iterations) |
| County, native, 1 thread | **59.6 s** |
| County, wasm32 under node 20, 1 thread | **83.2 s** |
| Radius-4 study area (76 chunks, 16k nodes, 36k edges), native 1 thread | 0.56 s |
| Radius-4 study area (50 chunks, 13k nodes, 29k edges), wasm32 | 1.0 s |
| Radius-2 study area (20 chunks, 5.3k nodes, 12k edges), wasm32 | 0.19 s |

wasm32 runs about **1.4x slower than native single-threaded** here — better
than the usual rule of thumb, because the hot loop is a `u32`/`f32` array walk
with no floating-point transcendentals. What kills the browser is not the wasm
penalty but the missing threads: `wasm32-unknown-unknown` has none, so rayon
degrades to a serial loop and `assign` compiles to the serial path on wasm
deliberately. The 16 cores the native build uses are the whole gap.

### Recommended default study area

A **radius-3 to radius-4 block of 2 km chunks — roughly 14-18 km square, 50-76
chunks, up to ~16k nodes and ~36k directed edges** — is what fits the 2 s
budget in the browser. Radius 4 costs ~500 ms per all-or-nothing
pass in wasm, so a congested hour needing three descent steps lands just under
2 s; radius 6 (30k nodes) is already 1.3 s *per pass* single-threaded and
cannot.

County-wide runs belong in a background job, not in the interactive path. The
three ways to move the line, in order of expected payoff:

1. Fewer zones. Aggregating the 1,403 block groups to ~470 census tracts is a
   3x cut straight off the top, and the loss of resolution is invisible at
   county zoom.
2. Threads. `wasm32-unknown-unknown` with the atomics ABI and a worker pool
   would recover most of the 7x the native build gets from 16 cores, which is
   the single biggest term: 83 s becomes ~12 s, and a radius-8 study area
   becomes interactive.
3. A cheaper one-to-all. A tree plus its loading is ~6 ms over 75k nodes
   single-threaded (59.6 s over 7 passes and 1,415 origins). A PHAST-style
   sweep over the CCH would beat that, but the `cch` crate exposes no such
   primitive, and its one-to-many (939 µs to 1,415 pinned targets) returns
   distances without the tree the loading needs.

## Phase 2.5 baseline (2026-09-13, re-measured)

Re-run of `cargo run --release -p twin-bench --bin hour` on the same box before
any Phase 2.5 work, so the gains below are measured against a fresh number
rather than against the Phase 2 table (the box is slower under load today).

| Configuration | hour 08 | iters |
|---|---|---|
| County, native, 16 threads | **13.26 s** | 6 |
| County, native, 1 thread (`RAYON_NUM_THREADS=1`) | **83.8 s** | 6 |

Per all-or-nothing pass (7 passes an hour): 1.9 s at 16 threads, 12 s serial —
8.5 ms per origin for a one-to-all Dijkstra over 75,705 nodes / 165,545 edges.
Parallel efficiency is only 6.3x on 16 cores.
