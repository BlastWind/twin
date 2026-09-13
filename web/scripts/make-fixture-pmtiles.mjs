// Build a tiny dev fixture `web/public/data/world.pmtiles` from hand-written
// GeoJSON, so the app renders without the Planetiler pipeline (offline dev).
// Layers and attributes mirror what scripts/build-tiles.sh emits.
import { gzipSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import geojsonvt from 'geojson-vt'
import vtpbf from 'vt-pbf'
import { zxyToTileId } from 'pmtiles'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../public/data/world.pmtiles')

// --- fixture geometry: a grid of streets + blocks around Tysons/Fairfax -------
const CENTER = [-77.28, 38.85]
const SPAN = 0.06
const STEPS = 12

const lerp = (a, b, t) => a + (b - a) * t
const grid = (i, n) => lerp(-SPAN, SPAN, i / n)

const roads = []
let wayId = 100000
for (let i = 0; i <= STEPS; i += 1) {
  const cls = i % 6 === 0 ? 'motorway' : i % 3 === 0 ? 'primary' : i % 2 === 0 ? 'secondary' : 'residential'
  const o = grid(i, STEPS)
  roads.push(
    {
      type: 'Feature',
      properties: { class: cls, osm_way_id: (wayId += 1), edge_id: wayId, lanes: cls === 'motorway' ? 4 : 2 },
      geometry: { type: 'LineString', coordinates: [[CENTER[0] - SPAN, CENTER[1] + o], [CENTER[0] + SPAN, CENTER[1] + o]] },
    },
    {
      type: 'Feature',
      properties: { class: cls, osm_way_id: (wayId += 1), edge_id: wayId, lanes: cls === 'motorway' ? 4 : 2 },
      geometry: { type: 'LineString', coordinates: [[CENTER[0] + o, CENTER[1] - SPAN], [CENTER[0] + o, CENTER[1] + SPAN]] },
    },
  )
}

const buildings = []
for (let i = 0; i < STEPS; i += 1) {
  for (let j = 0; j < STEPS; j += 1) {
    const x = CENTER[0] + grid(i, STEPS) + SPAN / STEPS / 4
    const y = CENTER[1] + grid(j, STEPS) + SPAN / STEPS / 4
    const w = SPAN / STEPS / 2.4
    const h = 6 + ((i * 7 + j * 13) % 30) * 3
    buildings.push({
      type: 'Feature',
      properties: { render_height: h, render_min_height: 0, 'building:levels': Math.round(h / 3.5) },
      geometry: { type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + w * 0.75], [x, y + w * 0.75], [x, y]]] },
    })
  }
}

const MIN_ZOOM = 6
const MAX_ZOOM = 15
const layers = {
  transportation: new geojsonvt({ type: 'FeatureCollection', features: roads }, { maxZoom: MAX_ZOOM, indexMaxZoom: MAX_ZOOM, tolerance: 3 }),
  building: new geojsonvt({ type: 'FeatureCollection', features: buildings }, { maxZoom: MAX_ZOOM, indexMaxZoom: MAX_ZOOM, tolerance: 3 }),
}

const BBOX = [CENTER[0] - SPAN, CENTER[1] - SPAN, CENTER[0] + SPAN, CENTER[1] + SPAN]
const lonToX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z)
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}

// --- render every covering tile ----------------------------------------------
const tiles = []
for (let z = MIN_ZOOM; z <= MAX_ZOOM; z += 1) {
  for (let x = lonToX(BBOX[0], z); x <= lonToX(BBOX[2], z); x += 1) {
    for (let y = latToY(BBOX[3], z); y <= latToY(BBOX[1], z); y += 1) {
      const parts = Object.fromEntries(
        Object.entries(layers)
          .map(([name, index]) => [name, index.getTile(z, x, y)])
          .filter(([, t]) => t && t.features.length > 0),
      )
      if (Object.keys(parts).length === 0) continue
      tiles.push({ id: zxyToTileId(z, x, y), data: gzipSync(vtpbf.fromGeojsonVt(parts, { version: 2 })) })
    }
  }
}
tiles.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

// --- PMTiles v3 writer --------------------------------------------------------
const varint = (n) => {
  const out = []
  let v = BigInt(n)
  while (v >= 128n) {
    out.push(Number((v & 127n) | 128n))
    v >>= 7n
  }
  out.push(Number(v))
  return out
}

/** Directory: counts, delta tile ids, run lengths, byte lengths, offsets. */
const serializeDirectory = (entries) => {
  const b = [...varint(entries.length)]
  let last = 0n
  entries.forEach((e) => {
    b.push(...varint(BigInt(e.id) - last))
    last = BigInt(e.id)
  })
  entries.forEach((e) => b.push(...varint(e.runLength)))
  entries.forEach((e) => b.push(...varint(e.length)))
  entries.forEach((e, i) => {
    const prev = entries[i - 1]
    const contiguous = i > 0 && prev.offset + prev.length === e.offset
    b.push(...varint(contiguous ? 0 : e.offset + 1))
  })
  return Buffer.from(b)
}

let offset = 0
const entries = tiles.map((t) => {
  const e = { id: t.id, offset, length: t.data.length, runLength: 1 }
  offset += t.data.length
  return e
})
const tileBody = Buffer.concat(tiles.map((t) => t.data))
const rootDir = gzipSync(serializeDirectory(entries))
const metadata = gzipSync(
  Buffer.from(
    JSON.stringify({
      name: 'twin fixture',
      description: 'hand-written dev fixture (offline): synthetic Fairfax grid',
      vector_layers: [
        { id: 'transportation', minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM, fields: { class: 'String', osm_way_id: 'Number', edge_id: 'Number', lanes: 'Number' } },
        { id: 'building', minzoom: 13, maxzoom: MAX_ZOOM, fields: { render_height: 'Number', render_min_height: 'Number' } },
      ],
    }),
  ),
)

const HEADER_BYTES = 127
const header = Buffer.alloc(HEADER_BYTES)
const rootOffset = HEADER_BYTES
const metaOffset = rootOffset + rootDir.length
const leafOffset = metaOffset + metadata.length
const dataOffset = leafOffset

header.write('PMTiles', 0, 'ascii')
header.writeUInt8(3, 7)
const u64 = (v, at) => header.writeBigUInt64LE(BigInt(v), at)
u64(rootOffset, 8); u64(rootDir.length, 16)
u64(metaOffset, 24); u64(metadata.length, 32)
u64(leafOffset, 40); u64(0, 48)
u64(dataOffset, 56); u64(tileBody.length, 64)
u64(tiles.length, 72); u64(entries.length, 80); u64(tiles.length, 88)
header.writeUInt8(1, 96)  // clustered
header.writeUInt8(2, 97)  // internal compression: gzip
header.writeUInt8(2, 98)  // tile compression: gzip
header.writeUInt8(1, 99)  // tile type: MVT
header.writeUInt8(MIN_ZOOM, 100)
header.writeUInt8(MAX_ZOOM, 101)
const e7 = (v, at) => header.writeInt32LE(Math.round(v * 1e7), at)
e7(BBOX[0], 102); e7(BBOX[1], 106); e7(BBOX[2], 110); e7(BBOX[3], 114)
header.writeUInt8(11, 118)
e7(CENTER[0], 119); e7(CENTER[1], 123)

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, Buffer.concat([header, rootDir, metadata, tileBody]))
console.log(`wrote ${OUT}: ${tiles.length} tiles, ${(Buffer.concat([header, rootDir, metadata, tileBody]).length / 1024).toFixed(1)} KB`)
