import { chromium } from '@playwright/test'
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] })
const p = await b.newPage()
await p.goto('http://localhost:4317/', { waitUntil: 'load' })
await p.waitForTimeout(4000)
console.log(await p.evaluate(() => {
  const m = globalThis.__twinMap
  const canvas = m.getCanvas()
  const caches = m.style.sourceCaches || m.style._sourceCaches || {}
  const sc = Object.keys(caches)
  const cache = caches[sc[0]]
  return {
    size: [canvas.width, canvas.height], zoom: m.getZoom(), center: m.getCenter(),
    scKeys: sc,
    tiles: cache ? Object.keys(cache._tiles).length : 'nocache',
    states: cache ? Object.values(cache._tiles).map(t=>t.state).slice(0,5) : null,
    areTilesLoaded: m.areTilesLoaded(), loaded: m.loaded(), isStyleLoaded: m.isStyleLoaded(),
    layers: m.getStyle().layers.map(l=>l.id),
  }
}))
await b.close()
