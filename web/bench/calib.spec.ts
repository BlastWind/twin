import { test } from '@playwright/test'
import { writeFileSync } from 'node:fs'

test('calibration rows', async ({ page }) => {
  await page.goto('http://localhost:4317/', { waitUntil: 'load' })
  await page.waitForFunction(() => ((globalThis as { __twinGauges?: Record<string, number> }).__twinGauges?.baselineHours ?? 0) >= 24, null, { timeout: 240_000 })
  await page.waitForTimeout(5000)
  const summary = await page.evaluate(() => {
    const rows = (globalThis as { __twinCalibration?: { getState: () => { rows: { aadt: number; modeledDaily: number; edge: number }[] } } }).__twinCalibration!.getState().rows
    const nonZero = rows.filter((r) => r.modeledDaily > 0)
    const order = (globalThis as { __twinWorld?: { getState: () => { order: { indexOf: Map<number, number> } } } }).__twinWorld!.getState().order
    const inArea = rows.filter((r) => order.indexOf.has(r.edge))
    return {
      rows: rows.length,
      nonZero: nonZero.length,
      inArea: inArea.length,
      inAreaNonZero: inArea.filter((r) => r.modeledDaily > 0).length,
      sample: nonZero.slice(0, 5),
      loadedEdges: order.indexOf.size,
    }
  })
  writeFileSync('bench/calib.json', `${JSON.stringify(summary, null, 2)}\n`)
})
