import type { LayerSpecification, StyleSpecification } from 'maplibre-gl'
import {
  DEFAULT_IMAGERY_OPACITY,
  IMAGERY_ATTRIBUTION,
  IMAGERY_MAX_ZOOM,
  IMAGERY_SOURCE_ID,
  IMAGERY_TILE_SIZE,
  IMAGERY_TILE_URL,
} from './imagery'

/** Magic-type aliases: keep ids and zooms from degrading into bare strings/numbers. */
export type LayerId =
  | 'imagery'
  | 'lidar'
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
export type SourceId = 'world' | typeof IMAGERY_SOURCE_ID

export const WORLD_SOURCE: SourceId = 'world'
export const WORLD_PMTILES_URL = '/data/world.pmtiles'

/** Point clouds only make sense once a screen pixel is smaller than a point. */
export const LIDAR_MIN_ZOOM: Zoom = 16 as Zoom

/** Buildings fade back to this while the point cloud is on, so the two do not fight. */
export const BUILDING_OPACITY_WITH_LIDAR = 0.25
export const BUILDING_OPACITY = 0.9

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
  /**
   * A raster entry draws from its own tile source, not from the vector tiles,
   * so `sourceLayer` is meaningless for it and the `vector_layers` probe must
   * leave its availability alone.
   */
  readonly raster?: true
  /**
   * A deck.gl entry has no MapLibre layer at all: the registry carries it so
   * that it appears in the panel and in `defaultVisibility`, and the overlay
   * that owns it reads the toggle.
   */
  readonly deck?: true
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


// --------------------------------------------------------------- land use

/**
 * Zoning categories, in a fixed order that is also the colour order: a hue
 * belongs to a category forever, never to its rank in whatever the viewport
 * happens to contain. The seven hues are the validated dark-surface
 * categorical slots (adjacent-pair CVD dE >= 8, contrast >= 3:1 on #0e1116);
 * `other` is the residual bucket and is deliberately gray.
 */
export type ZoneCategory =
  | 'residential'
  | 'commercial'
  | 'industrial'
  | 'institutional'
  | 'mixed_use'
  | 'agricultural'
  | 'open_space'
  | 'other'

export const ZONE_COLORS: Readonly<Record<ZoneCategory, string>> = {
  residential: '#3987e5',
  commercial: '#d95926',
  industrial: '#9085e9',
  institutional: '#199e70',
  mixed_use: '#c98500',
  agricultural: '#d55181',
  open_space: '#008300',
  other: '#6f7783',
}

export const ZONE_CATEGORIES = Object.keys(ZONE_COLORS) as readonly ZoneCategory[]

export const zoneCategory = (raw: string | null | undefined): ZoneCategory =>
  raw && raw in ZONE_COLORS ? (raw as ZoneCategory) : 'other'

const zoneColor = () =>
  [
    'match',
    ['get', 'category'],
    ...ZONE_CATEGORIES.flatMap((c) => [c, ZONE_COLORS[c]]),
    ZONE_COLORS.other,
  ] as unknown as never

// ---------------------------------------------------------------- transit

/**
 * GTFS `route_color` is six hex digits with no `#`. Agencies leave it blank
 * often enough that the fallback matters more than the colour does.
 */
const TRANSIT_FALLBACK = '#8fb6e8'

const routeColor = () =>
  [
    'case',
    ['==', ['coalesce', ['get', 'color'], ''], ''],
    TRANSIT_FALLBACK,
    ['concat', '#', ['get', 'color']],
  ] as unknown as never

const routeWidth = () =>
  ['interpolate', ['exponential', 1.5], ['zoom'], 10, 1, 14, 2.5, 17, 6] as unknown as never

// ------------------------------------------------------------------ feeds

/** Points from here up, grid below (DESIGN 7.2). */
export const CRASH_POINT_ZOOM: Zoom = 12 as Zoom

const CRASH_COLOR = '#d95926'
const COUNT_COLOR = '#3987e5'

/** severity 1 (minor) .. 5 (fatal) — ordinal, so it drives radius, not hue. */
const crashRadius = () =>
  [
    'interpolate',
    ['linear'],
    ['zoom'],
    12, ['interpolate', ['linear'], ['to-number', ['get', 'severity'], 1], 1, 1.5, 5, 4],
    17, ['interpolate', ['linear'], ['to-number', ['get', 'severity'], 1], 1, 4, 5, 12],
  ] as unknown as never

/**
 * Crash counts per grid cell: one hue, light -> dark reversed for a dark
 * surface, so more crashes read as brighter.
 */
