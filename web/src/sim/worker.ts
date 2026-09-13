/// <reference lib="webworker" />
import {
  decodeRequest,
  encodeResponse,
  type ChunkId,
  type HourResultDTO,
  type RequestDTO,
  type ResponseDTO,
  type RunRequestDTO,
  type StatsDTO,
  type WorkerErrorDTO,
} from './protocol'

/**
 * Sim worker. Uses the real wasm core when `public/wasm/twin_wasm.js` exists
 * (built by the Rust track), otherwise a deterministic stub so the whole
 * pipeline — codec, stores, overlay — is exercisable today.
 */

type WasmCore = {
  load_index: (bytes: Uint8Array) => void
  load_chunk: (id: string, bytes: Uint8Array) => void
  free_chunk: (id: string) => void
  stats: () => { nodes: number; edges: number; chunks_loaded: number; wasm_bytes: number }
}

type Backend =
  | { readonly kind: 'wasm'; readonly core: WasmCore }
  | { readonly kind: 'stub'; readonly chunks: Set<ChunkId>; edges: number; nodes: number }

const WASM_URL = '/wasm/twin_wasm.js'

const loadWasm = async (): Promise<Backend> => {
  try {
    const head = await fetch(WASM_URL, { method: 'HEAD' })
    if (!head.ok) throw new Error(`no wasm (${head.status})`)
    const mod = (await import(/* @vite-ignore */ WASM_URL)) as { default: (u?: string) => Promise<unknown> } & WasmCore
    await mod.default('/wasm/twin_wasm_bg.wasm')
    return { kind: 'wasm', core: mod }
  } catch {
    return { kind: 'stub', chunks: new Set<ChunkId>(), edges: 0, nodes: 0 }
  }
}

const statsOf = (b: Backend): StatsDTO =>
  b.kind === 'wasm'
    ? (() => {
        const s = b.core.stats()
        return { nodes: s.nodes, edges: s.edges, chunksLoaded: s.chunks_loaded, wasmBytes: s.wasm_bytes, backend: 'wasm' as const }
      })()
    : { nodes: b.nodes, edges: b.edges, chunksLoaded: b.chunks.size, wasmBytes: 0, backend: 'stub' as const }

/** Deterministic fake flows so the overlay has plausible data before the core lands. */
const fakeHourResult = (req: RunRequestDTO, h: number, edges: number): HourResultDTO => {
  const volume = new Float32Array(edges)
  const vc = new Float32Array(edges)
  const delay = new Float32Array(edges)
  const peak = 1 - Math.abs(h - 8) / 12
  let vmt = 0
  let vht = 0
  for (let i = 0; i < edges; i += 1) {
    const base = ((i * 2654435761) % 1000) / 1000
    const v = base * 1800 * Math.max(peak, 0.1)
    const ratio = v / 1600
    volume[i] = v
    vc[i] = ratio
    delay[i] = 15 * ratio ** 4
    vmt += v * 0.2
    vht += (v * 0.2) / 45
  }
  return {
    id: req.id,
    hour: h as HourResultDTO['hour'],
    volume,
    vc,
    delay,
    kpis: { vmt, vht, meanDelayS: edges ? delay.reduce((a, b) => a + b, 0) / edges : 0, maxVc: vc.length ? Math.max(...vc) : 0 },
  }
}

const post = (res: ResponseDTO): void => {
  const { message, transfer } = encodeResponse(res)
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer)
}

const errorOf = (code: WorkerErrorDTO['code'], e: unknown, seq: number): ResponseDTO => ({
  type: 'error',
  seq,
  payload: { code, message: e instanceof Error ? e.message : String(e), requestId: seq },
})

const cancelled = new Set<number>()

const handle = (backend: Backend, req: RequestDTO): void => {
  switch (req.type) {
    case 'load-index': {
      if (backend.kind === 'wasm') backend.core.load_index(new Uint8Array(req.payload.index))
      else backend.nodes = Math.max(backend.nodes, req.payload.index.byteLength >> 4)
      post({ type: 'ack', seq: req.seq, payload: { ok: true } })
      return
    }
    case 'load-chunk': {
      if (backend.kind === 'wasm') backend.core.load_chunk(req.payload.chunk, new Uint8Array(req.payload.bytes))
      else {
        backend.chunks.add(req.payload.chunk)
        backend.edges += req.payload.bytes.byteLength >> 5
      }
      post({ type: 'ack', seq: req.seq, payload: { ok: true } })
      return
    }
    case 'free-chunk': {
      if (backend.kind === 'wasm') backend.core.free_chunk(req.payload.chunk)
      else backend.chunks.delete(req.payload.chunk)
      post({ type: 'ack', seq: req.seq, payload: { ok: true } })
      return
    }
    case 'stats': {
      post({ type: 'stats', seq: req.seq, payload: statsOf(backend) })
      return
    }
    case 'cancel': {
      cancelled.add(req.payload.id)
      post({ type: 'ack', seq: req.seq, payload: { ok: true } })
      return
    }
    case 'run': {
      const edges = statsOf(backend).edges || 20_000
      req.payload.hours
        .filter(() => !cancelled.has(req.payload.id))
        .forEach((h) => post({ type: 'hour-result', seq: req.seq, payload: fakeHourResult(req.payload, h, edges) }))
      post({ type: 'run-done', seq: req.seq, payload: { id: req.payload.id } })
      return
    }
  }
}

void loadWasm().then((backend) => {
  post({ type: 'ready', seq: 0, payload: statsOf(backend) })
  self.onmessage = (ev: MessageEvent<unknown>) => {
    try {
      handle(backend, decodeRequest(ev.data))
    } catch (e) {
      post(errorOf('run-failed', e, -1))
    }
  }
})
