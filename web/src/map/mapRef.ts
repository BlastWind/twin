/**
 * One holder for the live MapLibre instance.
 *
 * The map is created inside `MapView`, but the deck.gl overlay, the study-area
 * draw tool and the dashboard's fly-to all need it. A React context would force
 * every one of them under `MapView`; a one-slot observable keeps them siblings.
 */

/** The narrow slice of MapLibre's surface the rest of the app is allowed to use. */
export type MapHandle = {
  getCanvas: () => HTMLCanvasElement
  getContainer: () => HTMLElement
  getZoom: () => number
  getBounds: () => { getWest: () => number; getSouth: () => number; getEast: () => number; getNorth: () => number }
  unproject: (p: [number, number]) => { lng: number; lat: number }
  project: (ll: [number, number]) => { x: number; y: number }
  flyTo: (o: { center: [number, number]; zoom?: number; duration?: number }) => void
  queryRenderedFeatures: (
    geometry?: unknown,
    options?: { layers?: string[] },
  ) => readonly { properties: Readonly<Record<string, unknown>> }[]
  addControl: (c: unknown) => void
  removeControl: (c: unknown) => void
  on: (event: string, fn: (e: never) => void) => void
  off: (event: string, fn: (e: never) => void) => void
  setLayoutProperty: (id: string, k: string, v: string) => void
  setStyle: (style: unknown) => void
  remove: () => void
}

type Listener = (map: MapHandle | null) => void

let current: MapHandle | null = null
const listeners = new Set<Listener>()

export const getMap = (): MapHandle | null => current

export const setMap = (map: MapHandle | null): void => {
  current = map
  listeners.forEach((l) => l(map))
}

/** Fires immediately with the current value, then on every change. */
export const onMap = (listener: Listener): (() => void) => {
  listeners.add(listener)
  listener(current)
  return () => {
    listeners.delete(listener)
  }
}
