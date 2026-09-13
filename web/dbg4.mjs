import { chromium } from '@playwright/test'
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] })
const p = await b.newPage()
p.on('console', m=>console.log('C',m.text().slice(0,300)))
await p.goto('http://localhost:4317/', { waitUntil: 'load' })
await p.waitForTimeout(1500)
console.log(await p.evaluate(async () => {
  const src = globalThis.__twinMap.getSource('world')
  const out = { loaded: src._loaded, tiles: src.tiles, vl: src.vectorLayerIds }
  try {
    const mod = await import('/assets/' + [...performance.getEntriesByType('resource')].map(r=>r.name).find(n=>n.includes('esm-')).split('/assets/')[1])
    const proto = new mod.Protocol()
    const r = await proto.tile({ url: 'pmtiles:///data/world.pmtiles', type: 'json' }, new AbortController())
    out.tilejson = r.data
  } catch (e) { out.err = String(e) }
  return out
}))
await b.close()
