import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeChunk, decodeIndex, edgeGeometry, MAGIC_CHUNK, SchemaError, SectionKind, roadClass, type LocalEdgeIx } from './schema'

/** Minimal mirror of `schema::FileWriter`, so the test owns its fixtures. */
type Section = { kind: number; elemSize: number; len: number; payload: Uint8Array }

const alignUp = (n: number): number => Math.ceil(n / 8) * 8

const writeFile = (magic: string, version: number, sections: readonly Section[]): ArrayBuffer => {
  const headLen = 16 + sections.length * 24
  let cursor = alignUp(headLen)
  const offsets = sections.map((s) => {
    const at = cursor
    cursor = alignUp(cursor + s.payload.byteLength)
    return at
  })
  const buf = new ArrayBuffer(cursor)
  const dv = new DataView(buf)
  const u8 = new Uint8Array(buf)
  ;[...magic].forEach((c, i) => u8.set([c.charCodeAt(0)], i))
  dv.setUint32(4, version, true)
  dv.setUint32(8, 0, true)
  dv.setUint32(12, sections.length, true)
  sections.forEach((s, i) => {
    const at = 16 + i * 24
    dv.setUint32(at, s.kind, true)
    dv.setUint32(at + 4, s.elemSize, true)
    dv.setUint32(at + 8, s.len, true)
    dv.setBigUint64(at + 16, BigInt(offsets[i]!), true)
    u8.set(s.payload, offsets[i])
  })
  return buf
}

const bytesOf = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)

const sec = (kind: number, elemSize: number, len: number, a: ArrayBufferView): Section => ({
  kind,
  elemSize,
  len,
  payload: bytesOf(a),
})

/** Two nodes, one directed edge, optionally with a 3-point polyline. */
const fixtureSections = (withGeom: boolean): Section[] => {
  const sections: Section[] = [
    sec(SectionKind.ChunkMeta, 16, 1, Uint32Array.of(7, 2, 1, 0)),
    sec(SectionKind.NodeLonLat, 8, 2, Float32Array.of(-77.1, 38.8, -77.0, 38.9)),
    sec(SectionKind.NodeGid, 4, 2, Uint32Array.of(100, 101)),
    sec(SectionKind.NodeChunk, 4, 2, Uint32Array.of(7, 7)),
    sec(SectionKind.EdgeFrom, 4, 1, Uint32Array.of(0)),
    sec(SectionKind.EdgeTo, 4, 1, Uint32Array.of(1)),
    sec(SectionKind.EdgeGid, 4, 1, Uint32Array.of(555)),
    sec(SectionKind.EdgeLenM, 4, 1, Float32Array.of(1200)),
    sec(SectionKind.EdgeFfSpeedKph, 4, 1, Float32Array.of(72)),
    sec(SectionKind.EdgeCapacityVph, 4, 1, Float32Array.of(3200)),
    sec(SectionKind.EdgeLanes, 1, 1, Uint8Array.of(2)),
    sec(SectionKind.EdgeClass, 1, 1, Uint8Array.of(2)),
    sec(SectionKind.OutOffsets, 4, 3, Uint32Array.of(0, 1, 1)),
    sec(SectionKind.OutEdges, 4, 1, Uint32Array.of(0)),
  ]
  const geom: Section[] = [
    sec(SectionKind.GeomOffsets, 4, 2, Uint32Array.of(0, 3)),
    sec(SectionKind.GeomLonLat, 8, 3, Float32Array.of(-77.1, 38.8, -77.05, 38.86, -77.0, 38.9)),
  ]
  // deliberately interleave the new sections *before* the CSR ones: a decoder
  // that trusted layout order rather than the table would break here
  return withGeom ? [...sections.slice(0, 12), ...geom, ...sections.slice(12)] : sections
}

const fixture = (withGeom: boolean, version = withGeom ? 2 : 1): ArrayBuffer =>
  writeFile(MAGIC_CHUNK, version, fixtureSections(withGeom))

