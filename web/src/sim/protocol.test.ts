import { describe, expect, it } from 'vitest'
import {
  decodeRequest,
  decodeResponse,
  edgeId,
  editedEdges,
  encodeRequest,
  encodeResponse,
  hour,
  runId,
  transferBytes,
  type HourResultDTO,
} from './protocol'

describe('protocol codec', () => {
  it('rejects out-of-range hours', () => {
    expect(() => hour(24)).toThrow(RangeError)
    expect(hour(23)).toBe(23)
  })

  it('round-trips a run request with no transferables', () => {
    const req = {
      type: 'run',
      seq: 1,
      payload: { id: runId(7), kind: 'baseline', scenario: { edits: [] }, hours: [hour(8)] },
    } as const
    const { message, transfer } = encodeRequest(req)
    expect(transfer).toHaveLength(0)
    expect(decodeRequest(message)).toEqual(req)
  })

  it('lists chunk bytes as transferable and counts their size', () => {
    const bytes = new ArrayBuffer(64)
    const { transfer } = encodeRequest({
      type: 'load-chunk',
      seq: 2,
      payload: { chunk: '1_2' as never, chunkIx: 5, bytes },
    })
    expect(transfer).toEqual([bytes])
    expect(transferBytes(transfer)).toBe(64)
  })

  it('transfers all three result arrays', () => {
    const payload: HourResultDTO = {
      id: runId(1),
      kind: 'baseline',
      hour: hour(8),
      volume: new Float32Array(4),
      vc: new Float32Array(4),
      delay: new Float32Array(4),
      kpis: { vmt: 1, vht: 2, meanDelayS: 3, topEdges: [] },
    }
    const { transfer } = encodeResponse({ type: 'hour-result', seq: 3, payload })
    expect(transfer).toHaveLength(3)
    expect(transferBytes(transfer)).toBe(3 * 16)
  })

  it('transfers the four geometry buffers', () => {
    const { transfer } = encodeResponse({
      type: 'chunk-geometry',
      seq: 4,
      payload: {
        chunk: '0_0' as never,
        edges: new Uint32Array(2),
        classes: new Uint8Array(2),
        positions: new Float32Array(8),
        startIndices: new Uint32Array(3),
      },
    })
    expect(transfer).toHaveLength(4)
  })

  it('collects the edges a scenario touches', () => {
    const edges = editedEdges({
      edits: [
        { type: 'CloseEdge', edge: edgeId(3) },
        { type: 'SetEdge', edge: edgeId(9), lanes: 4 },
      ],
    })
    expect([...edges]).toEqual([3, 9])
  })

  it('rejects malformed messages', () => {
    expect(() => decodeRequest({ type: 'nope', seq: 1, payload: {} })).toThrow(TypeError)
    expect(() => decodeResponse(null)).toThrow(TypeError)
  })
})
