/**
 * Viewport summaries over the rendered tiles.
 *
 * These read what MapLibre has already drawn (`queryRenderedFeatures`) rather
 * than re-fetching or decoding anything: the numbers are then exactly what is
 * on screen, which is what "for the current viewport" means in DESIGN 7.4. The
 * summarising half is pure so it can be tested without a map.
 */

import { zoneCategory, type LayerId, type ZoneCategory } from './layers'
import type { MapHandle } from './mapRef'

/** A rendered vector feature, narrowed to the part a summary reads. */
export type TileFeatureDTO = { readonly properties: Readonly<Record<string, unknown>> }

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

// ------------------------------------------------------------------ crashes

export type Severity = 1 | 2 | 3 | 4 | 5
export const SEVERITIES: readonly Severity[] = [1, 2, 3, 4, 5]

/** VDOT's KABCO, most severe first where it is shown to a reader. */
export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  5: 'Fatal',
  4: 'Serious injury',
  3: 'Minor injury',
  2: 'Possible injury',
  1: 'Property damage',
}

export type CrashSummaryDTO = {
  readonly total: number
  readonly bySeverity: Readonly<Record<Severity, number>>
  /** Populated only where the crash tiles carry the pipeline's nearest `edge_id`. */
  readonly topEdges: readonly { readonly edge: number; readonly crashes: number }[]
}

const EMPTY_SEVERITIES = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>

const clampSeverity = (v: unknown): Severity => {
  const n = Math.round(num(v))
  return (n >= 1 && n <= 5 ? n : 1) as Severity
}

export const TOP_EDGES = 5

export const crashSummary = (features: readonly TileFeatureDTO[]): CrashSummaryDTO => {
  const bySeverity = { ...EMPTY_SEVERITIES }
  const byEdge = new Map<number, number>()
  features.forEach((f) => {
    // a grid cell stands for `count` crashes; a point stands for one
    const weight = Math.max(1, Math.round(num(f.properties.count)))
    bySeverity[clampSeverity(f.properties.severity)] += weight
    const edge = f.properties.edge_id
    if (edge !== undefined && edge !== null) byEdge.set(num(edge), (byEdge.get(num(edge)) ?? 0) + weight)
  })
  return {
    total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0),
    bySeverity,
    topEdges: [...byEdge]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_EDGES)
      .map(([edge, crashes]) => ({ edge, crashes })),
  }
}

// ----------------------------------------------------------------- land use

export type ZoneRollupDTO = {
  readonly category: ZoneCategory
  readonly parcels: number
  readonly areaM2: number
  readonly assessedValue: number
}

export type LandUseSummaryDTO = {
  readonly parcels: number
  readonly areaM2: number
  readonly assessedValue: number
  readonly byCategory: readonly ZoneRollupDTO[]
}

/**
 * Parcels are deduplicated by `parcel_id`: one parcel straddling a tile
 * boundary comes back once per tile, and counting it twice would inflate both
 * the area and the assessed value.
 */
export const landUseSummary = (features: readonly TileFeatureDTO[]): LandUseSummaryDTO => {
  const seen = new Map<string, TileFeatureDTO>()
  features.forEach((f, i) => {
    const id = str(f.properties.parcel_id) ?? `#${i}`
    if (!seen.has(id)) seen.set(id, f)
  })
  const rollup = new Map<ZoneCategory, { parcels: number; areaM2: number; assessedValue: number }>()
  seen.forEach((f) => {
    const category = zoneCategory(str(f.properties.category) ?? str(f.properties.zone))
    const acc = rollup.get(category) ?? { parcels: 0, areaM2: 0, assessedValue: 0 }
    rollup.set(category, {
      parcels: acc.parcels + 1,
      areaM2: acc.areaM2 + num(f.properties.area_m2),
      assessedValue: acc.assessedValue + num(f.properties.assessed_value),
    })
  })
  const byCategory = [...rollup]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.assessedValue - a.assessedValue || b.parcels - a.parcels)
  return {
    parcels: seen.size,
    areaM2: byCategory.reduce((n, c) => n + c.areaM2, 0),
    assessedValue: byCategory.reduce((n, c) => n + c.assessedValue, 0),
    byCategory,
  }
}

// -------------------------------------------------------------------- parcel

/** One parcel, as the click popup shows it. */
export type ParcelDTO = {
  readonly parcelId: string
  readonly zone: string | null
  readonly category: ZoneCategory
  readonly landUse: string | null
  readonly assessedValue: number
  readonly areaM2: number
}

export const parcelOf = (f: TileFeatureDTO): ParcelDTO => ({
  parcelId: str(f.properties.parcel_id) ?? '(unknown)',
  zone: str(f.properties.zone),
  category: zoneCategory(str(f.properties.category) ?? str(f.properties.zone)),
  landUse: str(f.properties.land_use),
  assessedValue: num(f.properties.assessed_value),
  areaM2: num(f.properties.area_m2),
})

// --------------------------------------------------------------- map access

/** Impure half: whatever of these layers is on screen right now. */
export const renderedFeatures = (map: MapHandle | null, layers: readonly LayerId[]): readonly TileFeatureDTO[] => {
  if (!map) return []
  try {
    return map.queryRenderedFeatures(undefined, { layers: [...layers] })
  } catch {
    // a layer that is not in the style yet makes MapLibre throw rather than
    // return nothing; an empty viewport summary is the right answer either way
    return []
  }
}
