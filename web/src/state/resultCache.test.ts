import { describe, expect, it } from 'vitest'
import { edgeId, hour, runId, type HourResultDTO, type ResultKind } from '../sim/protocol'
import {
  coveredHours,
  dailyKpis,
  diffVc,
  edgeOrder,
  EMPTY_CACHE,
  getHour,
  isComplete,
  kpiDelta,
  putHour,
} from './resultCache'

const result = (h: number, vc: readonly number[], kind: ResultKind = 'baseline'): HourResultDTO => ({
  id: runId(1),
  kind,
  hour: hour(h),
  volume: Float32Array.from(vc, (v) => v * 1000),
  vc: Float32Array.from(vc),
  delay: Float32Array.from(vc, (v) => v * 10),
  kpis: { vmt: h * 100, vht: h * 4, meanDelayS: h / 2, topEdges: [{ edge: edgeId(h), vc: vc[0] }] },
})

describe('result cache', () => {
  it('starts empty and stays immutable on put', () => {
    const one = putHour(EMPTY_CACHE, result(8, [0.5]))
    expect(EMPTY_CACHE).toEqual({})
    expect(getHour(one, hour(8))?.vc[0]).toBeCloseTo(0.5)
    expect(getHour(one, hour(9))).toBeUndefined()
  })

  it('overwrites the same hour instead of accumulating', () => {
    const twice = putHour(putHour(EMPTY_CACHE, result(8, [0.5])), result(8, [0.9]))
    expect(coveredHours(twice)).toEqual([8])
    expect(getHour(twice, hour(8))?.vc[0]).toBeCloseTo(0.9)
  })

  it('reports coverage and completeness', () => {
    const partial = [3, 1, 2].reduce((c, h) => putHour(c, result(h, [0.1])), EMPTY_CACHE)
    expect(coveredHours(partial)).toEqual([1, 2, 3])
    expect(isComplete(partial)).toBe(false)
    const full = Array.from({ length: 24 }, (_, h) => h).reduce((c, h) => putHour(c, result(h, [0.1])), EMPTY_CACHE)
    expect(isComplete(full)).toBe(true)
  })

  it('diffs scenario minus baseline, clamped to the shorter run', () => {
    const base = result(8, [0.4, 0.8, 1.0])
    const scen = result(8, [0.1, 0.9], 'scenario')
    expect([...diffVc(base, scen)].map((v) => Number(v.toFixed(3)))).toEqual([-0.3, 0.1])
    expect(diffVc(undefined, scen)).toHaveLength(0)
  })

  it('deltas KPIs only when both sides exist', () => {
    const base = result(8, [0.5]).kpis
    const scen = result(9, [0.5]).kpis
    expect(kpiDelta(base, scen)).toEqual({ vmt: 100, vht: 4, meanDelayS: 0.5 })
    expect(kpiDelta(base, undefined)).toBeNull()
  })

  it('sums daily KPIs and takes corridors from the busiest hour', () => {
    const cache = [7, 8, 17].reduce((c, h) => putHour(c, result(h, [h / 20])), EMPTY_CACHE)
    const daily = dailyKpis(cache)
    expect(daily?.vmt).toBe((7 + 8 + 17) * 100)
    expect(daily?.topEdges[0].edge).toBe(17)
    expect(dailyKpis(EMPTY_CACHE)).toBeUndefined()
  })

  it('indexes the loaded edge order', () => {
    const order = edgeOrder(Uint32Array.of(11, 4, 9))
    expect(order.indexOf.get(edgeId(4))).toBe(1)
    expect(order.indexOf.get(edgeId(5))).toBeUndefined()
  })
})
