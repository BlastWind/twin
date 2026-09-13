import { LAYER_REGISTRY } from '../map/layers'
import { useUiStore } from '../state/stores'

export const LayerPanel = () => {
  const layers = useUiStore((s) => s.layers)
  const toggleLayer = useUiStore((s) => s.toggleLayer)
  return (
    <section style={panel}>
      <h2 style={heading}>Layers</h2>
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

const panel: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  padding: '10px 12px',
  background: 'rgba(16,20,27,0.88)',
  border: '1px solid #232a35',
  borderRadius: 8,
  minWidth: 190,
  backdropFilter: 'blur(6px)',
}
const heading: React.CSSProperties = { margin: '0 0 8px', fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8b95a5' }
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }
const dim: React.CSSProperties = { marginLeft: 'auto', color: '#6c7686', fontSize: 11 }
