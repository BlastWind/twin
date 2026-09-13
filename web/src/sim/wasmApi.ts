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
import type { ScenarioDTO } from './protocol'

export type WasmBackendKind = 'wasm' | 'stub'

export type KpiJsonDTO = {
  readonly vmt: number
  readonly vht: number
  readonly mean_delay_s: number
  readonly top_edges: readonly { readonly edge_id: number; readonly vc: number }[]
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
}

export const scenarioJson = (s: ScenarioDTO): string => JSON.stringify({ edits: s.edits })

// ------------------------------------------------------------------ real wasm

const WASM_JS = '/wasm/twin_wasm.js'
const WASM_BG = '/wasm/twin_wasm_bg.wasm'

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

/** Resolves to the real solver, or `null` when the module is absent or is still Phase-1. */
export const loadWasmSolver = async (): Promise<SolverApi | null> => {
  const mod = await import(/* @vite-ignore */ WASM_JS)
    .then((m) => m as WasmModule)
    .catch(() => null)
  if (!mod?.TwinWorld) return null
  const memory = await mod.default({ module_or_path: WASM_BG }).then((o) => o.memory).catch(() => null)
  if (!memory) return null
  const world = new mod.TwinWorld()
  const fns = Object.fromEntries(REQUIRED.map((n) => [n, bind(mod, world, n)]))
  if (REQUIRED.some((n) => !fns[n])) return null // Phase-1 module: no solver yet
  return {
    kind: 'wasm',
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
    loadIndex: (b) => {
      nodes = b.byteLength >> 5
    },
    loadChunk: (id, b) => {
      const c: GraphChunkSchema = decodeChunk(b.slice().buffer)
      chunks.set(
        id,
        Array.from({ length: c.meta.edgeCount }, (_, i) => ({
          gid: c.edgeGid[i],
          lenM: c.edgeLenM[i],
          capacityVph: c.edgeCapacityVph[i],
          ffSpeedKph: c.edgeFfSpeedKph[i],
          classByte: c.edgeClass[i],
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
        const classWeight = [1, 0.9, 0.75, 0.6, 0.45, 0.25, 0.25, 0.1, 0.1, 0.2][e.classByte] ?? 0.2
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
        .map((gid, i) => ({ edge_id: gid, vc: out[n + i] }))
        .sort((a, b) => b.vc - a.vc)
        .slice(0, 10)
      kpis = { vmt, vht, mean_delay_s: n ? delaySum / n : 0, top_edges: top }
      return out
    },
  }
}
