/**
 * TS mirror of the `twin-core` binary layouts (DESIGN 5): a 16-byte header, a
 * table of 24-byte section entries, then 8-byte-aligned struct-of-arrays
 * payloads.
 *
 * Sections are located *by kind through the table*, never by a fixed offset, so
 * a schema version bump that appends sections (e.g. the Phase-2 geometry
 * sections) decodes unchanged here. Unknown kinds are ignored; optional
 * sections decode to `undefined` rather than throwing.
 */

export type SchemaVersion = number & { readonly __brand: 'SchemaVersion' }
export type LocalNodeIx = number & { readonly __brand: 'LocalNodeIx' }
export type LocalEdgeIx = number & { readonly __brand: 'LocalEdgeIx' }
export type GlobalEdgeId = number & { readonly __brand: 'GlobalEdgeId' }
export type ChunkIx = number & { readonly __brand: 'ChunkIx' }

export const MAGIC_INDEX = 'TWIX'
export const MAGIC_CHUNK = 'TWCH'

/** Stable discriminants: append, never renumber (mirrors `schema::SectionKind`). */
export const SectionKind = {
  Grid: 1,
  ChunkTable: 2,
  ChunkMeta: 10,
  NodeLonLat: 11,
  NodeGid: 12,
  NodeChunk: 13,
  EdgeFrom: 20,
  EdgeTo: 21,
  EdgeGid: 22,
  EdgeLenM: 23,
  EdgeFfSpeedKph: 24,
  EdgeCapacityVph: 25,
  EdgeLanes: 26,
  EdgeClass: 27,
  GeomOffsets: 28,
  GeomLonLat: 29,
  OutOffsets: 30,
  OutEdges: 31,
} as const
export type SectionKind = (typeof SectionKind)[keyof typeof SectionKind]


export class SchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaError'
  }
}

const HEADER_BYTES = 16
const ENTRY_BYTES = 24

export type SectionEntry = {
  readonly kind: number
  readonly elemSize: number
  /** element count, not bytes */
  readonly len: number
  readonly offset: number
}

export type FileHeader = {
  readonly magic: string
  readonly version: SchemaVersion
  readonly flags: number
  readonly count: number
}

/** Header + section table over a caller-owned buffer. Views are zero-copy. */
export type FileView = {
  readonly header: FileHeader
  readonly table: readonly SectionEntry[]
  readonly bytes: Uint8Array
}

const ascii = (b: Uint8Array): string => String.fromCharCode(...b)

export const parseFile = (buffer: ArrayBuffer, magic: string): FileView => {
  const bytes = new Uint8Array(buffer)
  if (bytes.byteLength < HEADER_BYTES) throw new SchemaError(`truncated: ${bytes.byteLength} < ${HEADER_BYTES}`)
  const dv = new DataView(buffer)
  const found = ascii(bytes.subarray(0, 4))
  if (found !== magic) throw new SchemaError(`bad magic: expected ${magic}, found ${JSON.stringify(found)}`)
  const header: FileHeader = {
    magic: found,
    version: dv.getUint32(4, true) as SchemaVersion,
    flags: dv.getUint32(8, true),
    count: dv.getUint32(12, true),
  }
  const tableEnd = HEADER_BYTES + header.count * ENTRY_BYTES
  if (bytes.byteLength < tableEnd) throw new SchemaError(`truncated section table: need ${tableEnd}`)
  const table = Array.from({ length: header.count }, (_, i): SectionEntry => {
    const at = HEADER_BYTES + i * ENTRY_BYTES
    return {
      kind: dv.getUint32(at, true),
      elemSize: dv.getUint32(at + 4, true),
      len: dv.getUint32(at + 8, true),
      // offsets are u64 but every file is far below 2^32 bytes
      offset: Number(dv.getBigUint64(at + 16, true)),
    }
  })
  return { header, table, bytes }
}

type TypedCtor<T> = { new (b: ArrayBuffer, off: number, len: number): T; BYTES_PER_ELEMENT: number }

const findEntry = (f: FileView, kinds: readonly number[]): SectionEntry | undefined =>
  kinds.reduce<SectionEntry | undefined>((hit, k) => hit ?? f.table.find((s) => s.kind === k), undefined)

/**
 * Borrow a section as a typed array. `stride` is elements-per-record (2 for
 * `[f32;2]`); the on-disk `elem_size` is checked against it.
 */
