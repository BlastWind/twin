/**
 * Fly to an edge by id, using the chunk geometry the overlay already holds.
 *
 * Both the top-corridor table and the calibration scatter need it, and neither
 * has a position — only an edge id — so the lookup lives here rather than in
 * whichever panel needed it first.
 */

import type { ChunkGeometryDTO, ChunkKey, EdgeId } from '../sim/protocol'
import { getMap } from './mapRef'

export type GeometryIndex = ReadonlyMap<ChunkKey, ChunkGeometryDTO>

/** Midpoint vertex of the edge's polyline, or null if it is not resident. */
export const edgeCenter = (geometry: GeometryIndex, edge: EdgeId): readonly [number, number] | null => {
  for (const g of geometry.values()) {
    const i = g.edges.indexOf(edge)
    if (i < 0) continue
    const mid = Math.floor((g.startIndices[i]! + g.startIndices[i + 1]!) / 2)
    return [g.positions[mid * 2]!, g.positions[mid * 2 + 1]!]
  }
  return null
}

export const EDGE_ZOOM = 15

export const flyToEdge = (geometry: GeometryIndex, edge: EdgeId): void => {
  const center = edgeCenter(geometry, edge)
  if (center) getMap()?.flyTo({ center: [center[0], center[1]], zoom: EDGE_ZOOM, duration: 900 })
}
