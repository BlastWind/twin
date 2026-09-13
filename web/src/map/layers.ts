import type { LayerSpecification, StyleSpecification } from 'maplibre-gl'

/** Magic-type aliases: keep ids and zooms from degrading into bare strings/numbers. */
export type LayerId = 'buildings' | 'roads' | 'parcels' | 'zoning'
export type SourceLayerName = string & { readonly __brand?: 'SourceLayerName' }
export type Zoom = number & { readonly __brand?: 'Zoom' }
export type SourceId = 'world'

export const WORLD_SOURCE: SourceId = 'world'
export const WORLD_PMTILES_URL = '/data/world.pmtiles'

/** Camera over Fairfax County (DESIGN 7.1). */
export const FAIRFAX_CAMERA = {
  center: [-77.28, 38.85] as [number, number],
  zoom: 11 as Zoom,
  pitch: 45,
  bearing: 0,
} as const

/** Distributive Omit: `LayerSpecification` is a union, so plain Omit collapses it. */
type OmitUnion<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type LayerStyle = OmitUnion<LayerSpecification, 'id' | 'source' | 'source-layer' | 'minzoom' | 'maxzoom'>

/** A registry entry is the single source of truth for one map layer. */
export type LayerEntry = {
  readonly id: LayerId
  readonly sourceLayer: SourceLayerName
  readonly minzoom: Zoom
  readonly maxzoom?: Zoom
  /** false while the pipeline does not yet emit this source layer. */
  readonly available: boolean
  /** initial visibility when available */
  readonly visibleByDefault: boolean
  readonly label: string
  readonly style: LayerStyle
}

/**
 * Building height, in metres, resolved by fallback chain:
 * render_height -> height -> building:levels * 3.5 -> 6 m.
 */
const HEIGHT_M = [
  'coalesce',
  ['get', 'render_height'],
  ['to-number', ['get', 'height'], 0],
  ['*', ['to-number', ['get', 'building:levels'], 0], 3.5],
  6,
] as unknown as never

const MIN_HEIGHT_M = ['coalesce', ['get', 'render_min_height'], ['to-number', ['get', 'min_height'], 0], 0] as unknown as never

/**
 * Road zoom LOD, DESIGN 7.2: motorway/trunk/primary/secondary at all zooms,
 * tertiary from z12, residential/unclassified from z13, service from z15.
 */
const ROAD_CLASS_MINZOOM: ReadonlyArray<readonly [string, Zoom]> = [
  ['motorway', 0],
  ['trunk', 0],
  ['primary', 0],
  ['secondary', 0],
  ['tertiary', 12],
  ['minor', 13],
  ['residential', 13],
  ['unclassified', 13],
  ['service', 15],
]

const roadClassFilter = () =>
  [
    'any',
    ...ROAD_CLASS_MINZOOM.map(([cls, mz]) => ['all', ['==', ['get', 'class'], cls], ['>=', ['zoom'], mz]]),
    // classes we did not enumerate: show from z14 rather than drop them.
    ['all', ['!', ['in', ['get', 'class'], ['literal', ROAD_CLASS_MINZOOM.map(([c]) => c)]]], ['>=', ['zoom'], 14]],
  ] as unknown as never

const roadWidth = () =>
  [
    'interpolate',
    ['exponential', 1.6],
    ['zoom'],
    5, ['match', ['get', 'class'], ['motorway', 'trunk'], 0.8, 0.2],
    12, ['match', ['get', 'class'], ['motorway', 'trunk'], 2.4, ['primary', 'secondary'], 1.6, 0.7],
    16, ['match', ['get', 'class'], ['motorway', 'trunk'], 10, ['primary', 'secondary'], 7, 3.5],
  ] as unknown as never

const roadColor = () =>
  [
    'match',
    ['get', 'class'],
    ['motorway', 'trunk'], '#f2b872',
    ['primary', 'secondary'], '#d7dce4',
    ['tertiary'], '#9aa4b2',
    '#5c6675',
  ] as unknown as never

export const LAYER_REGISTRY: readonly LayerEntry[] = [
  {
    id: 'roads',
    sourceLayer: 'roads',
    minzoom: 0,
    available: true,
    visibleByDefault: true,
    label: 'Roads',
    style: {
      type: 'line',
      filter: roadClassFilter(),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': roadColor(), 'line-width': roadWidth(), 'line-opacity': 0.9 },
    },
  },
  {
    id: 'buildings',
    sourceLayer: 'buildings',
    minzoom: 13,
    available: true,
    visibleByDefault: true,
    label: 'Buildings',
    style: {
      type: 'fill-extrusion',
      paint: {
        'fill-extrusion-color': '#3b4657',
        'fill-extrusion-height': HEIGHT_M,
        'fill-extrusion-base': MIN_HEIGHT_M,
        'fill-extrusion-opacity': 0.9,
      },
    },
  },
  {
    id: 'parcels',
    sourceLayer: 'parcels',
    minzoom: 14,
    available: false,
    visibleByDefault: false,
    label: 'Parcels (pending tiles)',
    style: {
      type: 'line',
      paint: { 'line-color': '#6b7a90', 'line-width': 0.5, 'line-opacity': 0.6 },
    },
  },
  {
    id: 'zoning',
    sourceLayer: 'zoning',
    minzoom: 12,
    available: false,
    visibleByDefault: false,
    label: 'Zoning (pending tiles)',
    style: {
      type: 'fill',
      paint: { 'fill-color': '#4d7c5a', 'fill-opacity': 0.25 },
    },
  },
]

export const layerById = (id: LayerId): LayerEntry => {
  const found = LAYER_REGISTRY.find((l) => l.id === id)
  if (!found) throw new Error(`unknown layer ${id}`)
  return found
}

const toMapLibreLayer = (entry: LayerEntry, visible: boolean): LayerSpecification =>
  ({
    ...entry.style,
    id: entry.id,
    source: WORLD_SOURCE,
    'source-layer': entry.sourceLayer,
    minzoom: entry.minzoom,
    ...(entry.maxzoom === undefined ? {} : { maxzoom: entry.maxzoom }),
    layout: {
      ...(entry.style as { layout?: Record<string, unknown> }).layout,
      visibility: visible ? 'visible' : 'none',
    },
  }) as LayerSpecification

export type LayerVisibility = Readonly<Record<LayerId, boolean>>

export const defaultVisibility = (): LayerVisibility =>
  Object.fromEntries(LAYER_REGISTRY.map((l) => [l.id, l.available && l.visibleByDefault])) as LayerVisibility

/** Pure: registry + visibility -> a complete MapLibre style. */
export const buildStyle = (visibility: LayerVisibility, pmtilesUrl = WORLD_PMTILES_URL): StyleSpecification => ({
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    [WORLD_SOURCE]: { type: 'vector', url: `pmtiles://${pmtilesUrl}`, attribution: '© OpenStreetMap contributors' },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0e1116' } },
    ...LAYER_REGISTRY.map((entry) => toMapLibreLayer(entry, visibility[entry.id])),
  ],
})
