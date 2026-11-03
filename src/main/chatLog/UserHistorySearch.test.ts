import { describe, expect, it } from 'vitest'
import { UserHistorySearch, type WorkerLike } from '@main/chatLog/UserHistorySearch'
import type { UserHistoryRequest } from '@main/chatLog/userHistoryWorker'
import type { UserHistoryProgress, UserHistoryResult } from '@shared/userHistory'

/** A worker thread the test drives by hand: it records what it was sent and emits what it's told. */
class FakeWorker implements WorkerLike {
  readonly sent: UserHistoryRequest[] = []
  terminated = 0
  unrefd = false
  readonly #listeners = {
    message: [] as Array<(value: unknown) => void>,
    error: [] as Array<(error: Error) => void>,
    exit: [] as Array<(code: number) => void>
  }

  postMessage(value: UserHistoryRequest): void {
    this.sent.push(value)
  }

  on(event: 'message', listener: (value: unknown) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  on(event: 'message' | 'error' | 'exit', listener: (value: never) => void): this {
    ;(this.#listeners[event] as Array<(value: never) => void>).push(listener)
    return this
  }

  terminate(): Promise<number> {
    this.terminated += 1
    return Promise.resolve(1)
  }

  unref(): void {
    this.unrefd = true
  }

  emitMessage(value: unknown): void {
    for (const listener of this.#listeners.message) {
      listener(value)
    }
  }

  emitError(error: Error): void {
    for (const listener of this.#listeners.error) {
      listener(error)
    }
  }

  emitExit(code: number): void {
    for (const listener of this.#listeners.exit) {
      listener(code)
    }
  }
}

function setup(): {
  search: UserHistorySearch
  workers: FakeWorker[]
  progress: UserHistoryProgress[]
} {
  const workers: FakeWorker[] = []
  const progress: UserHistoryProgress[] = []
  const search = new UserHistorySearch({
    workerPath: '/out/main/userHistoryWorker.js',
    spawn: () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    },
    onProgress: (update) => progress.push(update)
  })
  return { search, workers, progress }
}

const EMPTY = {
  ok: true as const,
  rows: [],
  streams: [],
  total: 0,
  truncated: false,
  filesScanned: 3,
  malformedLines: 0,
  failures: []
}

