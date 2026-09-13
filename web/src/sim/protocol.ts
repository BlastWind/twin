/**
 * Worker <-> main-thread protocol (DESIGN 7.3).
 * Everything crossing postMessage is a `*DTO`; buffers are transferred, never copied.
 */

export type RunId = number & { readonly __brand: 'RunId' }
export type Hour = number & { readonly __brand: 'Hour' }
export type EdgeId = number & { readonly __brand: 'EdgeId' }
export type ChunkId = string & { readonly __brand: 'ChunkId' }
export type ManifestHash = string & { readonly __brand: 'ManifestHash' }

export const runId = (n: number): RunId => n as RunId
export const hour = (n: number): Hour => {
  if (!Number.isInteger(n) || n < 0 || n > 23) throw new RangeError(`hour out of range: ${n}`)
  return n as Hour
}
export const edgeId = (n: number): EdgeId => n as EdgeId
export const chunkId = (x: number, y: number): ChunkId => `${x}_${y}` as ChunkId

/** Scenario edits mirror the `Scenario` ADT in twin-core. */
export type EditDTO =
  | { readonly kind: 'close-edge'; readonly edge: EdgeId }
  | { readonly kind: 'set-edge'; readonly edge: EdgeId; readonly lanes?: number; readonly speedKph?: number; readonly capacityVph?: number }
  | { readonly kind: 'add-edge'; readonly from: number; readonly to: number; readonly lanes: number; readonly speedKph: number; readonly geometry: readonly [number, number][] }

export type ScenarioDTO = { readonly edits: readonly EditDTO[] }

export type KpiDTO = {
  readonly vmt: number
  readonly vht: number
  readonly meanDelayS: number
  readonly maxVc: number
}

export type StatsDTO = {
  readonly nodes: number
  readonly edges: number
  readonly chunksLoaded: number
  readonly wasmBytes: number
  readonly backend: 'wasm' | 'stub'
}

export type WorkerErrorCode = 'load-failed' | 'schema-mismatch' | 'run-failed' | 'unsupported'
export type WorkerErrorDTO = { readonly code: WorkerErrorCode; readonly message: string; readonly requestId?: number }

// ---------- requests ----------

export type LoadIndexDTO = { readonly manifestHash: ManifestHash; readonly index: ArrayBuffer }
export type LoadChunkDTO = { readonly chunk: ChunkId; readonly bytes: ArrayBuffer }
export type FreeChunkDTO = { readonly chunk: ChunkId }
export type RunRequestDTO = { readonly id: RunId; readonly scenario: ScenarioDTO; readonly hours: readonly Hour[] }

export type RequestDTO =
  | { readonly type: 'load-index'; readonly seq: number; readonly payload: LoadIndexDTO }
  | { readonly type: 'load-chunk'; readonly seq: number; readonly payload: LoadChunkDTO }
  | { readonly type: 'free-chunk'; readonly seq: number; readonly payload: FreeChunkDTO }
  | { readonly type: 'stats'; readonly seq: number; readonly payload: Record<string, never> }
  | { readonly type: 'run'; readonly seq: number; readonly payload: RunRequestDTO }
  | { readonly type: 'cancel'; readonly seq: number; readonly payload: { readonly id: RunId } }

export type RequestType = RequestDTO['type']

// ---------- responses ----------

export type HourResultDTO = {
  readonly id: RunId
  readonly hour: Hour
  readonly volume: Float32Array
  readonly vc: Float32Array
  readonly delay: Float32Array
  readonly kpis: KpiDTO
}

export type ResponseDTO =
  | { readonly type: 'ready'; readonly seq: number; readonly payload: StatsDTO }
  | { readonly type: 'stats'; readonly seq: number; readonly payload: StatsDTO }
  | { readonly type: 'ack'; readonly seq: number; readonly payload: { readonly ok: true } }
  | { readonly type: 'hour-result'; readonly seq: number; readonly payload: HourResultDTO }
  | { readonly type: 'run-done'; readonly seq: number; readonly payload: { readonly id: RunId } }
  | { readonly type: 'error'; readonly seq: number; readonly payload: WorkerErrorDTO }

export type ResponseType = ResponseDTO['type']

/** Narrow a `Response`'s payload by its tag — used by the typed client. */
export type PayloadOf<T extends ResponseType> = Extract<ResponseDTO, { type: T }>['payload']

// ---------- codec ----------

/** Structured-clone-safe encode: also computes the transfer list. */
export const encodeRequest = (req: RequestDTO): { readonly message: RequestDTO; readonly transfer: Transferable[] } => {
  switch (req.type) {
    case 'load-index':
      return { message: req, transfer: [req.payload.index] }
    case 'load-chunk':
      return { message: req, transfer: [req.payload.bytes] }
    default:
      return { message: req, transfer: [] }
  }
}

export const encodeResponse = (res: ResponseDTO): { readonly message: ResponseDTO; readonly transfer: Transferable[] } => {
  if (res.type !== 'hour-result') return { message: res, transfer: [] }
  const { volume, vc, delay } = res.payload
  return { message: res, transfer: [volume.buffer, vc.buffer, delay.buffer] as Transferable[] }
}

const REQUEST_TYPES: ReadonlySet<string> = new Set<RequestType>(['load-index', 'load-chunk', 'free-chunk', 'stats', 'run', 'cancel'])
const RESPONSE_TYPES: ReadonlySet<string> = new Set<ResponseType>(['ready', 'stats', 'ack', 'hour-result', 'run-done', 'error'])

const hasTag = (v: unknown, types: ReadonlySet<string>): boolean => {
  if (typeof v !== 'object' || v === null) return false
  const rec = v as { type?: unknown; seq?: unknown; payload?: unknown }
  return typeof rec.type === 'string' && types.has(rec.type) && typeof rec.seq === 'number' && typeof rec.payload === 'object'
}

export const decodeRequest = (data: unknown): RequestDTO => {
  if (!hasTag(data, REQUEST_TYPES)) throw new TypeError(`malformed worker request: ${JSON.stringify(data)?.slice(0, 120)}`)
  return data as RequestDTO
}

export const decodeResponse = (data: unknown): ResponseDTO => {
  if (!hasTag(data, RESPONSE_TYPES)) throw new TypeError(`malformed worker response: ${JSON.stringify(data)?.slice(0, 120)}`)
  return data as ResponseDTO
}
