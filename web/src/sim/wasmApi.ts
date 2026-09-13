/**
 * The solver contract, as one interface with two implementations: the real
 * `twin-wasm` module and a deterministic stub used until it lands.
 *
 * The layout is fixed by the contract and the worker depends on nothing else:
 *   - `runHour` returns `[volume | vc | delay_s]` concatenated over the loaded
 *     edges, i.e. `3 * loadedEdgeIds().length` floats.
 *   - `loadedEdgeIds()` gives that order, in global edge ids.
 */

import { decodeChunk, type GraphChunkSchema } from '../graph/schema'
import type { NodeIndex } from './nodeIndex'
import type { ScenarioDTO } from './protocol'

export type WasmBackendKind = 'wasm' | 'wasm-mt' | 'stub'

export type KpiJsonDTO = {
  readonly vmt: number
  readonly vht: number
  readonly mean_delay_s: number
  readonly top_edges: readonly { readonly edge_id: number; readonly vc: number }[]
}

/**
 * The Phase-3 transit/feeds surface (`twin-wasm/src/transit.rs`), separate from
 * `SolverApi` because it lands later: a module can be a complete solver and
 * still have none of it, in which case the worker substitutes `stubTransit`.
 */
export type TransitApi = {
  readonly kind: WasmBackendKind
  readonly loadTransit: (bytes: Uint8Array) => void
  readonly loadCounts: (bytes: Uint8Array) => void
  /** flat `[node_id, seconds, …]` pairs, per the contract. */
  readonly isochrone: (lon: number, lat: number, hour: number, budgetMin: number) => Float32Array
  /** `{"nodes":n,"population":p}` */
  readonly reachSummaryJson: () => string
  /** `[{"station_id":…,"edge_id":…,"aadt":…,"modeled_daily":…}]` */
  readonly calibrationJson: () => string
}

export type ReachSummaryJsonDTO = { readonly nodes: number; readonly population: number }

export type CalibrationJsonDTO = {
  readonly station_id: number
  readonly edge_id: number
  readonly aadt: number
  readonly modeled_daily: number
}

/** What the worker needs from a solver, real or stubbed. */
export type SolverApi = {
  readonly kind: WasmBackendKind
  readonly loadIndex: (bytes: Uint8Array) => void
  readonly loadChunk: (chunkIx: number, bytes: Uint8Array) => void
  readonly freeChunk: (chunkIx: number) => boolean
  readonly loadDemand: (bytes: Uint8Array) => void
  readonly loadCchOrder: (bytes: Uint8Array) => void
  /** `[volume | vc | delay_s]` over `loadedEdgeIds()`. */
  readonly runHour: (scenarioJson: string, hour: number) => Float32Array
  readonly loadedEdgeIds: () => Uint32Array
  readonly kpisJson: () => string
  readonly stats: () => { nodes: number; edges: number; chunksLoaded: number; wasmBytes: number }
  /** null until `twin-wasm/src/transit.rs` exports it. */
  readonly transit: TransitApi | null
}

export const scenarioJson = (s: ScenarioDTO): string => JSON.stringify({ edits: s.edits })

// ------------------------------------------------------------------ real wasm

// Absolute URLs: Vite's dev server rejects root-relative imports of /public
// assets, but leaves a full URL alone. wasm-pack output is served as-is.
export type WasmDir = '/wasm-mt/' | '/wasm/'

const abs = (path: string): string => new URL(path, self.location.origin).href

const exists = async (url: string): Promise<boolean> =>
  fetch(url, { method: 'HEAD' })
    .then((r) => r.ok)
    .catch(() => false)

/**
 * The threaded build is only usable on a cross-origin-isolated page (it needs
 * `SharedArrayBuffer`), and it is only present once Phase 2.5 ships it. Both
 * conditions are checked at runtime rather than at build time so one bundle
 * works either way.
 */
export const pickWasmDir = async (): Promise<WasmDir> =>
  globalThis.crossOriginIsolated === true && (await exists(abs('/wasm-mt/twin_wasm.js'))) ? '/wasm-mt/' : '/wasm/'

