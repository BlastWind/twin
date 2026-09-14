/**
 * Orthoimagery basemap.
 *
 * Source: VGIN's VBMP "most recent imagery" fused map cache (spring 2022/2023/
 * 2025, true colour, ~1 ft GSD statewide). It is an ArcGIS *cached* MapServer
 * in EPSG:3857 with 256 px tiles and the standard top-left origin, so its
 * `tile/{z}/{y}/{x}` endpoint is an XYZ scheme with the row and column
 * transposed — no bbox math, only an argument swap.
 *
 * Why it is still proxied in dev rather than pointed at directly: the app is
 * cross-origin isolated for threaded wasm (`Cross-Origin-Embedder-Policy:
 * require-corp`), and the VGIN server sends neither `Access-Control-Allow-Origin`
 * nor `Cross-Origin-Resource-Policy`, so the browser would refuse every tile.
 * The dev proxy in `vite.config.ts` makes them same-origin. Production serves
 * pre-rendered PMTiles from our own origin (see web/README.md).
 */

export type TileUrlTemplate = string & { readonly __brand: 'TileUrlTemplate' }

export const IMAGERY_SOURCE_ID = 'imagery' as const
export type ImagerySourceId = typeof IMAGERY_SOURCE_ID

/** Path the dev/preview proxy owns. `{y}` is the XYZ row; the proxy transposes. */
export const IMAGERY_TILE_URL = '/imagery/{z}/{x}/{y}' as TileUrlTemplate

export const IMAGERY_UPSTREAM =
  'https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VBMP_Imagery/MostRecentImagery_WGS/MapServer'

/**
 * Shown in the MapLibre attribution control. VBMP imagery is public Virginia
 * government data, free to use with credit to VGIN/VDEM.
 */
export const IMAGERY_ATTRIBUTION =
  '<a href="https://vgin.vdem.virginia.gov/" target="_blank" rel="noreferrer">Imagery © Virginia Geographic Information Network (VBMP)</a>'

export const IMAGERY_TILE_SIZE = 256
export const IMAGERY_MAX_ZOOM = 20

export const DEFAULT_IMAGERY_OPACITY = 0.85

/** MapLibre `tile/{z}/{y}/{x}` order for one XYZ tile — the whole proxy rule. */
export const upstreamTilePath = (z: number, x: number, y: number): string =>
  `${IMAGERY_UPSTREAM}/tile/${z}/${y}/${x}`
