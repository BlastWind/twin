import { describe, expect, it } from 'vitest'
import type { ChunkKey, GridDTO } from '../graph/manifest'
import { chunkBBox, selectChunks } from './viewport'
import type { LidarChunkIndexDTO, LidarChunkTable, Metres, PointCount } from './schema'

const GRID: GridDTO = { cols: 4, rows: 4, cellLonDeg: 0.1, cellLatDeg: 0.1, minLon: -77.5, minLat: 38.5 }

const row = (cx: number, cy: number, bytes = 1_000_000, points = 1000): LidarChunkIndexDTO => ({
  chunk: `${cx}_${cy}` as ChunkKey,
  bytes,
  points: points as PointCount,
  groundMin: 0 as Metres,
})

const table = (...rows: readonly LidarChunkIndexDTO[]): LidarChunkTable =>
  new Map(rows.map((r) => [r.chunk, r]))

describe('chunkBBox', () => {
  it('places a cell at its grid offset', () => {
    expect(chunkBBox(GRID, '1_2' as ChunkKey).map((v) => Number(v.toFixed(4)))).toEqual([-77.4, 38.7, -77.3, 38.8])
  })
})

describe('selectChunks', () => {
  const all = table(row(0, 0), row(1, 0), row(2, 0), row(1, 1))

  it('takes only the chunks the view touches', () => {
    // a window inside cell 1_0 alone
    const sel = selectChunks(all, GRID, [-77.39, 38.51, -77.31, 38.59])
    expect(sel.chunks).toEqual(['1_0'])
    expect(sel.dropped).toBe(0)
  })

  it('takes every chunk a wider view straddles', () => {
    const sel = selectChunks(all, GRID, [-77.45, 38.55, -77.25, 38.65])
    expect([...sel.chunks].sort()).toEqual(['0_0', '1_0', '1_1', '2_0'])
  })

  it('orders nearest the centre of the view first', () => {
    const sel = selectChunks(all, GRID, [-77.31, 38.51, -77.05, 38.59])
    expect(sel.chunks[0]).toBe('2_0')
  })

  it('stops at the byte budget, keeping the nearest and counting the rest', () => {
    const sel = selectChunks(all, GRID, [-77.45, 38.55, -77.25, 38.65], 2_500_000)
    expect(sel.chunks).toHaveLength(2)
    expect(sel.dropped).toBe(2)
    expect(sel.bytes).toBe(2_000_000)
  })

  it('never asks for a chunk the index does not list or that has no points', () => {
    const sparse = table(row(1, 0, 10, 0))
    expect(selectChunks(sparse, GRID, [-77.45, 38.45, -77.05, 38.95]).chunks).toEqual([])
    expect(selectChunks(new Map(), GRID, [-77.45, 38.45, -77.05, 38.95]).chunks).toEqual([])
  })

  it('does not select a cell the view only touches on its edge', () => {
    // the view ends exactly where cell 1_0 starts
    expect(selectChunks(all, GRID, [-77.5, 38.5, -77.4, 38.6]).chunks).toEqual(['0_0'])
  })
})
