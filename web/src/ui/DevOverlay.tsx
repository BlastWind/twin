import { useEffect, useState } from 'react'
import { timings } from '../perf'
import { useUiStore, useWorldStore } from '../state/stores'

/** fps + load-stage timings (DESIGN 8). Sampled with rAF, one state write per second. */
const useFps = (enabled: boolean): number => {
  const [fps, setFps] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let frames = 0
    let last = performance.now()
    let raf = 0
    const tick = (now: number) => {
      frames += 1
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)))
        ;(globalThis as { __twinFps?: number }).__twinFps = Math.round((frames * 1000) / (now - last))
        frames = 0
        last = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [enabled])
  return fps
}

export const DevOverlay = () => {
  const enabled = useUiStore((s) => s.devOverlay)
  const toggle = useUiStore((s) => s.toggleDevOverlay)
  const fps = useFps(enabled)
  const world = useWorldStore((s) => ({ load: s.load, stats: s.stats }))
  const [, force] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => force((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [enabled])

  if (!enabled) return <button style={{ ...box, cursor: 'pointer' }} onClick={toggle}>perf</button>

  return (
    <div style={box} onDoubleClick={toggle} title="double-click to hide">
      <div style={{ fontWeight: 600 }}>{fps} fps</div>
      {timings().map((t) => (
        <div key={t.stage} style={line}>
          <span>{t.stage}</span>
          <span style={{ marginLeft: 'auto' }}>{t.atMs.toFixed(0)} ms</span>
        </div>
      ))}
      <div style={line}>
        <span>worker</span>
        <span style={{ marginLeft: 'auto' }}>
          {world.load}
          {world.stats ? ` · ${world.stats.backend}` : ''}
        </span>
      </div>
    </div>
  )
}

const box: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  padding: '8px 10px',
  font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
  color: '#c8d0dc',
  background: 'rgba(16,20,27,0.88)',
  border: '1px solid #232a35',
  borderRadius: 8,
  minWidth: 170,
}
const line: React.CSSProperties = { display: 'flex', gap: 10 }
