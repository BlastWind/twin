import type { ManifestHash } from './protocol'

/**
 * The single fetch path for every binary asset (DESIGN 7.1).
 * - keyed by manifest hash, so a new build never serves stale bytes
 * - byte-budgeted in-memory LRU
 * - three-level priority queue with bounded concurrency
 * - abort on priority change (viewport moved -> drop the stale queue)
 * - Cache Storage persistence
 * - every `get` resolves to a *detachable* ArrayBuffer the caller may transfer
 */

export type AssetPath = string & { readonly __brand: 'AssetPath' }
export type Bytes = number & { readonly __brand: 'Bytes' }
export const bytes = (n: number): Bytes => n as Bytes

/** viewport (0) beats study area (1) beats idle prefetch (2). Lower runs first. */
export const Priority = { Viewport: 0, StudyArea: 1, Idle: 2 } as const
export type Priority = (typeof Priority)[keyof typeof Priority]

export type LoaderStats = {
  readonly hits: number
  readonly misses: number
  readonly aborted: number
  readonly heldBytes: Bytes
  readonly entries: number
  readonly inFlight: number
  readonly transferBytes: Bytes
}

export type AssetLoaderConfig = {
  readonly manifestHash: ManifestHash
  readonly budget: Bytes
  readonly concurrency: number
  readonly baseUrl: string
  readonly cacheName: string
  readonly fetchImpl: typeof fetch
  /** Cache Storage; omit (undefined) to run memory-only, e.g. in tests or Node. */
  readonly cacheStorage: CacheStorage | undefined
}

export type AssetLoaderOptions = Partial<Omit<AssetLoaderConfig, 'manifestHash'>> & { readonly manifestHash: ManifestHash }

const defaults = (o: AssetLoaderOptions): AssetLoaderConfig => ({
  budget: bytes(256 * 1024 * 1024),
  concurrency: 6,
  baseUrl: '/data/',
  cacheName: `twin-assets-${o.manifestHash}`,
  fetchImpl: globalThis.fetch?.bind(globalThis),
  cacheStorage: globalThis.caches,
  ...o,
})

type Task = {
  readonly key: string
  readonly path: AssetPath
  readonly priority: Priority
  readonly controller: AbortController
  readonly resolve: (b: ArrayBuffer) => void
  readonly reject: (e: unknown) => void
}

export class AbortedError extends Error {
  constructor(path: AssetPath) {
    super(`asset load aborted: ${path}`)
    this.name = 'AbortedError'
  }
}

const copyOf = (b: ArrayBuffer): ArrayBuffer => b.slice(0)

export class AssetLoader {
  private readonly cfg: AssetLoaderConfig
  /** insertion order == LRU order (re-inserted on hit). */
  private readonly lru = new Map<string, ArrayBuffer>()
  private readonly queue: Task[] = []
  private readonly running = new Map<string, Task>()
  private held = 0
  private counters = { hits: 0, misses: 0, aborted: 0, transferBytes: 0 }

  constructor(options: AssetLoaderOptions) {
    this.cfg = defaults(options)
  }

  private key = (path: AssetPath): string => `${this.cfg.manifestHash}/${path}`

  private url = (path: AssetPath): string => `${this.cfg.baseUrl}${path}`

  stats = (): LoaderStats => ({
    hits: this.counters.hits,
    misses: this.counters.misses,
    aborted: this.counters.aborted,
    heldBytes: bytes(this.held),
    entries: this.lru.size,
    inFlight: this.running.size,
    transferBytes: bytes(this.counters.transferBytes),
  })

  /** Evict least-recently-used entries until the budget is respected. */
  private trim = (): void => {
    for (const [k, v] of this.lru) {
      if (this.held <= this.cfg.budget) return
      this.lru.delete(k)
      this.held -= v.byteLength
    }
  }

  private remember = (key: string, buf: ArrayBuffer): void => {
    if (buf.byteLength > this.cfg.budget) return // never evict everything for one oversized asset
    const prev = this.lru.get(key)
    if (prev) this.held -= prev.byteLength
    this.lru.delete(key)
    this.lru.set(key, buf)
    this.held += buf.byteLength
    this.trim()
  }

  private touch = (key: string): ArrayBuffer | undefined => {
    const hit = this.lru.get(key)
    if (!hit) return undefined
    this.lru.delete(key)
    this.lru.set(key, hit)
    return hit
  }

