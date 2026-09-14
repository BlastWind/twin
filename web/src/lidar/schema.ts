/**
 * LiDAR chunk files, Phase 4 contract.
 *
 * `data/build/lidar/chunk_{x}_{y}.bin` reuses the pipeline's header + section
 * table (`graph/schema.ts`) and adds three sections:
 *
 * | kind | payload            | elem size |
 * |-----:|--------------------|----------:|
 * |   90 | `xyz: f32[N*3]`    |        12 |
 * |   91 | `rgb: u8[N*3]`     |         3 |
 * |   92 | `class: u8[N]`     |         1 |
 *
 * `xyz` is `lon, lat, height_m` — geographic, not projected, so deck.gl can
 * take the positions as-is. The magic is not pinned to one tag here: the file
 * is written by a separate pipeline stage and only has to be one of ours, so
 * whatever `TW..` tag it carries is accepted and the section table decides the
 * rest. Anything else is a decode error rather than a garbage point cloud.
 */

import {
  SchemaError,
  SectionKind,
  magicOf,
  parseFile,
  sectionOpt,
  type SchemaVersion,
} from '../graph/schema'
import type { ChunkKey, GridDTO } from '../graph/manifest'

export type PointCount = number & { readonly __brand: 'PointCount' }
/** Metres. Heights in the file are absolute; the renderer works in this unit. */
export type Metres = number & { readonly __brand: 'Metres' }

/** LiDAR classification bytes we care to name (ASPRS). */
export const LIDAR_CLASS = { Ground: 2, Vegetation: 5, Building: 6, Water: 9 } as const

export type LidarChunkSchema = {
  readonly version: SchemaVersion
  readonly count: PointCount
  /** interleaved `lon, lat, height_m`, `3N` long */
  readonly xyz: Float32Array
  /** interleaved `r, g, b`, `3N` long */
  readonly rgb: Uint8Array
  /** ASPRS classification, `N` long; absent in a colour-only build */
  readonly classification: Uint8Array | undefined
}

const MAGIC_PREFIX = 'TW'

export const decodeLidarChunk = (buffer: ArrayBuffer): LidarChunkSchema => {
  const magic = magicOf(buffer)
  if (!magic.startsWith(MAGIC_PREFIX)) throw new SchemaError(`lidar: bad magic ${JSON.stringify(magic)}`)
  const file = parseFile(buffer, magic)
  const xyz = sectionOpt(file, [SectionKind.LidarXyz], Float32Array, 3)
  if (!xyz) throw new SchemaError(`lidar: missing section ${SectionKind.LidarXyz}`)
  const count = (xyz.length / 3) as PointCount
  const rgb = sectionOpt(file, [SectionKind.LidarRgb], Uint8Array, 3) ?? new Uint8Array(count * 3).fill(200)
  const classification = sectionOpt(file, [SectionKind.LidarClass], Uint8Array)
  if (rgb.length !== count * 3) throw new SchemaError(`lidar: ${rgb.length / 3} colours for ${count} points`)
  if (classification && classification.length !== count) {
    throw new SchemaError(`lidar: ${classification.length} classes for ${count} points`)
  }
  return { version: file.header.version, count, xyz, rgb, classification }
}

// ------------------------------------------------------------- index.json

/** `lidar/index.json`, as the pipeline writes it. */
type RawLidarIndex = {
  chunks?: Record<string, { bytes?: number; points?: number; ground_min?: number }>
  grid?: { cols: number; rows: number; cell_lon_deg: number; cell_lat_deg: number; min_lon: number; min_lat: number }
  /** older/flatter shape: the chunk map at the top level */
  [key: string]: unknown
}

export type LidarChunkIndexDTO = {
  readonly chunk: ChunkKey
  readonly bytes: number
  readonly points: PointCount
  /**
   * Lowest ground height in the chunk, metres. The map has no terrain, so this
   * is subtracted from every point: without it a cloud whose heights are above
   * the ellipsoid floats ~50 m over the buildings around Fairfax.
   */
  readonly groundMin: Metres
}

export type LidarChunkTable = ReadonlyMap<ChunkKey, LidarChunkIndexDTO>

/**
 * The lidar index carries its own copy of the chunk grid. It is the
 * authoritative one for *these* keys — the graph manifest's grid should agree,
 * but a lidar build made against a different graph would otherwise place every
 * chunk in the wrong cell silently.
 */
export type LidarIndexDTO = {
  readonly grid: GridDTO | null
  readonly chunks: LidarChunkTable
}

export const EMPTY_LIDAR_INDEX: LidarIndexDTO = { grid: null, chunks: new Map() }

const CHUNK_KEY = /(?:^|\/)(?:chunk_)?(\d+)_(\d+)(?:\.bin)?$/

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/**
 * Tolerant on purpose: the index is written by another agent's pipeline stage,
 * and a missing `ground_min` (0) or an unrecognised key is a reason to draw
 * less, never to fail the layer.
 */
export const parseLidarIndex = (json: unknown): LidarIndexDTO => {
  const raw = (json ?? {}) as RawLidarIndex
  const table = (raw.chunks ?? raw) as Record<string, unknown>
  const rows = Object.entries(table).flatMap(([key, value]): readonly LidarChunkIndexDTO[] => {
    const hit = CHUNK_KEY.exec(key)
    if (!hit || typeof value !== 'object' || value === null) return []
    const v = value as Record<string, unknown>
    return [
      {
        chunk: `${Number(hit[1])}_${Number(hit[2])}` as ChunkKey,
        bytes: num(v.bytes),
        points: num(v.points) as PointCount,
        groundMin: num(v.ground_min ?? v.groundMin) as Metres,
      },
    ]
  })
  return { grid: raw.grid ? gridOf(raw.grid) : null, chunks: new Map(rows.map((r) => [r.chunk, r])) }
}

const gridOf = (g: NonNullable<RawLidarIndex['grid']>): GridDTO => ({
  cols: g.cols,
  rows: g.rows,
  cellLonDeg: g.cell_lon_deg,
  cellLatDeg: g.cell_lat_deg,
  minLon: g.min_lon,
  minLat: g.min_lat,
})

export const lidarChunkPath = (chunk: ChunkKey): string => `lidar/chunk_${chunk}.bin`
export const LIDAR_INDEX_PATH = 'lidar/index.json'
