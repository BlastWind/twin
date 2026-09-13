import { useMemo } from 'react'
import { flyToEdge } from '../map/edgeCenter'
import { axisMax, calibrationStats, scorableRows } from '../state/calibration'
import { useCalibrationStore, useUiStore, useWorldStore } from '../state/stores'
import type { CalibrationDTO, EdgeId } from '../sim/protocol'

/**
 * Observed AADT against modeled daily volume, one dot per count station, with
 * the 1:1 line the dots should sit on.
 *
 * One series, so no legend — the axes name it. The reference line is recessive
 * and dashed so it never reads as data, and R² is stated as a number rather
 * than left to be eyeballed off the cloud.
 */

const W = 300
const H = 230
const PAD = { top: 10, right: 10, bottom: 30, left: 44 } as const
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom

const DOT = '#3987e5'
const GRID = '#242b36'
const AXIS = '#6c7686'
const REFERENCE = '#8b95a5'

const TICKS = 4

const short = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: n >= 10_000 ? 0 : 1 })}k` : `${Math.round(n)}`

export const CalibrationChart = () => {
  const all = useCalibrationStore((s) => s.rows)
  const rows = useMemo(() => scorableRows(all), [all])
  const select = useUiStore((s) => s.select)
  const geometry = useWorldStore((s) => s.geometry)
  const stats = useMemo(() => calibrationStats(rows), [rows])

  if (rows.length === 0) {
    return (
      <p className="hint">
        {all.length === 0
          ? 'No count stations yet — counts.bin loads after the graph, and the table fills in after a 24 h sweep.'
          : `None of the ${all.length.toLocaleString()} stations sit on a road this study area models.`}
      </p>
    )
  }

  const max = axisMax(Math.max(stats.maxObserved, stats.maxModeled))
  const x = (v: number): number => PAD.left + (Math.min(v, max) / max) * PLOT_W
  const y = (v: number): number => PAD.top + PLOT_H - (Math.min(v, max) / max) * PLOT_H
  const ticks = Array.from({ length: TICKS + 1 }, (_, i) => (max * i) / TICKS)

  const flyTo = (edge: EdgeId): void => {
    select(edge)
    flyToEdge(geometry, edge)
  }

  return (
    <>
      <div className="cards">
        <div className="card">
          <span className="card-label">R² vs 1:1</span>
          <span className="card-value">{Number.isFinite(stats.r2) ? stats.r2.toFixed(3) : '—'}</span>
          <span className="card-unit">{stats.n} stations</span>
        </div>
        <div className="card">
          <span className="card-label">RMSE</span>
          <span className="card-value">{short(stats.rmse)}</span>
          <span className="card-unit">veh/day</span>
        </div>
        <div className="card">
          <span className="card-label">Bias</span>
          <span className="card-value">
            {stats.bias > 0 ? '+' : ''}
            {short(stats.bias)}
          </span>
          <span className="card-unit">model − count</span>
        </div>
      </div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Observed AADT against modeled daily volume">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" fontSize={9} fill={AXIS}>
              {short(t)}
            </text>
            <text x={x(t)} y={H - PAD.bottom + 14} textAnchor="middle" fontSize={9} fill={AXIS}>
              {short(t)}
            </text>
          </g>
        ))}
        <line
          x1={x(0)}
          y1={y(0)}
          x2={x(max)}
          y2={y(max)}
          stroke={REFERENCE}
          strokeWidth={1}
          strokeDasharray="4 3"
        />
        {rows.map((r: CalibrationDTO) => (
          <circle
            key={r.stationId}
            cx={x(r.aadt)}
            cy={y(r.modeledDaily)}
            r={4}
            fill={DOT}
            fillOpacity={0.75}
            stroke="#0e1116"
            strokeWidth={1}
            onClick={() => flyTo(r.edge)}
            style={{ cursor: 'pointer' }}
          >
            <title>{`station ${r.stationId} · edge ${r.edge}\ncount ${r.aadt.toLocaleString()} · model ${r.modeledDaily.toLocaleString()}`}</title>
          </circle>
        ))}
        <text x={PAD.left + PLOT_W / 2} y={H - 2} textAnchor="middle" fontSize={10} fill={AXIS}>
          observed AADT
        </text>
        <text x={10} y={PAD.top + PLOT_H / 2} textAnchor="middle" fontSize={10} fill={AXIS} transform={`rotate(-90 10 ${PAD.top + PLOT_H / 2})`}>
          modeled daily
        </text>
      </svg>
      <p className="chart-note">
        Dashed line is 1:1. Click a station to select its edge. {rows.length.toLocaleString()} of{' '}
        {all.length.toLocaleString()} stations sit on modelled roads; the rest are outside the study area.
      </p>
    </>
  )
}
