import { useEffect } from 'react'
import { onMap, type MapHandle } from '../map/mapRef'
import { ZONE_COLORS } from '../map/layers'
import { parcelOf } from '../map/viewportQuery'
import { useUiStore } from '../state/stores'

/**
 * Parcel info on click. Anchored to the click point rather than to the parcel
 * centroid: the centroid of a flag lot can be off screen, and the reader's eye
 * is already where they clicked.
 */

type MapClick = { readonly point: { readonly x: number; readonly y: number } }

const PICK_PX = 3

const useParcelClick = (): void => {
  const tool = useUiStore((s) => s.tool)
  const parcelsOn = useUiStore((s) => s.layers.parcels)
  const selectParcel = useUiStore((s) => s.selectParcel)
  useEffect(() => {
    if (tool !== 'select' || !parcelsOn) return
    let attached: MapHandle | null = null
    const onClick = (e: MapClick) => {
      const { x, y } = e.point
      const box = [
        [x - PICK_PX, y - PICK_PX],
        [x + PICK_PX, y + PICK_PX],
      ]
      const hit = attached?.queryRenderedFeatures(box, { layers: ['parcels'] })?.[0]
      selectParcel(hit ? { parcel: parcelOf(hit), x, y } : null)
    }
    const detach = (): void => {
      attached?.off('click', onClick as (e: never) => void)
      attached = null
    }
    const unsubscribe = onMap((map) => {
      detach()
      if (!map) return
      attached = map
      map.on('click', onClick as (e: never) => void)
    })
    return () => {
      unsubscribe()
      detach()
    }
  }, [tool, parcelsOn, selectParcel])
}

const fmt = (n: number, digits = 0): string => n.toLocaleString(undefined, { maximumFractionDigits: digits })

export const ParcelPopup = () => {
  const hit = useUiStore((s) => s.parcel)
  const selectParcel = useUiStore((s) => s.selectParcel)
  useParcelClick()
  if (!hit) return null
  const { parcel, x, y } = hit
  return (
    <div className="parcel-popup" style={{ left: x + 12, top: y + 12 }}>
      <div className="parcel-head">
        <span className="swatch" style={{ background: ZONE_COLORS[parcel.category] }} />
        {parcel.parcelId}
        <button className="link" onClick={() => selectParcel(null)}>
          ×
        </button>
      </div>
      <dl>
        <dt>zone</dt>
        <dd>{parcel.zone ?? '—'}</dd>
        <dt>land use</dt>
        <dd>{parcel.landUse ?? '—'}</dd>
        <dt>area</dt>
        <dd>{fmt(parcel.areaM2)} m²</dd>
        <dt>assessed</dt>
        <dd>${fmt(parcel.assessedValue)}</dd>
      </dl>
    </div>
  )
}
