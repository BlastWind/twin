import { LAYER_REGISTRY } from '../map/layers'
import { useUiStore } from '../state/stores'

export const LayerPanel = () => {
  const layers = useUiStore((s) => s.layers)
  const toggleLayer = useUiStore((s) => s.toggleLayer)
  return (
    <section className="panel">
      <h2>Layers</h2>
      {LAYER_REGISTRY.map((entry) => (
        <label key={entry.id} style={{ ...row, opacity: entry.available ? 1 : 0.45 }}>
          <input
            type="checkbox"
            checked={layers[entry.id]}
            disabled={!entry.available}
            onChange={() => toggleLayer(entry.id)}
          />
          <span>{entry.label}</span>
          <span style={dim}>z{entry.minzoom}+</span>
        </label>
      ))}
    </section>
  )
}

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }
const dim: React.CSSProperties = { marginLeft: 'auto', color: '#6c7686', fontSize: 11 }
