/**
 * `data/build/manifest.json` — the one JSON the app is allowed to fetch
 * (DESIGN 7.1). Parsed into a `DTO` that keeps only what the client needs.
 */

import type { ChunkIx } from './schema'

export type ManifestHash = string & { readonly __brand: 'ManifestHash' }
export type ChunkKey = string & { readonly __brand: 'ChunkKey' }

/** `cy * cols + cx`, mirroring `ids::ChunkId`. */
export const chunkIx = (cx: number, cy: number, cols: number): ChunkIx => (cy * cols + cx) as ChunkIx
export const chunkKey = (cx: number, cy: number): ChunkKey => `${cx}_${cy}` as ChunkKey
export const chunkPath = (cx: number, cy: number): string => `graph/chunk_${cx}_${cy}.bin`

export type BBox = readonly [west: number, south: number, east: number, north: number]

export type GridDTO = {
  readonly cols: number
  readonly rows: number
  readonly cellLonDeg: number
  readonly cellLatDeg: number
  readonly minLon: number
  readonly minLat: number
}

export type ManifestFileDTO = { readonly path: string; readonly bytes: number; readonly hash: string }

export type ManifestDTO = {
  readonly hash: ManifestHash
  readonly manifestVersion: number
  readonly schema: { readonly index: number; readonly chunk: number }
  readonly bbox: BBox
  readonly grid: GridDTO
  readonly counts: { readonly nodes: number; readonly edges: number; readonly chunks: number }
  readonly files: readonly ManifestFileDTO[]
}

type RawManifest = {
  manifest_version: number
  schema: { index: number; chunk: number }
  bbox: [number, number, number, number]
  grid: { cols: number; rows: number; cell_lon_deg: number; cell_lat_deg: number; min_lon: number; min_lat: number }
  counts: { nodes: number; edges: number; chunks: number }
  files: { path: string; bytes: number; hash: string }[]
}

/**
 * The manifest hash keys the asset cache and the IndexedDB drafts. Derived from
 * the index file's own content hash, so a rebuild invalidates everything at
 * once without the pipeline having to stamp a separate id.
 */
const hashOf = (raw: RawManifest): ManifestHash =>
  (raw.files.find((f) => f.path.endsWith('index.bin'))?.hash ?? 'unknown').slice(0, 16) as ManifestHash

export const parseManifest = (json: unknown): ManifestDTO => {
  const raw = json as RawManifest
  if (!raw?.grid || !raw.files) throw new TypeError('manifest.json: unexpected shape')
  return {
    hash: hashOf(raw),
    manifestVersion: raw.manifest_version,
    schema: raw.schema,
    bbox: raw.bbox,
    grid: {
      cols: raw.grid.cols,
      rows: raw.grid.rows,
      cellLonDeg: raw.grid.cell_lon_deg,
      cellLatDeg: raw.grid.cell_lat_deg,
      minLon: raw.grid.min_lon,
      minLat: raw.grid.min_lat,
    },
    counts: raw.counts,
    files: raw.files,
  }
}

/** Chunk files that actually exist, in the manifest's own (row-major) order. */
export const chunkCells = (m: ManifestDTO): readonly { readonly cx: number; readonly cy: number; readonly path: string }[] =>
  m.files
    .map((f) => /graph\/chunk_(\d+)_(\d+)\.bin$/.exec(f.path))
    .filter((hit): hit is RegExpExecArray => hit !== null)
    .map((hit) => ({ cx: Number(hit[1]), cy: Number(hit[2]), path: hit[0] }))

/**
 * Cell index of a coordinate along one axis.
 *
 * Subtracting degrees leaves a coordinate that should land exactly on a cell
 * boundary sitting a few ulps below it, and a bare `floor` would then put it in
 * the previous cell - enough to shift the whole default block. Values within an
 * ulp-scale epsilon of a boundary are snapped to it first.
 *
 * `edge` says which side of a boundary a point on it belongs to: the low corner
 * of a window takes the cell that starts there, the high corner the cell that
 * ends there, so a rectangle spanning exactly two cells selects two, not three.
 */
