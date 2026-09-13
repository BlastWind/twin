import { describe, expect, it } from 'vitest'
import { crashSummary, landUseSummary, parcelOf, type TileFeatureDTO } from './viewportQuery'

const f = (properties: Record<string, unknown>): TileFeatureDTO => ({ properties })

describe('crashSummary', () => {
  it('counts points once and grid cells by their count', () => {
    const s = crashSummary([
      f({ severity: 5, edge_id: 7 }),
      f({ severity: 3, edge_id: 7 }),
      f({ severity: 1, count: 12, edge_id: 9 }),
    ])
    expect(s.total).toBe(14)
    expect(s.bySeverity[5]).toBe(1)
    expect(s.bySeverity[1]).toBe(12)
    expect(s.topEdges[0]).toEqual({ edge: 9, crashes: 12 })
  })

  it('clamps a severity the tiles got wrong and survives string properties', () => {
    const s = crashSummary([f({ severity: 9 }), f({ severity: '4' }), f({})])
    expect(s.bySeverity[1]).toBe(2)
    expect(s.bySeverity[4]).toBe(1)
    expect(s.topEdges).toEqual([])
  })
})

describe('landUseSummary', () => {
  const parcels = [
    f({ parcel_id: 'a', category: 'residential', area_m2: 1000, assessed_value: 500_000 }),
    // the same parcel again from the neighbouring tile
    f({ parcel_id: 'a', category: 'residential', area_m2: 1000, assessed_value: 500_000 }),
    f({ parcel_id: 'b', category: 'commercial', area_m2: 4000, assessed_value: 4_000_000 }),
    f({ parcel_id: 'c', zone: 'not-a-category', area_m2: 500, assessed_value: 1 }),
  ]

  it('deduplicates by parcel id', () => {
    const s = landUseSummary(parcels)
    expect(s.parcels).toBe(3)
    expect(s.areaM2).toBe(5500)
    expect(s.assessedValue).toBe(4_500_001)
  })

  it('rolls up by category, richest first, with unknown zones in `other`', () => {
    const s = landUseSummary(parcels)
    expect(s.byCategory.map((c) => c.category)).toEqual(['commercial', 'residential', 'other'])
  })

  it('is empty, not broken, with no features', () => {
    expect(landUseSummary([])).toEqual({ parcels: 0, areaM2: 0, assessedValue: 0, byCategory: [] })
  })
})

describe('parcelOf', () => {
  it('keeps the tile fields the popup shows and defaults the rest', () => {
    expect(parcelOf(f({ parcel_id: '12-3', zone: 'R-1', land_use: 'single family', assessed_value: 750_000 }))).toEqual({
      parcelId: '12-3',
      zone: 'R-1',
      category: 'other',
      landUse: 'single family',
      assessedValue: 750_000,
      areaM2: 0,
    })
  })
})
