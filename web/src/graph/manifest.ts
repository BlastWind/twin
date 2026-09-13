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

/** Grid cell containing a lon/lat, clamped to the grid. */
const cellOf = (m: ManifestDTO, lon: number, lat: number): { cx: number; cy: number } => ({
  cx: Math.min(m.grid.cols - 1, Math.max(0, Math.floor((lon - m.grid.minLon) / m.grid.cellLonDeg))),
  cy: Math.min(m.grid.rows - 1, Math.max(0, Math.floor((lat - m.grid.minLat) / m.grid.cellLatDeg))),
})

/**
 * The study area: the set of chunks to keep resident. `null` bbox means the
 * whole county, which is the default.
 */
export type StudyArea = { readonly bbox: BBox | null }

export const WHOLE_COUNTY: StudyArea = { bbox: null }

export const chunksInArea = (m: ManifestDTO, area: StudyArea): readonly ChunkKey[] => {
  const cells = chunkCells(m)
  if (!area.bbox) return cells.map((c) => chunkKey(c.cx, c.cy))
  const [w, s, e, n] = area.bbox
  const lo = cellOf(m, Math.min(w, e), Math.min(s, n))
  const hi = cellOf(m, Math.max(w, e), Math.max(s, n))
  return cells
    .filter((c) => c.cx >= lo.cx && c.cx <= hi.cx && c.cy >= lo.cy && c.cy <= hi.cy)
    .map((c) => chunkKey(c.cx, c.cy))
}

/** Chunk-loading order: nearest the camera first, so the visible area fills in. */
export const orderByDistance = (
  cells: readonly ChunkKey[],
  m: ManifestDTO,
  center: readonly [number, number],
): readonly ChunkKey[] => {
  const dist = (key: ChunkKey): number => {
    const [cx, cy] = key.split('_').map(Number)
    const lon = m.grid.minLon + (cx + 0.5) * m.grid.cellLonDeg
    const lat = m.grid.minLat + (cy + 0.5) * m.grid.cellLatDeg
    return (lon - center[0]) ** 2 + (lat - center[1]) ** 2
  }
  return [...cells].sort((a, b) => dist(a) - dist(b))
}
