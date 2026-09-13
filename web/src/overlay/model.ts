/**
 * The overlay's binary geometry, merged across resident chunks once and reused
 * for every hour. Only the colour buffer is rebuilt when the hour, mode or
 * result changes — the position buffer never moves (DESIGN 7.2).
 */

import { MAJOR_CLASS_BYTES, type RoadClass, roadClass } from '../graph/schema'
import type { ChunkGeometryDTO, ChunkKey, EdgeId } from '../sim/protocol'
import type { EdgeOrder } from '../state/resultCache'

/** Below this zoom only motorway/trunk/primary/secondary are drawn. */
export const MAJOR_ONLY_BELOW_ZOOM = 12

export type PathModel = {
  /** flat `[lon, lat, …]`, `2V` long */
  readonly positions: Float32Array
  /** `paths + 1` vertex offsets */
  readonly startIndices: Uint32Array
  /** global edge id per path */
  readonly edges: Uint32Array
  /** road class byte per path */
  readonly classes: Uint8Array
  readonly pathCount: number
  readonly vertexCount: number
}

export const EMPTY_MODEL: PathModel = {
  positions: new Float32Array(0),
  startIndices: Uint32Array.of(0),
  edges: new Uint32Array(0),
  classes: new Uint8Array(0),
  pathCount: 0,
  vertexCount: 0,
}

const keep = (classByte: number, majorOnly: boolean): boolean => !majorOnly || MAJOR_CLASS_BYTES.has(classByte)

/**
 * Merge the resident chunks into one binary path set. Chunks are visited in a
 * stable key order so the model is a pure function of its inputs.
 */
export const buildModel = (
  geometry: ReadonlyMap<ChunkKey, ChunkGeometryDTO>,
  majorOnly: boolean,
): PathModel => {
  const chunks = [...geometry.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g)
  const sizes = chunks.map((g) => {
    let paths = 0
    let verts = 0
    for (let i = 0; i < g.edges.length; i += 1) {
      if (!keep(g.classes[i], majorOnly)) continue
      paths += 1
      verts += g.startIndices[i + 1] - g.startIndices[i]
    }
    return { paths, verts }
  })
  const pathCount = sizes.reduce((a, s) => a + s.paths, 0)
  const vertexCount = sizes.reduce((a, s) => a + s.verts, 0)
  if (pathCount === 0) return EMPTY_MODEL

  const positions = new Float32Array(vertexCount * 2)
  const startIndices = new Uint32Array(pathCount + 1)
  const edges = new Uint32Array(pathCount)
  const classes = new Uint8Array(pathCount)
  let p = 0
  let v = 0
  chunks.forEach((g) => {
    for (let i = 0; i < g.edges.length; i += 1) {
      if (!keep(g.classes[i], majorOnly)) continue
      const a = g.startIndices[i]
      const b = g.startIndices[i + 1]
      positions.set(g.positions.subarray(a * 2, b * 2), v * 2)
      startIndices[p] = v
      edges[p] = g.edges[i]
      classes[p] = g.classes[i]
      p += 1
      v += b - a
    }
  })
  startIndices[pathCount] = vertexCount
  return { positions, startIndices, edges, classes, pathCount, vertexCount }
}

// ------------------------------------------------------------------ colours

export type Rgb = readonly [number, number, number]

/** Green -> amber -> red over V/C in [0, 1.2], the usual LOS ramp. */
const VC_RAMP: readonly { readonly at: number; readonly rgb: Rgb }[] = [
  { at: 0.0, rgb: [56, 142, 96] },
  { at: 0.5, rgb: [140, 176, 70] },
  { at: 0.75, rgb: [227, 186, 60] },
  { at: 0.9, rgb: [232, 129, 47] },
  { at: 1.05, rgb: [214, 62, 51] },
  { at: 1.3, rgb: [140, 26, 60] },
]

/** Blue (relief) -> grey -> red (worse) over a signed V/C difference. */
const DIFF_RAMP: readonly { readonly at: number; readonly rgb: Rgb }[] = [
  { at: -0.3, rgb: [46, 122, 209] },
  { at: -0.05, rgb: [120, 150, 180] },
  { at: 0.0, rgb: [90, 96, 106] },
  { at: 0.05, rgb: [200, 140, 110] },
  { at: 0.3, rgb: [214, 62, 51] },
]

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

const sample = (ramp: readonly { readonly at: number; readonly rgb: Rgb }[], x: number): Rgb => {
  if (x <= ramp[0].at) return ramp[0].rgb
  const hit = ramp.findIndex((s) => x <= s.at)
  if (hit <= 0) return ramp[ramp.length - 1].rgb
  const lo = ramp[hit - 1]
  const hi = ramp[hit]
  const t = (x - lo.at) / (hi.at - lo.at)
  return [
    Math.round(lerp(lo.rgb[0], hi.rgb[0], t)),
    Math.round(lerp(lo.rgb[1], hi.rgb[1], t)),
    Math.round(lerp(lo.rgb[2], hi.rgb[2], t)),
  ]
}

export const vcColor = (vc: number): Rgb => sample(VC_RAMP, vc)
export const diffColor = (d: number): Rgb => sample(DIFF_RAMP, d)

const UNKNOWN: Rgb = [70, 76, 86]

/**
 * Per-vertex RGB for the whole model. This is the one buffer that re-uploads
 * per hour; `positions`/`startIndices` keep their identity so deck.gl leaves
 * them on the GPU.
 */
export const buildColors = (
  model: PathModel,
  order: EdgeOrder,
  values: Float32Array,
  signed: boolean,
): Uint8Array => {
  const colors = new Uint8Array(model.vertexCount * 3)
  for (let p = 0; p < model.pathCount; p += 1) {
    const ix = order.indexOf.get(model.edges[p] as EdgeId)
    const rgb =
      ix === undefined || ix >= values.length ? UNKNOWN : signed ? diffColor(values[ix]) : vcColor(values[ix])
    for (let v = model.startIndices[p]; v < model.startIndices[p + 1]; v += 1) {
      colors[v * 3] = rgb[0]
      colors[v * 3 + 1] = rgb[1]
      colors[v * 3 + 2] = rgb[2]
    }
  }
  return colors
}

/** Per-path metric lookup for the hover tooltip. */
export const pathClass = (model: PathModel, path: number): RoadClass => roadClass(model.classes[path])