const EPS = 1e-9

const axisCell = (value: number, min: number, size: number, count: number, edge: 'lo' | 'hi'): number => {
  const raw = (value - min) / size
  const nearest = Math.round(raw)
  const exact = Math.abs(raw - nearest) < EPS
  const ix = exact ? (edge === 'hi' ? nearest - 1 : nearest) : Math.floor(raw)
  return Math.min(count - 1, Math.max(0, ix))
}

/** Grid cell containing a lon/lat, clamped to the grid. */
const cellOf = (m: ManifestDTO, lon: number, lat: number, edge: 'lo' | 'hi' = 'lo'): { cx: number; cy: number } => ({
  cx: axisCell(lon, m.grid.minLon, m.grid.cellLonDeg, m.grid.cols, edge),
  cy: axisCell(lat, m.grid.minLat, m.grid.cellLatDeg, m.grid.rows, edge),
})

/**
 * The study area: which chunks stay resident. An assignment hour costs roughly
 * the cube of the edge count, so this is the single biggest performance knob in
 * the app and is modelled explicitly rather than as a nullable bbox.
 */
export type StudyArea =
  /** A square of `2r + 1` cells centred on a point — the default. */
  | { readonly kind: 'block'; readonly center: readonly [number, number]; readonly radius: number }
  | { readonly kind: 'rect'; readonly bbox: BBox }
  | { readonly kind: 'county' }

/** Fairfax City, the centre of the default block. */
export const FAIRFAX_CITY: readonly [number, number] = [-77.3, 38.85]

/**
 * Radius 4 is ~16 km square and ~36k edges, which the wasm solver assigns in
 * about a second. The whole county is 165k edges and ~83 s per hour, far too
 * slow to open on.
 */
export const DEFAULT_BLOCK_RADIUS = 4

export const DEFAULT_STUDY_AREA: StudyArea = {
  kind: 'block',
  center: FAIRFAX_CITY,
  radius: DEFAULT_BLOCK_RADIUS,
}

export const WHOLE_COUNTY: StudyArea = { kind: 'county' }

/** Chebyshev-radius cell window around a point, clamped to the grid. */
const blockCells = (m: ManifestDTO, center: readonly [number, number], radius: number) => {
  const mid = cellOf(m, center[0], center[1])
  return {
    lo: { cx: Math.max(0, mid.cx - radius), cy: Math.max(0, mid.cy - radius) },
    hi: { cx: Math.min(m.grid.cols - 1, mid.cx + radius), cy: Math.min(m.grid.rows - 1, mid.cy + radius) },
  }
}

/** Cell window of a bounded area. `county` is handled by the callers. */
const window_ = (m: ManifestDTO, area: Exclude<StudyArea, { kind: 'county' }>) => {
  if (area.kind === 'block') return blockCells(m, area.center, area.radius)
  const [w, s, e, n] = area.bbox
  return {
    lo: cellOf(m, Math.min(w, e), Math.min(s, n), 'lo'),
    hi: cellOf(m, Math.max(w, e), Math.max(s, n), 'hi'),
  }
}

export const chunksInArea = (m: ManifestDTO, area: StudyArea): readonly ChunkKey[] => {
  const cells = chunkCells(m)
  if (area.kind === 'county') return cells.map((c) => chunkKey(c.cx, c.cy))
  const { lo, hi } = window_(m, area)
  return cells
    .filter((c) => c.cx >= lo.cx && c.cx <= hi.cx && c.cy >= lo.cy && c.cy <= hi.cy)
    .map((c) => chunkKey(c.cx, c.cy))
}

/** Geographic extent of an area, for a fit-bounds or an outline. */
export const areaBBox = (m: ManifestDTO, area: StudyArea): BBox => {
  if (area.kind === 'rect') return area.bbox
  if (area.kind === 'county') return m.bbox
  const { lo, hi } = window_(m, area)
  return [
    m.grid.minLon + lo.cx * m.grid.cellLonDeg,
    m.grid.minLat + lo.cy * m.grid.cellLatDeg,
    m.grid.minLon + (hi.cx + 1) * m.grid.cellLonDeg,
    m.grid.minLat + (hi.cy + 1) * m.grid.cellLatDeg,
  ]
}

