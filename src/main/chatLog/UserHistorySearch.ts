import { Worker } from 'node:worker_threads'
import type { UserHistoryRequest } from '@main/chatLog/userHistoryWorker'
import type { Platform } from '@shared/model'
import {
  USER_HISTORY_CAP,
  type UserHistoryProgress,
  type UserHistoryResult
} from '@shared/userHistory'

/** The part of a worker thread a search uses (a real `Worker`, or a test's stand-in). */
export interface WorkerLike {
  postMessage(value: UserHistoryRequest): void
  on(event: 'message', listener: (value: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
  unref(): void
}

export interface UserHistorySearchDeps {
  /** The built worker entry (`userHistoryWorker.ts?modulePath`). */
  workerPath: string
  /** Starts a worker; a real thread unless a test supplies one. */
  spawn?: (path: string) => WorkerLike
  /** Progress of the search in flight, already tagged with its request id. */
  onProgress: (progress: UserHistoryProgress) => void
}

interface Running {
  requestId: number
  finish: (result: UserHistoryResult) => void
}

/**
 * Runs user-history searches (`userHistoryScan.ts`) in a worker thread, one at a time.
 *
 * Starting a search cancels the one in flight, which resolves as cancelled; so does {@link cancel}.
 * Every search resolves exactly once — with the worker's result, or with an error when the worker
 * fails, exits early, or can't start — and never rejects. The worker is unref'd, so a search can't
 * hold the app open, and {@link dispose} ends it at quit.
 */
export class UserHistorySearch {
  readonly #workerPath: string
  readonly #spawn: (path: string) => WorkerLike
  readonly #onProgress: (progress: UserHistoryProgress) => void
  #running: Running | undefined
  #disposed = false

  constructor(deps: UserHistorySearchDeps) {
    this.#workerPath = deps.workerPath
    this.#spawn = deps.spawn ?? ((path) => new Worker(path))
    this.#onProgress = deps.onProgress
  }

  /**
   * Search the logs under `dir` for one account's messages.
   *
   * Args:
   *   dir: The chat-log directory, read by the caller at the time of the request.
   *   platform: The account's platform.
   *   userId: The account id (Twitch user id or YouTube channel id).
   *   requestId: Chosen by the requester, which knows it before any progress can arrive; it tags
   *     this search's progress and result.
   */
  search(
    dir: string,
    platform: Platform,
    userId: string,
    requestId: number
  ): Promise<UserHistoryResult> {
    this.cancel()
    if (this.#disposed) {
      return Promise.resolve({ ok: false, requestId, error: 'The app is closing' })
    }
    return new Promise((resolve) => {
      let worker: WorkerLike
      try {
        worker = this.#spawn(this.#workerPath)
      } catch (error) {
        resolve({ ok: false, requestId, error: `Could not start the search: ${errorText(error)}` })
        return
      }
      // This search's own record: the caller's id may repeat, so it never identifies the search.
      const running: Running = {
        requestId,
        finish: (result) => {
          if (this.#running !== running) {
            return // Already settled: a result, an error, an exit or a cancel came first.
          }
          this.#running = undefined
          // The outcome is decided; a thread that fails to stop has nothing left to report to.
          worker.terminate().catch(() => undefined)
          resolve(result)
        }
      }
      this.#running = running
      worker.unref()
      this.#listen(worker, running)
      worker.postMessage({ requestId, dir, platform, userId, cap: USER_HISTORY_CAP })
    })
  }

  /** Stop the search in flight, if any; it resolves as cancelled. */
  cancel(): void {
    const running = this.#running
    running?.finish({ ok: false, requestId: running.requestId, error: 'cancelled' })
  }

  /** Stop for good (app quit): cancels the search in flight and refuses new ones. */
  dispose(): void {
    this.#disposed = true
    this.cancel()
  }

  #listen(worker: WorkerLike, running: Running): void {
    const { requestId, finish } = running
    worker.on('message', (value) => {
      const message = workerMessage(value)
      if (message?.kind === 'progress' && message.progress.requestId === requestId) {
        if (this.#running === running) {
          this.#onProgress(message.progress)
        }
      } else if (message?.kind === 'result') {
        finish({ ...message.result, requestId })
      }
    })
    worker.on('error', (error) => {
      finish({ ok: false, requestId, error: `The search failed: ${error.message}` })
    })
    worker.on('exit', (code) => {
      finish({ ok: false, requestId, error: `The search stopped early (exit code ${code})` })
    })
  }
}

type WorkerMessage =
  | { kind: 'progress'; progress: UserHistoryProgress }
  | { kind: 'result'; result: UserHistoryResult }

/** The worker's message, if it is one of the two kinds it sends. */
function workerMessage(value: unknown): WorkerMessage | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const { kind, progress, result } = value as Record<string, unknown>
  if (kind === 'progress' && typeof progress === 'object' && progress !== null) {
    return { kind, progress: progress as UserHistoryProgress }
  }
  if (kind === 'result' && typeof result === 'object' && result !== null) {
    return { kind, result: result as UserHistoryResult }
  }
  return undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
