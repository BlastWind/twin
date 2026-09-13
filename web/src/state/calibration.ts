/**
 * Calibration statistics: modeled daily volume against observed AADT.
 *
 * R² here is about the 1:1 line, not about a fitted regression — the question
 * is whether the model reproduces the counts, not whether some rescaling of it
 * would. A best-fit R² can look excellent while the model is off by a factor of
 * two everywhere, which is exactly the failure this panel exists to catch.
 */

import type { CalibrationDTO } from '../sim/protocol'

export type CalibrationStatsDTO = {
  readonly n: number
  /** Coefficient of determination about y = x. Can go negative; that is real. */
  readonly r2: number
  /** Root mean square error, in vehicles/day. */
  readonly rmse: number
  /** Mean signed bias: positive means the model runs hot. */
  readonly bias: number
  readonly maxObserved: number
  readonly maxModeled: number
}

export const EMPTY_STATS: CalibrationStatsDTO = { n: 0, r2: Number.NaN, rmse: 0, bias: 0, maxObserved: 0, maxModeled: 0 }

/**
 * Stations the current study area can actually be scored against.
 *
 * `calibration()` returns every station in `counts.bin` — 6,889 county-wide —
 * but a station on a road outside the resident chunks has no modelled volume
 * at all, and scoring the model against a zero it was never asked to produce
 * would drag R² down for a reason that has nothing to do with the model. Those
 * rows are dropped and counted, not silently averaged in.
 */
export const scorableRows = (rows: readonly CalibrationDTO[]): readonly CalibrationDTO[] =>
  rows.filter((r) => r.modeledDaily > 0)

export const calibrationStats = (rows: readonly CalibrationDTO[]): CalibrationStatsDTO => {
  if (rows.length === 0) return EMPTY_STATS
  const mean = rows.reduce((n, r) => n + r.aadt, 0) / rows.length
  const ssRes = rows.reduce((n, r) => n + (r.modeledDaily - r.aadt) ** 2, 0)
  const ssTot = rows.reduce((n, r) => n + (r.aadt - mean) ** 2, 0)
  return {
    n: rows.length,
    r2: ssTot === 0 ? Number.NaN : 1 - ssRes / ssTot,
    rmse: Math.sqrt(ssRes / rows.length),
    bias: rows.reduce((n, r) => n + (r.modeledDaily - r.aadt), 0) / rows.length,
    maxObserved: rows.reduce((n, r) => Math.max(n, r.aadt), 0),
    maxModeled: rows.reduce((n, r) => Math.max(n, r.modeledDaily), 0),
  }
}

/** A round axis maximum at or above the data, so the 1:1 line ends on a tick. */
export const axisMax = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  return Math.ceil(value / (magnitude / 2)) * (magnitude / 2)
}
