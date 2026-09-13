import { useEffect, useRef, useState } from 'react'
import { onMap, type MapHandle } from '../map/mapRef'
import { getSimClient } from '../sim/client'
import { useUiStore, useWorldStore } from '../state/stores'
import { chunksInArea, WHOLE_COUNTY, type BBox } from '../graph/manifest'

/**
 * Rectangle-draw study-area selector. Chunks intersecting the rectangle stay
 * resident; everything else is freed in the worker and evicted from the loader.
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

export const StudyAreaTool = () => {
  const drawing = useUiStore((s) => s.drawing)
  const setDrawing = useUiStore((s) => s.setDrawing)
  const studyArea = useUiStore((s) => s.studyArea)
  const setStudyArea = useUiStore((s) => s.setStudyArea)
  const manifest = useWorldStore((s) => s.manifest)
  const [map, setMapState] = useState<MapHandle | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  dragRef.current = drag

  useEffect(() => onMap(setMapState), [])

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
      const area = { bbox: bboxOf(map, d) }
      setStudyArea(area)
      void getSimClient()?.setStudyArea(area)
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

  return (
    <>
      {drag && <div className="draw-box" style={box(drag)} />}
      <div className="panel study-area">
        <h2>Study area</h2>
        <p className="hint">
          {studyArea.bbox ? 'rectangle' : 'whole county'} · {chunkCount} chunks
        </p>
        <div className="row">
          <button className={drawing ? 'on' : ''} onClick={() => setDrawing(!drawing)}>
            {drawing ? 'Drawing…' : 'Draw rectangle'}
          </button>
          <button
            disabled={!studyArea.bbox}
            onClick={() => {
              setStudyArea(WHOLE_COUNTY)
              void getSimClient()?.setStudyArea(WHOLE_COUNTY)
            }}
          >
            Whole county
          </button>
        </div>
      </div>
    </>
  )
}
