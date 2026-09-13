import { chromium } from '@playwright/test'
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage()
p.on('console', (m) => { const t = m.text(); if (m.type() === 'error') console.log('[console]', t.slice(0, 240)) })
p.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
const t0 = Date.now()
await p.goto('http://localhost:4317/', { waitUntil: 'load' })
for (let i = 0; i < 45; i++) {
  const s = await p.evaluate(() => ({ marks: globalThis.__twinMarks, g: globalThis.__twinGauges }))
  console.log(Date.now() - t0, JSON.stringify(s))
  if ((s.g?.baselineHours ?? 0) >= 24) break
  await new Promise((r) => setTimeout(r, 3000))
}
await b.close()
