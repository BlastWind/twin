import { useEffect } from 'react'
import { onMap, type MapHandle } from '../map/mapRef'
import { getSimClient } from '../sim/client'
import { withEdit, withoutRoute } from '../scenario/codec'
import type { RouteId, TransitEditDTO } from '../sim/protocol'
import { transitEdits } from '../sim/protocol'
import { useScenarioStore, useTransitStore, useUiStore } from '../state/stores'

/**
 * Minimal transit line editor (DESIGN 7.4): pick stops in order, give the
 * pattern a headway, add it to the scenario — or remove a route already in it.
 *
 * The solver ignores `TransitEdit` today, so a route added here moves the
 * isochrone and nothing else. The panel says so rather than letting the KPI
 * cards imply otherwise.
 */

const HEADWAYS_MIN: readonly number[] = [5, 10, 15, 20, 30, 60]

const routeIdOf = (name: string): RouteId =>
  (name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || `route-${Date.now().toString(36)}`) as RouteId

/** Each click in transit mode asks the worker to snap to the nearest node. */
const useStopPicking = (): void => {
  const tool = useUiStore((s) => s.tool)
  useEffect(() => {
    if (tool !== 'transit') return
    const onClick = (e: { lngLat: { lng: number; lat: number } }) =>
      getSimClient()?.snap(e.lngLat.lng, e.lngLat.lat)
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
      map.getCanvas().style.cursor = 'copy'
    })
    return () => {
      unsubscribe()
      detach()
    }
  }, [tool])
}

export const TransitEditor = () => {
  const tool = useUiStore((s) => s.tool)
  const setTool = useUiStore((s) => s.setTool)
  const stops = useTransitStore((s) => s.stops)
  const headwayMin = useTransitStore((s) => s.headwayMin)
  const routeName = useTransitStore((s) => s.routeName)
  const setHeadway = useTransitStore((s) => s.setHeadway)
  const setRouteName = useTransitStore((s) => s.setRouteName)
  const popStop = useTransitStore((s) => s.popStop)
  const clearDraft = useTransitStore((s) => s.clear)
  const scenario = useScenarioStore((s) => s.scenario)
  const apply = useScenarioStore((s) => s.apply)

  useStopPicking()

  const routes = transitEdits(scenario)

  const commit = (): void => {
    const edit: TransitEditDTO = {
      type: 'TransitEdit',
      op: 'AddPattern',
      route_id: routeIdOf(routeName),
      stops: stops.map((s) => s.node),
      headway_s: headwayMin * 60,
    }
    apply(withEdit(scenario, edit))
    clearDraft()
  }

  return (
    <section className="panel">
      <h2>
        Transit <span className="sub">{tool === 'transit' ? 'picking stops' : `${routes.length} edit(s)`}</span>
      </h2>
      <div className="row">
        <button className={tool === 'transit' ? 'on' : ''} onClick={() => setTool(tool === 'transit' ? 'select' : 'transit')}>
          {tool === 'transit' ? 'Done picking' : 'New pattern'}
        </button>
        {stops.length > 0 && (
          <button className="link" onClick={popStop}>
            undo stop
          </button>
        )}
      </div>
      {tool === 'transit' && (
        <p className="hint">Click the map in service order; each click snaps to the nearest graph node.</p>
      )}
      {stops.length > 0 && (
        <>
          <ol className="stop-list">
            {stops.map((s, i) => (
              <li key={`${s.node}-${i}`}>
                <span>{i + 1}.</span>
                <span>node {s.node}</span>
                <span>
                  {s.lat.toFixed(4)}, {s.lon.toFixed(4)}
                </span>
              </li>
            ))}
          </ol>
          <label>
            <span>name</span>
            <input value={routeName} placeholder="Route 1A" onChange={(e) => setRouteName(e.target.value)} />
          </label>
          <label>
            <span>headway</span>
            <select value={headwayMin} onChange={(e) => setHeadway(Number(e.target.value))}>
              {HEADWAYS_MIN.map((m) => (
                <option key={m} value={m}>
                  every {m} min
                </option>
              ))}
            </select>
          </label>
          <button disabled={stops.length < 2} onClick={commit}>
            Add route ({stops.length} stops)
          </button>
        </>
      )}
      <label>
        <span>drop route</span>
        <input
          placeholder="route_id"
          onKeyDown={(e) => {
            const id = e.currentTarget.value.trim()
            if (e.key !== 'Enter' || id === '') return
            apply(withEdit(scenario, { type: 'TransitEdit', op: 'RemoveRoute', route_id: id as RouteId }))
            e.currentTarget.value = ''
          }}
        />
      </label>
      <ul className="edits">
        {routes.map((e) => (
          <li key={e.route_id}>
            <code>{e.op === 'AddPattern' ? 'add' : 'remove'}</code> {e.route_id}
            {e.op === 'AddPattern' && ` · ${e.stops.length} stops · ${Math.round(e.headway_s / 60)} min`}
            <button className="link" onClick={() => apply(withoutRoute(scenario, e.route_id))}>
              remove
            </button>
          </li>
        ))}
      </ul>
      {routes.length > 0 && <p className="chart-note">Transit edits affect isochrones only; the road assignment ignores them.</p>}
    </section>
  )
}
