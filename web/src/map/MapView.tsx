import { useEffect, useRef } from 'react'
import { useUiStore } from '../state/stores'
import { mark } from '../perf'
import { FAIRFAX_CAMERA, LAYER_REGISTRY, buildStyle, mapLayerIds, type LayerVisibility } from './layers'

/** MapLibre is ~200 KB gz: kept out of the shell by lazy-importing here. */
const createMap = async (container: HTMLDivElement, visibility: LayerVisibility) => {
  const [{ Map }, pmtiles, maplibre] = await Promise.all([
    import('maplibre-gl'),
    import('pmtiles'),
    import('maplibre-gl'),
  ])
  maplibre.addProtocol('pmtiles', new pmtiles.Protocol().tile)
  return new Map({
    container,
    style: buildStyle(visibility),
    ...FAIRFAX_CAMERA,
    canvasContextAttributes: { antialias: true },
    attributionControl: { compact: true },
  })
}

export type MapHandle = { readonly setVisibility: (v: LayerVisibility) => void }

export const MapView = () => {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<{ setLayoutProperty: (id: string, k: string, v: string) => void; remove: () => void } | null>(null)
  const layers = useUiStore((s) => s.layers)
  const layersRef = useRef(layers)
  layersRef.current = layers

  useEffect(() => {
    const el = container.current
    if (!el) return
    let disposed = false
    void createMap(el, layersRef.current).then((map) => {
      if (disposed) return map.remove()
      mapRef.current = map as unknown as typeof mapRef.current
      map.on('style.load', () => mark('style-ready'))
      map.on('error', (e) => console.error('[map]', e.error?.message ?? e))
      map.on('data', (e) => {
        if (e.dataType === 'source' && 'tile' in e) mark('first-tile')
      })
      map.once('idle', () => {
        mark('map-idle')
        ;(globalThis as { __twinMapReady?: boolean }).__twinMapReady = true
      })
      ;(globalThis as { __twinMap?: unknown }).__twinMap = map
      return undefined
    })
    return () => {
      disposed = true
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    LAYER_REGISTRY.flatMap((entry) => mapLayerIds(entry).map((id) => [id, layers[entry.id]] as const)).forEach(
      ([id, visible]) => {
        try {
          map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
        } catch {
          /* style not loaded yet; the initial style already encodes visibility */
        }
      },
    )
  }, [layers])

  return <div id="map" ref={container} />
}
