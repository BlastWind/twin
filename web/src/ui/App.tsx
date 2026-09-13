import { useEffect } from 'react'
import { MapView } from '../map/MapView'
import { ResultOverlay } from '../overlay/ResultOverlay'
import { LayerPanel } from './LayerPanel'
import { DevOverlay } from './DevOverlay'
import { HourScrubber } from './HourScrubber'
import { EdgeTooltip } from './EdgeTooltip'
import { ParcelPopup } from './ParcelPopup'
import { ScenarioEditor } from './ScenarioEditor'
import { ReachTool } from './ReachTool'
import { TransitEditor } from './TransitEditor'
import { Dashboard } from './Dashboard'
import { StudyAreaTool } from './StudyAreaTool'
import { createSimClient, setSimClient } from '../sim/client'
import { useWorldStore } from '../state/stores'
import './ui.css'

export const App = () => {
  useEffect(() => {
    const client = createSimClient()
    setSimClient(client)
    void client.start().catch((e: unknown) => {
      useWorldStore.getState().setError({ code: 'load-failed', message: e instanceof Error ? e.message : String(e) })
    })
    return () => {
      setSimClient(null)
      client.terminate()
    }
  }, [])

  const error = useWorldStore((s) => s.error)

  return (
    <>
      <MapView />
      <ResultOverlay />
      <div className="left-rail">
        <LayerPanel />
        <StudyAreaTool />
        <ReachTool />
        <ScenarioEditor />
        <TransitEditor />
      </div>
      <div className="right-rail">
        <Dashboard />
      </div>
      <HourScrubber />
      <EdgeTooltip />
      <ParcelPopup />
      <DevOverlay />
      {error && <div className="toast">{error.code}: {error.message}</div>}
    </>
  )
}
