import { describe, expect, it } from 'vitest'
import { SchemaError } from '../graph/schema'
import { decodeLidarChunk, parseLidarIndex } from './schema'

/**
 * The encoder here is the Phase-4 contract written out by hand — header, 24-byte
 * section entries, 8-byte-aligned payloads. It exists so the decoder is tested
 * against the *format*, not against whatever the pipeline happened to emit.
 */

const HEADER_BYTES = 16
const ENTRY_BYTES = 24
const align8 = (n: number): number => (n + 7) & ~7

type Section = { kind: number; elemSize: number; len: number; payload: Uint8Array }

const encode = (sections: readonly Section[], magic = 'TWLD'): ArrayBuffer => {
  let at = align8(HEADER_BYTES + sections.length * ENTRY_BYTES)
  const placed = sections.map((s) => {
    const offset = at
    at = align8(offset + s.payload.byteLength)
    return { ...s, offset }
  })
  const out = new Uint8Array(at)
  const dv = new DataView(out.buffer)
  ;[...magic].forEach((c, i) => (out[i] = c.charCodeAt(0)))
  dv.setUint32(4, 1, true)
  dv.setUint32(12, placed.length, true)
  placed.forEach((s, i) => {
    const o = HEADER_BYTES + i * ENTRY_BYTES
    dv.setUint32(o, s.kind, true)
    dv.setUint32(o + 4, s.elemSize, true)
    dv.setUint32(o + 8, s.len, true)
    dv.setBigUint64(o + 16, BigInt(s.offset), true)
    out.set(s.payload, s.offset)
  })
  return out.buffer
}

const XYZ = Float32Array.of(-77.3, 38.85, 101.5, -77.31, 38.86, 96)
const RGB = Uint8Array.of(10, 20, 30, 40, 50, 60)
const CLS = Uint8Array.of(2, 6)

const chunk = (extra: readonly Section[] = []): ArrayBuffer =>
  encode([
    { kind: 90, elemSize: 12, len: 2, payload: new Uint8Array(XYZ.buffer) },
    { kind: 91, elemSize: 3, len: 2, payload: RGB },
    ...extra,
  ])

describe('decodeLidarChunk', () => {
  it('reads xyz, rgb and classification', () => {
    const c = decodeLidarChunk(chunk([{ kind: 92, elemSize: 1, len: 2, payload: CLS }]))
    expect(c.count).toBe(2)
    expect([...c.xyz]).toEqual([...XYZ])
    expect([...c.rgb]).toEqual([...RGB])
    expect([...(c.classification ?? [])]).toEqual([2, 6])
  })

  it('treats classification as optional', () => {
    expect(decodeLidarChunk(chunk()).classification).toBeUndefined()
  })

  it('accepts any TW magic — the tag is the pipeline stage, not the layout', () => {
    expect(decodeLidarChunk(encode([{ kind: 90, elemSize: 12, len: 1, payload: new Uint8Array(12) }], 'TWLZ')).count).toBe(1)
  })

  it('rejects a foreign file rather than drawing noise', () => {
    expect(() => decodeLidarChunk(encode([{ kind: 90, elemSize: 12, len: 1, payload: new Uint8Array(12) }], 'PNG!'))).toThrow(
      SchemaError,
    )
  })

  it('rejects a chunk with no points section', () => {
    expect(() => decodeLidarChunk(encode([{ kind: 91, elemSize: 3, len: 1, payload: RGB.subarray(0, 3) }]))).toThrow(
      SchemaError,
    )
  })

  it('rejects arrays that disagree on the point count', () => {
    const bad = encode([
      { kind: 90, elemSize: 12, len: 2, payload: new Uint8Array(XYZ.buffer) },
      { kind: 92, elemSize: 1, len: 1, payload: CLS.subarray(0, 1) },
    ])
    expect(() => decodeLidarChunk(bad)).toThrow(/1 classes for 2 points/)
  })

  it('rejects a section whose element size is not the contract', () => {
    expect(() =>
      decodeLidarChunk(encode([{ kind: 90, elemSize: 8, len: 2, payload: new Uint8Array(XYZ.buffer) }])),
    ).toThrow(SchemaError)
  })
})

describe('parseLidarIndex', () => {
  const RAW = {
    grid: { cols: 22, rows: 26, cell_lon_deg: 0.023, cell_lat_deg: 0.018, min_lon: -77.54, min_lat: 38.6 },
    chunks: {
      chunk_10_13: { bytes: 1920088, points: 120000, ground_min: 90.25 },
      'chunk_11_13.bin': { bytes: 10, points: 1 },
    },
  }

  it('keys rows by chunk and keeps ground_min', () => {
    const { chunks } = parseLidarIndex(RAW)
    expect([...chunks.keys()]).toEqual(['10_13', '11_13'])
    expect(chunks.get('10_13' as never)?.groundMin).toBe(90.25)
    // absent ground_min means "already relative"; 0 is the only safe reading
    expect(chunks.get('11_13' as never)?.groundMin).toBe(0)
  })

  it('reads the index own grid', () => {
    expect(parseLidarIndex(RAW).grid?.cellLonDeg).toBe(0.023)
  })

  it('is total on junk and on an index with no chunks yet', () => {
    ;[null, undefined, 42, { chunks: {} }, { chunks: { nope: 1 } }].forEach((v) =>
      expect(parseLidarIndex(v).chunks.size).toBe(0),
    )
  })
})
