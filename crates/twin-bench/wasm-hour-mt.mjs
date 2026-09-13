// The same county hour as wasm-hour.mjs, but on the threaded build, in
// headless Chromium.
//
//   node crates/twin-bench/wasm-hour-mt.mjs [full|coarse] [hour] [threads]
//
// Node cannot host wasm-bindgen-rayon's pool (it is Web Workers), so this
// serves the repo over http with the COOP/COEP headers SharedArrayBuffer
// requires and drives a real browser. Chromium comes from web/node_modules.
//
// The measured work runs inside a worker, not on the page: rayon blocks the
// thread that calls into it, and a browser's main thread may not block.
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const zones = process.argv[2] ?? "coarse";
const hour = Number(process.argv[3] ?? 8);
const threads = Number(process.argv[4] ?? 8);

const require = createRequire(path.join(root, "web/package.json"));
const { chromium } = require("@playwright/test");

const WORKER_SOURCE = `
self.onmessage = async ({ data: { base, zones, hour, threads } }) => {
  try {
    const wasm = await import(base + "/web/public/wasm-mt/twin_wasm.js");
    await wasm.default();
    await wasm.initThreadPool(threads);
    const get = async (p) => new Uint8Array(await (await fetch(base + "/" + p)).arrayBuffer());
    const manifest = await (await fetch(base + "/data/build/manifest.json")).json();
    const cols = manifest.grid.cols;
    const world = new wasm.TwinWorld();
    const t0 = performance.now();
    world.loadIndex(await get("data/build/graph/index.bin"));
    for (const [file, cx, cy] of await (await fetch(base + "/chunks.json")).json()) {
      world.loadChunk(cy * cols + cx, await get("data/build/graph/" + file));
    }
    world.loadDemand(await get("data/build/demand.bin"));
    world.loadCchOrder(await get("data/build/cch_order.bin"));
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
    self.postMessage({
      threads: wasm.threadCount(),
      nodes: stats.nodes,
      edges: stats.edges,
      load_ms: Math.round(load),
      first_ms: Math.round(first),
      warm_ms: Math.round(warm),
      iterations: kpis.iterations,
      rel_gap: kpis.rel_gap,
      vmt: Math.round(kpis.vmt),
    });
  } catch (e) {
    self.postMessage({ error: String((e && e.stack) || e) });
  }
};
`;

const TYPES = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".html": "text/html",
};

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const headers = {
    // What SharedArrayBuffer, and so wasm threads, requires of the page.
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (rel === "/") {
    res.writeHead(200, { ...headers, "content-type": "text/html" });
    res.end("<!doctype html><meta charset=utf-8><title>twin wasm mt bench</title>");
    return;
  }
  if (rel === "/bench-worker.js") {
    res.writeHead(200, { ...headers, "content-type": "text/javascript" });
    res.end(WORKER_SOURCE);
    return;
  }
  if (rel === "/chunks.json") {
    const files = (await readdir(path.join(root, "data/build/graph")))
      .map((f) => /^chunk_(-?\d+)_(-?\d+)\.bin$/.exec(f))
      .filter(Boolean)
      .map(([file, cx, cy]) => [file, Number(cx), Number(cy)]);
    res.writeHead(200, { ...headers, "content-type": "application/json" });
    res.end(JSON.stringify(files));
    return;
  }
  // wasm-bindgen-rayon's worker helper resolves the main module as
  // `import("../../..")`, i.e. the pkg *directory*. Bundlers answer that from
  // package.json's "module"; a plain file server has to be told.
  const file = rel.endsWith("/") ? `${rel}twin_wasm.js` : rel;
  try {
    const body = await readFile(path.join(root, file.slice(1)));
    res.writeHead(200, {
      ...headers,
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404, headers);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// /dev/shm is small in containers and a crashed renderer looks like "target
// closed"; --disable-dev-shm-usage sends shared memory to /tmp instead.
const browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
const page = await browser.newPage();
page.on("console", (m) => process.env.VERBOSE && console.error("page:", m.text()));
page.on("pageerror", (e) => console.error("pageerror:", e.message));
page.on("crash", () => console.error("the renderer crashed"));
await page.goto(base);
const out = await page.evaluate(
  ({ base, zones, hour, threads }) =>
    new Promise((resolve, reject) => {
      const w = new Worker(`${base}/bench-worker.js`, { type: "module" });
      w.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data));
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ base, zones, hour, threads });
    }),
  { base, zones, hour, threads },
);
console.log(JSON.stringify({ pkg: "web/public/wasm-mt", zones, hour, ...out }));
await browser.close();
server.close();
