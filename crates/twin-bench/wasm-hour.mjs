// One county hour through the browser build, under node.
//
//   node crates/twin-bench/wasm-hour.mjs [full|coarse] [hour] [pkg-dir]
//
// Loads the real data/build artifacts into the wasm TwinWorld exactly as the
// worker does and times runHour. The threaded pkg cannot run here — its pool is
// Web Workers — so this measures the single-threaded build; wasm-hour-mt.mjs
// does the threaded one in headless Chromium.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = path.resolve(import.meta.dirname, "../..");
const build = path.join(root, "data/build");
const zones = process.argv[2] ?? "full";
const hour = Number(process.argv[3] ?? 8);
const pkg = process.argv[4] ?? "web/public/wasm";

const wasm = await import(path.join(root, pkg, "twin_wasm.js"));
await wasm.default({
  module_or_path: await readFile(path.join(root, pkg, "twin_wasm_bg.wasm")),
});

const manifest = JSON.parse(await readFile(path.join(build, "manifest.json"), "utf8"));
const cols = manifest.grid.cols;
const world = new wasm.TwinWorld();

const t0 = performance.now();
world.loadIndex(await readFile(path.join(build, "graph/index.bin")));
const chunks = (await readdir(path.join(build, "graph")))
  .map((f) => /^chunk_(-?\d+)_(-?\d+)\.bin$/.exec(f))
  .filter(Boolean);
for (const [file, cx, cy] of chunks) {
  const bytes = await readFile(path.join(build, "graph", file));
  world.loadChunk(Number(cy) * cols + Number(cx), bytes);
}
world.loadDemand(await readFile(path.join(build, "demand.bin")));
world.loadCchOrder(await readFile(path.join(build, "cch_order.bin")));
const stats = world.stats();
const load = performance.now() - t0;

const scenario = JSON.stringify({ edits: [], zones });
const t1 = performance.now();
world.runHour(scenario, hour);
const first = performance.now() - t1;
const t2 = performance.now();
world.runHour(scenario, hour);
const warm = performance.now() - t2;
const kpis = JSON.parse(world.kpisJson());

console.log(
  JSON.stringify({
    pkg,
    zones,
    hour,
    threads: wasm.threadCount(),
    nodes: stats.nodes,
    edges: stats.edges,
    load_ms: Math.round(load),
    first_ms: Math.round(first),
    warm_ms: Math.round(warm),
    iterations: kpis.iterations,
    rel_gap: kpis.rel_gap,
    vmt: Math.round(kpis.vmt),
  }),
);
