/**
 * Which lidar chunks the camera is asking for. Pure, so the selection is
 * testable without a map: everything impure (fetching, decoding, evicting)
 * lives in `LidarOverlay`.
 */

import type { BBox, ChunkKey, GridDTO } from '../graph/manifest'
import { chunkKey } from '../graph/manifest'
import type { LidarChunkIndexDTO, LidarChunkTable } from './schema'

/** ~300 MB of decoded points held at once (plan Phase 4). */
export const LIDAR_BUDGET_BYTES = 300 * 1024 * 1024

export type ChunkBBox = BBox

export const chunkBBox = (grid: GridDTO, chunk: ChunkKey): ChunkBBox => {
  const [cx, cy] = chunk.split('_').map(Number) as [number, number]
  return [
    grid.minLon + cx * grid.cellLonDeg,
    grid.minLat + cy * grid.cellLatDeg,
    grid.minLon + (cx + 1) * grid.cellLonDeg,
    grid.minLat + (cy + 1) * grid.cellLatDeg,
  ]
}

const intersects = (a: BBox, b: BBox): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]

const centre = (b: BBox): readonly [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]

const distance2 = (a: readonly [number, number], b: readonly [number, number]): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2

export type ChunkSelection = {
  readonly chunks: readonly ChunkKey[]
  readonly bytes: number
  /** Chunks that intersect the view but did not fit in the budget. */
  readonly dropped: number
}

export const EMPTY_SELECTION: ChunkSelection = { chunks: [], bytes: 0, dropped: 0 }

/**
 * Chunks intersecting `view`, nearest the centre of the view first, taken until
 * the byte budget is spent. Nearest-first is what makes the truncation
 * defensible: at z16 a viewport covers a handful of chunks, and when it covers
 * more than the budget allows, the ones under the cursor are the ones kept.
 *
 * A chunk the index does not list is not requested at all — a 404 per pan is
 * worse than a hole.
 */
export const selectChunks = (
  index: LidarChunkTable,
  grid: GridDTO,
  view: BBox,
  budgetBytes: number = LIDAR_BUDGET_BYTES,
): ChunkSelection => {
  const mid = centre(view)
  const visible = [...index.values()]
    .map((row): readonly [LidarChunkIndexDTO, ChunkBBox] => [row, chunkBBox(grid, row.chunk)])
    .filter(([row, box]) => row.points > 0 && intersects(box, view))
    .sort(([, a], [, b]) => distance2(centre(a), mid) - distance2(centre(b), mid))

  return visible.reduce<ChunkSelection>((acc, [row]) => {
    const bytes = acc.bytes + row.bytes
    return bytes > budgetBytes
      ? { ...acc, dropped: acc.dropped + 1 }
      : { chunks: [...acc.chunks, row.chunk], bytes, dropped: acc.dropped }
  }, EMPTY_SELECTION)
}

/** `chunkKey` re-exported so callers building a key do not reach into manifest. */
export { chunkKey }
