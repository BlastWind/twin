/**
 * Worker <-> main-thread protocol (DESIGN 7.3).
 * Everything crossing postMessage is a `*DTO`; buffers are transferred, never copied.
 */

import type { ChunkKey, ManifestHash } from '../graph/manifest'
import type { WasmBackendKind } from './wasmApi'

export type RunId = number & { readonly __brand: 'RunId' }
export type Hour = number & { readonly __brand: 'Hour' }
export type EdgeId = number & { readonly __brand: 'EdgeId' }

export const runId = (n: number): RunId => n as RunId
export const hour = (n: number): Hour => {
  if (!Number.isInteger(n) || n < 0 || n > 23) throw new RangeError(`hour out of range: ${n}`)
  return n as Hour
}
export const ALL_HOURS: readonly Hour[] = Array.from({ length: 24 }, (_, h) => h as Hour)
export const edgeId = (n: number): EdgeId => n as EdgeId

export type { ChunkKey, ManifestHash }

/** Which of the two result tracks a run belongs to. */
export type ResultKind = 'baseline' | 'scenario'

// ---------- scenario (mirrors the wasm JSON contract verbatim) ----------

/**
 * `{"edits":[{"type":"CloseEdge","edge":n} | {"type":"SetEdge","edge":n,...}]}`
 * — field names are snake_case because this object *is* the wire format handed
 * to `runHour`; there is no second transformation.
 */
export type EdgeEditDTO =
  | { readonly type: 'CloseEdge'; readonly edge: EdgeId }
  | {
      readonly type: 'SetEdge'
      readonly edge: EdgeId
      readonly lanes?: number
      readonly speed_mps?: number
      readonly capacity_vph?: number
    }

export type RouteId = string & { readonly __brand: 'RouteId' }
export type NodeId = number & { readonly __brand: 'NodeId' }

/**
 * Transit edits ride in the same `edits` array so a scenario stays one object
 * in the URL hash and one JSON string at the wasm boundary.
 *
 * The road solver ignores them today — they change isochrones only, and the UI
 * says so. `stops` are graph node ids, in service order.
 */
export type TransitEditDTO =
  | {
      readonly type: 'TransitEdit'
      readonly op: 'AddPattern'
      readonly route_id: RouteId
      readonly stops: readonly NodeId[]
      readonly headway_s: number
    }
  | { readonly type: 'TransitEdit'; readonly op: 'RemoveRoute'; readonly route_id: RouteId }

export type EditDTO = EdgeEditDTO | TransitEditDTO

export const isEdgeEdit = (e: EditDTO): e is EdgeEditDTO => e.type !== 'TransitEdit'

/**
 * How finely the demand loads. County-scale runs want `coarse` — a few hundred
 * loading points instead of 1,415 — and it is what keeps an hour inside a few
 * seconds. Optional and defaulted on the Rust side, so an older saved scenario
 * still parses.
 */
export type ZonesDTO = 'full' | 'coarse'

export type ScenarioDTO = { readonly edits: readonly EditDTO[]; readonly zones?: ZonesDTO }

export const EMPTY_SCENARIO: ScenarioDTO = { edits: [] }

export const withZones = (s: ScenarioDTO, zones: ZonesDTO): ScenarioDTO => ({ ...s, zones })

export const editedEdges = (s: ScenarioDTO): ReadonlySet<EdgeId> =>
  new Set(s.edits.filter(isEdgeEdit).map((e) => e.edge))

export const transitEdits = (s: ScenarioDTO): readonly TransitEditDTO[] =>
  s.edits.filter((e): e is TransitEditDTO => e.type === 'TransitEdit')

// ---------- results ----------

export type KpiDTO = {
  readonly vmt: number
  readonly vht: number
  readonly meanDelayS: number
  readonly topEdges: readonly { readonly edge: EdgeId; readonly vc: number }[]
}

/**
 * A clicked point resolved to the nearest graph node. The node table lives in
 * the worker, so snapping does too — the transit editor names stops by node id
 * because that is what a pattern is made of.
 */
