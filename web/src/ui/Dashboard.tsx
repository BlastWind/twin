import { getMap } from '../map/mapRef'
import type { EdgeId, KpiDTO } from '../sim/protocol'
import { useSimStore, useUiStore, useWorldStore } from '../state/stores'
import { kpiDelta } from '../state/resultCache'

/** KPI cards (baseline vs scenario) and the top-10 congested corridors. */

type CardSpec = {
  readonly key: 'vmt' | 'vht' | 'meanDelayS'
  readonly label: string
  readonly unit: string
  readonly digits: number
}

const CARDS: readonly CardSpec[] = [
  { key: 'vmt', label: 'VMT', unit: 'veh-mi', digits: 0 },
  { key: 'vht', label: 'VHT', unit: 'veh-h', digits: 0 },
  { key: 'meanDelayS', label: 'Mean delay', unit: 's/edge', digits: 2 },
]

const fmt = (n: number | undefined, digits: number): string =>
  n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: digits })

const signed = (n: number, digits: number): string => `${n > 0 ? '+' : ''}${fmt(n, digits)}`

/** Centroid of an edge's polyline, for the fly-to. */
const edgeCenter = (
  geometry: ReadonlyMap<string, { edges: Uint32Array; positions: Float32Array; startIndices: Uint32Array }>,
  edge: EdgeId,
): [number, number] | null => {
  for (const g of geometry.values()) {
    const i = g.edges.indexOf(edge)
    if (i < 0) continue
    const mid = Math.floor((g.startIndices[i]! + g.startIndices[i + 1]!) / 2)
    return [g.positions[mid * 2]!, g.positions[mid * 2 + 1]!]
  }
  return null
}

const Cards = ({ base, scen }: { base: KpiDTO | undefined; scen: KpiDTO | undefined }) => {
  const delta = kpiDelta(base, scen)
  return (
    <div className="cards">
      {CARDS.map((c) => (
        <div key={c.key} className="card">
          <span className="card-label">{c.label}</span>
          <span className="card-value">{fmt(base?.[c.key], c.digits)}</span>
          <span className="card-unit">{c.unit}</span>
          {delta && (
            <span className={delta[c.key] > 0 ? 'delta up' : delta[c.key] < 0 ? 'delta down' : 'delta'}>
              {signed(delta[c.key], c.digits)}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

export const Dashboard = () => {
  const h = useUiStore((s) => s.hour)
  const select = useUiStore((s) => s.select)
  const baseline = useSimStore((s) => s.baseline[h])
  const scenario = useSimStore((s) => s.scenario[h])
  const geometry = useWorldStore((s) => s.geometry)
  const stats = useWorldStore((s) => s.stats)

  const shown = scenario?.kpis ?? baseline?.kpis
  const top = (shown?.topEdges ?? []).slice(0, 10)

  const flyTo = (edge: EdgeId): void => {
    select(edge)
    const center = edgeCenter(geometry as never, edge)
    if (center) getMap()?.flyTo({ center, zoom: 15, duration: 900 })
  }

  return (
    <div className="panel dashboard">
      <h2>
        Dashboard <span className="sub">{stats ? `${stats.backend} · ${stats.edges.toLocaleString()} edges` : 'loading…'}</span>
      </h2>
      <Cards base={baseline?.kpis} scen={scenario?.kpis} />
      <table className="top-edges">
        <thead>
          <tr>
            <th>#</th>
            <th>edge</th>
            <th>V/C</th>
          </tr>
        </thead>
        <tbody>
          {top.map((t, i) => (
            <tr key={t.edge} onClick={() => flyTo(t.edge)}>
              <td>{i + 1}</td>
              <td>{t.edge}</td>
              <td>{t.vc.toFixed(2)}</td>
            </tr>
          ))}
          {top.length === 0 && (
            <tr>
              <td colSpan={3} className="hint">
                no results yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
