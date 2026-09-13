import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  areaBBox,
  chunksInArea,
  DEFAULT_BLOCK_RADIUS,
  DEFAULT_STUDY_AREA,
  edgesInArea,
  estimatedHourSeconds,
  FAIRFAX_CITY,
  HEAVY_AREA_EDGES,
  parseManifest,
  WHOLE_COUNTY,
  type ManifestDTO,
} from './manifest'

/** A 10x10 grid of 0.01-degree cells with one chunk file per cell. */
const grid = { cols: 10, rows: 10, cell_lon_deg: 0.01, cell_lat_deg: 0.01, min_lon: -77.35, min_lat: 38.8 }

const fixture = (): ManifestDTO =>
  parseManifest({
    manifest_version: 1,
    schema: { index: 1, chunk: 2 },
    bbox: [-77.35, 38.8, -77.25, 38.9],
    grid,
    counts: { nodes: 100, edges: 1000, chunks: 100 },
    files: [
      { path: 'graph/index.bin', bytes: 16, hash: 'abc123def456789a' },
      ...Array.from({ length: 100 }, (_, i) => ({
        path: `graph/chunk_${i % 10}_${Math.floor(i / 10)}.bin`,
        bytes: 10,
        hash: `h${i}`,
      })),
    ],
  })

/** One edge per cell makes the selected-edge count equal the chunk count. */
const indexChunks = Array.from({ length: 100 }, (_, i) => ({
  cx: i % 10,
  cy: Math.floor(i / 10),
  edgeCount: 1,
}))

describe('study area selection', () => {
  const m = fixture()

  it('takes the manifest hash from the index file', () => {
    expect(m.hash).toBe('abc123def456789a')
  })

  it('selects a (2r+1)-square block around the centre', () => {
    // FAIRFAX_CITY sits at cell (5, 5) in this grid
    const area = { kind: 'block' as const, center: FAIRFAX_CITY, radius: 2 }
    expect(chunksInArea(m, area)).toHaveLength(25)
    expect(chunksInArea(m, area)).toContain('5_5')
    expect(chunksInArea(m, area)).not.toContain('2_5')
  })

  it('clamps a block that runs off the grid instead of wrapping', () => {
    const corner = { kind: 'block' as const, center: [-77.35, 38.8] as const, radius: 3 }
    const keys = chunksInArea(m, corner)
    expect(keys).toContain('0_0')
    expect(keys).toHaveLength(16) // 4x4, not 7x7
  })

  it('selects every chunk for the county and a window for a rectangle', () => {
    expect(chunksInArea(m, WHOLE_COUNTY)).toHaveLength(100)
    expect(chunksInArea(m, { kind: 'rect', bbox: [-77.35, 38.8, -77.33, 38.82] })).toHaveLength(4)
  })

  it('accepts a rectangle drawn in any corner order', () => {
    const a = chunksInArea(m, { kind: 'rect', bbox: [-77.35, 38.8, -77.33, 38.82] })
    const b = chunksInArea(m, { kind: 'rect', bbox: [-77.33, 38.82, -77.35, 38.8] })
    expect(b).toEqual(a)
  })

  it('costs a selection by the index chunk table', () => {
    expect(edgesInArea(indexChunks, m, WHOLE_COUNTY)).toBe(100)
    expect(edgesInArea(indexChunks, m, { kind: 'block', center: FAIRFAX_CITY, radius: 1 })).toBe(9)
  })

  it('reports a block bbox that contains its centre', () => {
    const [w, s, e, n] = areaBBox(m, { kind: 'block', center: FAIRFAX_CITY, radius: 1 })
    expect(FAIRFAX_CITY[0]).toBeGreaterThanOrEqual(w)
    expect(FAIRFAX_CITY[0]).toBeLessThanOrEqual(e)
    expect(FAIRFAX_CITY[1]).toBeGreaterThanOrEqual(s)
    expect(FAIRFAX_CITY[1]).toBeLessThanOrEqual(n)
  })
})

describe('assignment cost model', () => {
  it('reproduces the two measured twin-bench points', () => {
    expect(estimatedHourSeconds(36_000)).toBeCloseTo(1.0, 2)
    // ~83 s for the county at 165k edges
    expect(estimatedHourSeconds(165_545)).toBeGreaterThan(60)
    expect(estimatedHourSeconds(165_545)).toBeLessThan(110)
  })

  it('rises steeply, which is what the warning exists to convey', () => {
    expect(estimatedHourSeconds(HEAVY_AREA_EDGES)).toBeGreaterThan(estimatedHourSeconds(36_000) * 3)
    expect(estimatedHourSeconds(0)).toBe(0)
  })
})

const REAL_MANIFEST = '/home/flober/repos/twin/data/build/manifest.json'

describe.skipIf(!existsSync(REAL_MANIFEST))('default study area on the real county', () => {
  it('is a small fraction of the county', () => {
    const real = parseManifest(JSON.parse(readFileSync(REAL_MANIFEST, 'utf8')))
    const block = chunksInArea(real, DEFAULT_STUDY_AREA)
    const county = chunksInArea(real, WHOLE_COUNTY)
    const side = 2 * DEFAULT_BLOCK_RADIUS + 1
    expect(block.length).toBeLessThanOrEqual(side * side)
    expect(block.length).toBeLessThan(county.length / 3)
  })
})
