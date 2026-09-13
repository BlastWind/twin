import { mark } from '../perf'
import { useSimStore, useWorldStore } from '../state/stores'
import { decodeResponse, encodeRequest, type RequestDTO, type ResponseDTO, type RunRequestDTO } from './protocol'

/** Thin, typed host for the sim worker. The UI never touches the worker directly. */
export type SimClient = {
  readonly send: (req: Omit<RequestDTO, 'seq'> extends never ? never : RequestDTO) => void
  readonly run: (req: RunRequestDTO) => void
  readonly stats: () => void
  readonly terminate: () => void
}

let seq = 0
const nextSeq = (): number => (seq += 1)

const applyResponse = (res: ResponseDTO): void => {
  switch (res.type) {
    case 'ready':
    case 'stats':
      mark('worker-ready')
      useWorldStore.getState().setStats(res.payload)
      return
    case 'hour-result':
      useSimStore.getState().putResult('baseline', res.payload)
      return
    case 'run-done':
      useSimStore.getState().setStatus('done', res.payload.id)
      return
    case 'error':
      useWorldStore.getState().setError(res.payload)
      return
    case 'ack':
      return
  }
}

export const createSimClient = (): SimClient => {
  mark('worker-start')
  useWorldStore.getState().setLoad('loading')
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (ev: MessageEvent<unknown>) => applyResponse(decodeResponse(ev.data))
  const send = (req: RequestDTO): void => {
    const { message, transfer } = encodeRequest(req)
    worker.postMessage(message, transfer)
  }
  return {
    send,
    run: (payload) => {
      useSimStore.getState().setStatus('running', payload.id)
      send({ type: 'run', seq: nextSeq(), payload })
    },
    stats: () => send({ type: 'stats', seq: nextSeq(), payload: {} }),
    terminate: () => worker.terminate(),
  }
}