describe('UserHistorySearch', () => {
  it('sends the request to a fresh, unref’d worker and resolves with its result', async () => {
    const { search, workers } = setup()
    const pending = search.search('/logs', 'youtube', 'UCaaaaaaaaaaaaaaaaaaaaaa', 1)
    const worker = workers[0]!
    expect(worker.unrefd).toBe(true)
    expect(worker.sent).toEqual([
      {
        requestId: 1,
        dir: '/logs',
        platform: 'youtube',
        userId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
        cap: 2000
      }
    ])
    worker.emitMessage({ kind: 'result', result: { requestId: 1, ...EMPTY } })
    await expect(pending).resolves.toEqual({ requestId: 1, ...EMPTY })
    expect(worker.terminated).toBe(1)
  })

  it('cancels the search in flight when a new one starts', async () => {
    const { search, workers } = setup()
    const first = search.search('/logs', 'twitch', '123456789', 1)
    const second = search.search('/logs', 'twitch', '987654321', 2)
    await expect(first).resolves.toEqual({ ok: false, requestId: 1, error: 'cancelled' })
    expect(workers[0]!.terminated).toBe(1)
    // The first worker's late result must not settle the second search.
    workers[0]!.emitMessage({ kind: 'result', result: { requestId: 1, ...EMPTY } })
    workers[1]!.emitMessage({ kind: 'result', result: { requestId: 2, ...EMPTY, filesScanned: 9 } })
    await expect(second).resolves.toMatchObject({ ok: true, requestId: 2, filesScanned: 9 })
  })

  it('forwards progress only for the search in flight', async () => {
    const { search, workers, progress } = setup()
    const first = search.search('/logs', 'twitch', '123456789', 1)
    const tick = { bytesDone: 5, bytesTotal: 10, filesDone: 0, filesTotal: 2 }
    workers[0]!.emitMessage({ kind: 'progress', progress: { requestId: 1, ...tick } })
    search.cancel()
    await first
    workers[0]!.emitMessage({ kind: 'progress', progress: { requestId: 1, ...tick, bytesDone: 9 } })
    expect(progress).toEqual([{ requestId: 1, ...tick }])
  })

  it('resolves with an error when the worker fails or exits before answering', async () => {
    const { search, workers } = setup()
    const failed = search.search('/logs', 'twitch', '123456789', 1)
    workers[0]!.emitError(new Error('boom'))
    await expect(failed).resolves.toEqual({
      ok: false,
      requestId: 1,
      error: 'The search failed: boom'
    })
    const exited = search.search('/logs', 'twitch', '123456789', 2)
    workers[1]!.emitExit(1)
    await expect(exited).resolves.toMatchObject({ ok: false, requestId: 2 })
  })

  it('settles once: the exit that follows a result changes nothing', async () => {
    const { search, workers } = setup()
    const pending = search.search('/logs', 'twitch', '123456789', 1)
    workers[0]!.emitMessage({ kind: 'result', result: { requestId: 1, ...EMPTY } })
    workers[0]!.emitExit(0)
    await expect(pending).resolves.toMatchObject({ ok: true, requestId: 1 })
    expect(workers[0]!.terminated).toBe(1)
  })

  it('ignores messages that are not progress or a result', async () => {
    const { search, workers } = setup()
    const pending = search.search('/logs', 'twitch', '123456789', 1)
    for (const junk of [null, 5, 'x', {}, { kind: 'result' }, { kind: 'progress', progress: 3 }]) {
      workers[0]!.emitMessage(junk)
    }
    workers[0]!.emitMessage({ kind: 'result', result: { requestId: 1, ...EMPTY } })
    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('stamps the result with its own request id, whatever the worker sent', async () => {
    const { search, workers } = setup()
    const pending = search.search('/logs', 'twitch', '123456789', 1)
    const result: UserHistoryResult = { ok: false, requestId: 99, error: 'Could not list' }
    workers[0]!.emitMessage({ kind: 'result', result })
    await expect(pending).resolves.toEqual({ ok: false, requestId: 1, error: 'Could not list' })
  })

  it('resolves with an error when the worker cannot start', async () => {
    const search = new UserHistorySearch({
      workerPath: '/missing.js',
      spawn: () => {
        throw new Error('ENOENT')
      },
      onProgress: () => {}
    })
    await expect(search.search('/logs', 'twitch', '1', 1)).resolves.toEqual({
      ok: false,
      requestId: 1,
      error: 'Could not start the search: ENOENT'
    })
  })

  it('cancels at dispose and refuses new searches afterwards', async () => {
    const { search, workers } = setup()
    const pending = search.search('/logs', 'twitch', '123456789', 1)
    search.dispose()
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'cancelled' })
    expect(workers[0]!.terminated).toBe(1)
    await expect(search.search('/logs', 'twitch', '1', 2)).resolves.toMatchObject({ ok: false })
    expect(workers).toHaveLength(1)
  })
})

describe('UserHistorySearch with a repeated request id', () => {
  it('settles the newer search even when the cancelled one shares its id', async () => {
    const { search, workers } = setup()
    const first = search.search('/logs', 'twitch', '123456789', 42)
    const second = search.search('/logs', 'twitch', '123456789', 42)
    await expect(first).resolves.toMatchObject({ ok: false, error: 'cancelled' })
    // The cancelled worker exits afterwards; that must not touch the newer search.
    workers[0]!.emitExit(1)
    workers[1]!.emitMessage({ kind: 'result', result: { requestId: 42, ...EMPTY } })
    await expect(second).resolves.toMatchObject({ ok: true, requestId: 42 })
  })
})
