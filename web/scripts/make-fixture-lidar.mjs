// Synthetic `lidar/` fixture, so the web layer can be built and benchmarked
// before the pipeline's real chunks land. Writes into `web/public/data/lidar`,
// which is gitignored; if `data/build/lidar` exists this instead points a
// symlink at the real output and writes nothing.
//
//   node scripts/make-fixture-lidar.mjs
//
// The bytes are the Phase-4 contract: the pipeline header + section table with
// kinds 90 (xyz f32[N*3]), 91 (rgb u8[N*3]) and 92 (class u8[N]).

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../public/data/lidar')
const REAL = resolve(HERE, '../../data/build/lidar')
const MANIFEST = resolve(HERE, '../../data/build/manifest.json')

const MAGIC = 'TWLD'
const VERSION = 1
const HEADER_BYTES = 16
const ENTRY_BYTES = 24
const align8 = (n) => (n + 7) & ~7

/** sections: [{ kind, elemSize, len, payload: Uint8Array }] */
const encode = (sections) => {
  const tableEnd = HEADER_BYTES + sections.length * ENTRY_BYTES
  let at = align8(tableEnd)
  const placed = sections.map((s) => {
    const offset = at
    at = align8(offset + s.payload.byteLength)
    return { ...s, offset }
  })
  const out = new Uint8Array(at)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < 4; i += 1) out[i] = MAGIC.charCodeAt(i)
  dv.setUint32(4, VERSION, true)
  dv.setUint32(8, 0, true)
  dv.setUint32(12, placed.length, true)
  placed.forEach((s, i) => {
    const o = HEADER_BYTES + i * ENTRY_BYTES
    dv.setUint32(o, s.kind, true)
    dv.setUint32(o + 4, s.elemSize, true)
    dv.setUint32(o + 8, s.len, true)
    dv.setBigUint64(o + 16, BigInt(s.offset), true)
    out.set(s.payload, s.offset)
  })
  return out
}

/** A block of ground with a few boxy "buildings" and some noise, in lon/lat/m. */
const chunkPoints = (west, south, cellLon, cellLat, n, groundMin) => {
  const xyz = new Float32Array(n * 3)
  const rgb = new Uint8Array(n * 3)
  const cls = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) {
    const u = (i * 2654435761) % 1000 / 1000
    const v = (i * 40503) % 997 / 997
    const lon = west + u * cellLon
    const lat = south + v * cellLat
    const boxy = u > 0.35 && u < 0.55 && v > 0.4 && v < 0.6
    const h = groundMin + (boxy ? 12 + (i % 7) : (i % 3) * 0.4)
    xyz[i * 3] = lon
    xyz[i * 3 + 1] = lat
    xyz[i * 3 + 2] = h
    rgb[i * 3] = boxy ? 190 : 90 + (i % 40)
    rgb[i * 3 + 1] = boxy ? 180 : 120 + (i % 40)
    rgb[i * 3 + 2] = boxy ? 170 : 80 + (i % 30)
    cls[i] = boxy ? 6 : 2
  }
  return { xyz, rgb, cls }
}

const chunkFile = (points) => {
  const n = points.cls.length
  return encode([
    { kind: 90, elemSize: 12, len: n, payload: new Uint8Array(points.xyz.buffer) },
    { kind: 91, elemSize: 3, len: n, payload: points.rgb },
    { kind: 92, elemSize: 1, len: n, payload: points.cls },
  ])
}

const hasRealChunks = () =>
  existsSync(REAL) && readdirSync(REAL).some((f) => /^chunk_\d+_\d+\.bin$/.test(f))

// `--force` synthesises even when the pipeline output is there, for a run that
// has to be reproducible (the bench) rather than real.
if (hasRealChunks() && !process.argv.includes('--force')) {
  if (existsSync(OUT) || lstatSync(OUT, { throwIfNoEntry: false })) rmSync(OUT, { recursive: true, force: true })
  symlinkSync('../../../data/build/lidar', OUT)
  console.log(`[fixture] real pipeline output found — ${OUT} -> ${REAL}`)
  process.exit(0)
}

const grid = existsSync(MANIFEST)
  ? JSON.parse(readFileSync(MANIFEST, 'utf8')).grid
  : { min_lon: -77.55, min_lat: 38.6, cell_lon_deg: 0.02, cell_lat_deg: 0.016, cols: 24, rows: 24 }

// The four cells around Fairfax City, which is where the harness looks.
const cellOf = (lon, lat) => [
  Math.floor((lon - grid.min_lon) / grid.cell_lon_deg),
  Math.floor((lat - grid.min_lat) / grid.cell_lat_deg),
]
const [cx0, cy0] = cellOf(-77.3, 38.85)
const POINTS_PER_CHUNK = 120_000

// `rm` never follows a symlink, so this drops the link to the real output
// rather than the pipeline's files.
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const index = { grid, chunks: {} }
for (const dx of [0, 1]) {
  for (const dy of [0, 1]) {
    const cx = cx0 + dx
    const cy = cy0 + dy
    const west = grid.min_lon + cx * grid.cell_lon_deg
    const south = grid.min_lat + cy * grid.cell_lat_deg
    const groundMin = 90
    const bin = chunkFile(chunkPoints(west, south, grid.cell_lon_deg, grid.cell_lat_deg, POINTS_PER_CHUNK, groundMin))
    writeFileSync(resolve(OUT, `chunk_${cx}_${cy}.bin`), bin)
    index.chunks[`chunk_${cx}_${cy}`] = { bytes: bin.byteLength, points: POINTS_PER_CHUNK, ground_min: groundMin }
  }
}
writeFileSync(resolve(OUT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
console.log(`[fixture] wrote ${Object.keys(index.chunks).length} synthetic lidar chunks to ${OUT}`)
