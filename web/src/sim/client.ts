import { gauge, mark } from '../perf'
import { useSimStore, useUiStore, useWorldStore } from '../state/stores'
import { AssetLoader, Priority, type AssetPath } from './AssetLoader'
import {
  ALL_HOURS,
  decodeResponse,
  encodeRequest,
  hour,
  runId,
  transferBytes,
  type Hour,
  type RequestDTO,
  type ResponseDTO,
  type ResultKind,
  type RunId,
  type ScenarioDTO,
} from './protocol'
import {
  chunkIx,
  chunkPath,
  chunksInArea,
  orderByDistance,
  parseManifest,
  type ChunkKey,
  type ManifestDTO,
  type StudyArea,
} from '../graph/manifest'
import { FAIRFAX_CAMERA } from '../map/layers'

/**
 * Load orchestration + typed worker host (DESIGN 7.1). The UI never touches the
 * worker or the network directly; it calls into the handle this returns.
 */

export type SimClient = {
  readonly start: () => Promise<void>
  readonly setStudyArea: (area: StudyArea) => Promise<void>
  readonly run: (kind: ResultKind, scenario: ScenarioDTO, hours?: readonly Hour[]) => void
  readonly selectHour: (kind: ResultKind, h: Hour) => void
  readonly stats: () => void
  readonly terminate: () => void
  /** Cumulative bytes handed to `postMessage`, for the perf harness. */
  readonly messageBytes: () => number
}

const BASELINE_HOUR: Hour = hour(8)
const MANIFEST_PATH = 'manifest.json' as AssetPath
const INDEX_PATH = 'graph/index.bin' as AssetPath

const rest = (first: Hour): readonly Hour[] => ALL_HOURS.filter((h) => h !== first)

const applyResponse = (res: ResponseDTO): void => {
  const world = useWorldStore.getState()
  switch (res.type) {
    case 'ready':
    case 'stats':
      mark('worker-ready')
      return world.setStats(res.payload)
    case 'chunk-geometry':
      return world.putGeometry(res.payload)
    case 'edge-order':
      return world.setOrder(res.payload.edges)
    case 'hour-result': {
      if (res.payload.kind === 'baseline' && res.payload.hour === BASELINE_HOUR) mark('first-baseline')
      useSimStore.getState().putResult(res.payload)
      const sim = useSimStore.getState()
      gauge('baselineHours', Object.keys(sim.baseline).length)
      gauge('scenarioHours', Object.keys(sim.scenario).length)
      return
    }
    case 'run-done':
      return useSimStore.getState().setStatus('done', res.payload.kind)
    case 'error':
      return world.setError(res.payload)
    case 'ack':
      return
  }
}

export const createSimClient = (): SimClient => {
  mark('worker-start')
  useWorldStore.getState().setLoad('loading')
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (ev: MessageEvent<unknown>) => applyResponse(decodeResponse(ev.data))

  let seq = 0
  let bytes = 0
  const send = (req: Omit<RequestDTO, 'seq'>): void => {
    seq += 1
    const { message, transfer } = encodeRequest({ ...req, seq } as RequestDTO)
    bytes += transferBytes(transfer)
    gauge('workerMessageBytes', bytes)
    worker.postMessage(message, transfer)
  }

  let loader: AssetLoader | null = null
  let manifest: ManifestDTO | null = null
  let resident: ReadonlySet<ChunkKey> = new Set()
  let nextRun = 0

  const loadChunks = async (m: ManifestDTO, keys: readonly ChunkKey[], priority: Priority): Promise<void> => {
    const ordered = orderByDistance(keys, m, FAIRFAX_CAMERA.center)
    // AssetLoader already caps concurrency at 6; fire them all and let it queue.
    await Promise.allSettled(
      ordered.map(async (key) => {
        const [cx, cy] = key.split('_').map(Number) as [number, number]
        const buf = await loader!.get(chunkPath(cx, cy) as AssetPath, priority)
        send({ type: 'load-chunk', payload: { chunk: key, chunkIx: chunkIx(cx, cy, m.grid.cols), bytes: buf } })
      }),
    )
  }

  /** demand + CCH order are idle-priority and optional until the Rust track ships them. */
  const loadIdleAssets = async (): Promise<void> => {
    const pairs = [
      ['demand.bin', 'load-demand'],
      ['cch_order.bin', 'load-cch-order'],
    ] as const
    await Promise.all(
      pairs.map(async ([path, type]) => {
        const buf = await loader!.get(path as AssetPath, Priority.Idle).catch(() => null)
        if (buf) send({ type, payload: { bytes: buf } })
      }),
    )
  }

  const run = (kind: ResultKind, scenario: ScenarioDTO, hours: readonly Hour[] = [BASELINE_HOUR, ...rest(BASELINE_HOUR)]): void => {
    nextRun += 1
    const id = runId(nextRun) as RunId
    useSimStore.getState().clear(kind)
    useSimStore.getState().setStatus('running', kind)
    send({ type: 'run', payload: { id, kind, scenario, hours } })
  }

  const setStudyArea = async (area: StudyArea): Promise<void> => {
    if (!manifest || !loader) return
    const wanted = new Set(chunksInArea(manifest, area))
    const toFree = [...resident].filter((k) => !wanted.has(k))
    const toLoad = [...wanted].filter((k) => !resident.has(k))
    if (toFree.length > 0) {
      const cols = manifest.grid.cols
      send({
        type: 'free-chunk',
        payload: {
          chunks: toFree.map((chunk) => {
            const [cx, cy] = chunk.split('_').map(Number) as [number, number]
            return { chunk, chunkIx: chunkIx(cx, cy, cols) }
          }),
        },
      })
      useWorldStore.getState().dropGeometry(toFree)
      // the freed chunk buffers are the bulk of the LRU; drop it rather than
      // hold bytes for cells the worker no longer knows about
      loader.clear()
    }
    resident = wanted
    await loadChunks(manifest, toLoad, Priority.StudyArea)
    run('baseline', { edits: [] })
  }

  const start = async (): Promise<void> => {
    const res = await fetch(`/data/${MANIFEST_PATH}`)
    if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`)
    const m = parseManifest(await res.json())
    manifest = m
    useWorldStore.getState().setManifest(m)
    mark('manifest')
    loader = new AssetLoader({ manifestHash: m.hash })

    const index = await loader.get(INDEX_PATH, Priority.Viewport)
    send({ type: 'load-index', payload: { manifestHash: m.hash, index } })
    mark('index')

    const keys = chunksInArea(m, useUiStore.getState().studyArea)
    resident = new Set(keys)
    await loadChunks(m, keys, Priority.StudyArea)
    mark('chunks')

    // baseline first (it is the diff target); the big idle blobs follow.
    run('baseline', { edits: [] })
    void loadIdleAssets()
    send({ type: 'stats', payload: {} })
  }

  return {
    start,
    setStudyArea,
    run,
    selectHour: (kind, h) => send({ type: 'select-hour', payload: { kind, hour: h } }),
    stats: () => send({ type: 'stats', payload: {} }),
    terminate: () => worker.terminate(),
    messageBytes: () => bytes,
  }
}

/**
 * The app runs exactly one worker, and the panels are siblings of the component
 * that starts it, so the handle lives here rather than in a React context.
 */
let active: SimClient | null = null

export const setSimClient = (client: SimClient | null): void => {
  active = client
}

export const getSimClient = (): SimClient | null => active