const sectionOpt = <T>(f: FileView, kinds: readonly number[], ctor: TypedCtor<T>, stride = 1): T | undefined => {
  const entry = findEntry(f, kinds)
  if (!entry) return undefined
  const expect = ctor.BYTES_PER_ELEMENT * stride
  if (entry.elemSize !== expect) {
    throw new SchemaError(`section ${entry.kind}: elem_size ${entry.elemSize}, expected ${expect}`)
  }
  const start = f.bytes.byteOffset + entry.offset
  const count = entry.len * stride
  if (entry.offset + entry.len * expect > f.bytes.byteLength) {
    throw new SchemaError(`section ${entry.kind}: runs past end of buffer`)
  }
  return new ctor(f.bytes.buffer as ArrayBuffer, start, count)
}

const section = <T>(f: FileView, kind: SectionKind, ctor: TypedCtor<T>, stride = 1): T => {
  const got = sectionOpt(f, [kind], ctor, stride)
  if (!got) throw new SchemaError(`missing section ${kind}`)
  return got
}

// ---------------------------------------------------------------- index.bin

export type GridSchema = {
  readonly minLon: number
  readonly minLat: number
  readonly maxLon: number
  readonly maxLat: number
  readonly cellLonDeg: number
  readonly cellLatDeg: number
  readonly cols: number
  readonly rows: number
}

export type ChunkEntrySchema = {
  readonly chunkId: ChunkIx
  readonly cx: number
  readonly cy: number
  readonly nodeCount: number
  readonly edgeCount: number
  readonly nodeGidOffset: number
  readonly edgeGidOffset: number
}

export type GraphIndexSchema = {
  readonly grid: GridSchema
  readonly chunks: readonly ChunkEntrySchema[]
}

/** `min_lon,min_lat,max_lon,max_lat,cell_lon,cell_lat` as f64 then `cols,rows` as u32. */
const GRID_BYTES = 56

const decodeGrid = (f: FileView): GridSchema => {
  const raw = section(f, SectionKind.Grid, Uint8Array, GRID_BYTES)
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  return {
    minLon: dv.getFloat64(0, true),
    minLat: dv.getFloat64(8, true),
    maxLon: dv.getFloat64(16, true),
    maxLat: dv.getFloat64(24, true),
    cellLonDeg: dv.getFloat64(32, true),
    cellLatDeg: dv.getFloat64(40, true),
    cols: dv.getUint32(48, true),
    rows: dv.getUint32(52, true),
  }
}

const CHUNK_ENTRY_WORDS = 8

export const decodeIndex = (buffer: ArrayBuffer): GraphIndexSchema => {
  const f = parseFile(buffer, MAGIC_INDEX)
  const flat = section(f, SectionKind.ChunkTable, Uint32Array, CHUNK_ENTRY_WORDS)
  const chunks = Array.from({ length: flat.length / CHUNK_ENTRY_WORDS }, (_, i): ChunkEntrySchema => {
    const o = i * CHUNK_ENTRY_WORDS
    return {
      chunkId: flat[o] as ChunkIx,
      cx: flat[o + 1]!,
      cy: flat[o + 2]!,
      nodeCount: flat[o + 3]!,
      edgeCount: flat[o + 4]!,
      nodeGidOffset: flat[o + 5]!,
      edgeGidOffset: flat[o + 6]!,
    }
  })
  return { grid: decodeGrid(f), chunks }
}

// ---------------------------------------------------------------- chunk_*.bin

export type ChunkMetaSchema = {
  readonly chunkId: ChunkIx
  readonly nodeCount: number
  readonly edgeCount: number
  readonly ghostNodeCount: number
}

/**
 * A decoded chunk. Every `edge*` array is `E` long and parallel; `nodeLonLat`
 * is `2N` long (interleaved). `geomOffsets`/`geomLonLat` are absent until the
 * pipeline emits them — callers fall back to the straight from→to segment.
 */
export type GraphChunkSchema = {
  readonly version: SchemaVersion
  readonly meta: ChunkMetaSchema
  readonly nodeLonLat: Float32Array
  readonly nodeGid: Uint32Array
  readonly nodeChunk: Uint32Array
  readonly edgeFrom: Uint32Array
  readonly edgeTo: Uint32Array
  readonly edgeGid: Uint32Array
  readonly edgeLenM: Float32Array
  readonly edgeFfSpeedKph: Float32Array
  readonly edgeCapacityVph: Float32Array
  readonly edgeLanes: Uint8Array
  readonly edgeClass: Uint8Array
  readonly outOffsets: Uint32Array
  readonly outEdges: Uint32Array
  /** `E + 1` prefix offsets into `geomLonLat`, in points. */
  readonly geomOffsets: Uint32Array | undefined
  /** interleaved `[lon, lat]` points, `2P` long. */
  readonly geomLonLat: Float32Array | undefined
}

