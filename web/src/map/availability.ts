/**
 * Probe the tiles for the source layers they actually carry.
 *
 * PMTiles v3 keeps the TileJSON-ish metadata in its own header section, so one
 * range request answers the question for every layer at once — no per-layer
 * guessing and no waiting for a tile to come back empty.
 */

import type { SourceLayerName, SourceLayerSet } from './layers'
import { KNOWN_SOURCE_LAYERS, WORLD_PMTILES_URL } from './layers'

type VectorLayerMeta = { readonly id?: unknown }
type PmtilesMetadata = { readonly vector_layers?: readonly VectorLayerMeta[] }

/** Pure half: metadata JSON -> the set of source-layer names. */
export const sourceLayersOf = (metadata: unknown): SourceLayerSet => {
  const layers = (metadata as PmtilesMetadata | null)?.vector_layers
  if (!Array.isArray(layers)) return new Set()
  return new Set(layers.map((l) => l?.id).filter((id): id is string => typeof id === 'string' && id.length > 0))
}

type MetadataSource = { readonly getMetadata: () => Promise<unknown> }

/**
 * Falls back to the Phase-1/2 layers rather than to nothing: a metadata block
 * we cannot read is no reason to blank the basemap, and every Phase-3 layer
 * stays hidden either way.
 */
export const probeSourceLayers = async (source: MetadataSource): Promise<SourceLayerSet> => {
  const found = await source
    .getMetadata()
    .then(sourceLayersOf)
    .catch(() => new Set<SourceLayerName>())
  return found.size > 0 ? found : KNOWN_SOURCE_LAYERS
}

export const probeWorldSourceLayers = async (
  PMTiles: new (url: string) => MetadataSource,
  url: string = WORLD_PMTILES_URL,
): Promise<SourceLayerSet> => probeSourceLayers(new PMTiles(url))
