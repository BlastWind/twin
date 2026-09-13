import { describe, expect, it } from 'vitest'
import { probeSourceLayers, sourceLayersOf } from './availability'
import {
  KNOWN_SOURCE_LAYERS,
  LAYER_REGISTRY,
  availableLayers,
  buildStyle,
  defaultVisibility,
  withAvailability,
} from './layers'

const METADATA = {
  vector_layers: [{ id: 'transportation' }, { id: 'building' }, { id: 'parcels' }, { id: 'zoning' }],
}

describe('sourceLayersOf', () => {
  it('reads vector_layers ids', () => {
    expect([...sourceLayersOf(METADATA)]).toEqual(['transportation', 'building', 'parcels', 'zoning'])
  })

  it('is total on junk', () => {
    ;[null, undefined, {}, { vector_layers: 'no' }, { vector_layers: [{}, { id: 3 }] }].forEach((v) =>
      expect(sourceLayersOf(v).size).toBe(0),
    )
  })
})

describe('probeSourceLayers', () => {
  it('falls back to the known layers when the metadata is unreadable', async () => {
    const rejects = { getMetadata: () => Promise.reject(new Error('416')) }
    await expect(probeSourceLayers(rejects)).resolves.toEqual(KNOWN_SOURCE_LAYERS)
  })

  it('uses the archive metadata when it has any layers', async () => {
    const set = await probeSourceLayers({ getMetadata: () => Promise.resolve(METADATA) })
    expect(set.has('parcels')).toBe(true)
    expect(set.has('crashes')).toBe(false)
  })
})

describe('withAvailability', () => {
  it('marks exactly the layers the tiles carry', () => {
    const registry = withAvailability(sourceLayersOf(METADATA))
    expect(availableLayers(registry).map((l) => l.id)).toEqual(['roads', 'buildings', 'parcels', 'zoning'])
  })

  it('hides missing layers from the style rather than pointing them at nothing', () => {
    const registry = withAvailability(KNOWN_SOURCE_LAYERS)
    const ids = buildStyle(defaultVisibility(registry), registry).layers.map((l) => l.id)
    expect(ids.some((id) => id.startsWith('roads/'))).toBe(true)
    expect(ids).not.toContain('crashes')
    expect(ids).not.toContain('zoning')
  })

  it('never invents a layer the registry does not declare', () => {
    const registry = withAvailability(new Set(['transportation', 'not_a_layer']))
    expect(registry).toHaveLength(LAYER_REGISTRY.length)
    expect(availableLayers(registry).map((l) => l.id)).toEqual(['roads'])
  })

  it('leaves defaults off for everything the pipeline has not emitted', () => {
    const vis = defaultVisibility(withAvailability(new Set()))
    expect(Object.values(vis).every((v) => v === false)).toBe(true)
  })
})
