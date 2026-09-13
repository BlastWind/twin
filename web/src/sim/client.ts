import { gauge, mark } from '../perf'
import {
  useCalibrationStore,
  useScenarioStore,
  useReachStore,
  useSimStore,
  useTransitStore,
  useUiStore,
  useWorldStore,
} from '../state/stores'
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
  type IsochroneRequestDTO,
  type RunId,
  type ScenarioDTO,
  withZones,
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
import { decodeIndex } from '../graph/schema'
import { FAIRFAX_CAMERA } from '../map/layers'

/**
 * Load orchestration + typed worker host (DESIGN 7.1). The UI never touches the
 * worker or the network directly; it calls into the handle this returns.
 */

export type SimClient = {
  readonly start: () => Promise<void>
  readonly setStudyArea: (area: StudyArea) => Promise<void>
  readonly run: (kind: ResultKind, scenario: ScenarioDTO, hours?: readonly Hour[]) => void
  /** Recomputes the reach from the stored origin; a no-op when there is none. */
  readonly isochrone: (req: IsochroneRequestDTO) => void
  readonly calibration: () => void
  readonly snap: (lon: number, lat: number) => void
  readonly selectHour: (kind: ResultKind, h: Hour) => void
  readonly stats: () => void
  readonly terminate: () => void
  /** Cumulative bytes handed to `postMessage`, for the perf harness. */
  readonly messageBytes: () => number
}

const BASELINE_HOUR: Hour = hour(8)

/** `requestIdleCallback` where it exists, a macrotask everywhere else. */
const whenIdle = (fn: () => Promise<void>): Promise<void> =>
  new Promise((resolve) => {
    const run = () => void fn().then(resolve)
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
      .requestIdleCallback
    if (ric) ric(run, { timeout: 5_000 })
    else setTimeout(run, 0)
  })
const MANIFEST_PATH = 'manifest.json' as AssetPath
const INDEX_PATH = 'graph/index.bin' as AssetPath

/** The hour on screen is computed first; the other 23 are the background sweep. */
const selectedFirst = (first: Hour): readonly Hour[] => [first, ...ALL_HOURS.filter((h) => h !== first)]

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
    case 'reach':
      mark('first-isochrone')
      gauge('reachNodes', res.payload.summary.nodes)
      return useReachStore.getState().putResult(res.payload)
    case 'calibration':
      return useCalibrationStore.getState().setRows(res.payload.rows)
    case 'snap':
      // only ever requested while the transit editor is drawing, so the reply
      // is the next stop of whatever pattern is open
      return useTransitStore.getState().addStop(res.payload.snapped)
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
  let activeRun: RunId | null = null
  let demandReady = false

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

/**
   * Demand and the CCH order queue at idle priority but are *awaited*: the
   * solver rejects `runHour` before `loadDemand`, so the baseline cannot start
   * until they land. Missing files leave `demandReady` false and the baseline
   * is skipped with a clear error rather than a solver exception per hour.
   */
  const loadIdleAssets = async (): Promise<void> => {
    const pairs = [
      ['demand.bin', 'load-demand'],
      ['cch_order.bin', 'load-cch-order'],
    ] as const
    const got = await Promise.all(
      pairs.map(async ([path, type]) => {
        const buf = await loader!.get(path as AssetPath, Priority.Idle).catch(() => null)
        if (buf) send({ type, payload: { bytes: buf } })
        return buf !== null
      }),
    )
    demandReady = got[0] === true
  }

  /**
   * Feeds are not on the critical path: the graph, demand and the baseline all
   * come first, then these fill in at idle priority (DESIGN 7.1 step 4). A file
   * the pipeline has not produced yet simply never arrives — the isochrone tool
   * falls back to the worker's stub and the calibration panel stays empty.
   */
  const loadFeeds = async (): Promise<void> => {
    const pairs = [
      ['transit.bin', 'load-transit'],
      ['counts.bin', 'load-counts'],
    ] as const
    await Promise.all(
      pairs.map(async ([path, type]) => {
        const buf = await loader!.get(path as AssetPath, Priority.Idle).catch(() => null)
        if (buf) send({ type, payload: { bytes: buf } })
      }),
    )
    mark('feeds')
  }

  /**
   * Starting a run cancels whatever is still sweeping: a stale 24-hour sweep
   * would otherwise sit in front of the hour the user is actually waiting on,
   * and at county scale one hour is tens of seconds.
   */
  const cancelActive = (): void => {
    if (activeRun === null) return
    send({ type: 'cancel', payload: { id: activeRun } })
    activeRun = null
  }

  const run = (kind: ResultKind, scenario: ScenarioDTO, hours?: readonly Hour[]): void => {
    cancelActive()
    nextRun += 1
    const id = runId(nextRun) as RunId
    activeRun = id
    useSimStore.getState().clear(kind)
    useSimStore.getState().setStatus('running', kind)
    send({ type: 'run', payload: { id, kind, scenario, hours: hours ?? selectedFirst(useUiStore.getState().hour) } })
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
    startBaseline()
  }

  /** The one place that decides whether a baseline run is possible. */
  const startBaseline = (): void => {
    if (!demandReady) {
      return useWorldStore.getState().setError({
        code: 'load-failed',
        message: 'demand.bin is missing, so no hour can be assigned',
      })
    }
    // the baseline is the comparison target, so it runs under the same zoning
    // the scenario does; only the edits are dropped
    run('baseline', withZones({ edits: [] }, useScenarioStore.getState().scenario.zones ?? 'full'))
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
    // decode before transferring: the chunk table's per-cell edge counts are
    // what the study-area picker costs a selection with
    useWorldStore.getState().setIndex(decodeIndex(index).chunks)
    send({ type: 'load-index', payload: { manifestHash: m.hash, index } })
    mark('index')

    const keys = chunksInArea(m, useUiStore.getState().studyArea)
    resident = new Set(keys)
    await loadChunks(m, keys, Priority.StudyArea)
    mark('chunks')

    // the solver refuses to assign before demand is loaded, so the baseline
    // waits on it rather than racing it
    await loadIdleAssets()
    mark('demand')
    startBaseline()
    send({ type: 'stats', payload: {} })
    // after the graph, never in front of it
    void whenIdle(loadFeeds)
  }

  return {
    start,
    setStudyArea,
    run,
    isochrone: (req) => {
      useReachStore.getState().setStatus('running')
      send({ type: 'isochrone', payload: req })
    },
    calibration: () => send({ type: 'calibration', payload: {} }),
    snap: (lon, lat) => send({ type: 'snap', payload: { lon, lat } }),
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
  // the perf harness drives the study area from outside React
  Object.assign(globalThis, { __twinClient: client })
}

export const getSimClient = (): SimClient | null => active
