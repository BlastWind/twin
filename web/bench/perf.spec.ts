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
  | 'heapBytesAfterLoad'
  | 'transferBytes'
  | 'fpsZ11'
  | 'fpsZ13'
  | 'fpsZ15'

/** Higher-is-better metrics regress when they *fall*; the rest when they rise. */
const HIGHER_IS_BETTER: ReadonlySet<MetricName> = new Set<MetricName>(['fpsZ11', 'fpsZ13', 'fpsZ15'])

type Results = Readonly<Record<MetricName, number>>

const readJson = <T,>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const markMs = async (page: Page, stage: string): Promise<Ms> =>
  page.evaluate(
    (s) => (globalThis as { __twinMarks?: Record<string, number> }).__twinMarks?.[s] ?? Number.NaN,
    stage,
  )

/** Drive a scripted path and count frames actually presented. */
const measureFps = async (page: Page, zoom: number): Promise<number> => {
  await page.evaluate((z) => {
    const map = (globalThis as { __twinMap?: { jumpTo: (o: unknown) => void } }).__twinMap
    map?.jumpTo({ center: [-77.28, 38.85], zoom: z, pitch: 45, bearing: 0 })
  }, zoom)
  await page.waitForTimeout(500)

  const frames = await page.evaluate(async () => {
    const map = (globalThis as { __twinMap?: { easeTo: (o: unknown) => void; getCenter: () => { lng: number; lat: number } } }).__twinMap
    if (!map) return { frames: 0, ms: 1 }
    let count = 0
    let stop = false
    const tick = () => {
      count += 1
      if (!stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const t0 = performance.now()
    const c = map.getCenter()
    const legs = [
      { center: [c.lng + 0.03, c.lat + 0.02], bearing: 25, duration: 900 },
      { center: [c.lng - 0.03, c.lat - 0.02], pitch: 60, duration: 900 },
      { center: [c.lng, c.lat], pitch: 45, bearing: 0, duration: 900 },
    ]
    for (const leg of legs) {
      map.easeTo({ ...leg, essential: true })
      await new Promise((r) => setTimeout(r, leg.duration + 60))
    }
    stop = true
    return { frames: count, ms: performance.now() - t0 }
  })
  return Number(((frames.frames * 1000) / frames.ms).toFixed(1))
}

const heapBytes = async (cdp: CDPSession): Promise<number> => {
  const { result } = (await cdp.send('Runtime.evaluate', {
    expression: 'performance.memory ? performance.memory.usedJSHeapSize : 0',
  })) as { result: { value?: number } }
  return result.value ?? 0
}

test('browser perf harness', async ({ page, browser }) => {
  const cdp = await browser.newBrowserCDPSession().catch(() => null)
  void cdp
  const session = await page.context().newCDPSession(page)

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

  const results: Results = {
    firstPaintMs: Number(firstPaintMs.toFixed(1)),
    firstTileMs: Number((await markMs(page, 'first-tile')).toFixed(1)),
    mapIdleMs: Number((await markMs(page, 'map-idle')).toFixed(1)),
    workerReadyMs: Number((await markMs(page, 'worker-ready')).toFixed(1)),
    heapBytesAfterLoad: await heapBytes(session),
    transferBytes,
    fpsZ11: await measureFps(page, 11),
    fpsZ13: await measureFps(page, 13),
    fpsZ15: await measureFps(page, 15),
  }

  writeJson(RESULTS, results)
  // eslint-disable-next-line no-console
  console.table(results)

  const baseline = readJson<Results>(BASELINES)
  if (!baseline) {
    writeJson(BASELINES, results)
    console.log('[perf] no baseline found — wrote bench/baselines.json from this run')
    return
  }

  const regressions = (Object.keys(results) as MetricName[])
    .filter((k) => Number.isFinite(results[k]) && Number.isFinite(baseline[k]) && baseline[k] !== 0)
    .map((k) => ({ k, ratio: results[k] / baseline[k] }))
    .filter(({ k, ratio }) => (HIGHER_IS_BETTER.has(k) ? ratio < 1 - REGRESSION : ratio > 1 + REGRESSION))
    .map(({ k, ratio }) => `${k}: ${results[k]} vs baseline ${baseline[k]} (${((ratio - 1) * 100).toFixed(0)}%)`)

  expect(regressions, `perf regressions beyond ${REGRESSION * 100}%`).toEqual([])
})
