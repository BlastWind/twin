import { LAYER_GROUPS, ZONE_CATEGORIES, ZONE_COLORS, type LayerEntry, type LayerGroup } from '../map/layers'
import { useUiStore } from '../state/stores'

/**
 * Layer panel, grouped as in DESIGN 7.4. Only layers the tiles actually carry
 * are listed — `available` is resolved from the PMTiles metadata at load, so a
 * layer the pipeline has not emitted yet is absent rather than a dead toggle.
 */

/** Opacity is only meaningful while the imagery is on, so it lives with the row. */
const ImageryOpacity = () => {
  const value = useUiStore((s) => s.imageryOpacity)
  const setImageryOpacity = useUiStore((s) => s.setImageryOpacity)
  return (
    <label style={slider}>
      <span style={dim}>opacity</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => setImageryOpacity(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      <span style={dim}>{Math.round(value * 100)}%</span>
    </label>
  )
}

const Row = ({ entry }: { entry: LayerEntry }) => {
  const on = useUiStore((s) => s.layers[entry.id])
  const toggleLayer = useUiStore((s) => s.toggleLayer)
  return (
    <label style={row}>
      <input type="checkbox" checked={on} onChange={() => toggleLayer(entry.id)} />
      <span>{entry.label}</span>
      <span style={dim}>z{entry.minzoom}+</span>
    </label>
  )
}

/** Identity is never colour alone: the swatch sits beside its category name. */
const ZoningLegend = () => (
  <div style={legend}>
    {ZONE_CATEGORIES.map((c) => (
      <span key={c} style={legendItem}>
        <span style={{ ...swatch, background: ZONE_COLORS[c] }} />
        {c.replace('_', ' ')}
      </span>
    ))}
  </div>
)

export const LayerPanel = () => {
  const registry = useUiStore((s) => s.registry)
  const zoningOn = useUiStore((s) => s.layers.zoning)
  const imageryOn = useUiStore((s) => s.layers.imagery)
  const overlay = useUiStore((s) => s.overlay)
  const toggleOverlay = useUiStore((s) => s.toggleOverlay)
  const tool = useUiStore((s) => s.tool)
  const setTool = useUiStore((s) => s.setTool)

  const groups = LAYER_GROUPS.map(
    (g): readonly [LayerGroup, readonly LayerEntry[]] => [g, registry.filter((e) => e.available && e.group === g)],
  ).filter(([, entries]) => entries.length > 0)

  return (
    <section className="panel">
      <h2>Layers</h2>
      {groups.map(([group, entries]) => (
        <div key={group} className="layer-group">
          <h3>{group}</h3>
          {entries.map((entry) => (
            <Row key={entry.id} entry={entry} />
          ))}
          {group === 'Base' && imageryOn && <ImageryOpacity />}
          {group === 'Land use' && zoningOn && <ZoningLegend />}
        </div>
      ))}
      <div className="layer-group">
        <h3>Sim</h3>
        <label style={row}>
          <input type="checkbox" checked={overlay} onChange={toggleOverlay} />
          <span>Assignment overlay</span>
        </label>
        <label style={row}>
          <input type="checkbox" checked={tool === 'reach'} onChange={() => setTool(tool === 'reach' ? 'select' : 'reach')} />
          <span>Isochrone (reach)</span>
        </label>
      </div>
    </section>
  )
}

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }
const dim: React.CSSProperties = { marginLeft: 'auto', color: '#6c7686', fontSize: 11 }
const slider: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0 4px 22px' }
const legend: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', padding: '4px 0 2px 22px' }
const legendItem: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#9aa4b2' }
const swatch: React.CSSProperties = { width: 9, height: 9, borderRadius: 2, display: 'inline-block' }
