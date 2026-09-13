/// <reference lib="webworker" />
import { decodeChunk } from '../graph/schema'
import type { ChunkKey } from '../graph/manifest'
import {
  decodeRequest,
  encodeResponse,
  type ChunkGeometryDTO,
  type HourResultDTO,
  type Hour,
  type KpiDTO,
  type RequestDTO,
  type ResponseDTO,
  type ResultKind,
  type RunRequestDTO,
  type StatsDTO,
  type WorkerErrorDTO,
  type EdgeId,
} from './protocol'
import { createStubSolver, loadWasmSolver, scenarioJson, type KpiJsonDTO, type SolverApi } from './wasmApi'

/**
 * Sim worker: owns the solver, the chunk residency set and the per-hour result
 * cache. Only the *selected* hour ever crosses back to the main thread; the
 * other 23 stay here (DESIGN 6, ~120 MB at county scale).
 */

const post = (res: ResponseDTO): void => {
  const { message, transfer } = encodeResponse(res)
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer)
}

const errorOf = (code: WorkerErrorDTO['code'], e: unknown, seq: number): ResponseDTO => ({
  type: 'error',
  seq,
  payload: { code, message: e instanceof Error ? e.message : String(e), requestId: seq },
})

/** One run's 24 slots; each is the raw `[volume | vc | delay]` block plus its KPIs. */
type HourCell = { readonly raw: Float32Array; readonly kpis: KpiDTO }
type ResultCache = Map<Hour, HourCell>

const caches: Record<ResultKind, ResultCache> = { baseline: new Map(), scenario: new Map() }

const parseKpis = (json: string): KpiDTO => {
  const k = JSON.parse(json) as KpiJsonDTO
  return {
    vmt: k.vmt,
    vht: k.vht,
    meanDelayS: k.mean_delay_s,
    topEdges: (k.top_edges ?? []).map((t) => ({ edge: t.edge_id as EdgeId, vc: t.vc })),
  }
}

const hourResult = (id: RunRequestDTO['id'], kind: ResultKind, h: Hour, cell: HourCell): HourResultDTO => {
  const n = cell.raw.length / 3
  return {
    id,
    kind,
    hour: h,
    volume: cell.raw.slice(0, n),
    vc: cell.raw.slice(n, 2 * n),
    delay: cell.raw.slice(2 * n, 3 * n),
    kpis: cell.kpis,
  }
}

/**
 * Chunk geometry in deck.gl's binary path shape. Edges below the major classes
 * are dropped at low zoom on the main thread, so both arrays ship once and the
 * per-hour update touches only the colour attribute.
 */
const geometryOf = (chunk: ChunkKey, bytes: ArrayBuffer): ChunkGeometryDTO => {
  const c = decodeChunk(bytes)
  const e = c.meta.edgeCount
  const counts = Array.from({ length: e }, (_, i) =>
    c.geomOffsets ? c.geomOffsets[i + 1]! - c.geomOffsets[i]! : 2,
  ).map((n) => (n >= 2 ? n : 2))
  const total = counts.reduce((a, b) => a + b, 0)
  const positions = new Float32Array(total * 2)
  const startIndices = new Uint32Array(e + 1)
  let at = 0
  for (let i = 0; i < e; i += 1) {
    startIndices[i] = at
    if (c.geomOffsets && c.geomLonLat && counts[i]! > 2) {
      positions.set(c.geomLonLat.subarray(c.geomOffsets[i]! * 2, c.geomOffsets[i + 1]! * 2), at * 2)
    } else {
      const f = c.edgeFrom[i]! * 2
      const t = c.edgeTo[i]! * 2
      positions.set([c.nodeLonLat[f]!, c.nodeLonLat[f + 1]!, c.nodeLonLat[t]!, c.nodeLonLat[t + 1]!], at * 2)
    }
    at += counts[i]!
  }
  startIndices[e] = at
  return { chunk, edges: c.edgeGid.slice(), classes: c.edgeClass.slice(), positions, startIndices }
}

const statsOf = (solver: SolverApi): StatsDTO => ({ ...solver.stats(), backend: solver.kind })

const cancelled = new Set<number>()

/**
 * Runs the requested hours one message-loop turn apart so the worker stays
 * responsive to `select-hour` while the background 23 finish. The first hour is
 * posted; the rest are cached.
 */
const runHours = (solver: SolverApi, req: RunRequestDTO): void => {
  const json = scenarioJson(req.scenario)
  const cache = caches[req.kind]
  cache.clear()
  post({ type: 'edge-order', seq: 0, payload: { edges: solver.loadedEdgeIds().slice() } })
  const queue = [...req.hours]
  const step = (): void => {
    if (cancelled.has(req.id) || queue.length === 0) {
      post({ type: 'run-done', seq: 0, payload: { id: req.id, kind: req.kind } })
      return
    }
    const h = queue.shift() as Hour
    const raw = solver.runHour(json, h)
    const cell: HourCell = { raw: raw.slice(), kpis: parseKpis(solver.kpisJson()) }
    cache.set(h, cell)
    post({ type: 'hour-result', seq: 0, payload: hourResult(req.id, req.kind, h, cell) })
    setTimeout(step, 0)
  }
  step()
}

const handle = (solver: SolverApi, req: RequestDTO): void => {
  switch (req.type) {
    case 'load-index':
      solver.loadIndex(new Uint8Array(req.payload.index))
      return post({ type: 'ack', seq: req.seq, payload: { ok: true } })
    case 'load-chunk': {
      const { chunk, chunkIx, bytes } = req.payload
      post({ type: 'chunk-geometry', seq: req.seq, payload: geometryOf(chunk, bytes) })
      solver.loadChunk(chunkIx, new Uint8Array(bytes))
      return post({ type: 'ack', seq: req.seq, payload: { ok: true } })
    }
    case 'free-chunk':
      req.payload.chunks.forEach((c) => solver.freeChunk(c.chunkIx))
      return post({ type: 'ack', seq: req.seq, payload: { ok: true } })
    case 'load-demand':
      solver.loadDemand(new Uint8Array(req.payload.bytes))
      return post({ type: 'ack', seq: req.seq, payload: { ok: true } })
    case 'load-cch-order':
      solver.loadCchOrder(new Uint8Array(req.payload.bytes))
      return post({ type: 'ack', seq: req.seq, payload: { ok: true } })
    case 'stats':
      return post({ type: 'stats', seq: req.seq, payload: statsOf(solver) })
    case 'cancel':
      cancelled.add(req.payload.id)
      return post({ type: 'ack', seq: req.seq, payload: { ok: true } })
    case 'select-hour': {
      const cell = caches[req.payload.kind].get(req.payload.hour)
      if (!cell) return post({ type: 'ack', seq: req.seq, payload: { ok: true } })
      return post({
        type: 'hour-result',
        seq: req.seq,
        payload: hourResult(0 as RunRequestDTO['id'], req.payload.kind, req.payload.hour, cell),
      })
    }
    case 'run':
      return runHours(solver, req.payload)
  }
}

void loadWasmSolver()
  .catch(() => null)
  .then((real) => real ?? createStubSolver())
  .then((solver) => {
    post({ type: 'ready', seq: 0, payload: statsOf(solver) })
    self.onmessage = (ev: MessageEvent<unknown>) => {
      try {
        handle(solver, decodeRequest(ev.data))
      } catch (e) {
        post(errorOf('run-failed', e, -1))
      }
    }
  })
