/**
 * Per-hour result cache for one track (baseline or scenario), plus the edge
 * order every result array is indexed by. Pure and immutable: the store just
 * swaps the value, and the whole thing is testable without a worker.
 */

import type { EdgeId, HourResultDTO, Hour, KpiDTO } from '../sim/protocol'

/** `loadedEdgeIds()`, plus the reverse map the overlay and the KPI table need. */
export type EdgeOrder = {
  readonly edges: Uint32Array
  readonly indexOf: ReadonlyMap<EdgeId, number>
}

export const EMPTY_ORDER: EdgeOrder = { edges: new Uint32Array(0), indexOf: new Map() }

export const edgeOrder = (edges: Uint32Array): EdgeOrder => ({
  edges,
  indexOf: new Map(Array.from(edges, (e, i) => [e as EdgeId, i] as const)),
})

export type ResultCache = Readonly<Partial<Record<Hour, HourResultDTO>>>

export const EMPTY_CACHE: ResultCache = {}

export const putHour = (cache: ResultCache, result: HourResultDTO): ResultCache => ({
  ...cache,
  [result.hour]: result,
})

export const getHour = (cache: ResultCache, h: Hour): HourResultDTO | undefined => cache[h]

/** Which hours are resident — drives the scrubber's "computed" ticks. */
export const coveredHours = (cache: ResultCache): readonly Hour[] =>
  Object.keys(cache)
    .map(Number)
    .sort((a, b) => a - b) as Hour[]

export const isComplete = (cache: ResultCache): boolean => coveredHours(cache).length === 24

/**
 * Scenario minus baseline, element-wise, for the diff overlay. Mismatched
 * lengths mean the study area changed under us: fall back to the shorter run
 * rather than reading past the end.
 */
export const diffVc = (baseline: HourResultDTO | undefined, scenario: HourResultDTO | undefined): Float32Array => {
  if (!baseline || !scenario) return new Float32Array(0)
  const n = Math.min(baseline.vc.length, scenario.vc.length)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += 1) out[i] = scenario.vc[i]! - baseline.vc[i]!
  return out
}

export type KpiDelta = {
  readonly vmt: number
  readonly vht: number
  readonly meanDelayS: number
}

export const kpiDelta = (baseline: KpiDTO | undefined, scenario: KpiDTO | undefined): KpiDelta | null =>
  baseline && scenario
    ? {
        vmt: scenario.vmt - baseline.vmt,
        vht: scenario.vht - baseline.vht,
        meanDelayS: scenario.meanDelayS - baseline.meanDelayS,
      }
    : null

/** Daily totals across whichever hours have landed. */
export const dailyKpis = (cache: ResultCache): KpiDTO | undefined => {
  const hours = coveredHours(cache)
  if (hours.length === 0) return undefined
  const parts = hours.map((h) => cache[h]!.kpis)
  // the busiest hour's corridors are the interesting ones, not a blend
  const peak = parts.reduce((best, k) => (k.vmt > best.vmt ? k : best), parts[0]!)
  return {
    vmt: parts.reduce((a, k) => a + k.vmt, 0),
    vht: parts.reduce((a, k) => a + k.vht, 0),
    meanDelayS: parts.reduce((a, k) => a + k.meanDelayS, 0) / parts.length,
    topEdges: peak.topEdges,
  }
}