/**
 * The Phase-1 module exposed a `TwinWorld` class; Phase 2 adds the solver
 * calls. Whether they land as methods on the world or as free functions on the
 * module is not worth a flag day, so both are accepted.
 */
type WasmWorld = Partial<Record<keyof SolverApi, unknown>> & {
  loadIndex: (b: Uint8Array) => void
  loadChunk: (id: number, b: Uint8Array) => void
  freeChunk: (id: number) => boolean
  stats: () => { nodes: number; edges: number; chunks_loaded?: number; chunksLoaded?: number; wasm_bytes?: number }
}

type WasmModule = {
  default: (init?: unknown) => Promise<{ memory: WebAssembly.Memory }>
  TwinWorld: new () => WasmWorld
} & Partial<Record<string, unknown>>

const bind = <T>(mod: WasmModule, world: WasmWorld, name: string): T | undefined => {
  const onWorld = (world as Record<string, unknown>)[name]
  if (typeof onWorld === 'function') return (onWorld as (...a: never[]) => unknown).bind(world) as T
  const onModule = mod[name]
  return typeof onModule === 'function' ? (onModule as T) : undefined
}

const REQUIRED: readonly string[] = ['loadDemand', 'loadCchOrder', 'runHour', 'loadedEdgeIds', 'kpisJson']


const TRANSIT_REQUIRED: readonly string[] = ['loadTransit', 'isochrone', 'reachSummary', 'loadCounts', 'calibration']

const wasmTransit = (mod: WasmModule, world: WasmWorld, kind: WasmBackendKind): TransitApi | null => {
  const fns = Object.fromEntries(TRANSIT_REQUIRED.map((n) => [n, bind(mod, world, n)]))
  if (TRANSIT_REQUIRED.some((n) => !fns[n])) return null
  return {
    kind,
    loadTransit: fns.loadTransit as TransitApi['loadTransit'],
    loadCounts: fns.loadCounts as TransitApi['loadCounts'],
    isochrone: fns.isochrone as TransitApi['isochrone'],
    reachSummaryJson: fns.reachSummary as TransitApi['reachSummaryJson'],
    calibrationJson: fns.calibration as TransitApi['calibrationJson'],
  }
}

/** Resolves to the real solver, or `null` when the module is absent or is still Phase-1. */
export const loadWasmSolver = async (): Promise<SolverApi | null> => {
  const dir = await pickWasmDir()
  const mod = await import(/* @vite-ignore */ abs(`${dir}twin_wasm.js`))
    .then((m) => m as WasmModule)
    .catch(() => null)
  if (!mod?.TwinWorld) return null
  const memory = await mod
    .default({ module_or_path: abs(`${dir}twin_wasm_bg.wasm`) })
    .then((o) => o.memory)
    .catch(() => null)
  if (!memory) return null
  const world = new mod.TwinWorld()
  // wasm-bindgen-rayon needs an explicit pool start; absent in the single-threaded build.
  const initThreads = bind<(n: number) => Promise<void>>(mod, world, 'initThreadPool')
  if (dir === '/wasm-mt/' && initThreads) await initThreads(navigator.hardwareConcurrency ?? 4).catch(() => undefined)
  const fns = Object.fromEntries(REQUIRED.map((n) => [n, bind(mod, world, n)]))
  if (REQUIRED.some((n) => !fns[n])) return null // Phase-1 module: no solver yet
  const kind: WasmBackendKind = dir === '/wasm-mt/' ? 'wasm-mt' : 'wasm'
  return {
    kind,
    transit: wasmTransit(mod, world, kind),
    loadIndex: (b) => world.loadIndex(b),
    loadChunk: (id, b) => world.loadChunk(id, b),
    freeChunk: (id) => world.freeChunk(id),
    loadDemand: fns.loadDemand as SolverApi['loadDemand'],
    loadCchOrder: fns.loadCchOrder as SolverApi['loadCchOrder'],
    runHour: fns.runHour as SolverApi['runHour'],
    loadedEdgeIds: fns.loadedEdgeIds as SolverApi['loadedEdgeIds'],
    kpisJson: fns.kpisJson as SolverApi['kpisJson'],
    stats: () => {
      const s = world.stats()
      return {
        nodes: s.nodes,
        edges: s.edges,
        chunksLoaded: s.chunks_loaded ?? s.chunksLoaded ?? 0,
        wasmBytes: s.wasm_bytes ?? memory.buffer.byteLength,
      }
    },
  }
}

