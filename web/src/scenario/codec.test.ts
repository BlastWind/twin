import { describe, expect, it } from 'vitest'
import { edgeId, type ScenarioDTO } from '../sim/protocol'
import {
  closeEdge,
  decodeScenario,
  encodeScenario,
  scenarioFromHash,
  scenarioToHash,
  withEdit,
  withoutEdge,
} from './codec'

const sample: ScenarioDTO = {
  edits: [
    { type: 'CloseEdge', edge: edgeId(42) },
    { type: 'SetEdge', edge: edgeId(7), lanes: 3, capacity_vph: 2400 },
  ],
}

describe('scenario codec', () => {
  it('round-trips through CBOR + base64url', () => {
    const code = encodeScenario(sample)
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeScenario(code)).toEqual({
      edits: [
        { type: 'SetEdge', edge: 7, lanes: 3, capacity_vph: 2400 },
        { type: 'CloseEdge', edge: 42 },
      ],
    })
  })

  it('is canonical: edit order and absent fields do not change the code', () => {
    const reordered: ScenarioDTO = { edits: [sample.edits[1], sample.edits[0]] }
    expect(encodeScenario(reordered)).toBe(encodeScenario(sample))
    const withUndefined: ScenarioDTO = { edits: [{ type: 'SetEdge', edge: edgeId(7), lanes: 3, capacity_vph: 2400, speed_mps: undefined }] }
    expect(encodeScenario(withUndefined)).toBe(encodeScenario({ edits: [{ type: 'SetEdge', edge: edgeId(7), lanes: 3, capacity_vph: 2400 }] }))
  })

  it('round-trips through the URL hash', () => {
    expect(scenarioFromHash(scenarioToHash(sample))).toEqual(decodeScenario(encodeScenario(sample)))
    expect(scenarioToHash({ edits: [] })).toBe('')
    expect(scenarioFromHash('')).toEqual({ edits: [] })
  })

  it('returns null rather than throwing on garbage', () => {
    expect(decodeScenario('not-cbor!!')).toBeNull()
    expect(decodeScenario('')).toBeNull()
    expect(scenarioFromHash('#s=@@@@')).toEqual({ edits: [] })
  })

  it('rejects a payload whose edits are not edits', () => {
    const code = encodeScenario({ edits: [] })
    expect(decodeScenario(code)).toEqual({ edits: [] })
    // a well-formed CBOR object with a bad edit must not slip through
    const bad = encodeScenario({ edits: [{ type: 'Nope', edge: 1 } as never] })
    expect(decodeScenario(bad)).toBeNull()
  })

  it('replaces, rather than stacks, edits on the same edge', () => {
    const once = withEdit({ edits: [] }, closeEdge(edgeId(9)))
    const twice = withEdit(once, { type: 'SetEdge', edge: edgeId(9), lanes: 1 })
    expect(twice.edits).toHaveLength(1)
    expect(twice.edits[0].type).toBe('SetEdge')
    expect(withoutEdge(twice, edgeId(9)).edits).toHaveLength(0)
  })
})