const CRASH_COUNT_STEPS: readonly (readonly [number, string])[] = [
  [0, '#3a2118'],
  [5, '#6d3a20'],
  [15, '#a44d1f'],
  [40, '#d95926'],
  [100, '#f08b5e'],
]

const crashCountColor = () =>
  [
    'interpolate',
    ['linear'],
    ['to-number', ['get', 'count'], 0],
    ...CRASH_COUNT_STEPS.flatMap(([n, c]) => [n, c]),
  ] as unknown as never

/** sqrt-scaled radius: area, not radius, should track AADT. */
const aadtRadius = () =>
  [
    'interpolate',
    ['linear'],
    ['zoom'],
    9, ['interpolate', ['linear'], ['sqrt', ['to-number', ['get', 'aadt'], 0]], 0, 1.5, 400, 7],
    16, ['interpolate', ['linear'], ['sqrt', ['to-number', ['get', 'aadt'], 0]], 0, 4, 400, 22],
  ] as unknown as never

export const LAYER_REGISTRY: readonly LayerEntry[] = [
  {
    // first in the registry == first in the style == under everything else
    id: 'imagery',
    group: 'Base',
    sourceLayer: '',
    minzoom: 0,
    available: true,
    visibleByDefault: true,
    raster: true,
    label: 'Imagery',
    style: { type: 'raster', paint: { 'raster-opacity': DEFAULT_IMAGERY_OPACITY } },
  },
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
        'fill-extrusion-opacity': BUILDING_OPACITY,
      },
    },
  },
  {
    id: 'lidar',
    group: 'Base',
    sourceLayer: '',
    minzoom: LIDAR_MIN_ZOOM,
    available: true,
    visibleByDefault: false,
    deck: true,
    label: 'LiDAR point cloud',
    // drawn by `LidarOverlay` through deck.gl; MapLibre never sees it
    style: { type: 'background', paint: {} },
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
    source: entry.raster ? IMAGERY_SOURCE_ID : WORLD_SOURCE,
    ...(entry.raster ? {} : { 'source-layer': entry.sourceLayer }),
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

/**
 * Which source layers the tiles actually contain, from the PMTiles metadata's
 * `vector_layers`. A layer the pipeline has not emitted yet is *hidden*, not
 * broken: MapLibre would otherwise keep a live layer pointed at a source-layer
 * that never yields a feature, and the panel would offer a toggle that does
 * nothing.
 */
export type SourceLayerSet = ReadonlySet<SourceLayerName>

/** Everything the Phase-1/2 tiles are known to have; the pre-probe assumption. */
export const KNOWN_SOURCE_LAYERS: SourceLayerSet = new Set<SourceLayerName>(['transportation', 'building'])

export const withAvailability = (
  present: SourceLayerSet,
  registry: readonly LayerEntry[] = LAYER_REGISTRY,
): readonly LayerEntry[] =>
  registry.map((e) => {
    // raster and deck entries do not come out of the vector tiles at all
    const available = e.raster || e.deck ? e.available : present.has(e.sourceLayer)
    return e.available === available ? e : { ...e, available }
  })

export const availableLayers = (registry: readonly LayerEntry[]): readonly LayerEntry[] =>
  registry.filter((e) => e.available)

export const defaultVisibility = (registry: readonly LayerEntry[] = LAYER_REGISTRY): LayerVisibility =>
  Object.fromEntries(registry.map((l) => [l.id, l.available && l.visibleByDefault])) as LayerVisibility

/** Pure: registry + visibility -> a complete MapLibre style. */
export const buildStyle = (
  visibility: LayerVisibility,
  registry: readonly LayerEntry[] = LAYER_REGISTRY,
  pmtilesUrl = WORLD_PMTILES_URL,
  imageryOpacity = DEFAULT_IMAGERY_OPACITY,
): StyleSpecification => ({
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    [WORLD_SOURCE]: { type: 'vector', url: `pmtiles://${pmtilesUrl}`, attribution: '© OpenStreetMap contributors' },
    [IMAGERY_SOURCE_ID]: {
      type: 'raster',
      tiles: [IMAGERY_TILE_URL],
      tileSize: IMAGERY_TILE_SIZE,
      maxzoom: IMAGERY_MAX_ZOOM,
      attribution: IMAGERY_ATTRIBUTION,
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0e1116' } },
    ...availableLayers(registry).filter((e) => !e.deck).flatMap((entry) =>
      entry.lod
        ? entry.lod.map((g) => toMapLibreLayer(entry, visibility[entry.id], g))
        : [
            toMapLibreLayer(
              entry.raster
                ? { ...entry, style: { ...entry.style, paint: { 'raster-opacity': imageryOpacity } } as LayerStyle }
                : entry,
              visibility[entry.id],
            ),
          ],
    ),
  ],
})