export type SnapRequestDTO = { readonly lon: number; readonly lat: number }
export type SnapResultDTO = { readonly node: NodeId; readonly lon: number; readonly lat: number } | null

/** Isochrone origin and budget; `hour` picks the transit timetable slice. */
export type IsochroneRequestDTO = {
  readonly lon: number
  readonly lat: number
  readonly hour: Hour
  readonly budgetMin: number
}

export type ReachSummaryDTO = { readonly nodes: number; readonly population: number }

/**
 * `pairs` is the contract's flat `[node_id, seconds, …]`. `positions` is the
 * same rows resolved to `[lon, lat, …]` by the worker, which is the only place
 * that holds the node table; without it the main thread could not draw them.
 */
export type ReachResultDTO = {
  readonly request: IsochroneRequestDTO
  readonly pairs: Float32Array
  readonly positions: Float32Array
  readonly summary: ReachSummaryDTO
}

/** One count station: observed AADT against the modeled 24 h total. */
export type CalibrationDTO = {
  readonly stationId: number
  readonly edge: EdgeId
  readonly aadt: number
  readonly modeledDaily: number
}

export type StatsDTO = {
  readonly nodes: number
  readonly edges: number
  readonly chunksLoaded: number
  readonly wasmBytes: number
  readonly backend: WasmBackendKind
  /** What `threadCount()` reports: 1 unless the threaded build's pool started. */
  readonly threads: number
}

export type WorkerErrorCode = 'load-failed' | 'schema-mismatch' | 'run-failed' | 'unsupported'
export type WorkerErrorDTO = { readonly code: WorkerErrorCode; readonly message: string; readonly requestId?: number }

// ---------- requests ----------

export type LoadIndexDTO = { readonly manifestHash: ManifestHash; readonly index: ArrayBuffer }
export type LoadChunkDTO = { readonly chunk: ChunkKey; readonly chunkIx: number; readonly bytes: ArrayBuffer }
export type FreeChunkDTO = { readonly chunks: readonly { readonly chunk: ChunkKey; readonly chunkIx: number }[] }
export type LoadBlobDTO = { readonly bytes: ArrayBuffer }
export type RunRequestDTO = {
  readonly id: RunId
  readonly kind: ResultKind
  readonly scenario: ScenarioDTO
  readonly hours: readonly Hour[]
}
export type SelectHourDTO = { readonly kind: ResultKind; readonly hour: Hour }

export type RequestDTO =
  | { readonly type: 'load-index'; readonly seq: number; readonly payload: LoadIndexDTO }
  | { readonly type: 'load-chunk'; readonly seq: number; readonly payload: LoadChunkDTO }
  | { readonly type: 'free-chunk'; readonly seq: number; readonly payload: FreeChunkDTO }
  | { readonly type: 'load-demand'; readonly seq: number; readonly payload: LoadBlobDTO }
  | { readonly type: 'load-cch-order'; readonly seq: number; readonly payload: LoadBlobDTO }
  | { readonly type: 'stats'; readonly seq: number; readonly payload: Record<string, never> }
  | { readonly type: 'run'; readonly seq: number; readonly payload: RunRequestDTO }
  | { readonly type: 'select-hour'; readonly seq: number; readonly payload: SelectHourDTO }
  | { readonly type: 'cancel'; readonly seq: number; readonly payload: { readonly id: RunId } }
  | { readonly type: 'load-transit'; readonly seq: number; readonly payload: LoadBlobDTO }
  | { readonly type: 'load-counts'; readonly seq: number; readonly payload: LoadBlobDTO }
  | { readonly type: 'isochrone'; readonly seq: number; readonly payload: IsochroneRequestDTO }
  | { readonly type: 'calibration'; readonly seq: number; readonly payload: Record<string, never> }
  | { readonly type: 'snap'; readonly seq: number; readonly payload: SnapRequestDTO }

export type RequestType = RequestDTO['type']

// ---------- responses ----------

/**
 * Edge polylines for one chunk, in deck.gl's binary `PathLayer` shape:
 * `positions` is flat `[lon, lat, …]`, `startIndices` is `paths + 1` vertex
 * offsets. `edges`/`classes` are parallel to the paths.
 */
