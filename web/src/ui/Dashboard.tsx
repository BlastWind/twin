import { useEffect, useState } from 'react'
import { flyToEdge } from '../map/edgeCenter'
import type { EdgeId, KpiDTO } from '../sim/protocol'
import { useSimStore, useUiStore, useWorldStore } from '../state/stores'
import { isComplete, kpiDelta } from '../state/resultCache'
import { getSimClient } from '../sim/client'
import { CalibrationChart } from './CalibrationChart'
import { CrashSummary, LandUseSummary } from './ViewportPanels'

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

/** Four questions, one panel: the traffic result, then the three Phase-3 feeds. */
const TABS = ['Traffic', 'Calibration', 'Crashes', 'Land use'] as const
type Tab = (typeof TABS)[number]

/**
 * Calibration compares against *daily* volume, so it is only meaningful once
 * the background sweep has all 24 hours; asking earlier would score the model
 * against a partial day.
 */
const useCalibration = (): void => {
  const complete = useSimStore((s) => isComplete(s.baseline))
  useEffect(() => {
    if (complete) getSimClient()?.calibration()
  }, [complete])
}

export const Dashboard = () => {
  const [tab, setTab] = useState<Tab>('Traffic')
  const h = useUiStore((s) => s.hour)
  const select = useUiStore((s) => s.select)
  const baseline = useSimStore((s) => s.baseline[h])
  const scenario = useSimStore((s) => s.scenario[h])
  const geometry = useWorldStore((s) => s.geometry)
  const stats = useWorldStore((s) => s.stats)
  useCalibration()

  const shown = scenario?.kpis ?? baseline?.kpis
  const top = (shown?.topEdges ?? []).slice(0, 10)

  const flyTo = (edge: EdgeId): void => {
    select(edge)
    flyToEdge(geometry, edge)
  }

  return (
    <div className="panel dashboard">
      <h2>
        Dashboard <span className="sub">{stats
          ? `${stats.backend}${stats.threads > 1 ? ` ×${stats.threads}` : ''} · ${stats.edges.toLocaleString()} edges`
          : 'loading…'}</span>
      </h2>
      <div className="row tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'Calibration' && <CalibrationChart />}
      {tab === 'Crashes' && <CrashSummary />}
      {tab === 'Land use' && <LandUseSummary />}
      {tab !== 'Traffic' ? null : (
      <>
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
      </>
      )}
    </div>
  )
}
