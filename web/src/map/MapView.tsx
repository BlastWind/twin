import { useEffect, useRef } from 'react'
import { useUiStore } from '../state/stores'
import { mark } from '../perf'
import { FAIRFAX_CAMERA, WORLD_PMTILES_URL, buildStyle, mapLayerIds } from './layers'
import { probeSourceLayers } from './availability'
import { setMap, type MapHandle } from './mapRef'

/** MapLibre is ~200 KB gz: kept out of the shell by lazy-importing here. */
const createMap = async (container: HTMLDivElement) => {
  const [{ Map }, pmtiles, maplibre] = await Promise.all([
    import('maplibre-gl'),
    import('pmtiles'),
    import('maplibre-gl'),
  ])
  // one PMTiles instance, shared by the tile protocol and the metadata probe,
  // so the header and directory are fetched once
  const protocol = new pmtiles.Protocol()
  const archive = new pmtiles.PMTiles(WORLD_PMTILES_URL)
  protocol.add(archive)
  maplibre.addProtocol('pmtiles', protocol.tile)
  useUiStore.getState().setSourceLayers(await probeSourceLayers(archive))
  const { layers, registry } = useUiStore.getState()
  return new Map({
    container,
    style: buildStyle(layers, registry),
    ...FAIRFAX_CAMERA,
    canvasContextAttributes: { antialias: true },
    attributionControl: { compact: true },
  })
}

export const MapView = () => {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<{ setLayoutProperty: (id: string, k: string, v: string) => void; remove: () => void } | null>(null)
  const layers = useUiStore((s) => s.layers)
  const registry = useUiStore((s) => s.registry)
  const registryRef = useRef(registry)
  registryRef.current = registry

  useEffect(() => {
    const el = container.current
    if (!el) return
    let disposed = false
    void createMap(el).then((map) => {
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
      setMap(map as unknown as MapHandle)
      return undefined
    })
    return () => {
      disposed = true
      setMap(null)
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    registryRef.current.flatMap((entry) => mapLayerIds(entry).map((id) => [id, layers[entry.id]] as const)).forEach(
      ([id, visible]) => {
        try {
          map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
        } catch {
          /* style not loaded yet; the initial style already encodes visibility */
        }
      },
    )
  }, [layers, registry])

  return <div id="map" ref={container} />
}
