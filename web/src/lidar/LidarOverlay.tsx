import { useEffect, useRef, useState } from 'react'
import { gauge } from '../perf'
import { onMap, type MapHandle } from '../map/mapRef'
import { LIDAR_MIN_ZOOM } from '../map/layers'
import { useUiStore, useWorldStore } from '../state/stores'
import { AssetLoader, Priority, bytes, type AssetPath } from '../sim/AssetLoader'
import type { BBox, ChunkKey, GridDTO } from '../graph/manifest'
import { LIDAR_BUDGET_BYTES, selectChunks } from './viewport'
import {
  EMPTY_LIDAR_INDEX,
  LIDAR_INDEX_PATH,
  decodeLidarChunk,
  lidarChunkPath,
  parseLidarIndex,
  type LidarChunkSchema,
  type LidarIndexDTO,
} from './schema'

/**
 * LiDAR point cloud (plan Phase 4).
 *
 * Its own `MapboxOverlay` rather than a branch inside `ResultOverlay`: the two
 * have nothing in common but deck.gl, they turn on and off independently, and
 * the point cloud's data lifecycle (fetch, decode, evict on pan) has no
 * business in the assignment overlay's render path. deck.gl is lazy-imported
 * either way, so a second instance costs nothing until the layer is switched
 * on.
 *
 * It is `interleaved: false`, unlike the result overlay, and that is not a
 * preference: a second *interleaved* `MapboxOverlay` on the same map renders
 * nothing at all (verified — 240k points loaded, zero pixels), because
 * interleaving hands deck the map's own GL context and the two instances fight
 * over it. Overlaid mode gives the cloud its own canvas above the map, so it
 * draws over the building extrusions rather than being depth-tested against
 * them — which is exactly why the extrusions drop to 0.25 opacity while it is
 * on.
 */

type DeckLayer = new (props: Record<string, unknown>) => unknown

type DeckModules = {
  readonly MapboxOverlay: new (props: Record<string, unknown>) => {
    setProps: (p: Record<string, unknown>) => void
    finalize: () => void
  }
  readonly PointCloudLayer: DeckLayer
}

const loadDeck = async (): Promise<DeckModules> => {
  const [mapbox, layers] = await Promise.all([import('@deck.gl/mapbox'), import('@deck.gl/layers')])
  return {
    MapboxOverlay: mapbox.MapboxOverlay as DeckModules['MapboxOverlay'],
    PointCloudLayer: layers.PointCloudLayer as DeckLayer,
  }
}

/**
 * A point is one pixel at z16 and doubles with each zoom in, capped: past ~6 px
 * the cloud reads as a blanket rather than a surface, and the fill rate is
 * what costs at z18.
 */
const MAX_POINT_PX = 6

export const pointSizeFor = (zoom: number): number =>
  Math.min(MAX_POINT_PX, Math.max(1, 2 ** (zoom - LIDAR_MIN_ZOOM)))

/** Half a screen of slack, so a nudge of the camera does not refetch. */
const VIEW_PAD = 0.25

const paddedBounds = (map: MapHandle): BBox => {
  const b = map.getBounds()
  const padLon = (b.getEast() - b.getWest()) * VIEW_PAD
  const padLat = (b.getNorth() - b.getSouth()) * VIEW_PAD
  return [b.getWest() - padLon, b.getSouth() - padLat, b.getEast() + padLon, b.getNorth() + padLat]
}

/**
 * Heights come off the pipeline as metres above the ellipsoid/ground datum the
 * index documents. The map has no terrain, so every point is lowered by its
 * chunk's `ground_min` and the cloud sits on the same zero plane as the
 * building extrusions. Done in place: the buffer is this loader's own copy.
 */
const flatten = (chunk: LidarChunkSchema, groundMin: number): LidarChunkSchema => {
  if (groundMin === 0) return chunk
  for (let i = 2; i < chunk.xyz.length; i += 3) chunk.xyz[i] = (chunk.xyz[i] ?? 0) - groundMin
  return chunk
}

type Resident = ReadonlyMap<ChunkKey, LidarChunkSchema>

const layerFor = (deck: DeckModules, chunk: ChunkKey, points: LidarChunkSchema, pointSize: number): unknown =>
  new deck.PointCloudLayer({
    id: `twin-lidar-${chunk}`,
    data: {
      length: points.count,
      attributes: {
        getPosition: { value: points.xyz, size: 3 },
        getColor: { value: points.rgb, size: 3, normalized: true },
      },
    },
    pointSize,
    sizeUnits: 'pixels',
    opacity: 1,
    pickable: false,
    material: false,
  })

