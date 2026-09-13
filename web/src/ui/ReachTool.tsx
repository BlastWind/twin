import { useEffect } from 'react'
import { onMap, type MapHandle } from '../map/mapRef'
import { getSimClient } from '../sim/client'
import { REACH_BANDS_MIN, useReachStore, useUiStore } from '../state/stores'
import { bandColor } from '../overlay/reach'

/**
 * Isochrone tool: in "reach" mode a click on the map sets the origin, and the
 * reach is recomputed whenever the origin, the hour or the budget changes — the
 * hour matters because the timetable does (DESIGN 7.4).
 */

const rgba = (c: readonly [number, number, number, number]): string => `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`

const useReachClick = (): void => {
  const tool = useUiStore((s) => s.tool)
  const setOrigin = useReachStore((s) => s.setOrigin)
  useEffect(() => {
    if (tool !== 'reach') return
    const onClick = (e: { lngLat: { lng: number; lat: number } }) => setOrigin([e.lngLat.lng, e.lngLat.lat])
    let attached: MapHandle | null = null
    const detach = (): void => {
      if (!attached) return
      attached.off('click', onClick as (e: never) => void)
      attached.getCanvas().style.cursor = ''
      attached = null
    }
    const unsubscribe = onMap((map) => {
      detach()
      if (!map) return
      attached = map
      map.on('click', onClick as (e: never) => void)
      map.getCanvas().style.cursor = 'crosshair'
    })
    return () => {
      unsubscribe()
      detach()
    }
  }, [tool, setOrigin])
}

/** One request per (origin, hour, budget); the worker coalesces nothing, so we do. */
const useReachRequest = (): void => {
  const origin = useReachStore((s) => s.origin)
  const budgetMin = useReachStore((s) => s.budgetMin)
  const hour = useUiStore((s) => s.hour)
  useEffect(() => {
    if (!origin) return
    getSimClient()?.isochrone({ lon: origin[0], lat: origin[1], hour, budgetMin })
  }, [origin, hour, budgetMin])
}

export const ReachTool = () => {
  const tool = useUiStore((s) => s.tool)
  const setTool = useUiStore((s) => s.setTool)
  const origin = useReachStore((s) => s.origin)
  const budgetMin = useReachStore((s) => s.budgetMin)
  const setBudget = useReachStore((s) => s.setBudget)
  const setOrigin = useReachStore((s) => s.setOrigin)
  const result = useReachStore((s) => s.result)
  const status = useReachStore((s) => s.status)

  useReachClick()
  useReachRequest()

  if (tool !== 'reach') return null

  return (
    <section className="panel">
      <h2>
        Reach <span className="sub">{status === 'running' ? 'computing…' : `${budgetMin} min`}</span>
      </h2>
      {origin === null ? (
        <p className="hint">Click the map to drop an origin.</p>
      ) : (
        <>
          <div className="row">
            {[30, 45, 60].map((m) => (
              <button key={m} className={m === budgetMin ? 'on' : ''} onClick={() => setBudget(m)}>
                {m}m
              </button>
            ))}
            <button className="link" onClick={() => setOrigin(null)}>
              clear
            </button>
          </div>
          <div className="cards">
            <div className="card">
              <span className="card-label">Reachable population</span>
              <span className="card-value">{(result?.summary.population ?? 0).toLocaleString()}</span>
              <span className="card-unit">people</span>
            </div>
            <div className="card">
              <span className="card-label">Nodes</span>
              <span className="card-value">{(result?.summary.nodes ?? 0).toLocaleString()}</span>
              <span className="card-unit">reached</span>
            </div>
          </div>
          <div className="reach-legend">
            {REACH_BANDS_MIN.filter((m) => m <= budgetMin).map((m, i) => (
              <span key={m}>
                <span className="swatch" style={{ background: rgba(bandColor(i, 220)) }} />
                {m} min
              </span>
            ))}
          </div>
        </>
      )}
      <p className="hint">
        Transit edits change the reach only — the road assignment ignores them.{' '}
        <button className="link" onClick={() => setTool('select')}>
          exit
        </button>
      </p>
    </section>
  )
}
