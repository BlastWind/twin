import { expect, test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'integration.json')
const report: Record<string, unknown> = {}
const put = (k: string, v: unknown): void => {
  report[k] = v
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
}

const APP = 'http://localhost:4317/'

const gauges = (page: Page) =>
  page.evaluate(() => (globalThis as { __twinGauges?: Record<string, number> }).__twinGauges ?? {})

test('phase 3 integration', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)))
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`))

  await page.goto(APP, { waitUntil: 'load' })
  await page.waitForFunction(() => (globalThis as { __twinMapReady?: boolean }).__twinMapReady === true, null, { timeout: 90_000 })

  put('isolated', await page.evaluate(() => globalThis.crossOriginIsolated))
  put('stats', await page.evaluate(() =>
    (globalThis as { __twinWorld?: { getState: () => { stats: unknown } } }).__twinWorld?.getState().stats))

  // every layer the tiles carry
  put('layers', await page.evaluate(() => {
    const s = (globalThis as { __twinUi?: { getState: () => { registry: { id: string; available: boolean; sourceLayer: string }[]; layers: Record<string, boolean>; toggleLayer: (i: string) => void } } }).__twinUi!.getState()
    s.registry.filter((l) => l.available && !s.layers[l.id]).forEach((l) => s.toggleLayer(l.id))
    return s.registry.map((l) => ({ id: l.id, available: l.available }))
  }))
  await page.waitForTimeout(4000)

  // rendered feature counts per layer, at a zoom where they all exist
  await page.evaluate(() => (globalThis as { __twinMap?: { jumpTo: (o: unknown) => void } }).__twinMap?.jumpTo({ center: [-77.3, 38.85], zoom: 15, pitch: 0 }))
  await page.waitForTimeout(5000)
  put('rendered', await page.evaluate(() => {
    const map = (globalThis as { __twinMap?: { getStyle: () => { layers: { id: string }[] }; queryRenderedFeatures: (g?: unknown, o?: unknown) => unknown[] } }).__twinMap!
    return Object.fromEntries(
      map.getStyle().layers.filter((l) => l.id !== 'background').map((l) => {
        try { return [l.id, map.queryRenderedFeatures(undefined, { layers: [l.id] }).length] } catch { return [l.id, -1] }
      }),
    )
  }))
  put('errorsSoFar', errors.slice(0, 6))

  // isochrone against the real backend
  await page.evaluate(() => {
    const g = globalThis as { __twinMap?: { getCenter: () => { lng: number; lat: number } }; __twinReach?: { getState: () => { setOrigin: (o: [number, number]) => void } } }
    const c = g.__twinMap!.getCenter()
    g.__twinReach!.getState().setOrigin([c.lng, c.lat])
  })
  await page.waitForTimeout(8000)
  put('reach', await page.evaluate(() => {
    const st = (globalThis as { __twinReach?: { getState: () => { result: { summary: unknown; pairs: Float32Array } | null; status: string } } }).__twinReach!.getState()
    return { status: st.status, summary: st.result?.summary ?? null, pairs: st.result?.pairs.length ?? 0 }
  }))
  put('marks', await page.evaluate(() => (globalThis as { __twinMarks?: Record<string, number> }).__twinMarks))

  // 24h sweep, then calibration
  await page.waitForFunction(() => ((globalThis as { __twinGauges?: Record<string, number> }).__twinGauges?.baselineHours ?? 0) >= 24, null, { timeout: 240_000 }).catch(() => undefined)
  await page.waitForTimeout(6000)
  put('calibration', await page.evaluate(() =>
    (globalThis as { __twinCalibration?: { getState: () => { rows: unknown[] } } }).__twinCalibration?.getState().rows.slice(0, 3)))
  put('calibrationCount', await page.evaluate(() =>
    (globalThis as { __twinCalibration?: { getState: () => { rows: unknown[] } } }).__twinCalibration?.getState().rows.length ?? -1))
  put('gauges', await gauges(page))
  put('errors', errors.slice(0, 10))
  expect(report).toBeTruthy()
})