  /** Fetch (or serve) an asset. Resolves to a buffer the caller owns and may transfer. */
  get = (path: AssetPath, priority: Priority = Priority.Viewport): Promise<ArrayBuffer> => {
    const key = this.key(path)
    const hit = this.touch(key)
    if (hit) {
      this.counters.hits += 1
      this.counters.transferBytes += hit.byteLength
      return Promise.resolve(copyOf(hit))
    }
    this.counters.misses += 1
    const queued = this.queue.find((t) => t.key === key)
    if (queued) this.bump(queued, priority)
    if (queued || this.running.has(key)) return this.joinExisting(key)
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.enqueue({ key, path, priority, controller: new AbortController(), resolve, reject })
    })
  }

  /** Raise a queued task's priority in place (lower number wins) and re-sort. */
  private bump = (task: Task, priority: Priority): void => {
    if (priority >= task.priority) return
    const idx = this.queue.indexOf(task)
    this.queue.splice(idx, 1, { ...task, priority })
    this.sortQueue()
  }

  private joinExisting = (key: string): Promise<ArrayBuffer> =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      const list = this.waiters.get(key) ?? []
      list.push({ resolve, reject })
      this.waiters.set(key, list)
    })

  private readonly waiters = new Map<string, { resolve: (b: ArrayBuffer) => void; reject: (e: unknown) => void }[]>()

  private sortQueue = (): void => {
    this.queue.sort((a, b) => a.priority - b.priority)
  }

  private enqueue = (task: Task): void => {
    this.queue.push(task)
    this.sortQueue()
    this.pump()
  }

  private pump = (): void => {
    while (this.running.size < this.cfg.concurrency && this.queue.length > 0) {
      const next = this.queue.shift()
      if (!next) return
      this.running.set(next.key, next)
      void this.run(next)
    }
  }

  private settle = (key: string, result: { ok: true; buf: ArrayBuffer } | { ok: false; err: unknown }): void => {
    const waiting = this.waiters.get(key) ?? []
    this.waiters.delete(key)
    waiting.forEach((w) => (result.ok ? w.resolve(copyOf(result.buf)) : w.reject(result.err)))
  }

  private run = async (task: Task): Promise<void> => {
    try {
      const buf = await this.load(task)
      this.remember(task.key, buf)
      this.counters.transferBytes += buf.byteLength
      task.resolve(copyOf(buf))
      this.settle(task.key, { ok: true, buf })
    } catch (err) {
      if (task.controller.signal.aborted) this.counters.aborted += 1
      const e = task.controller.signal.aborted ? new AbortedError(task.path) : err
      task.reject(e)
      this.settle(task.key, { ok: false, err: e })
    } finally {
      this.running.delete(task.key)
      this.pump()
    }
  }

  private openCache = async (): Promise<Cache | undefined> => {
    if (!this.cfg.cacheStorage) return undefined
    try {
      return await this.cfg.cacheStorage.open(this.cfg.cacheName)
    } catch {
      return undefined
    }
  }

  private load = async (task: Task): Promise<ArrayBuffer> => {
    const cache = await this.openCache()
    const cached = await cache?.match(this.url(task.path)).catch(() => undefined)
    if (cached) return await cached.arrayBuffer()
    const res = await this.cfg.fetchImpl(this.url(task.path), { signal: task.controller.signal })
    if (!res.ok) throw new Error(`asset ${task.path}: HTTP ${res.status}`)
    const type = res.headers.get('content-type') ?? ''
    // A dev server answers a missing file with index.html; surface that here
    // instead of as a "bad magic" error deep in the decoder.
    if (type.includes('text/html')) throw new Error(`asset ${task.path}: server returned HTML (missing file?)`)
    const buf = await res.arrayBuffer()
    await cache?.put(this.url(task.path), new Response(buf.slice(0))).catch(() => undefined)
    return buf
  }

  /**
   * Priority change (viewport moved): abort everything strictly below `keep`.
   * Queued tasks are dropped; in-flight tasks are aborted via their controller.
   */
  cancelBelow = (keep: Priority): number => {
    const dropped = this.queue.filter((t) => t.priority > keep)
    const kept = this.queue.filter((t) => t.priority <= keep)
    this.queue.length = 0
    this.queue.push(...kept)
    dropped.forEach((t) => {
      this.counters.aborted += 1
      const err = new AbortedError(t.path)
      t.reject(err)
      this.settle(t.key, { ok: false, err })
    })
    const inFlight = [...this.running.values()].filter((t) => t.priority > keep)
    inFlight.forEach((t) => t.controller.abort())
    return dropped.length + inFlight.length
  }

  /** Abort a specific path regardless of priority. */
  cancel = (path: AssetPath): void => {
    const key = this.key(path)
    this.running.get(key)?.controller.abort()
    const idx = this.queue.findIndex((t) => t.key === key)
    if (idx < 0) return
    const [task] = this.queue.splice(idx, 1)
    if (!task) return
    this.counters.aborted += 1
    const err = new AbortedError(path)
    task.reject(err)
    this.settle(key, { ok: false, err })
  }

  clear = (): void => {
    this.lru.clear()
    this.held = 0
  }
}
