/**
 * Scenario persistence (DESIGN 7.3): `ScenarioDTO` -> CBOR -> base64url in the
 * URL hash, and named drafts in IndexedDB keyed by manifest hash.
 *
 * The codec is pure and total: a malformed hash yields `null`, never a throw,
 * because it arrives from whatever someone pasted into the address bar.
 */

import { decode as cborDecode, encode as cborEncode } from 'cbor-x'
import type { EdgeId, EditDTO, RouteId, ScenarioDTO } from '../sim/protocol'
import { EMPTY_SCENARIO, isEdgeEdit } from '../sim/protocol'
import type { ManifestHash } from '../graph/manifest'

export type ScenarioCode = string & { readonly __brand: 'ScenarioCode' }
export type DraftName = string & { readonly __brand: 'DraftName' }

const HASH_PREFIX = '#s='

// -------------------------------------------------------------- base64url

const toBase64Url = (bytes: Uint8Array): ScenarioCode => {
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join('')
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') as ScenarioCode
}

const fromBase64Url = (code: string): Uint8Array => {
  const padded = code.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(code.length / 4) * 4, '=')
  const bin = atob(padded)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

// ------------------------------------------------------------------ codec

/**
 * Edits are re-normalised on the way out so two scenarios that differ only in
 * edit order or in `undefined` fields encode to the same string.
 */
/**
 * What an edit is *about*: one edge, or one route. Two edits with the same
 * target cannot coexist — applying one replaces the other — and it doubles as
 * the canonical sort key, so edge edits sort before transit edits by id.
 */
const editTarget = (e: EditDTO): string =>
  isEdgeEdit(e) ? `0:${String(e.edge).padStart(12, '0')}` : `1:${e.route_id}`

const canonicalEdit = (e: EditDTO): EditDTO => {
  if (e.type === 'CloseEdge') return { type: 'CloseEdge', edge: e.edge }
  if (e.type === 'SetEdge')
    return {
      type: 'SetEdge',
      edge: e.edge,
      ...(e.lanes === undefined ? {} : { lanes: e.lanes }),
      ...(e.speed_mps === undefined ? {} : { speed_mps: e.speed_mps }),
      ...(e.capacity_vph === undefined ? {} : { capacity_vph: e.capacity_vph }),
    }
  return e.op === 'RemoveRoute'
    ? { type: 'TransitEdit', op: 'RemoveRoute', route_id: e.route_id }
    : { type: 'TransitEdit', op: 'AddPattern', route_id: e.route_id, stops: [...e.stops], headway_s: e.headway_s }
}

const canonical = (s: ScenarioDTO): ScenarioDTO => ({
  edits: [...s.edits].sort((a, b) => editTarget(a).localeCompare(editTarget(b))).map(canonicalEdit),
})

export const encodeScenario = (s: ScenarioDTO): ScenarioCode => toBase64Url(cborEncode(canonical(s)))

const isEdit = (v: unknown): boolean => {
  const e = v as { type?: unknown; edge?: unknown; route_id?: unknown }
  if (e?.type === 'TransitEdit') return typeof e.route_id === 'string'
  return (e?.type === 'CloseEdge' || e?.type === 'SetEdge') && typeof e.edge === 'number'
}

export const decodeScenario = (code: string): ScenarioDTO | null => {
  try {
    const value = cborDecode(fromBase64Url(code)) as { edits?: unknown }
    if (!Array.isArray(value?.edits) || !value.edits.every(isEdit)) return null
    return canonical({ edits: value.edits as ScenarioDTO['edits'] })
  } catch {
    return null
  }
}

// ------------------------------------------------------------------- hash

export const scenarioToHash = (s: ScenarioDTO): string => (s.edits.length === 0 ? '' : `${HASH_PREFIX}${encodeScenario(s)}`)

export const scenarioFromHash = (hash: string): ScenarioDTO =>
  hash.startsWith(HASH_PREFIX) ? (decodeScenario(hash.slice(HASH_PREFIX.length)) ?? EMPTY_SCENARIO) : EMPTY_SCENARIO

/** Replace, never push: scenario edits should not fill the back stack. */
export const writeHash = (s: ScenarioDTO): void => {
  const next = `${location.pathname}${location.search}${scenarioToHash(s)}`
  history.replaceState(null, '', next)
}

// ------------------------------------------------------------- IndexedDB

const draftKey = (manifest: ManifestHash, name: DraftName): string => `twin:draft:${manifest}:${name}`
const AUTOSAVE = 'autosave' as DraftName

/** `idb-keyval` is ~1 KB and lazy-loaded so it stays out of the shell. */
const idb = () => import('idb-keyval')

export const saveDraft = async (manifest: ManifestHash, s: ScenarioDTO, name: DraftName = AUTOSAVE): Promise<void> => {
  const { set } = await idb()
  await set(draftKey(manifest, name), encodeScenario(s)).catch(() => undefined)
}

export const loadDraft = async (manifest: ManifestHash, name: DraftName = AUTOSAVE): Promise<ScenarioDTO | null> => {
  const { get } = await idb()
  const code = await get<string>(draftKey(manifest, name)).catch(() => undefined)
  return code ? decodeScenario(code) : null
}

export const clearDraft = async (manifest: ManifestHash, name: DraftName = AUTOSAVE): Promise<void> => {
  const { del } = await idb()
  await del(draftKey(manifest, name)).catch(() => undefined)
}

// ------------------------------------------------------------------ edits

export const closeEdge = (edge: EdgeId): ScenarioDTO['edits'][number] => ({ type: 'CloseEdge', edge })

/** Applying an edit replaces any prior edit on the same edge. */
export const withEdit = (s: ScenarioDTO, edit: EditDTO): ScenarioDTO => ({
  edits: [...s.edits.filter((e) => editTarget(e) !== editTarget(edit)), edit],
})

export const withoutEdge = (s: ScenarioDTO, edge: EdgeId): ScenarioDTO => ({
  edits: s.edits.filter((e) => !isEdgeEdit(e) || e.edge !== edge),
})

/** Both the add and the remove for one route, so undoing a route is one step. */
export const withoutRoute = (s: ScenarioDTO, route: RouteId): ScenarioDTO => ({
  edits: s.edits.filter((e) => e.type !== 'TransitEdit' || e.route_id !== route),
})
