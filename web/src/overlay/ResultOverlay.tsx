import { useEffect, useMemo, useRef, useState } from 'react'
import { mark } from '../perf'
import { onMap, type MapHandle } from '../map/mapRef'
import { useSimStore, useUiStore, useWorldStore, type ViewMode } from '../state/stores'
import { diffVc, type EdgeOrder } from '../state/resultCache'
import { buildColors, buildModel, EMPTY_MODEL, MAJOR_ONLY_BELOW_ZOOM, type PathModel } from './model'
import type { EdgeId, HourResultDTO } from '../sim/protocol'

/**
 * deck.gl result overlay (DESIGN 7.2). Interleaved with the MapLibre layers via
 * `MapboxOverlay`, and lazy-imported so ~120 KB gz of deck.gl stays out of the
 * shell until there is something to draw.
 */

type DeckModules = {
  readonly MapboxOverlay: new (props: Record<string, unknown>) => {
    setProps: (p: Record<string, unknown>) => void
    finalize: () => void
  }
  readonly PathLayer: new (props: Record<string, unknown>) => unknown
}

const loadDeck = async (): Promise<DeckModules> => {
  const [mapbox, layers] = await Promise.all([import('@deck.gl/mapbox'), import('@deck.gl/layers')])
  return { MapboxOverlay: mapbox.MapboxOverlay as DeckModules['MapboxOverlay'], PathLayer: layers.PathLayer as DeckModules['PathLayer'] }
}

/** The values the overlay colours by, and whether they are signed (diff mode). */
const valuesFor = (
  mode: ViewMode,
  baseline: HourResultDTO | undefined,
  scenario: HourResultDTO | undefined,
): { readonly values: Float32Array; readonly signed: boolean } => {
  if (mode === 'diff') return { values: diffVc(baseline, scenario), signed: true }
  const pick = mode === 'scenario' ? (scenario ?? baseline) : baseline
  return { values: pick?.vc ?? new Float32Array(0), signed: false }
}

const layerProps = (
  model: PathModel,
  colors: Uint8Array,
  onHover: (index: number, x: number, y: number) => void,
  onClick: (edge: EdgeId) => void,
): Record<string, unknown> => ({
  id: 'twin-results',
  data: {
    length: model.pathCount,
    startIndices: model.startIndices,
    attributes: {
      getPath: { value: model.positions, size: 2 },
      getColor: { value: colors, size: 3, normalized: true },
    },
  },
  _pathType: 'open',
  positionFormat: 'XY',
  widthUnits: 'pixels',
  widthMinPixels: 1.5,
  widthMaxPixels: 12,
  getWidth: 3,
  jointRounded: true,
  capRounded: true,
  opacity: 0.9,
  pickable: true,
  autoHighlight: true,
  highlightColor: [255, 255, 255, 120],
  onHover: (info: { index: number; x: number; y: number }) => onHover(info.index, info.x, info.y),
  onClick: (info: { index: number }) => {
    if (info.index >= 0) onClick(model.edges[info.index] as EdgeId)
  },
})

export const ResultOverlay = () => {
  const [deck, setDeck] = useState<DeckModules | null>(null)
  const [map, setMapState] = useState<MapHandle | null>(null)
  const [zoom, setZoom] = useState(11)
  const overlayRef = useRef<{ setProps: (p: Record<string, unknown>) => void; finalize: () => void } | null>(null)

  const geometry = useWorldStore((s) => s.geometry)
  const order: EdgeOrder = useWorldStore((s) => s.order)
  // one selector per field: zustand v5 compares snapshots by identity, so an
  // object literal selector would re-render forever
  const hour = useUiStore((s) => s.hour)
  const mode = useUiStore((s) => s.mode)
  const enabled = useUiStore((s) => s.overlay)
  const setHover = useUiStore((s) => s.setHover)
  const select = useUiStore((s) => s.select)
  const baselineCache = useSimStore((s) => s.baseline)
  const scenarioCache = useSimStore((s) => s.scenario)
  const baseline = baselineCache[hour]
  const scenarioResult = scenarioCache[hour]

  useEffect(() => onMap(setMapState), [])
  useEffect(() => {
    if (map) void loadDeck().then(setDeck)
  }, [map])

  // zoom drives the class filter, so the low-zoom upload stays bounded
  useEffect(() => {
    if (!map) return
    const sync = () => setZoom(map.getZoom())
    sync()
    map.on('zoomend', sync as (e: never) => void)
    return () => map.off('zoomend', sync as (e: never) => void)
  }, [map])

  useEffect(() => {
    if (!map || !deck) return
    const overlay = new deck.MapboxOverlay({ interleaved: true, layers: [] })
    map.addControl(overlay)
    overlayRef.current = overlay
    mark('overlay-ready')
    return () => {
      map.removeControl(overlay)
      overlay.finalize()
      overlayRef.current = null
    }
  }, [map, deck])

  const majorOnly = zoom < MAJOR_ONLY_BELOW_ZOOM
  const model = useMemo(() => (enabled ? buildModel(geometry, majorOnly) : EMPTY_MODEL), [geometry, majorOnly, enabled])

  const colors = useMemo(() => {
    const { values, signed } = valuesFor(mode, baseline, scenarioResult)
    return buildColors(model, order, values, signed)
  }, [model, order, mode, baseline, scenarioResult])

  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay || !deck) return
    if (model.pathCount === 0) return overlay.setProps({ layers: [] })
    const onHover = (index: number, x: number, y: number) =>
      setHover(index < 0 ? null : { edge: model.edges[index] as EdgeId, classByte: model.classes[index], x, y })
    overlay.setProps({ layers: [new deck.PathLayer(layerProps(model, colors, onHover, select))] })
  }, [deck, model, colors, hour, setHover, select])

  return null
}
