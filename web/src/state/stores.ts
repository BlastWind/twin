import { create } from 'zustand'
import { defaultVisibility, type LayerId, type LayerVisibility } from '../map/layers'
import type { ChunkGeometryDTO, ChunkKey, EdgeId, HourResultDTO, Hour, ResultKind, ScenarioDTO, StatsDTO, WorkerErrorDTO } from '../sim/protocol'
import { EMPTY_SCENARIO } from '../sim/protocol'
import type { ManifestDTO, StudyArea } from '../graph/manifest'
import { DEFAULT_STUDY_AREA } from '../graph/manifest'
import type { ChunkEntrySchema } from '../graph/schema'
import { EMPTY_CACHE, EMPTY_ORDER, edgeOrder, putHour, type EdgeOrder, type ResultCache } from './resultCache'

/** DESIGN 7.3 — four stores, one concern each. */

export type LoadState = 'idle' | 'loading' | 'ready' | 'error'

export type WorldState = {
  readonly manifest: ManifestDTO | null
  /** index.bin's chunk table: per-cell node/edge counts, for costing an area. */
  readonly index: readonly ChunkEntrySchema[] | null
  readonly load: LoadState
  readonly stats: StatsDTO | null
  readonly error: WorkerErrorDTO | null
  /** chunk geometry resident on the main thread, keyed by cell */
  readonly geometry: ReadonlyMap<ChunkKey, ChunkGeometryDTO>
  readonly order: EdgeOrder
  setManifest: (m: ManifestDTO) => void
  setIndex: (chunks: readonly ChunkEntrySchema[]) => void
  setLoad: (load: LoadState) => void
  setStats: (stats: StatsDTO) => void
  setError: (error: WorkerErrorDTO | null) => void
  putGeometry: (g: ChunkGeometryDTO) => void
  dropGeometry: (chunks: readonly ChunkKey[]) => void
  setOrder: (edges: Uint32Array) => void
}

export const useWorldStore = create<WorldState>((set) => ({
  manifest: null,
  index: null,
  load: 'idle',
  stats: null,
  error: null,
  geometry: new Map(),
  order: EMPTY_ORDER,
  setManifest: (manifest) => set({ manifest }),
  setIndex: (index) => set({ index }),
  setLoad: (load) => set({ load }),
  setStats: (stats) => set({ stats, load: 'ready' }),
  setError: (error) => set({ error, load: error ? 'error' : 'ready' }),
  putGeometry: (g) => set((s) => ({ geometry: new Map(s.geometry).set(g.chunk, g) })),
  dropGeometry: (chunks) =>
    set((s) => {
      const next = new Map(s.geometry)
      chunks.forEach((c) => next.delete(c))
      return { geometry: next }
    }),
  setOrder: (edges) => set({ order: edgeOrder(edges) }),
}))

// ------------------------------------------------------------------ scenario

export type ScenarioState = {
  readonly scenario: ScenarioDTO
  readonly undo: readonly ScenarioDTO[]
  readonly dirty: boolean
  apply: (next: ScenarioDTO) => void
  /** Replace without pushing history — used when restoring from the URL hash. */
  restore: (next: ScenarioDTO) => void
  undoLast: () => void
  reset: () => void
}

export const useScenarioStore = create<ScenarioState>((set) => ({
  scenario: EMPTY_SCENARIO,
  undo: [],
  dirty: false,
  apply: (next) => set((s) => ({ scenario: next, undo: [...s.undo, s.scenario], dirty: true })),
  restore: (next) => set({ scenario: next, undo: [], dirty: next.edits.length > 0 }),
  undoLast: () =>
    set((s) => {
      const prev = s.undo.at(-1)
      if (!prev) return s
      return { scenario: prev, undo: s.undo.slice(0, -1), dirty: s.undo.length > 1 }
    }),
  reset: () => set({ scenario: EMPTY_SCENARIO, undo: [], dirty: false }),
}))

// ----------------------------------------------------------------------- sim

export type RunStatus = 'idle' | 'running' | 'done' | 'error'

export type SimState = {
  readonly baseline: ResultCache
  readonly scenario: ResultCache
  readonly status: RunStatus
  readonly runningKind: ResultKind | null
  putResult: (result: HourResultDTO) => void
  setStatus: (status: RunStatus, kind?: ResultKind | null) => void
  clear: (kind: ResultKind) => void
}

export const useSimStore = create<SimState>((set) => ({
  baseline: EMPTY_CACHE,
  scenario: EMPTY_CACHE,
  status: 'idle',
  runningKind: null,
  putResult: (result) => set((s) => ({ [result.kind]: putHour(s[result.kind], result) }) as Partial<SimState>),
  setStatus: (status, kind) => set(kind === undefined ? { status } : { status, runningKind: kind }),
  clear: (kind) => set({ [kind]: EMPTY_CACHE } as Partial<SimState>),
}))

// ------------------------------------------------------------------------ ui

/** What the overlay paints: one track, or the signed difference. */
export type ViewMode = 'baseline' | 'scenario' | 'diff'

export type HoverInfo = {
  readonly edge: EdgeId
  readonly classByte: number
  readonly x: number
  readonly y: number
}

export type UiState = {
  readonly hour: Hour
  readonly playing: boolean
  readonly mode: ViewMode
  readonly layers: LayerVisibility
  readonly overlay: boolean
  readonly devOverlay: boolean
  readonly studyArea: StudyArea
  readonly drawing: boolean
  readonly hover: HoverInfo | null
  readonly selected: EdgeId | null
  setHour: (hour: Hour) => void
  setPlaying: (playing: boolean) => void
  setMode: (mode: ViewMode) => void
  toggleLayer: (id: LayerId) => void
  toggleOverlay: () => void
  toggleDevOverlay: () => void
  setStudyArea: (area: StudyArea) => void
  setDrawing: (drawing: boolean) => void
  setHover: (hover: HoverInfo | null) => void
  select: (edge: EdgeId | null) => void
}

export const useUiStore = create<UiState>((set) => ({
  hour: 8 as Hour,
  playing: false,
  mode: 'baseline',
  layers: defaultVisibility(),
  overlay: true,
  devOverlay: true,
  studyArea: DEFAULT_STUDY_AREA,
  drawing: false,
  hover: null,
  selected: null,
  setHour: (hour) => set({ hour }),
  setPlaying: (playing) => set({ playing }),
  setMode: (mode) => set({ mode }),
  toggleLayer: (id) => set((s) => ({ layers: { ...s.layers, [id]: !s.layers[id] } })),
  toggleOverlay: () => set((s) => ({ overlay: !s.overlay })),
  toggleDevOverlay: () => set((s) => ({ devOverlay: !s.devOverlay })),
  setStudyArea: (studyArea) => set({ studyArea }),
  setDrawing: (drawing) => set({ drawing }),
  setHover: (hover) => set({ hover }),
  select: (selected) => set({ selected, hover: null }),
}))