/** Chunk-loading order: nearest the camera first, so the visible area fills in. */
export const orderByDistance = (
  cells: readonly ChunkKey[],
  m: ManifestDTO,
  center: readonly [number, number],
): readonly ChunkKey[] => {
  const dist = (key: ChunkKey): number => {
    const [cx, cy] = key.split('_').map(Number) as [number, number]
    const lon = m.grid.minLon + (cx + 0.5) * m.grid.cellLonDeg
    const lat = m.grid.minLat + (cy + 0.5) * m.grid.cellLatDeg
    return (lon - center[0]) ** 2 + (lat - center[1]) ** 2
  }
  return [...cells].sort((a, b) => dist(a) - dist(b))
}

// ------------------------------------------------------- cost of an area

/**
 * Edges in the chunks an area selects. Read off the index's chunk table, which
 * the client decodes before handing the buffer to the worker.
 */
export const edgesInArea = (
  chunks: readonly { readonly cx: number; readonly cy: number; readonly edgeCount: number }[],
  m: ManifestDTO,
  area: StudyArea,
): number => {
  const wanted = new Set(chunksInArea(m, area))
  return chunks.filter((c) => wanted.has(chunkKey(c.cx, c.cy))).reduce((n, c) => n + c.edgeCount, 0)
}

/**
 * Seconds for one assignment hour, fitted to the wasm solver's measured
 * figures: ~1.0 s at 36k edges and ~83 s at the county's 165k, full zones,
 * single-threaded. That is an exponent near 2.9 — close to cubic in the edge
 * count, which is why the app opens on a block rather than the county.
 */
const REF_EDGES = 36_000
const REF_SECONDS = 1.0
const COST_EXPONENT = 2.9

/**
 * Zone aggregation and threads are the two Phase-2.5 multipliers, both
 * anchored on the county-coarse measurements: 12 s single-threaded, 1.7 s warm
 * on 8 threads, and roughly double that on the first (cold) hour.
 *
 *   coarse zones     12 / 82.7   = 0.145 of the full-zone cost
 *   8 threads        12 / 1.7    = 7.06x, i.e. ~0.88 efficiency per thread
 */
const COARSE_ZONE_FACTOR = 0.145
const THREAD_EFFICIENCY = 0.883
const COLD_MULTIPLIER = 2

export type Zoning = 'full' | 'coarse'

export type HourCostDTO = {
  /** A later hour, warm-started from the previous one. */
  readonly warmS: number
  /** The first hour after the edge set changes, which rebuilds the solver. */
  readonly coldS: number
}

export type HourCostInput = {
  readonly edges: number
  readonly zones: Zoning
  /** What `threadCount()` reported; 1 in the single-threaded build. */
  readonly threads: number
}

/** Rayon does not scale perfectly, and past the core count it does not scale. */
export const threadSpeedup = (threads: number): number =>
  threads <= 1 ? 1 : 1 + (threads - 1) * THREAD_EFFICIENCY

export const estimatedHourSeconds = (edges: number): number =>
  edges <= 0 ? 0 : REF_SECONDS * (edges / REF_EDGES) ** COST_EXPONENT

export const hourCost = ({ edges, zones, threads }: HourCostInput): HourCostDTO => {
  const warmS =
    (estimatedHourSeconds(edges) * (zones === 'coarse' ? COARSE_ZONE_FACTOR : 1)) / threadSpeedup(threads)
  return { warmS, coldS: warmS * COLD_MULTIPLIER }
}

/**
 * Past this much time per hour the UI warns. It is a time, not an edge count:
 * the county is fine on eight threads with coarse zones and painful without,
 * and the same edge count means both things.
 */
export const HEAVY_HOUR_SECONDS = 5

/** Kept for the edge-count reading of the same threshold (full zones, 1 thread). */
export const HEAVY_AREA_EDGES = 60_000
