import { useEffect, useState } from 'react'
import { getSimClient } from '../sim/client'
import type { EdgeId, EditDTO, ScenarioDTO } from '../sim/protocol'
import { useScenarioStore, useUiStore, useWorldStore } from '../state/stores'
import { closeEdge, loadDraft, saveDraft, scenarioFromHash, withEdit, withoutEdge, writeHash } from '../scenario/codec'

/**
 * Scenario editor: click an edge on the overlay, then close it or override
 * lanes / speed / capacity. Every change goes through the undo stack, the URL
 * hash and the IndexedDB autosave draft (DESIGN 7.3/7.4).
 */

type FieldName = 'lanes' | 'speed_mps' | 'capacity_vph'
const FIELDS: readonly { readonly name: FieldName; readonly label: string; readonly step: number }[] = [
  { name: 'lanes', label: 'lanes', step: 1 },
  { name: 'speed_mps', label: 'speed (m/s)', step: 1 },
  { name: 'capacity_vph', label: 'capacity (veh/h)', step: 100 },
]

const setEdge = (edge: EdgeId, values: Partial<Record<FieldName, number>>): EditDTO => ({
  type: 'SetEdge',
  edge,
  ...values,
})

/** Restores from `#s=…` first, then the autosave draft if the hash was empty. */
const useRestore = (): void => {
  const restore = useScenarioStore((s) => s.restore)
  const manifest = useWorldStore((s) => s.manifest)
  useEffect(() => {
    if (!manifest) return
    const fromHash = scenarioFromHash(location.hash)
    if (fromHash.edits.length > 0) return restore(fromHash)
    void loadDraft(manifest.hash).then((draft) => {
      if (draft && draft.edits.length > 0) restore(draft)
    })
  }, [manifest, restore])
}

export const ScenarioEditor = () => {
  const selected = useUiStore((s) => s.selected)
  const select = useUiStore((s) => s.select)
  const setMode = useUiStore((s) => s.setMode)
  const scenario = useScenarioStore((s) => s.scenario)
  const undoDepth = useScenarioStore((s) => s.undo.length)
  const apply = useScenarioStore((s) => s.apply)
  const undoLast = useScenarioStore((s) => s.undoLast)
  const reset = useScenarioStore((s) => s.reset)
  const manifest = useWorldStore((s) => s.manifest)
  const [draftFields, setDraftFields] = useState<Partial<Record<FieldName, number>>>({})

  useRestore()

  // the hash and the autosave draft mirror the scenario, never lead it
  useEffect(() => {
    writeHash(scenario)
    if (manifest) void saveDraft(manifest.hash, scenario)
  }, [scenario, manifest])

  useEffect(() => setDraftFields({}), [selected])

  const change = (next: ScenarioDTO): void => {
    apply(next)
    setMode('scenario')
    getSimClient()?.run('scenario', next)
  }

  const existing = selected === null ? undefined : scenario.edits.find((e) => e.edge === selected)

  return (
    <div className="panel editor">
      <h2>Scenario</h2>
      {selected === null ? (
        <p className="hint">Click a road in the result overlay to edit it.</p>
      ) : (
        <div className="edit-form">
          <div className="edit-head">
            edge {selected}
            <button className="link" onClick={() => select(null)}>
              clear
            </button>
          </div>
          <button className="danger" onClick={() => change(withEdit(scenario, closeEdge(selected)))}>
            Close edge
          </button>
          {FIELDS.map((f) => (
            <label key={f.name}>
              <span>{f.label}</span>
              <input
                type="number"
                step={f.step}
                min={0}
                value={draftFields[f.name] ?? ''}
                onChange={(e) =>
                  setDraftFields((d) => ({ ...d, [f.name]: e.target.value === '' ? undefined : Number(e.target.value) }))
                }
              />
            </label>
          ))}
          <button
            disabled={Object.values(draftFields).every((v) => v === undefined)}
            onClick={() => change(withEdit(scenario, setEdge(selected, draftFields)))}
          >
            Apply edit
          </button>
          {existing && (
            <button className="link" onClick={() => change(withoutEdge(scenario, selected))}>
              remove this edit
            </button>
          )}
        </div>
      )}
      <ul className="edits">
        {scenario.edits.map((e) => (
          <li key={`${e.type}-${e.edge}`} onClick={() => select(e.edge)}>
            <code>{e.type}</code> {e.edge}
          </li>
        ))}
      </ul>
      <div className="row">
        <button
          disabled={undoDepth === 0}
          onClick={() => {
            undoLast()
            const back = useScenarioStore.getState().scenario
            if (back.edits.length === 0) setMode('baseline')
            getSimClient()?.run('scenario', back)
          }}
        >
          Undo ({undoDepth})
        </button>
        <button
          disabled={scenario.edits.length === 0}
          onClick={() => {
            reset()
            setMode('baseline')
          }}
        >
          Reset
        </button>
      </div>
    </div>
  )
}