export type ChunkGeometryDTO = {
  readonly chunk: ChunkKey
  readonly edges: Uint32Array
  readonly classes: Uint8Array
  readonly positions: Float32Array
  readonly startIndices: Uint32Array
}

/** The `loadedEdgeIds()` order every result array is indexed by. */
export type EdgeOrderDTO = { readonly edges: Uint32Array }

export type HourResultDTO = {
  readonly id: RunId
  readonly kind: ResultKind
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
  | { readonly type: 'chunk-geometry'; readonly seq: number; readonly payload: ChunkGeometryDTO }
  | { readonly type: 'edge-order'; readonly seq: number; readonly payload: EdgeOrderDTO }
  | { readonly type: 'hour-result'; readonly seq: number; readonly payload: HourResultDTO }
  | { readonly type: 'run-done'; readonly seq: number; readonly payload: { readonly id: RunId; readonly kind: ResultKind } }
  | { readonly type: 'reach'; readonly seq: number; readonly payload: ReachResultDTO }
  | { readonly type: 'snap'; readonly seq: number; readonly payload: { readonly snapped: SnapResultDTO } }
  | { readonly type: 'calibration'; readonly seq: number; readonly payload: { readonly rows: readonly CalibrationDTO[] } }
  | { readonly type: 'error'; readonly seq: number; readonly payload: WorkerErrorDTO }

export type ResponseType = ResponseDTO['type']

export type PayloadOf<T extends ResponseType> = Extract<ResponseDTO, { type: T }>['payload']

// ---------- codec ----------

/** Structured-clone-safe encode: also computes the transfer list. */
export const encodeRequest = (req: RequestDTO): { readonly message: RequestDTO; readonly transfer: Transferable[] } => {
  switch (req.type) {
    case 'load-index':
      return { message: req, transfer: [req.payload.index] }
    case 'load-chunk':
      return { message: req, transfer: [req.payload.bytes] }
    case 'load-demand':
    case 'load-cch-order':
    case 'load-transit':
    case 'load-counts':
      return { message: req, transfer: [req.payload.bytes] }
    default:
      return { message: req, transfer: [] }
  }
}

export const encodeResponse = (res: ResponseDTO): { readonly message: ResponseDTO; readonly transfer: Transferable[] } => {
  switch (res.type) {
    case 'hour-result': {
      const { volume, vc, delay } = res.payload
      return { message: res, transfer: [volume.buffer, vc.buffer, delay.buffer] as Transferable[] }
    }
    case 'chunk-geometry': {
      const { edges, classes, positions, startIndices } = res.payload
      return { message: res, transfer: [edges.buffer, classes.buffer, positions.buffer, startIndices.buffer] as Transferable[] }
    }
    case 'edge-order':
      return { message: res, transfer: [res.payload.edges.buffer] as Transferable[] }
    case 'reach':
      return { message: res, transfer: [res.payload.pairs.buffer, res.payload.positions.buffer] as Transferable[] }
    default:
      return { message: res, transfer: [] }
  }
}

/** Bytes actually handed to `postMessage` — the perf harness asserts on these. */
export const transferBytes = (transfer: readonly Transferable[]): number =>
  transfer.reduce<number>((n, t) => n + ((t as ArrayBuffer).byteLength ?? 0), 0)

const REQUEST_TYPES: ReadonlySet<string> = new Set<RequestType>([
  'load-index',
  'load-chunk',
  'free-chunk',
  'load-demand',
  'load-cch-order',
  'stats',
  'run',
  'select-hour',
  'cancel',
  'load-transit',
  'load-counts',
  'isochrone',
  'calibration',
  'snap',
])
const RESPONSE_TYPES: ReadonlySet<string> = new Set<ResponseType>([
  'ready',
  'stats',
  'ack',
  'chunk-geometry',
  'edge-order',
  'hour-result',
  'run-done',
  'reach',
  'calibration',
  'snap',
  'error',
])

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
