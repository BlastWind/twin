import { chromium } from '@playwright/test'
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] })
const p = await b.newPage()
await p.goto('http://localhost:4317/', { waitUntil: 'load' })
await p.waitForTimeout(4000)
console.log(await p.evaluate(() => {
  const m = globalThis.__twinMap
  const st = m.style
  const keys = Object.keys(st).filter(k=>/source|Source/i.test(k))
  const out = { keys, _loaded: st._loaded }
  for (const k of keys) { try { out[k] = Object.keys(st[k]) } catch(e){} }
  out.srcLoaded = m.getSource('world')?.loaded?.()
  out.repaint = m.repaint
  return out
}))
await b.close()
