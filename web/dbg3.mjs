import { chromium } from '@playwright/test'
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] })
const p = await b.newPage()
await p.goto('http://localhost:4317/', { waitUntil: 'load' })
await p.waitForTimeout(2000)
console.log(await p.evaluate(async () => {
  const m = globalThis.__twinMap
  const s = m.getStyle().sources.world
  const src = m.getSource('world')
  return { styleSrc: s, srcKeys: src ? Object.keys(src) : null, tiles: src?.tiles, vl: src?.vectorLayerIds, loaded: src?.loaded?.() }
}))
await b.close()
