import { expect, test, type CDPSession, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Browser perf harness (DESIGN 8): time to first tile / first paint, fps over a
 * scripted pan/tilt/zoom path at three zooms, JS heap after load, transfer bytes.
 * Results land in bench/results.json and are compared to bench/baselines.json.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS = resolve(HERE, 'results.json')
const BASELINES = resolve(HERE, 'baselines.json')
const APP_URL = 'http://localhost:4317/'
const REGRESSION = 0.15

type Ms = number
type MetricName =
  | 'firstPaintMs'
  | 'firstTileMs'
  | 'mapIdleMs'
  | 'workerReadyMs'
  | 'firstBaselineMs'
  | 'firstIsochroneMs'
  | 'heapBytesAfterLoad'
  | 'heapBytesAllLayers'
  | 'heapBytesAfter24h'
  | 'transferBytes'
  | 'workerMessageBytes'
  | 'overlayPaths'
  | 'fpsZ11'
  | 'fpsZ13'
  | 'fpsZ15'
  | 'reachNodes'

/** Higher-is-better metrics regress when they *fall*; the rest when they rise. */
const HIGHER_IS_BETTER: ReadonlySet<MetricName> = new Set<MetricName>(['fpsZ11', 'fpsZ13', 'fpsZ15'])

/**
 * Recorded and printed, but not gated.
 *
 * `overlayPaths` is a count, not a cost. The fps figures are excluded for a
 * different reason: under swiftshader they land between 0.5 and 2, where a
 * single frame moves the number by more than the regression threshold, so
 * gating on them reports noise. Fold them back in once they are measured on a
 * machine with a real GPU and sit somewhere stable.
 */
const INFORMATIONAL: ReadonlySet<MetricName> = new Set<MetricName>([
  'overlayPaths',
  'reachNodes',
  'fpsZ11',
  'fpsZ13',
  'fpsZ15',
])

type Results = Readonly<Record<MetricName, number>>

const readJson = <T,>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const gauge = async (page: Page, name: string): Promise<number> =>
  page.evaluate(
    (n) => (globalThis as { __twinGauges?: Record<string, number> }).__twinGauges?.[n] ?? 0,
    name,
  )

/** Waits for the worker to have cached all 24 baseline hours. */
const wait24h = async (page: Page): Promise<void> => {
  await page
    .waitForFunction(
      () => ((globalThis as { __twinGauges?: Record<string, number> }).__twinGauges?.baselineHours ?? 0) >= 24,
      null,
      { timeout: 120_000 },
    )
    .catch(() => undefined)
}

const markMs = async (page: Page, stage: string): Promise<Ms> =>
  page.evaluate(
    (s) => (globalThis as { __twinMarks?: Record<string, number> }).__twinMarks?.[s] ?? Number.NaN,
    stage,
  )

/**
 * Drive a scripted path and count frames actually presented.
 *
 * The frame counter is installed, waited on, and read back in three *short*
 * evaluates. A single long-lived `page.evaluate` spanning the animation is the
 * obvious way to write this and the wrong one: when the page cannot keep up,
 * that call never settles, and Playwright will not tear the test down while a
 * protocol call is outstanding - so one slow zoom hangs the entire run and no
 * metric gets written. Nothing here outlives a wait Playwright itself controls.
 */
type FpsProbe = { readonly frames: number; readonly ms: number }

const LEGS = [
  { dLng: 0.03, dLat: 0.02, bearing: 25, duration: 900 },
  { dLng: -0.03, dLat: -0.02, pitch: 60, duration: 900 },
  { dLng: 0, dLat: 0, pitch: 45, bearing: 0, duration: 900 },
] as const

const LEG_GAP_MS = 60
const PATH_MS = LEGS.reduce((n, l) => n + l.duration + LEG_GAP_MS, 0)

const measureFps = async (page: Page, zoom: number): Promise<number> => {
  await page.evaluate((z) => {
    const map = (globalThis as { __twinMap?: { jumpTo: (o: unknown) => void } }).__twinMap
    map?.jumpTo({ center: [-77.3, 38.85], zoom: z, pitch: 45, bearing: 0 })
  }, zoom)
  await page.waitForTimeout(500)

  // install the counter and start the animation; returns at once
  await page.evaluate((legs) => {
    const g = globalThis as {
      __twinMap?: { easeTo: (o: unknown) => void; getCenter: () => { lng: number; lat: number } }
      __twinFpsProbe?: { frames: number; t0: number; stop: boolean }
    }
    const map = g.__twinMap
    if (!map) return
    const probe = { frames: 0, t0: performance.now(), stop: false }
    g.__twinFpsProbe = probe
    const tick = () => {
      probe.frames += 1
      if (!probe.stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const c = map.getCenter()
    legs.forEach((leg, i) => {
      setTimeout(
        () => map.easeTo({ ...leg, center: [c.lng + leg.dLng, c.lat + leg.dLat], essential: true }),
        legs.slice(0, i).reduce((n, l) => n + l.duration + 60, 0),
      )
    })
  }, LEGS as unknown as { dLng: number; dLat: number; duration: number }[])

  await page.waitForTimeout(PATH_MS)

  const probe = await page.evaluate((): FpsProbe => {
    const g = globalThis as { __twinFpsProbe?: { frames: number; t0: number; stop: boolean } }
    const p = g.__twinFpsProbe
    if (!p) return { frames: 0, ms: 1 }
    p.stop = true
    return { frames: p.frames, ms: Math.max(1, performance.now() - p.t0) }
  })
  return Number(((probe.frames * 1000) / probe.ms).toFixed(1))
}

/**
 * Software GL in CI is noisy; take the best of a few passes (the first pass
 * also warms the tile cache and shaders) so the 15% threshold is meaningful.
 */
const bestFps = async (page: Page, zoom: number, passes = 3): Promise<number> => {
  const runs: number[] = []
  for (let i = 0; i < passes; i += 1) runs.push(await measureFps(page, zoom))
  return runs.length > 0 ? Math.max(...runs) : Number.NaN
}

/**
 * Switch on every layer the tiles actually carry. The registry hides what the
 * pipeline has not emitted, so this is "all available layers", which is the
 * state the heap figure is about.
 */
const enableAllLayers = async (page: Page): Promise<number> => {
  const n = await page.evaluate(() => {
    const g = globalThis as { __twinUi?: { getState: () => { registry: { id: string; available: boolean }[]; layers: Record<string, boolean>; toggleLayer: (id: string) => void } } }
    const store = g.__twinUi
    if (!store) return 0
    const { registry, layers, toggleLayer } = store.getState()
    const off = registry.filter((l) => l.available && !layers[l.id])
    off.forEach((l) => toggleLayer(l.id))
    return registry.filter((l) => l.available).length
  })
  await page.waitForTimeout(1500)
  return n
}

/**
 * Drops a reach origin at the camera centre and returns how long the first
 * result took. A *duration*, not a page timestamp: when the harness gets round
 * to asking says nothing about how long the answer takes.
 */
const requestIsochrone = async (page: Page): Promise<Ms> => {
  const started = Date.now()
  await page.evaluate(() => {
    const g = globalThis as {
      __twinMap?: { getCenter: () => { lng: number; lat: number } }
      __twinReach?: { getState: () => { setOrigin: (o: [number, number]) => void } }
    }
    const c = g.__twinMap?.getCenter()
    if (c) g.__twinReach?.getState().setOrigin([c.lng, c.lat])
  })
  await page
    .waitForFunction(
      () => (globalThis as { __twinMarks?: Record<string, number> }).__twinMarks?.['first-isochrone'] !== undefined,
      null,
      { timeout: 60_000 },
    )
    .catch(() => undefined)
  return Date.now() - started
}

/** CDP heap usage: exact, unlike the quantized `performance.memory`. */
const heapBytes = async (cdp: CDPSession): Promise<number> => {
  await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined)
  const usage = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }
  return Math.round(usage.usedSize)
}

test('browser perf harness', async ({ page }) => {
  const session = await page.context().newCDPSession(page)
  await session.send('HeapProfiler.enable').catch(() => undefined)

  let transferBytes = 0
  page.on('response', (res) => {
    const len = Number(res.headers()['content-length'] ?? 0)
    transferBytes += Number.isFinite(len) ? len : 0
  })

  await page.goto(APP_URL, { waitUntil: 'load' })
  await page.waitForFunction(() => (globalThis as { __twinMapReady?: boolean }).__twinMapReady === true, null, {
    timeout: 60_000,
  })

  const firstPaintMs = await page.evaluate(
    () => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? Number.NaN,
  )

  // the baseline hour is the first thing a scenario can be diffed against
  await page
    .waitForFunction(() => (globalThis as { __twinMarks?: Record<string, number> }).__twinMarks?.['first-baseline'] !== undefined, null, {
      timeout: 120_000,
    })
    .catch(() => undefined)

  const heapAfterLoad = await heapBytes(session)
  await wait24h(page)

  // Every registry layer on, then a reach from the middle of the study area:
  // this is the heaviest state the app has, and the isochrone is the one
  // Phase-3 interaction with a latency a user waits on.
  const layersOn = await enableAllLayers(page)
  const heapAllLayers = await heapBytes(session)
  const firstIsochroneMs = await requestIsochrone(page)
  const reachNodes = await gauge(page, 'reachNodes')

  const loadMetrics: Results = {
    firstPaintMs: Number(firstPaintMs.toFixed(1)),
    firstTileMs: Number((await markMs(page, 'first-tile')).toFixed(1)),
    mapIdleMs: Number((await markMs(page, 'map-idle')).toFixed(1)),
    workerReadyMs: Number((await markMs(page, 'worker-ready')).toFixed(1)),
    firstBaselineMs: Number((await markMs(page, 'first-baseline')).toFixed(1)),
    firstIsochroneMs: Number(firstIsochroneMs.toFixed(1)),
    heapBytesAfterLoad: heapAfterLoad,
    heapBytesAllLayers: heapAllLayers,
    reachNodes,
    heapBytesAfter24h: await heapBytes(session),
    transferBytes,
    workerMessageBytes: await gauge(page, 'workerMessageBytes'),
    overlayPaths: await gauge(page, 'overlayPaths'),
    fpsZ11: Number.NaN,
    fpsZ13: Number.NaN,
    fpsZ15: Number.NaN,
  }

  // Land the load metrics before the expensive part: if the fps passes overrun
  // or the page dies under them, the run still leaves something behind.
  writeJson(RESULTS, loadMetrics)

  /**
   * fps is measured with the result overlay on, which is the state the app
   * actually runs in from here on. Each zoom is banked as soon as it lands:
   * under software GL a high zoom can saturate the page's main thread badly
   * enough to starve the CDP channel, and when that happens the zooms that did
   * complete are still worth having.
   */
  const fps: Partial<Record<MetricName, number>> = {}
  for (const [metric, zoom] of [
    ['fpsZ11', 11],
    ['fpsZ13', 13],
    ['fpsZ15', 15],
  ] as const) {
    fps[metric] = await bestFps(page, zoom)
    writeJson(RESULTS, { ...loadMetrics, ...fps })
  }

  const results: Results = { ...loadMetrics, ...fps }

  writeJson(RESULTS, results)
  // eslint-disable-next-line no-console
  console.table(results)
  // eslint-disable-next-line no-console
  console.log(`[perf] heap measured with ${layersOn} available layers on`)

  const baseline = readJson<Results>(BASELINES)
  if (!baseline) {
    writeJson(BASELINES, results)
    console.log('[perf] no baseline found — wrote bench/baselines.json from this run')
    return
  }

  const regressions = (Object.keys(results) as MetricName[])
    .filter((k) => !INFORMATIONAL.has(k))
    .filter((k) => Number.isFinite(results[k]) && Number.isFinite(baseline[k]) && baseline[k] !== 0)
    .map((k) => ({ k, ratio: results[k] / baseline[k] }))
    .filter(({ k, ratio }) => (HIGHER_IS_BETTER.has(k) ? ratio < 1 - REGRESSION : ratio > 1 + REGRESSION))
    .map(({ k, ratio }) => `${k}: ${results[k]} vs baseline ${baseline[k]} (${((ratio - 1) * 100).toFixed(0)}%)`)

  expect(regressions, `perf regressions beyond ${REGRESSION * 100}%`).toEqual([])
})
