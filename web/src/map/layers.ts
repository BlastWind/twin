import type { LayerSpecification, StyleSpecification } from 'maplibre-gl'

/** Magic-type aliases: keep ids and zooms from degrading into bare strings/numbers. */
export type LayerId =
  | 'roads'
  | 'buildings'
  | 'parcels'
  | 'zoning'
  | 'transit_routes'
  | 'transit_stops'
  | 'crashes'
  | 'crash_grid'
  | 'counts'

/** Layer panel sections (DESIGN 7.4). Order here is the order on screen. */
export type LayerGroup = 'Base' | 'Land use' | 'Transit' | 'Feeds'
export const LAYER_GROUPS: readonly LayerGroup[] = ['Base', 'Land use', 'Transit', 'Feeds']
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
  readonly group: LayerGroup
  readonly sourceLayer: SourceLayerName
  readonly minzoom: Zoom
  readonly maxzoom?: Zoom
  /**
   * Resolved at runtime from the tiles' own `vector_layers` metadata — see
   * `withAvailability`. The literal here is only the pre-probe default.
   */
  readonly available: boolean
  /** initial visibility when available */
  readonly visibleByDefault: boolean
  readonly label: string
  readonly style: LayerStyle
  /** When present, this entry expands into one MapLibre layer per group. */
  readonly lod?: readonly LodGroup[]
}

/**
 * Building height, in metres, resolved by fallback chain:
 * render_height -> height -> building:levels * 3.5 -> 6 m.
 */
const HEIGHT_M = [
  'coalesce',
  // county GIS `height` (metres) is authoritative in Phase 3; the OSM-derived
  // render_height / levels chain stays as the fallback for anything it misses.
  ['to-number', ['get', 'height'], 0],
  ['get', 'render_height'],
  ['*', ['to-number', ['get', 'building:levels'], 0], 3.5],
  6,
] as unknown as never

const MIN_HEIGHT_M = ['coalesce', ['get', 'render_min_height'], ['to-number', ['get', 'min_height'], 0], 0] as unknown as never

/**
 * Road zoom LOD, DESIGN 7.2: motorway/trunk/primary/secondary at all zooms,
 * tertiary from z12, residential/unclassified from z13, service from z15.
 * `zoom` is not allowed inside a layer `filter`, so each group becomes its own
 * MapLibre layer with a real `minzoom` — generated from this one registry entry.
 */
export type LodGroup = { readonly suffix: string; readonly minzoom: Zoom; readonly classes: readonly string[] }

