import { useEffect } from 'react'
import { MapView } from '../map/MapView'
import { LayerPanel } from './LayerPanel'
import { DevOverlay } from './DevOverlay'
import { createSimClient } from '../sim/client'

export const App = () => {
  useEffect(() => {
    const client = createSimClient()
    const idle = (globalThis.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200)))(() => client.stats())
    return () => {
      globalThis.cancelIdleCallback?.(idle as number)
      client.terminate()
    }
  }, [])
  return (
    <>
      <MapView />
      <LayerPanel />
      <DevOverlay />
    </>
  )
}
