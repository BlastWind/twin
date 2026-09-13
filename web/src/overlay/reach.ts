/**
 * Isochrone geometry: reachable nodes -> one contour per time band.
 *
 * A convex hull per band is coarse — it bridges water, parkland and anything
 * else the network does not cross — but it is honest about being a summary and
 * costs one O(n log n) pass, which matters because the whole thing is recomputed
 * every time the hour changes. The point cloud stays available underneath it.
 */

import type { ReachResultDTO } from '../sim/protocol'

export type Minutes = number & { readonly __brand: 'Minutes' }
export type Ring = readonly (readonly [lon: number, lat: number])[]

export type ReachBand = {
  readonly maxMinutes: Minutes
  readonly count: number
  readonly ring: Ring
}

/** Bands are cumulative: the 30-minute contour contains the 15-minute one. */
export const bandsOf = (result: ReachResultDTO, edges: readonly number[]): readonly ReachBand[] => {
  const n = result.pairs.length / 2
  return edges
    .map((minutes) => {
      const points: (readonly [number, number])[] = []
      for (let i = 0; i < n; i += 1) {
        const lon = result.positions[i * 2]!
        const lat = result.positions[i * 2 + 1]!
        if (result.pairs[i * 2 + 1]! <= minutes * 60 && Number.isFinite(lon) && Number.isFinite(lat)) {
          points.push([lon, lat])
        }
      }
      return { maxMinutes: minutes as Minutes, count: points.length, ring: convexHull(points) }
    })
    .filter((b) => b.ring.length >= 3)
}

/** Andrew's monotone chain. Returns a closed ring in counter-clockwise order. */
export const convexHull = (points: readonly (readonly [number, number])[]): Ring => {
  if (points.length < 3) return []
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

  const half = (pts: readonly (readonly [number, number])[]): (readonly [number, number])[] =>
    pts.reduce<(readonly [number, number])[]>((acc, p) => {
      while (acc.length >= 2 && cross(acc[acc.length - 2]!, acc[acc.length - 1]!, p) <= 0) acc.pop()
      return [...acc, p]
    }, [])

  const lower = half(sorted)
  const upper = half([...sorted].reverse())
  const ring = [...lower.slice(0, -1), ...upper.slice(0, -1)]
  return ring.length >= 3 ? [...ring, ring[0]!] : []
}

/**
 * One hue, light -> dark with time: the bands are a magnitude, not four
 * categories. RGBA, because deck.gl wants channels not hex.
 */
export type Rgba = readonly [number, number, number, number]

const BAND_RAMP: readonly Rgba[] = [
  [205, 226, 251, 255],
  [134, 182, 239, 255],
  [57, 135, 229, 255],
  [24, 79, 149, 255],
]

export const bandColor = (index: number, alpha: number): Rgba => {
  const [r, g, b] = BAND_RAMP[Math.min(index, BAND_RAMP.length - 1)]!
  return [r, g, b, alpha]
}
