import { useEffect, useMemo, useRef, useState } from 'react'
import { gauge, mark } from '../perf'
import { onMap, type MapHandle } from '../map/mapRef'
import { useSimStore, useUiStore, useWorldStore, type ViewMode } from '../state/stores'
import { diffVc, type EdgeOrder } from '../state/resultCache'
import { buildColors, buildModel, EMPTY_MODEL, MAJOR_ONLY_BELOW_ZOOM, type PathModel, type ViewBounds } from './model'
import type { EdgeId, HourResultDTO, ReachResultDTO } from '../sim/protocol'
import { bandColor, bandsOf, type ReachBand } from './reach'
import { REACH_BANDS_MIN, useReachStore } from '../state/stores'

/**
 * deck.gl result overlay (DESIGN 7.2). Interleaved with the MapLibre layers via
 * `MapboxOverlay`, and lazy-imported so ~120 KB gz of deck.gl stays out of the
 * shell until there is something to draw.
 */

type DeckLayer = new (props: Record<string, unknown>) => unknown

type DeckModules = {
  readonly MapboxOverlay: new (props: Record<string, unknown>) => {
    setProps: (p: Record<string, unknown>) => void
    finalize: () => void
  }
  readonly PathLayer: DeckLayer
  readonly ScatterplotLayer: DeckLayer
  readonly PolygonLayer: DeckLayer
}

const loadDeck = async (): Promise<DeckModules> => {
  const [mapbox, layers] = await Promise.all([import('@deck.gl/mapbox'), import('@deck.gl/layers')])
  return {
    MapboxOverlay: mapbox.MapboxOverlay as DeckModules['MapboxOverlay'],
    PathLayer: layers.PathLayer as DeckLayer,
    ScatterplotLayer: layers.ScatterplotLayer as DeckLayer,
    PolygonLayer: layers.PolygonLayer as DeckLayer,
  }
}

/**
 * Reach layers: the contour per time band under a thinned point cloud of the
 * reachable nodes themselves, so the hull's over-reach is visible rather than
 * implied. Drawn by this overlay rather than a second `MapboxOverlay` so there
 * is one deck instance and one z-order.
 */
const reachLayers = (deck: DeckModules, result: ReachResultDTO | null): readonly unknown[] => {
  if (!result || result.pairs.length === 0) return []
  const bands = bandsOf(result, REACH_BANDS_MIN)
  const points = Array.from({ length: result.pairs.length / 2 }, (_, i) => i).filter((i) =>
    Number.isFinite(result.positions[i * 2]),
  )
  return [
    new deck.PolygonLayer({
      id: 'twin-reach-bands',
      // widest first: the tighter bands paint over it
      data: [...bands].reverse(),
      getPolygon: (b: ReachBand) => b.ring,
      getFillColor: (b: ReachBand) => bandColor(REACH_BANDS_MIN.indexOf(b.maxMinutes), 38),
      getLineColor: (b: ReachBand) => bandColor(REACH_BANDS_MIN.indexOf(b.maxMinutes), 200),
      getLineWidth: 2,
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      pickable: false,
    }),
    new deck.ScatterplotLayer({
      id: 'twin-reach-nodes',
      data: points,
      getPosition: (i: number) => [result.positions[i * 2]!, result.positions[i * 2 + 1]!],
      getFillColor: (i: number) =>
        bandColor(REACH_BANDS_MIN.findIndex((m) => result.pairs[i * 2 + 1]! <= m * 60), 190),
      getRadius: 2,
      radiusUnits: 'pixels',
      radiusMinPixels: 1.5,
      pickable: false,
    }),
  ]
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
  /** false in reach/transit mode: there the click belongs to the tool, not the edge. */
  pickable: boolean,
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
  pickable,
  autoHighlight: pickable,
  highlightColor: [255, 255, 255, 120],
  onHover: (info: { index: number; x: number; y: number }) => onHover(info.index, info.x, info.y),
  onClick: (info: { index: number }) => {
    if (info.index >= 0) onClick(model.edges[info.index] as EdgeId)
  },
})

/**
 * Chunk geometry arrives one message per chunk — 469 of them for the whole
 * county. Rebuilding the merged model on each would be quadratic, so coalesce
 * the burst and rebuild on a trailing edge.
 */
const useSettled = <T,>(value: T, ms: number): T => {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

const GEOMETRY_SETTLE_MS = 250

/** Half a screen of slack, so a small pan does not immediately re-clip. */
const VIEW_PAD = 0.5

export const ResultOverlay = () => {
  const [deck, setDeck] = useState<DeckModules | null>(null)
  const [map, setMapState] = useState<MapHandle | null>(null)
  const [camera, setCamera] = useState<{ readonly zoom: number; readonly view: ViewBounds | null }>({ zoom: 11, view: null })
  const overlayRef = useRef<{ setProps: (p: Record<string, unknown>) => void; finalize: () => void } | null>(null)

  const geometry = useSettled(useWorldStore((s) => s.geometry), GEOMETRY_SETTLE_MS)
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
  const tool = useUiStore((s) => s.tool)
  const reach = useReachStore((s) => s.result)
  const baseline = baselineCache[hour]
  const scenarioResult = scenarioCache[hour]

  useEffect(() => onMap(setMapState), [])
  useEffect(() => {
    if (map) void loadDeck().then(setDeck)
  }, [map])

  /**
   * Two complementary bounds on the upload: below z12 only the major classes,
   * from z12 up every class but only inside the padded viewport.
   */
  useEffect(() => {
    if (!map) return
    const sync = () => {
      const zoom = map.getZoom()
      if (zoom < MAJOR_ONLY_BELOW_ZOOM) return setCamera({ zoom, view: null })
      const b = map.getBounds()
      const padLon = (b.getEast() - b.getWest()) * VIEW_PAD
      const padLat = (b.getNorth() - b.getSouth()) * VIEW_PAD
      setCamera({
        zoom,
        view: [b.getWest() - padLon, b.getSouth() - padLat, b.getEast() + padLon, b.getNorth() + padLat],
      })
    }
    sync()
    map.on('moveend', sync as (e: never) => void)
    return () => map.off('moveend', sync as (e: never) => void)
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

  const majorOnly = camera.zoom < MAJOR_ONLY_BELOW_ZOOM
  const model = useMemo(
    () => (enabled ? buildModel(geometry, majorOnly, camera.view) : EMPTY_MODEL),
    [geometry, majorOnly, camera.view, enabled],
  )

  const colors = useMemo(() => {
    const { values, signed } = valuesFor(mode, baseline, scenarioResult)
    return buildColors(model, order, values, signed)
  }, [model, order, mode, baseline, scenarioResult])

  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay || !deck) return
    gauge('overlayPaths', model.pathCount)
    const onHover = (index: number, x: number, y: number) =>
      setHover(index < 0 ? null : { edge: model.edges[index] as EdgeId, classByte: model.classes[index] ?? 9, x, y })
    const paths =
      model.pathCount === 0 ? [] : [new deck.PathLayer(layerProps(model, colors, onHover, select, tool === 'select'))]
    overlay.setProps({ layers: [...paths, ...reachLayers(deck, reach)] })
  }, [deck, model, colors, hour, reach, tool, setHover, select])

  return null
}