// ---------------------------------------------------------------------- stub

/**
 * Deterministic fake solver over the *real* decoded chunks: same shapes, same
 * edge order, plausible magnitudes. A hash of the edge id drives a stable
 * "demand" so results are reproducible across reloads and across the two
 * baseline/scenario runs.
 */
const hash01 = (x: number): number => {
  const h = Math.imul(x ^ 0x9e3779b9, 0x85ebca6b) >>> 0
  return ((h ^ (h >>> 15)) >>> 0) / 0xffffffff
}

/** Weekday double-peak profile, normalised to 1.0 at the AM peak. */
const hourFactor = (h: number): number =>
  Math.max(0.06, Math.exp(-(((h - 8) / 2.1) ** 2)) + 0.85 * Math.exp(-(((h - 17.5) / 2.4) ** 2)))

/** How much of the trip table a class carries, by `RoadClass` byte. */
const CLASS_WEIGHT: readonly number[] = [1, 0.9, 0.75, 0.6, 0.45, 0.25, 0.25, 0.1, 0.1, 0.2]

type StubEdge = {
  readonly gid: number
  readonly lenM: number
  readonly capacityVph: number
  readonly ffSpeedKph: number
  readonly classByte: number
}

export const createStubSolver = (): SolverApi => {
  const chunks = new Map<number, readonly StubEdge[]>()
  let order: Uint32Array = new Uint32Array(0)
  let edges: StubEdge[] = []
  let kpis: KpiJsonDTO = { vmt: 0, vht: 0, mean_delay_s: 0, top_edges: [] }
  let demandBytes = 0
  let nodes = 0

  const rebuild = (): void => {
    edges = [...chunks.entries()].sort(([a], [b]) => a - b).flatMap(([, e]) => e)
    order = Uint32Array.from(edges, (e) => e.gid)
  }

  const closedOf = (json: string): { closed: ReadonlySet<number>; capScale: ReadonlyMap<number, number> } => {
    const parsed = JSON.parse(json) as ScenarioDTO
    const closed = new Set<number>()
    const capScale = new Map<number, number>()
    parsed.edits.forEach((e) => {
      if (e.type === 'CloseEdge') closed.add(e.edge)
      else if (e.capacity_vph !== undefined) capScale.set(e.edge, e.capacity_vph)
      else if (e.lanes !== undefined) capScale.set(e.edge, e.lanes * 900)
    })
    return { closed, capScale }
  }

  return {
    kind: 'stub',
    // the worker composes `createStubTransit`: it owns the node index and the
    // hour cache that the stub calibration is derived from
    transit: null,
    loadIndex: (b) => {
      nodes = b.byteLength >> 5
    },
    loadChunk: (id, b) => {
      const c: GraphChunkSchema = decodeChunk(b.slice().buffer)
      chunks.set(
        id,
        Array.from({ length: c.meta.edgeCount }, (_, i): StubEdge => ({
          gid: c.edgeGid[i]!,
          lenM: c.edgeLenM[i]!,
          capacityVph: c.edgeCapacityVph[i]!,
          ffSpeedKph: c.edgeFfSpeedKph[i]!,
          classByte: c.edgeClass[i]!,
        })),
      )
      rebuild()
    },
    freeChunk: (id) => {
      const had = chunks.delete(id)
      if (had) rebuild()
      return had
    },
    loadDemand: (b) => {
      demandBytes = b.byteLength
    },
    loadCchOrder: () => undefined,
    loadedEdgeIds: () => order,
    kpisJson: () => JSON.stringify(kpis),
    stats: () => ({ nodes, edges: edges.length, chunksLoaded: chunks.size, wasmBytes: demandBytes }),
    runHour: (json, hour) => {
      const { closed, capScale } = closedOf(json)
      const n = edges.length
      const out = new Float32Array(3 * n)
      const peak = hourFactor(hour)
      let vmt = 0
      let vht = 0
      let delaySum = 0
      edges.forEach((e, i) => {
        const cap = Math.max(1, capScale.get(e.gid) ?? e.capacityVph)
        // heavier classes carry more of the trip table
        const classWeight = CLASS_WEIGHT[e.classByte] ?? 0.2
        const volume = closed.has(e.gid) ? 0 : (0.35 + 0.9 * hash01(e.gid)) * cap * classWeight * peak
        const vc = volume / cap
        const ffS = (e.lenM / 1000 / Math.max(5, e.ffSpeedKph)) * 3600
        const delay = ffS * (0.15 * vc ** 4)
        out[i] = volume
        out[n + i] = vc
        out[2 * n + i] = delay
        const miles = (e.lenM / 1000) * 0.621371
        vmt += volume * miles
        vht += (volume * (ffS + delay)) / 3600
        delaySum += delay
      })
      const top = [...order]
        .map((gid, i) => ({ edge_id: gid, vc: out[n + i] ?? 0 }))
        .sort((a, b) => b.vc - a.vc)
        .slice(0, 10)
      kpis = { vmt, vht, mean_delay_s: n ? delaySum / n : 0, top_edges: top }
      return out
    },
  }
}