const decodeMeta = (f: FileView): ChunkMetaSchema => {
  const m = section(f, SectionKind.ChunkMeta, Uint32Array, 4)
  return { chunkId: m[0] as ChunkIx, nodeCount: m[1]!, edgeCount: m[2]!, ghostNodeCount: m[3]! }
}

export const decodeChunk = (buffer: ArrayBuffer): GraphChunkSchema => {
  const f = parseFile(buffer, MAGIC_CHUNK)
  const chunk: GraphChunkSchema = {
    version: f.header.version,
    meta: decodeMeta(f),
    nodeLonLat: section(f, SectionKind.NodeLonLat, Float32Array, 2),
    nodeGid: section(f, SectionKind.NodeGid, Uint32Array),
    nodeChunk: section(f, SectionKind.NodeChunk, Uint32Array),
    edgeFrom: section(f, SectionKind.EdgeFrom, Uint32Array),
    edgeTo: section(f, SectionKind.EdgeTo, Uint32Array),
    edgeGid: section(f, SectionKind.EdgeGid, Uint32Array),
    edgeLenM: section(f, SectionKind.EdgeLenM, Float32Array),
    edgeFfSpeedKph: section(f, SectionKind.EdgeFfSpeedKph, Float32Array),
    edgeCapacityVph: section(f, SectionKind.EdgeCapacityVph, Float32Array),
    edgeLanes: section(f, SectionKind.EdgeLanes, Uint8Array),
    edgeClass: section(f, SectionKind.EdgeClass, Uint8Array),
    outOffsets: section(f, SectionKind.OutOffsets, Uint32Array),
    outEdges: section(f, SectionKind.OutEdges, Uint32Array),
    geomOffsets: sectionOpt(f, [SectionKind.GeomOffsets], Uint32Array),
    geomLonLat: sectionOpt(f, [SectionKind.GeomLonLat], Float32Array, 2),
  }
  validateChunk(chunk)
  return chunk
}

const validateChunk = (c: GraphChunkSchema): void => {
  const { nodeCount: n, edgeCount: e } = c.meta
  const nodeOk = c.nodeGid.length === n && c.nodeChunk.length === n && c.nodeLonLat.length === 2 * n
  if (!nodeOk) throw new SchemaError(`node arrays disagree with meta.node_count=${n}`)
  const edgeLens = [
    c.edgeFrom.length,
    c.edgeTo.length,
    c.edgeGid.length,
    c.edgeLenM.length,
    c.edgeFfSpeedKph.length,
    c.edgeCapacityVph.length,
    c.edgeLanes.length,
    c.edgeClass.length,
  ]
  if (edgeLens.some((l) => l !== e)) throw new SchemaError(`edge arrays disagree with meta.edge_count=${e}`)
  if (c.outOffsets.length !== n + 1 || c.outEdges.length !== e) throw new SchemaError('CSR arrays inconsistent')
  if (!c.geomOffsets) return
  if (c.geomOffsets.length !== e + 1) throw new SchemaError(`geom_offsets must be E+1=${e + 1}`)
  const points = (c.geomLonLat?.length ?? 0) / 2
  if (c.geomOffsets[e] !== points) throw new SchemaError(`geom_offsets ends at ${c.geomOffsets[e]}, have ${points} points`)
}

/** Road classes, mirroring `ids::RoadClass`. Index == stored byte. */
export const ROAD_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'unclassified',
  'service',
  'living',
  'other',
] as const
export type RoadClass = (typeof ROAD_CLASSES)[number]

export const roadClass = (raw: number): RoadClass => ROAD_CLASSES[raw] ?? 'other'

/** Classes drawn county-wide below z12 (DESIGN 7.2) — bounded attribute upload. */
export const MAJOR_CLASS_BYTES: ReadonlySet<number> = new Set([0, 1, 2, 3])

/**
 * Polyline of one directed edge as a flat `[lon, lat, …]` array. Falls back to
 * the two endpoints when the chunk predates the geometry sections.
 */
export const edgeGeometry = (c: GraphChunkSchema, edge: LocalEdgeIx): Float32Array => {
  const { geomOffsets, geomLonLat } = c
  if (geomOffsets && geomLonLat) {
    const a = geomOffsets[edge]! * 2
    const b = geomOffsets[edge + 1]! * 2
    if (b > a) return geomLonLat.subarray(a, b)
  }
  const from = c.edgeFrom[edge]! * 2
  const to = c.edgeTo[edge]! * 2
  return Float32Array.of(c.nodeLonLat[from]!, c.nodeLonLat[from + 1]!, c.nodeLonLat[to]!, c.nodeLonLat[to + 1]!)
}
