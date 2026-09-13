import { chromium } from '@playwright/test'
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
await p.goto('http://localhost:4317/', { waitUntil: 'load' })
await p.waitForFunction(() => (globalThis.__twinGauges?.baselineHours ?? 0) >= 1, null, { timeout: 120000 })
for (const z of [11, 13, 15]) {
  const t = Date.now()
  await p.evaluate((zz) => globalThis.__twinMap?.jumpTo({ center: [-77.28, 38.85], zoom: zz, pitch: 45, bearing: 0 }), z)
  await p.waitForTimeout(1500)
  const paths = await p.evaluate(() => globalThis.__twinGauges?.overlayPaths)
  const r = await p.evaluate(async () => {
    const map = globalThis.__twinMap
    let n = 0, stop = false
    const tick = () => { n++; if (!stop) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    const t0 = performance.now()
    const c = map.getCenter()
    map.easeTo({ center: [c.lng + 0.01, c.lat + 0.01], duration: 900, essential: true })
    await new Promise((r) => setTimeout(r, 1200))
    stop = true
    return { fps: (n * 1000) / (performance.now() - t0) }
  })
  console.log('z', z, 'paths', paths, 'fps', r.fps.toFixed(1), 'wall', Date.now() - t)
}
await b.close()
