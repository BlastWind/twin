/** Load stages instrumented with performance.mark (DESIGN 8). */
export type LoadStage =
  | 'app-start'
  | 'style-ready'
  | 'first-tile'
  | 'map-idle'
  | 'worker-start'
  | 'worker-ready'
  | 'manifest'
  | 'index'
  | 'chunks'
  | 'first-baseline'
  | 'overlay-ready'

export type StageTiming = { readonly stage: LoadStage; readonly atMs: number }

const seen = new Map<LoadStage, number>()

export const mark = (stage: LoadStage): number => {
  const existing = seen.get(stage)
  if (existing !== undefined) return existing
  performance.mark(`twin:${stage}`)
  const at = performance.now()
  seen.set(stage, at)
  ;(globalThis as { __twinMarks?: Record<string, number> }).__twinMarks = Object.fromEntries(seen)
  return at
}

export const timings = (): readonly StageTiming[] =>
  [...seen.entries()].map(([stage, atMs]) => ({ stage, atMs })).sort((a, b) => a.atMs - b.atMs)