export const LidarOverlay = () => {
  const [deck, setDeck] = useState<DeckModules | null>(null)
  const [map, setMapState] = useState<MapHandle | null>(null)
  const [camera, setCamera] = useState<{ readonly zoom: number; readonly view: BBox | null }>({ zoom: 0, view: null })
  const [index, setIndex] = useState<LidarIndexDTO | null>(null)
  const [resident, setResident] = useState<Resident>(new Map())

  const on = useUiStore((s) => s.layers.lidar)
  const grid: GridDTO | null = useWorldStore((s) => s.manifest?.grid ?? null)
  const manifestHash = useWorldStore((s) => s.manifest?.hash ?? null)

  const overlayRef = useRef<{ setProps: (p: Record<string, unknown>) => void; finalize: () => void } | null>(null)
  const loaderRef = useRef<AssetLoader | null>(null)
  const residentRef = useRef<Resident>(resident)
  residentRef.current = resident

  useEffect(() => onMap(setMapState), [])

  useEffect(() => {
    if (on && !deck) void loadDeck().then(setDeck)
  }, [on, deck])

  /** One loader, its own 300 MB budget, so lidar never evicts graph chunks. */
  useEffect(() => {
    if (!manifestHash) return
    loaderRef.current = new AssetLoader({
      manifestHash,
      budget: bytes(LIDAR_BUDGET_BYTES),
      concurrency: 4,
      cacheName: `twin-lidar-${manifestHash}`,
    })
    return () => {
      loaderRef.current?.clear()
      loaderRef.current = null
    }
  }, [manifestHash])

  /** The index is fetched once, the first time the layer is switched on. */
  useEffect(() => {
    if (!on || index) return
    let dropped = false
    void fetch(`/data/${LIDAR_INDEX_PATH}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`lidar index: HTTP ${res.status}`))))
      .then((json) => {
        if (!dropped) setIndex(parseLidarIndex(json))
      })
      .catch((err: unknown) => {
        // no pipeline output yet is the normal state during Phase 4, not a bug
        console.warn('[lidar]', err)
        if (!dropped) setIndex(EMPTY_LIDAR_INDEX)
      })
    return () => {
      dropped = true
    }
  }, [on, index])

  useEffect(() => {
    if (!map) return
    const sync = () => setCamera({ zoom: map.getZoom(), view: paddedBounds(map) })
    sync()
    map.on('moveend', sync as (e: never) => void)
    return () => map.off('moveend', sync as (e: never) => void)
  }, [map])

  useEffect(() => {
    if (!map || !deck || !on) return
    const overlay = new deck.MapboxOverlay({ interleaved: false, layers: [] })
    map.addControl(overlay)
    overlayRef.current = overlay
    return () => {
      map.removeControl(overlay)
      overlay.finalize()
      overlayRef.current = null
    }
  }, [map, deck, on])

  /**
   * Load what the viewport wants and drop what it no longer does. The selection
   * is recomputed from scratch on every camera change, which is also the
   * eviction rule: anything absent from it is released this pass.
   */
  useEffect(() => {
    const loader = loaderRef.current
    if (!on || !index || !grid || !camera.view || camera.zoom < LIDAR_MIN_ZOOM || !loader) {
      if (residentRef.current.size > 0) setResident(new Map())
      return
    }
    // the lidar build's own grid wins; the manifest's is the fallback
    const selection = selectChunks(index.chunks, index.grid ?? grid, camera.view)
    const wanted = new Set(selection.chunks)
    let cancelled = false

    const keep = new Map([...residentRef.current].filter(([k]) => wanted.has(k)))
    if (keep.size !== residentRef.current.size) setResident(keep)

    const missing = selection.chunks.filter((c) => !keep.has(c))
    // a pan invalidates the previous viewport's queue before it invalidates ours
    loader.cancelBelow(Priority.Viewport)
    missing.forEach((chunk) => {
      void loader
        .get(lidarChunkPath(chunk) as AssetPath, Priority.Viewport)
        .then((buf) => {
          if (cancelled) return
          const points = flatten(decodeLidarChunk(buf), index.chunks.get(chunk)?.groundMin ?? 0)
          setResident((prev) => (prev.has(chunk) ? prev : new Map(prev).set(chunk, points)))
        })
        .catch((err: unknown) => {
          if (!cancelled && !(err instanceof Error && err.name === 'AbortedError')) console.warn('[lidar]', err)
        })
    })
    return () => {
      cancelled = true
    }
  }, [on, index, grid, camera])

  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay || !deck) return
    const pointSize = pointSizeFor(camera.zoom)
    const layers = [...resident].map(([chunk, points]) => layerFor(deck, chunk, points, pointSize))
    gauge('lidarChunks', resident.size)
    gauge('lidarPoints', [...resident.values()].reduce((n, c) => n + c.count, 0))
    overlay.setProps({ layers })
  }, [deck, resident, camera.zoom])

  return null
}
