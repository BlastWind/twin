import { test } from '@playwright/test'
import { writeFileSync } from 'node:fs'

/**
 * What the county (coarse) preset costs, driven the way a user drives it: click
 * the button, then watch the sim store.
 *
 * The hour counter alone is not a clock — a stale sweep is still posting
 * results when the click lands — so this waits for the run id to change and
 * times that run's own hours.
 */
type Snapshot = { readonly runs: number; readonly hours: number; readonly edges: number; readonly status: string }

test('county coarse', async ({ page }) => {
  await page.goto('http://localhost:4317/', { waitUntil: 'load' })
  await page.waitForFunction(
    () => (globalThis as { __twinMarks?: Record<string, number> }).__twinMarks?.['first-baseline'] !== undefined,
    null,
    { timeout: 180_000 },
  )
  await page.waitForTimeout(3000)

  const snap = (): Promise<Snapshot> =>
    page.evaluate(() => {
      const sim = (globalThis as { __twinSim?: { getState: () => { baseline: Record<string, { id: number }>; status: string } } }).__twinSim!.getState()
      const world = (globalThis as { __twinWorld?: { getState: () => { stats: { edges: number } | null } } }).__twinWorld!.getState()
      const hours = Object.values(sim.baseline)
      return {
        runs: hours[0]?.id ?? 0,
        hours: hours.length,
        edges: world.stats?.edges ?? 0,
        status: sim.status,
      }
    })

  const before = await snap()
  await page.getByRole('button', { name: 'County (coarse)' }).click()

  const t0 = Date.now()
  // the new run announces itself with a new run id on its first hour
  await page.waitForFunction(
    (prev) => {
      const sim = (globalThis as { __twinSim?: { getState: () => { baseline: Record<string, { id: number }> } } }).__twinSim!.getState()
      const first = Object.values(sim.baseline)[0]
      return first !== undefined && first.id > prev
    },
    before.runs,
    { timeout: 600_000 },
  )
  const firstHourMs = Date.now() - t0

  const t1 = Date.now()
  await page.waitForFunction(
    () => Object.keys((globalThis as { __twinSim?: { getState: () => { baseline: Record<string, unknown> } } }).__twinSim!.getState().baseline).length >= 4,
    null,
    { timeout: 600_000 },
  )
  const warmHourMs = (Date.now() - t1) / 3

  await page.evaluate(() => (globalThis as { __twinClient?: { stats: () => void } }).__twinClient?.stats())
  await page.waitForTimeout(1000)
  const after = await snap()
  const threads = await page.evaluate(() => (globalThis as { __twinWorld?: { getState: () => { stats: { threads: number; backend: string } | null } } }).__twinWorld!.getState().stats)

  writeFileSync('bench/county.json', `${JSON.stringify({ before, after, threads, firstHourMs, warmHourMs }, null, 2)}\n`)
})
