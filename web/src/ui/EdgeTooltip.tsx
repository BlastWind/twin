import { roadClass } from '../graph/schema'
import { useSimStore, useUiStore, useWorldStore } from '../state/stores'

/** Hover readout for one edge: id, class, volume, V/C, delay at the current hour. */

const fmt = (n: number | undefined, digits = 0): string =>
  n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: digits })

export const EdgeTooltip = () => {
  const hover = useUiStore((s) => s.hover)
  const h = useUiStore((s) => s.hour)
  const mode = useUiStore((s) => s.mode)
  const order = useWorldStore((s) => s.order)
  const baseline = useSimStore((s) => s.baseline[h])
  const scenario = useSimStore((s) => s.scenario[h])
  if (!hover) return null

  const result = mode === 'baseline' ? baseline : (scenario ?? baseline)
  const ix = order.indexOf.get(hover.edge)
  const at = (a: Float32Array | undefined): number | undefined => (ix === undefined ? undefined : a?.[ix])

  return (
    <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
      <div className="tt-head">
        edge {hover.edge} <span className="tt-class">{roadClass(hover.classByte)}</span>
      </div>
      <dl>
        <dt>volume</dt>
        <dd>{fmt(at(result?.volume))} veh/h</dd>
        <dt>V/C</dt>
        <dd>{fmt(at(result?.vc), 2)}</dd>
        <dt>delay</dt>
        <dd>{fmt(at(result?.delay), 1)} s</dd>
      </dl>
    </div>
  )
}
