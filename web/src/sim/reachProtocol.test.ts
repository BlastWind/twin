import { describe, expect, it } from 'vitest'
import {
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
  editedEdges,
  edgeId,
  hour,
  isEdgeEdit,
  transferBytes,
  transitEdits,
  type IsochroneRequestDTO,
  type NodeId,
  type ReachResultDTO,
  type RouteId,
  type ScenarioDTO,
} from './protocol'
import { createNodeIndex } from './nodeIndex'
import { bandsOf, convexHull } from '../overlay/reach'
import { axisMax, calibrationStats } from '../state/calibration'
import { encodeScenario, decodeScenario, withEdit, withoutRoute } from '../scenario/codec'

const request: IsochroneRequestDTO = { lon: -77.3, lat: 38.85, hour: hour(8), budgetMin: 45 }

const reach = (pairs: readonly number[], positions: readonly number[]): ReachResultDTO => ({
  request,
  pairs: Float32Array.from(pairs),
  positions: Float32Array.from(positions),
  summary: { nodes: pairs.length / 2, population: 1234 },
})

describe('transit and reach requests', () => {
  it('transfers the isochrone buffers rather than copying them', () => {
    const res = reach([1, 60, 2, 120], [-77.3, 38.85, -77.31, 38.86])
    const { transfer } = encodeResponse({ type: 'reach', seq: 1, payload: res })
    expect(transfer).toHaveLength(2)
    expect(transferBytes(transfer)).toBe(res.pairs.byteLength + res.positions.byteLength)
  })

  it('transfers transit and counts blobs', () => {
    const bytes = new ArrayBuffer(64)
    const { transfer } = encodeRequest({ type: 'load-transit', seq: 1, payload: { bytes } })
    expect(transferBytes(transfer)).toBe(64)
  })

  it('round-trips the new request and response tags', () => {
    const req = encodeRequest({ type: 'isochrone', seq: 3, payload: request })
    expect(decodeRequest(req.message)).toEqual({ type: 'isochrone', seq: 3, payload: request })
    const res = encodeResponse({ type: 'calibration', seq: 4, payload: { rows: [] } })
    expect(decodeResponse(res.message).type).toBe('calibration')
  })

  it('rejects a tag that is not in the protocol', () => {
    expect(() => decodeRequest({ type: 'isochrone!', seq: 1, payload: {} })).toThrow(TypeError)
  })
})

describe('scenario with transit edits', () => {
  const route = 'route-1a' as RouteId
  const pattern = {
    type: 'TransitEdit' as const,
    op: 'AddPattern' as const,
    route_id: route,
    stops: [1, 2, 3] as unknown as readonly NodeId[],
    headway_s: 900,
  }

  it('keeps edge and transit edits apart', () => {
    const s: ScenarioDTO = withEdit({ edits: [{ type: 'CloseEdge', edge: edgeId(7) }] }, pattern)
    expect([...editedEdges(s)]).toEqual([7])
    expect(transitEdits(s)).toHaveLength(1)
    expect(s.edits.filter(isEdgeEdit)).toHaveLength(1)
  })

  it('survives the CBOR hash round-trip', () => {
    const s = withEdit({ edits: [{ type: 'CloseEdge', edge: edgeId(7) }] }, pattern)
    expect(decodeScenario(encodeScenario(s))).toEqual(s)
  })

  it('encodes to the same code whatever order the edits arrive in', () => {
    const a = withEdit({ edits: [{ type: 'CloseEdge', edge: edgeId(7) }] }, pattern)
    const b = withEdit({ edits: [pattern] }, { type: 'CloseEdge', edge: edgeId(7) })
    expect(encodeScenario(a)).toBe(encodeScenario(b))
  })

  it('replaces a route rather than stacking edits on it', () => {
    const once = withEdit({ edits: [] }, pattern)
    const twice = withEdit(once, { type: 'TransitEdit', op: 'RemoveRoute', route_id: route })
    expect(twice.edits).toHaveLength(1)
    expect(withoutRoute(twice, route).edits).toHaveLength(0)
  })
})

describe('node index', () => {
  const chunk = { nodeGid: Uint32Array.of(10, 11), nodeLonLat: Float32Array.of(-77.3, 38.85, -77.2, 38.9) }

  it('resolves ids and finds the nearest node, and forgets a dropped chunk', () => {
    const index = createNodeIndex()
    index.put('0_0' as never, chunk as never)
    expect(index.size()).toBe(2)
    expect(index.positionOf(11 as never)?.[0]).toBeCloseTo(-77.2, 4)
    expect(index.nearest(-77.29, 38.851)).toBe(10)
    index.drop('0_0' as never)
    expect(index.size()).toBe(0)
    expect(index.nearest(0, 0)).toBeNull()
  })
})

describe('reach bands', () => {
  it('nests the bands and drops ones with too few points for a ring', () => {
    const result = reach(
      [1, 60, 2, 120, 3, 1800, 4, 1810, 5, 1820],
      [-77.3, 38.85, -77.29, 38.85, -77.28, 38.9, -77.32, 38.88, -77.26, 38.82],
    )
    const bands = bandsOf(result, [15, 30])
    expect(bands.map((b) => b.maxMinutes)).toEqual([30])
    // 1810 s and 1820 s fall outside the 30-minute budget
    expect(bands[0]!.count).toBe(3)
  })

  it('returns a closed ring and ignores collinear points', () => {
    const ring = convexHull([
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [1, 1],
    ])
    expect(ring[0]).toEqual(ring[ring.length - 1])
    expect(ring).toHaveLength(5)
  })

  it('has no hull for fewer than three points', () => {
    expect(convexHull([[0, 0], [1, 1]])).toEqual([])
  })
})

describe('calibration stats', () => {
  const rows = [1, 2, 3, 4].map((i) => ({
    stationId: i,
    edge: edgeId(i),
    aadt: i * 1000,
    modeledDaily: i * 1000,
  }))

  it('scores a perfect model 1 with no bias', () => {
    const s = calibrationStats(rows)
    expect(s.r2).toBeCloseTo(1, 12)
    expect(s.rmse).toBeCloseTo(0, 12)
    expect(s.bias).toBeCloseTo(0, 12)
  })

  it('reports a hot model as positive bias and can go negative on R²', () => {
    const hot = rows.map((r) => ({ ...r, modeledDaily: r.aadt * 3 }))
    const s = calibrationStats(hot)
    expect(s.bias).toBeGreaterThan(0)
    expect(s.r2).toBeLessThan(0)
  })

  it('is total on no rows', () => {
    expect(calibrationStats([]).n).toBe(0)
    expect(axisMax(0)).toBe(1)
    expect(axisMax(42_000)).toBeGreaterThanOrEqual(42_000)
  })
})
