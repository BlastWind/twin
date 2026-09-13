import { useEffect } from 'react'
import { hour, type Hour } from '../sim/protocol'
import { getSimClient } from '../sim/client'
import { useSimStore, useUiStore, type ViewMode } from '../state/stores'
import { coveredHours } from '../state/resultCache'

/** Hour scrubber with play, and the baseline / scenario / diff switch. */

const PLAY_MS = 600
const MODES: readonly ViewMode[] = ['baseline', 'scenario', 'diff']
const MODE_LABEL: Record<ViewMode, string> = { baseline: 'Baseline', scenario: 'Scenario', diff: 'Diff' }

const clock = (h: Hour): string => `${String(h).padStart(2, '0')}:00`

export const HourScrubber = () => {
  const h = useUiStore((s) => s.hour)
  const playing = useUiStore((s) => s.playing)
  const mode = useUiStore((s) => s.mode)
  const setHour = useUiStore((s) => s.setHour)
  const setPlaying = useUiStore((s) => s.setPlaying)
  const setMode = useUiStore((s) => s.setMode)
  const baseline = useSimStore((s) => s.baseline)
  const scenario = useSimStore((s) => s.scenario)
  const status = useSimStore((s) => s.status)

  const ready = new Set(coveredHours(mode === 'scenario' || mode === 'diff' ? scenario : baseline))

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setHour(hour((useUiStore.getState().hour + 1) % 24)), PLAY_MS)
    return () => clearInterval(t)
  }, [playing, setHour])

  // the worker holds all 24 hours; ask it for the one being shown
  useEffect(() => {
    const client = getSimClient()
    if (!client) return
    if (!baseline[h]) client.selectHour('baseline', h)
    if (mode !== 'baseline' && !scenario[h]) client.selectHour('scenario', h)
  }, [h, mode, baseline, scenario])

  return (
    <div className="panel scrubber">
      <button className="play" onClick={() => setPlaying(!playing)} aria-label={playing ? 'pause' : 'play'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="scrub-body">
        <input
          type="range"
          min={0}
          max={23}
          step={1}
          value={h}
          onChange={(e) => setHour(hour(Number(e.target.value)))}
        />
        <div className="ticks">
          {Array.from({ length: 24 }, (_, i) => (
            <span key={i} className={ready.has(i as Hour) ? 'tick on' : 'tick'} />
          ))}
        </div>
      </div>
      <span className="clock">{clock(h)}</span>
      <div className="modes">
        {MODES.map((m) => (
          <button key={m} className={m === mode ? 'mode on' : 'mode'} onClick={() => setMode(m)}>
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
      <span className={`status ${status}`}>{status === 'running' ? 'solving…' : status}</span>
    </div>
  )
}