const ROAD_LOD: readonly LodGroup[] = [
  { suffix: 'major', minzoom: 0, classes: ['motorway', 'trunk', 'primary', 'secondary'] },
  { suffix: 'tertiary', minzoom: 12, classes: ['tertiary', 'tertiary_link'] },
  { suffix: 'minor', minzoom: 13, classes: ['minor', 'residential', 'unclassified', 'living_street'] },
  { suffix: 'service', minzoom: 15, classes: ['service', 'track', 'path'] },
]

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
    group: 'Base',
    // openmaptiles/Planetiler names this MVT layer `transportation`.
    sourceLayer: 'transportation',
    minzoom: 0,
    available: true,
    visibleByDefault: true,
    label: 'Roads',
    lod: ROAD_LOD,
    style: {
      type: 'line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': roadColor(), 'line-width': roadWidth(), 'line-opacity': 0.9 },
    },
  },
  {
    id: 'buildings',
    group: 'Base',
    sourceLayer: 'building',
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
    group: 'Land use',
    sourceLayer: 'parcels',
    minzoom: 14,
    available: false,
    visibleByDefault: false,
    label: 'Parcels',
    style: {
      type: 'line',
      paint: { 'line-color': '#6b7a90', 'line-width': 0.5, 'line-opacity': 0.6 },
    },
  },
  {
    id: 'zoning',
    group: 'Land use',
    sourceLayer: 'zoning',
    minzoom: 12,
    available: false,
    visibleByDefault: false,
    label: 'Zoning',
    style: {
      type: 'fill',
      paint: { 'fill-color': zoneColor(), 'fill-opacity': 0.35, 'fill-outline-color': '#0e1116' },
    },
  },
  {
    id: 'transit_routes',
    group: 'Transit',
    sourceLayer: 'transit_routes',
    minzoom: 10,
    available: false,
    visibleByDefault: false,
    label: 'Transit routes',
    style: {
      type: 'line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': routeColor(), 'line-width': routeWidth(), 'line-opacity': 0.85 },
    },
  },
  {
    id: 'transit_stops',
    group: 'Transit',
    sourceLayer: 'transit_stops',
    minzoom: 13,
    available: false,
    visibleByDefault: false,
    label: 'Transit stops',
    style: {
      type: 'circle',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2, 17, 5] as unknown as never,
        'circle-color': '#e8eaed',
        'circle-stroke-color': '#0e1116',
        'circle-stroke-width': 1,
      },
    },
  },
  {
    id: 'crash_grid',
    group: 'Feeds',
    sourceLayer: 'crash_grid',
    minzoom: 0,
    // handing over to the points at z12 (DESIGN 7.2: feed points aggregate below z13)
    maxzoom: CRASH_POINT_ZOOM,
    available: false,
    visibleByDefault: false,
    label: 'Crashes (grid)',
    style: {
      type: 'fill',
      paint: { 'fill-color': crashCountColor(), 'fill-opacity': 0.55 },
    },
  },
  {
    id: 'crashes',
    group: 'Feeds',
    sourceLayer: 'crashes',
    minzoom: CRASH_POINT_ZOOM,
    available: false,
    visibleByDefault: false,
    label: 'Crashes',
    style: {
      type: 'circle',
      paint: {
        // severity is ordinal, so it drives size; one hue keeps it from reading
        // as five unrelated categories
        'circle-radius': crashRadius(),
        'circle-color': CRASH_COLOR,
        'circle-opacity': 0.8,
        'circle-stroke-color': '#0e1116',
        'circle-stroke-width': 0.5,
      },
    },
  },
  {
    id: 'counts',
    group: 'Feeds',
    sourceLayer: 'counts',
    minzoom: 9,
    available: false,
    visibleByDefault: false,
    label: 'Traffic counts (AADT)',
    style: {
      type: 'circle',
      paint: {
        'circle-radius': aadtRadius(),
        'circle-color': COUNT_COLOR,
        'circle-opacity': 0.75,
        'circle-stroke-color': '#0e1116',
        'circle-stroke-width': 0.75,
      },
    },
  },
]

export const layerById = (id: LayerId): LayerEntry => {
  const found = LAYER_REGISTRY.find((l) => l.id === id)
  if (!found) throw new Error(`unknown layer ${id}`)
  return found
}

const toMapLibreLayer = (entry: LayerEntry, visible: boolean, group?: LodGroup): LayerSpecification =>
  ({
    ...entry.style,
    id: group ? `${entry.id}/${group.suffix}` : entry.id,
    source: WORLD_SOURCE,
    'source-layer': entry.sourceLayer,
    minzoom: group ? group.minzoom : entry.minzoom,
    ...(entry.maxzoom === undefined ? {} : { maxzoom: entry.maxzoom }),
    ...(group ? { filter: ['in', ['get', 'class'], ['literal', group.classes]] } : {}),
    layout: {
      ...(entry.style as { layout?: Record<string, unknown> }).layout,
      visibility: visible ? 'visible' : 'none',
    },
  }) as LayerSpecification

/** Every MapLibre layer id produced by one registry entry. */
export const mapLayerIds = (entry: LayerEntry): readonly string[] =>
  entry.lod ? entry.lod.map((g) => `${entry.id}/${g.suffix}`) : [entry.id]

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
    ...LAYER_REGISTRY.flatMap((entry) =>
      entry.lod
        ? entry.lod.map((g) => toMapLibreLayer(entry, visibility[entry.id], g))
        : [toMapLibreLayer(entry, visibility[entry.id])],
    ),
  ],
})
