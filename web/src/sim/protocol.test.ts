import { describe, expect, it } from 'vitest'
import { decodeRequest, decodeResponse, encodeRequest, encodeResponse, hour, runId, type HourResultDTO } from './protocol'

describe('protocol codec', () => {
  it('rejects out-of-range hours', () => {
    expect(() => hour(24)).toThrow(RangeError)
    expect(hour(23)).toBe(23)
  })

  it('round-trips a run request with no transferables', () => {
    const req = { type: 'run', seq: 1, payload: { id: runId(7), scenario: { edits: [] }, hours: [hour(8)] } } as const
    const { message, transfer } = encodeRequest(req)
    expect(transfer).toHaveLength(0)
    expect(decodeRequest(message)).toEqual(req)
  })

  it('lists chunk bytes as transferable', () => {
    const bytes = new ArrayBuffer(64)
    const { transfer } = encodeRequest({ type: 'load-chunk', seq: 2, payload: { chunk: '1_2' as never, bytes } })
    expect(transfer).toEqual([bytes])
  })

  it('transfers all three result arrays', () => {
    const payload: HourResultDTO = {
      id: runId(1),
      hour: hour(8),
      volume: new Float32Array(4),
      vc: new Float32Array(4),
      delay: new Float32Array(4),
      kpis: { vmt: 1, vht: 2, meanDelayS: 3, maxVc: 4 },
    }
    const { transfer } = encodeResponse({ type: 'hour-result', seq: 3, payload })
    expect(transfer).toHaveLength(3)
  })

  it('rejects malformed messages', () => {
    expect(() => decodeRequest({ type: 'nope', seq: 1, payload: {} })).toThrow(TypeError)
    expect(() => decodeResponse(null)).toThrow(TypeError)
  })
})