describe('chunk decoder', () => {
  it('decodes a v1 chunk with no geometry sections', () => {
    const c = decodeChunk(fixture(false))
    expect(c.version).toBe(1)
    expect(c.meta).toEqual({ chunkId: 7, nodeCount: 2, edgeCount: 1, ghostNodeCount: 0 })
    expect([...c.edgeGid]).toEqual([555])
    expect(roadClass(c.edgeClass[0]!)).toBe('primary')
    expect(c.geomOffsets).toBeUndefined()
  })

  it('falls back to the straight from->to segment when geometry is absent', () => {
    const c = decodeChunk(fixture(false))
    const g = edgeGeometry(c, 0 as LocalEdgeIx)
    expect(g.length).toBe(4)
    expect(g[0]).toBeCloseTo(-77.1, 4)
    expect(g[3]).toBeCloseTo(38.9, 4)
  })

  it('decodes the v2 geometry sections by table lookup, not by offset', () => {
    const c = decodeChunk(fixture(true))
    expect(c.version).toBe(2)
    expect([...(c.geomOffsets ?? [])]).toEqual([0, 3])
    const g = edgeGeometry(c, 0 as LocalEdgeIx)
    expect(g.length).toBe(6)
    expect(g[2]).toBeCloseTo(-77.05, 4)
  })

  it('ignores unknown section kinds and an unrecognised version', () => {
    const unknown: Section = { kind: 4242, elemSize: 4, len: 2, payload: bytesOf(Uint32Array.of(1, 2)) }
    const c = decodeChunk(writeFile(MAGIC_CHUNK, 99, [unknown, ...fixtureSections(true)]))
    expect(c.version).toBe(99)
    expect([...c.edgeGid]).toEqual([555])
  })

  it('rejects a bad magic and a truncated buffer', () => {
    expect(() => decodeChunk(new ArrayBuffer(8))).toThrow(SchemaError)
    expect(() => decodeChunk(writeFile('XXXX', 1, []))).toThrow(/bad magic/)
  })

  it('rejects arrays that disagree with the meta counts', () => {
    const broken = writeFile(MAGIC_CHUNK, 2, [
      sec(SectionKind.ChunkMeta, 16, 1, Uint32Array.of(7, 2, 2, 0)),
      sec(SectionKind.NodeLonLat, 8, 2, Float32Array.of(0, 0, 1, 1)),
      sec(SectionKind.NodeGid, 4, 2, Uint32Array.of(1, 2)),
      sec(SectionKind.NodeChunk, 4, 2, Uint32Array.of(7, 7)),
      sec(SectionKind.EdgeFrom, 4, 1, Uint32Array.of(0)),
      sec(SectionKind.EdgeTo, 4, 1, Uint32Array.of(1)),
      sec(SectionKind.EdgeGid, 4, 1, Uint32Array.of(1)),
      sec(SectionKind.EdgeLenM, 4, 1, Float32Array.of(1)),
      sec(SectionKind.EdgeFfSpeedKph, 4, 1, Float32Array.of(1)),
      sec(SectionKind.EdgeCapacityVph, 4, 1, Float32Array.of(1)),
      sec(SectionKind.EdgeLanes, 1, 1, Uint8Array.of(1)),
      sec(SectionKind.EdgeClass, 1, 1, Uint8Array.of(1)),
      sec(SectionKind.OutOffsets, 4, 3, Uint32Array.of(0, 1, 1)),
      sec(SectionKind.OutEdges, 4, 1, Uint32Array.of(0)),
    ])
    expect(() => decodeChunk(broken)).toThrow(/edge arrays disagree/)
  })
})

const REAL = resolve(import.meta.dirname, '../../../data/build/graph/chunk_10_10.bin')

describe.skipIf(!existsSync(REAL))('chunk decoder on real pipeline output', () => {
  const load = () => {
    const file = readFileSync(REAL)
    return decodeChunk(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer)
  }

  it('decodes a county chunk', () => {
    const c = load()
    expect(c.meta.edgeCount).toBeGreaterThan(0)
    expect(c.edgeGid.length).toBe(c.meta.edgeCount)
    expect(c.outOffsets.length).toBe(c.meta.nodeCount + 1)
    const g = edgeGeometry(c, 0 as LocalEdgeIx)
    expect(g.length).toBeGreaterThanOrEqual(4)
  })

  /**
   * The pipeline bumped the chunk schema to v2 mid-flight. This asserts the
   * decoder picked the new sections up off the table without a code change,
   * and that what it yields is real road shape rather than the straight-line
   * fallback.
   */
  it('reads the v2 polylines the pipeline now emits', () => {
    const c = load()
    expect(c.version).toBeGreaterThanOrEqual(2)
    expect(c.geomOffsets).toBeDefined()
    expect(c.geomOffsets?.length).toBe(c.meta.edgeCount + 1)
    const bent = Array.from({ length: c.meta.edgeCount }, (_, i) => edgeGeometry(c, i as LocalEdgeIx).length).filter(
      (n) => n > 4,
    ).length
    expect(bent).toBeGreaterThan(0)
  })
})

const REAL_INDEX = '/home/flober/repos/twin/data/build/graph/index.bin'

describe.skipIf(!existsSync(REAL_INDEX))('index decoder on real pipeline output', () => {
  /**
   * The grid record is 56 bytes, not a padded 64: six f64s then two u32s.
   * Getting that wrong made the whole index fail to decode, so it is pinned.
   */
  it('decodes the grid and the chunk table', () => {
    const file = readFileSync(REAL_INDEX)
    const ix = decodeIndex(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer)
    expect(ix.grid.cols).toBeGreaterThan(0)
    expect(ix.grid.rows).toBeGreaterThan(0)
    expect(ix.grid.minLon).toBeLessThan(ix.grid.maxLon)
    expect(ix.grid.minLat).toBeLessThan(ix.grid.maxLat)
    expect(ix.grid.cellLonDeg).toBeGreaterThan(0)
    expect(ix.chunks.length).toBeGreaterThan(0)
    expect(ix.chunks.every((c) => c.cx < ix.grid.cols && c.cy < ix.grid.rows)).toBe(true)
    expect(ix.chunks.reduce((n, c) => n + c.edgeCount, 0)).toBeGreaterThan(0)
  })
})
