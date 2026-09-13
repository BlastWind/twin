import { chromium } from '@playwright/test'

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
p.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
p.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)) })

const t0 = Date.now()
await p.goto('http://localhost:4317/', { waitUntil: 'load' })

for (let i = 0; i < 24; i++) {
  const s = await p.evaluate(() => ({
    dash: document.querySelector('.dashboard h2 .sub')?.textContent ?? null,
    marks: globalThis.__twinMarks,
    g: globalThis.__twinGauges,
    kpi: [...document.querySelectorAll('.card-value')].map((e) => e.textContent),
    top: [...document.querySelectorAll('.top-edges tbody tr')].slice(0, 3).map((r) => r.textContent),
    err: document.querySelector('.toast')?.textContent ?? null,
  }))
  console.log(Date.now() - t0, 'backend', s.dash, 'marks', Object.keys(s.marks ?? {}).join(','), 'g', JSON.stringify(s.g), 'err', s.err)
  if (s.marks?.['first-baseline'] !== undefined) {
    console.log('ms', Date.now() - t0)
    console.log('backend  :', s.dash)
    console.log('baseline :', s.marks['first-baseline'].toFixed(0), 'ms')
    console.log('paths    :', s.g?.overlayPaths, 'hours', s.g?.baselineHours)
    console.log('KPIs     :', JSON.stringify(s.kpi))
    console.log('top edges:', JSON.stringify(s.top))
    if ((s.g?.baselineHours ?? 0) >= 24) break
  }
  await new Promise((r) => setTimeout(r, 3000))
}
await b.close()