// -------------------------------------------------------------- stub transit

/**
 * Stand-in for `twin-wasm/src/transit.rs` until it lands.
 *
 * `isochrone` is a straight-line reach over the resident nodes at a fixed
 * door-to-door speed with a peak-hour penalty — enough to exercise the request
 * shape, the four time bands and the recompute-on-hour-change path, and
 * deliberately crude so nobody mistakes the picture for a routed isochrone.
 *
 * `calibration` needs modeled daily volumes, which live in the worker\'s hour
 * cache, so the worker passes them in rather than this module reaching for
 * them; the "stations" are then the busiest loaded edges with a synthetic AADT
 * scattered around the model.
 */
const STUB_SPEED_KPH = 26
const STUB_POP_PER_NODE = 3.4
const STUB_STATIONS = 40
const METRES_PER_DEG_LAT = 111_320
/** A road network is not a straight line. */
const STUB_DETOUR = 1.3

/** Peak-hour slowdown, reusing the volume profile\'s shape. */
const stubSpeedKph = (h: number): number => STUB_SPEED_KPH / (0.75 + 0.45 * hourFactor(h))

/** Daily modeled volume per edge id, as the worker sees it after a 24 h run. */
export type DailyByEdge = () => ReadonlyMap<number, number>

export const createStubTransit = (nodes: NodeIndex, daily: DailyByEdge): TransitApi => {
  let summary: ReachSummaryJsonDTO = { nodes: 0, population: 0 }

  return {
    kind: 'stub',
    loadTransit: () => undefined,
    loadCounts: () => undefined,
    isochrone: (lon, lat, h, budgetMin) => {
      const { nodes: gids, lonLat } = nodes.snapshot()
      const mps = (stubSpeedKph(h) * 1000) / 3600
      const budgetS = budgetMin * 60
      const kx = Math.cos((lat * Math.PI) / 180)
      const out: number[] = []
      for (let i = 0; i < gids.length; i += 1) {
        const dx = (lonLat[i * 2]! - lon) * kx * METRES_PER_DEG_LAT
        const dy = (lonLat[i * 2 + 1]! - lat) * METRES_PER_DEG_LAT
        const seconds = (Math.hypot(dx, dy) * STUB_DETOUR) / mps
        if (seconds <= budgetS) out.push(gids[i]!, seconds)
      }
      summary = { nodes: out.length / 2, population: Math.round((out.length / 2) * STUB_POP_PER_NODE) }
      return Float32Array.from(out)
    },
    reachSummaryJson: () => JSON.stringify(summary),
    calibrationJson: () => {
      const rows = [...daily()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, STUB_STATIONS)
        .map(([edge_id, modeled_daily], i): CalibrationJsonDTO => ({
          station_id: 900_000 + i,
          edge_id,
          // ±35% of the model, stable per edge: a plausible calibration cloud
          aadt: Math.round(modeled_daily * (0.65 + 0.7 * hash01(edge_id))),
          modeled_daily: Math.round(modeled_daily),
        }))
      return JSON.stringify(rows)
    },
  }
}
