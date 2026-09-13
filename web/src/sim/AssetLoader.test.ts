import { describe, expect, it, vi } from 'vitest'
import { AbortedError, AssetLoader, Priority, bytes, type AssetPath } from './AssetLoader'
import type { ManifestHash } from './protocol'

const HASH = 'deadbeef' as ManifestHash
const p = (s: string): AssetPath => s as AssetPath

type FetchLog = { readonly calls: string[]; readonly impl: typeof fetch; release: () => void }

const stubFetch = (sizes: Record<string, number>, opts: { manual?: boolean } = {}): FetchLog => {
  const calls: string[] = []
  const pending: (() => void)[] = []
  const impl = ((url: string, init?: RequestInit) => {
    calls.push(url)
    const size = sizes[url] ?? 8
    const body = new ArrayBuffer(size)
    const settle = (resolve: (r: Response) => void, reject: (e: unknown) => void) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      const done = () => resolve(new Response(body))
      if (opts.manual) pending.push(done)
      else queueMicrotask(done)
    }
    return new Promise<Response>(settle)
  }) as unknown as typeof fetch
  return { calls, impl, release: () => pending.splice(0).forEach((f) => f()) }
}

const until = async (cond: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const make = (f: FetchLog, over: Partial<{ budget: number; concurrency: number }> = {}) =>
  new AssetLoader({
    manifestHash: HASH,
    fetchImpl: f.impl,
    cacheStorage: undefined,
    budget: bytes(over.budget ?? 1024),
    concurrency: over.concurrency ?? 6,
  })

describe('AssetLoader', () => {
  it('fetches once and serves the LRU afterwards', async () => {
    const f = stubFetch({ '/data/a.bin': 16 })
    const loader = make(f)
    const first = await loader.get(p('a.bin'))
    const second = await loader.get(p('a.bin'))
    expect(f.calls).toEqual(['/data/a.bin'])
    expect(first.byteLength).toBe(16)
    expect(loader.stats().hits).toBe(1)
    expect(second).not.toBe(first) // detachable copies, safe to transfer
  })

  it('returns buffers that survive transfer of a sibling copy', async () => {
    const f = stubFetch({ '/data/a.bin': 16 })
    const loader = make(f)
    const a = await loader.get(p('a.bin'))
    structuredClone(a, { transfer: [a] })
    const b = await loader.get(p('a.bin'))
    expect(b.byteLength).toBe(16)
  })

  it('coalesces concurrent requests for the same path', async () => {
    const f = stubFetch({ '/data/a.bin': 8 }, { manual: true })
    const loader = make(f)
    const both = Promise.all([loader.get(p('a.bin')), loader.get(p('a.bin'), Priority.Idle)])
    await until(() => f.calls.length === 1, 'first fetch')
    f.release()
    const [x, y] = await both
    expect(f.calls).toHaveLength(1)
    expect(x.byteLength).toBe(8)
    expect(y.byteLength).toBe(8)
  })

  it('evicts least-recently-used entries over budget', async () => {
    const f = stubFetch({ '/data/a.bin': 40, '/data/b.bin': 40, '/data/c.bin': 40 })
    const loader = make(f, { budget: 100 })
    await loader.get(p('a.bin'))
    await loader.get(p('b.bin'))
    await loader.get(p('a.bin')) // touch a -> b is now LRU
    await loader.get(p('c.bin'))
    expect(loader.stats().heldBytes).toBeLessThanOrEqual(100)
    await loader.get(p('b.bin'))
    expect(f.calls.filter((c) => c === '/data/b.bin')).toHaveLength(2)
  })

  it('runs higher priority work first', async () => {
    const f = stubFetch({}, { manual: true })
    const loader = make(f, { concurrency: 1 })
    void loader.get(p('block.bin'), Priority.Viewport)
    void loader.get(p('idle.bin'), Priority.Idle).catch(() => undefined)
    void loader.get(p('view.bin'), Priority.Viewport).catch(() => undefined)
    await until(() => f.calls.length === 1, 'first fetch')
    f.release()
    await until(() => f.calls.length === 2, 'second fetch')
    f.release()
    expect(f.calls.slice(0, 2)).toEqual(['/data/block.bin', '/data/view.bin'])
  })

  it('aborts queued and in-flight work below the new priority', async () => {
    const f = stubFetch({}, { manual: true })
    const loader = make(f, { concurrency: 1 })
    const blocking = loader.get(p('block.bin'), Priority.Viewport)
    const idle = loader.get(p('idle.bin'), Priority.Idle)
    await until(() => f.calls.length === 1, 'first fetch')
    loader.cancelBelow(Priority.Viewport)
    await expect(idle).rejects.toBeInstanceOf(AbortedError)
    f.release()
    await expect(blocking).resolves.toBeInstanceOf(ArrayBuffer)
    expect(loader.stats().aborted).toBe(1)
  })

  it('surfaces HTTP failures', async () => {
    const impl = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    const loader = make({ calls: [], impl, release: () => undefined })
    await expect(loader.get(p('missing.bin'))).rejects.toThrow(/404/)
  })

  it('keys the cache by manifest hash', async () => {
    const f = stubFetch({ '/data/a.bin': 8 })
    const one = make(f)
    await one.get(p('a.bin'))
    const two = new AssetLoader({ manifestHash: 'other' as ManifestHash, fetchImpl: f.impl, cacheStorage: undefined })
    await two.get(p('a.bin'))
    expect(f.calls).toHaveLength(2)
  })
})
