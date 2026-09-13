/**
 * Node id -> position, assembled in the worker from the chunks it already
 * decodes.
 *
 * The isochrone contract returns `[node_id, seconds]` pairs and nothing else,
 * so somebody has to turn ids into coordinates. The worker is the only place
 * that ever sees the node tables, and it drops them with the chunk, so the map
 * stays exactly as big as the resident study area.
 */

import type { GraphChunkSchema } from '../graph/schema'
import type { ChunkKey } from '../graph/manifest'

export type NodeId = number & { readonly __brand: 'NodeId' }
export type LonLat = readonly [lon: number, lat: number]

export type NodeIndex = {
  readonly put: (chunk: ChunkKey, decoded: GraphChunkSchema) => void
  readonly drop: (chunk: ChunkKey) => void
  readonly size: () => number
  readonly positionOf: (node: NodeId) => LonLat | null
  /** Nearest resident node to a clicked point, by squared degrees. */
  readonly nearest: (lon: number, lat: number) => NodeId | null
  /** `[lon, lat, …]` parallel to `nodes`, for a whole-graph sweep. */
  readonly snapshot: () => { readonly nodes: Uint32Array; readonly lonLat: Float32Array }
}

type Cell = { readonly nodes: Uint32Array; readonly lonLat: Float32Array }

export const createNodeIndex = (): NodeIndex => {
  const cells = new Map<ChunkKey, Cell>()
  /** rebuilt lazily: chunk loads arrive in bursts of hundreds. */
  let flat: { nodes: Uint32Array; lonLat: Float32Array } | null = null
  let byId: Map<number, number> | null = null

  const rebuild = (): { nodes: Uint32Array; lonLat: Float32Array } => {
    if (flat) return flat
    const total = [...cells.values()].reduce((n, c) => n + c.nodes.length, 0)
    const nodes = new Uint32Array(total)
    const lonLat = new Float32Array(total * 2)
    let at = 0
    cells.forEach((c) => {
      nodes.set(c.nodes, at)
      lonLat.set(c.lonLat, at * 2)
      at += c.nodes.length
    })
    flat = { nodes, lonLat }
    byId = null
    return flat
  }

  const index = (): Map<number, number> => {
    if (byId) return byId
    const { nodes } = rebuild()
    byId = new Map(Array.from(nodes, (gid, i) => [gid, i]))
    return byId
  }

  return {
    put: (chunk, decoded) => {
      // ghost nodes repeat their owner's gid; keeping the first wins is fine,
      // the position is identical either way.
      cells.set(chunk, { nodes: decoded.nodeGid.slice(), lonLat: decoded.nodeLonLat.slice() })
      flat = null
      byId = null
    },
    drop: (chunk) => {
      if (cells.delete(chunk)) {
        flat = null
        byId = null
      }
    },
    size: () => rebuild().nodes.length,
    positionOf: (node) => {
      const i = index().get(node)
      if (i === undefined) return null
      const { lonLat } = rebuild()
      return [lonLat[i * 2]!, lonLat[i * 2 + 1]!]
    },
    nearest: (lon, lat) => {
      const { nodes, lonLat } = rebuild()
      if (nodes.length === 0) return null
      // latitude-corrected so "nearest" is not skewed at 39°N
      const kx = Math.cos((lat * Math.PI) / 180)
      let best = -1
      let bestD = Number.POSITIVE_INFINITY
      for (let i = 0; i < nodes.length; i += 1) {
        const dx = (lonLat[i * 2]! - lon) * kx
        const dy = lonLat[i * 2 + 1]! - lat
        const d = dx * dx + dy * dy
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      return best < 0 ? null : (nodes[best]! as NodeId)
    },
    snapshot: rebuild,
  }
}
