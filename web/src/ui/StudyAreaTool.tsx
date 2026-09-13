import { useEffect, useRef, useState } from 'react'
import { onMap, type MapHandle } from '../map/mapRef'
import { getSimClient } from '../sim/client'
import { useUiStore, useWorldStore } from '../state/stores'
import {
  chunksInArea,
  DEFAULT_STUDY_AREA,
  edgesInArea,
  hourCost,
  HEAVY_HOUR_SECONDS,
  WHOLE_COUNTY,
  type BBox,
  type StudyArea,
} from '../graph/manifest'
import { useScenarioStore } from '../state/stores'
import { withZones } from '../sim/protocol'

/**
 * Rectangle-draw study-area selector. Chunks intersecting the rectangle stay
 * resident; everything else is freed in the worker and evicted from the loader.
 *
 * An assignment hour is close to cubic in the edge count, so the panel prices a
 * selection before it is committed to.
 */

type Drag = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

const bboxOf = (map: MapHandle, d: Drag): BBox => {
  const a = map.unproject([Math.min(d.x0, d.x1), Math.max(d.y0, d.y1)])
  const b = map.unproject([Math.max(d.x0, d.x1), Math.min(d.y0, d.y1)])
  return [a.lng, a.lat, b.lng, b.lat]
}

const box = (d: Drag): React.CSSProperties => ({
  left: Math.min(d.x0, d.x1),
  top: Math.min(d.y0, d.y1),
  width: Math.abs(d.x1 - d.x0),
  height: Math.abs(d.y1 - d.y0),
})

const AREA_LABEL: Record<StudyArea['kind'], string> = {
  block: 'default block',
  rect: 'rectangle',
  county: 'whole county',
}

const duration = (seconds: number): string =>
  seconds < 90 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)} s` : `${(seconds / 60).toFixed(1)} min`

export const StudyAreaTool = () => {
  const drawing = useUiStore((s) => s.drawing)
  const setDrawing = useUiStore((s) => s.setDrawing)
  const studyArea = useUiStore((s) => s.studyArea)
  const setStudyArea = useUiStore((s) => s.setStudyArea)
  const manifest = useWorldStore((s) => s.manifest)
  const index = useWorldStore((s) => s.index)
  const stats = useWorldStore((s) => s.stats)
  const scenario = useScenarioStore((s) => s.scenario)
  const applyScenario = useScenarioStore((s) => s.apply)
  const [map, setMapState] = useState<MapHandle | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  dragRef.current = drag

  useEffect(() => onMap(setMapState), [])

  const commit = (area: StudyArea): void => {
    setStudyArea(area)
    void getSimClient()?.setStudyArea(area)
  }

  /**
   * Zoning is a property of the scenario, not of the selection, because it is
   * what the solver is handed — but it is chosen here, next to the estimate it
   * changes. Changing it re-runs the baseline, which is what it is comparing
   * against.
   */
  const setZones = (zones: 'full' | 'coarse'): void => {
    applyScenario(withZones(scenario, zones))
    getSimClient()?.run('baseline', withZones({ edits: [] }, zones))
  }

  /** The county is only sane coarse, so the preset sets both at once. */
  const countyCoarse = (): void => {
    applyScenario(withZones(scenario, 'coarse'))
    commit(WHOLE_COUNTY)
  }

  useEffect(() => {
    if (!drawing || !map) return
    const canvas = map.getCanvas()
    const rect = () => canvas.getBoundingClientRect()
    const at = (e: PointerEvent): [number, number] => {
      const r = rect()
      return [e.clientX - r.left, e.clientY - r.top]
    }
    const down = (e: PointerEvent) => {
      const [x, y] = at(e)
      setDrag({ x0: x, y0: y, x1: x, y1: y })
    }
    const move = (e: PointerEvent) => {
      if (!dragRef.current) return
      const [x, y] = at(e)
      setDrag({ ...dragRef.current, x1: x, y1: y })
    }
    const up = () => {
      const d = dragRef.current
      setDrag(null)
      setDrawing(false)
      if (!d || Math.abs(d.x1 - d.x0) < 8 || Math.abs(d.y1 - d.y0) < 8) return
      commit({ kind: 'rect', bbox: bboxOf(map, d) })
    }
    canvas.style.cursor = 'crosshair'
    canvas.addEventListener('pointerdown', down)
    globalThis.addEventListener('pointermove', move)
    globalThis.addEventListener('pointerup', up)
    return () => {
      canvas.style.cursor = ''
      canvas.removeEventListener('pointerdown', down)
      globalThis.removeEventListener('pointermove', move)
      globalThis.removeEventListener('pointerup', up)
    }
  }, [drawing, map, setDrawing, setStudyArea])

  const chunkCount = manifest ? chunksInArea(manifest, studyArea).length : 0
  const edges = manifest && index ? edgesInArea(index, manifest, studyArea) : 0
  const zones = scenario.zones ?? 'full'
  const threads = stats?.threads ?? 1
  const cost = hourCost({ edges, zones, threads })
  const heavy = cost.warmS > HEAVY_HOUR_SECONDS

  return (
    <>
      {drag && <div className="draw-box" style={box(drag)} />}
      <div className="panel study-area">
        <h2>Study area</h2>
        <p className="hint">
          {AREA_LABEL[studyArea.kind]} · {chunkCount} chunks · {edges.toLocaleString()} edges
        </p>
        {edges > 0 && (
          <p className={heavy ? 'estimate heavy' : 'estimate'}>
            ~{duration(cost.warmS)}/hour warm, {duration(cost.coldS)} cold · {zones} zones ·{' '}
            {threads === 1 ? 'single-threaded' : `${threads} threads`}
            {heavy && (
              <span className="warn-tag">
                ~{duration(cost.warmS * 24)} for all 24 — {zones === 'full' ? 'try coarse zones' : 'try a smaller area'}
              </span>
            )}
          </p>
        )}
        <div className="row">
          {(['full', 'coarse'] as const).map((z) => (
            <button key={z} className={z === zones ? 'on' : ''} onClick={() => setZones(z)}>
              {z} zones
            </button>
          ))}
        </div>
        <div className="row">
          <button className={drawing ? 'on' : ''} onClick={() => setDrawing(!drawing)}>
            {drawing ? 'Drawing…' : 'Draw rectangle'}
          </button>
          <button disabled={studyArea.kind === 'block'} onClick={() => commit(DEFAULT_STUDY_AREA)}>
            Default block
          </button>
          <button disabled={studyArea.kind === 'county'} onClick={() => commit(WHOLE_COUNTY)}>
            Whole county
          </button>
          <button
            disabled={studyArea.kind === 'county' && zones === 'coarse'}
            onClick={countyCoarse}
            title="the whole county with aggregated zones — the only county setting that runs in seconds"
          >
            County (coarse)
          </button>
        </div>
      </div>
    </>
  )
}
