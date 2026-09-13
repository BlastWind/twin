import { useEffect, useMemo, useState } from 'react'
import { getMap, onMap, type MapHandle } from '../map/mapRef'
import { flyToEdge } from '../map/edgeCenter'
import { ZONE_COLORS, type LayerId } from '../map/layers'
import {
  SEVERITIES,
  SEVERITY_LABEL,
  crashSummary,
  landUseSummary,
  renderedFeatures,
  type TileFeatureDTO,
} from '../map/viewportQuery'
import type { EdgeId } from '../sim/protocol'
import { useUiStore, useWorldStore } from '../state/stores'

/**
 * Feed and land-use summaries for what is on screen (DESIGN 7.4).
 *
 * They read the rendered tiles, so they follow the camera and cost nothing when
 * the layer is off — and they say so plainly instead of showing a zero, because
 * "no crashes here" and "the crash layer is off" are different answers.
 */

/** Bumps once per settled camera move, so the summaries recompute at most then. */
const useViewportVersion = (): number => {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1)
    let attached: MapHandle | null = null
    const detach = (): void => {
      attached?.off('moveend', bump as (e: never) => void)
      attached?.off('idle', bump as (e: never) => void)
      attached = null
    }
    const unsubscribe = onMap((map) => {
      detach()
      if (!map) return
      attached = map
      map.on('moveend', bump as (e: never) => void)
      map.on('idle', bump as (e: never) => void)
    })
    return () => {
      unsubscribe()
      detach()
    }
  }, [])
  return version
}

const useVisibleFeatures = (layers: readonly LayerId[]): readonly TileFeatureDTO[] => {
  const version = useViewportVersion()
  const visibility = useUiStore((s) => s.layers)
  const shown = layers.filter((id) => visibility[id])
  const key = shown.join(',')
  return useMemo(
    () => (shown.length === 0 ? [] : renderedFeatures(getMap(), shown)),
    // the camera is the real dependency; `key` covers the layer set
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, key],
  )
}

const fmt = (n: number, digits = 0): string => n.toLocaleString(undefined, { maximumFractionDigits: digits })

const usd = (n: number): string =>
  n >= 1e9 ? `$${fmt(n / 1e9, 2)}B` : n >= 1e6 ? `$${fmt(n / 1e6, 1)}M` : `$${fmt(n)}`

const KM2 = 1e6

export const CrashSummary = () => {
  const crashesOn = useUiStore((s) => s.layers.crashes || s.layers.crash_grid)
  const features = useVisibleFeatures(['crashes', 'crash_grid'])
  const geometry = useWorldStore((s) => s.geometry)
  const select = useUiStore((s) => s.select)
  const summary = useMemo(() => crashSummary(features), [features])

  if (!crashesOn) return <p className="hint">Turn on a crash layer to summarise the viewport.</p>

  return (
    <>
      <div className="cards">
        <div className="card">
          <span className="card-label">Crashes in view</span>
          <span className="card-value">{fmt(summary.total)}</span>
          <span className="card-unit">records</span>
        </div>
      </div>
      <table className="top-edges">
        <tbody>
          {[...SEVERITIES].reverse().map((s) => (
            <tr key={s}>
              <td>{SEVERITY_LABEL[s]}</td>
              <td>{fmt(summary.bySeverity[s])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {summary.topEdges.length > 0 && (
        <table className="top-edges">
          <thead>
            <tr>
              <th>edge</th>
              <th>crashes</th>
            </tr>
          </thead>
          <tbody>
            {summary.topEdges.map((t) => (
              <tr
                key={t.edge}
                onClick={() => {
                  select(t.edge as EdgeId)
                  flyToEdge(geometry, t.edge as EdgeId)
                }}
              >
                <td>{t.edge}</td>
                <td>{fmt(t.crashes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

export const LandUseSummary = () => {
  const parcelsOn = useUiStore((s) => s.layers.parcels)
  const features = useVisibleFeatures(['parcels'])
  const summary = useMemo(() => landUseSummary(features), [features])

  if (!parcelsOn) return <p className="hint">Turn on parcels to summarise land use in the viewport.</p>

  return (
    <>
      <div className="cards">
        <div className="card">
          <span className="card-label">Parcels</span>
          <span className="card-value">{fmt(summary.parcels)}</span>
          <span className="card-unit">in view</span>
        </div>
        <div className="card">
          <span className="card-label">Area</span>
          <span className="card-value">{fmt(summary.areaM2 / KM2, 2)}</span>
          <span className="card-unit">km²</span>
        </div>
        <div className="card">
          <span className="card-label">Assessed</span>
          <span className="card-value">{usd(summary.assessedValue)}</span>
          <span className="card-unit">total</span>
        </div>
      </div>
      <table className="top-edges">
        <thead>
          <tr>
            <th>zone</th>
            <th>parcels</th>
            <th>km²</th>
            <th>assessed</th>
          </tr>
        </thead>
        <tbody>
          {summary.byCategory.map((c) => (
            <tr key={c.category}>
              <td>
                <span className="swatch" style={{ background: ZONE_COLORS[c.category], marginRight: 5 }} />
                {c.category.replace('_', ' ')}
              </td>
              <td>{fmt(c.parcels)}</td>
              <td>{fmt(c.areaM2 / KM2, 2)}</td>
              <td>{usd(c.assessedValue)}</td>
            </tr>
          ))}
          {summary.byCategory.length === 0 && (
            <tr>
              <td colSpan={4} className="hint">
                no parcels in view
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  )
}
