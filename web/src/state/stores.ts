import { create } from 'zustand'
import { defaultVisibility, type LayerId, type LayerVisibility } from '../map/layers'
import type { HourResultDTO, RunId, ScenarioDTO, StatsDTO, WorkerErrorDTO } from '../sim/protocol'
import type { Hour } from '../sim/protocol'

/** DESIGN 7.3 — four stores, one concern each. */

export type LoadState = 'idle' | 'loading' | 'ready' | 'error'

export type WorldState = {
  readonly manifestHash: string | null
  readonly load: LoadState
  readonly stats: StatsDTO | null
  readonly error: WorkerErrorDTO | null
  setManifestHash: (hash: string) => void
  setLoad: (load: LoadState) => void
  setStats: (stats: StatsDTO) => void
  setError: (error: WorkerErrorDTO | null) => void
}

export const useWorldStore = create<WorldState>((set) => ({
  manifestHash: null,
  load: 'idle',
  stats: null,
  error: null,
  setManifestHash: (manifestHash) => set({ manifestHash }),
  setLoad: (load) => set({ load }),
  setStats: (stats) => set({ stats, load: 'ready' }),
  setError: (error) => set({ error, load: error ? 'error' : 'ready' }),
}))

export const emptyScenario = (): ScenarioDTO => ({ edits: [] })

export type ScenarioState = {
  readonly scenario: ScenarioDTO
  readonly undo: readonly ScenarioDTO[]
  readonly dirty: boolean
  apply: (next: ScenarioDTO) => void
  undoLast: () => void
  reset: () => void
}

export const useScenarioStore = create<ScenarioState>((set) => ({
  scenario: emptyScenario(),
  undo: [],
  dirty: false,
  apply: (next) => set((s) => ({ scenario: next, undo: [...s.undo, s.scenario], dirty: true })),
  undoLast: () =>
    set((s) => {
      const prev = s.undo.at(-1)
      if (!prev) return s
      return { scenario: prev, undo: s.undo.slice(0, -1), dirty: s.undo.length > 1 }
    }),
  reset: () => set({ scenario: emptyScenario(), undo: [], dirty: false }),
}))

export type RunStatus = 'idle' | 'running' | 'done' | 'error'
export type ResultCache = Readonly<Record<Hour, HourResultDTO | undefined>>

export type SimState = {
  readonly baseline: ResultCache
  readonly scenario: ResultCache
  readonly status: RunStatus
  readonly runId: RunId | null
  putResult: (kind: 'baseline' | 'scenario', result: HourResultDTO) => void
  setStatus: (status: RunStatus, runId?: RunId) => void
}

export const useSimStore = create<SimState>((set) => ({
  baseline: {},
  scenario: {},
  status: 'idle',
  runId: null,
  putResult: (kind, result) => set((s) => ({ [kind]: { ...s[kind], [result.hour]: result } }) as Partial<SimState>),
  setStatus: (status, runId) => set(runId === undefined ? { status } : { status, runId }),
}))

export type UiState = {
  readonly hour: Hour
  readonly layers: LayerVisibility
  readonly devOverlay: boolean
  setHour: (hour: Hour) => void
  toggleLayer: (id: LayerId) => void
  toggleDevOverlay: () => void
}

export const useUiStore = create<UiState>((set) => ({
  hour: 8 as Hour,
  layers: defaultVisibility(),
  devOverlay: true,
  setHour: (hour) => set({ hour }),
  toggleLayer: (id) => set((s) => ({ layers: { ...s.layers, [id]: !s.layers[id] } })),
  toggleDevOverlay: () => set((s) => ({ devOverlay: !s.devOverlay })),
}))
