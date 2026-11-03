import { parentPort } from 'node:worker_threads'
import type { Platform } from '@shared/model'
import { scanUserHistory } from '@main/chatLog/userHistoryScan'

/** What `UserHistorySearch` asks of this worker. */
export interface UserHistoryRequest {
  requestId: number
  dir: string
  platform: Platform
  userId: string
  cap: number
}

/**
 * The worker thread a user-history search runs in, so reading many log files never competes with
 * chat on the main process. One request per worker; the thread is terminated to cancel it.
 */
parentPort?.once('message', (request: UserHistoryRequest) => {
  const { requestId, dir, platform, userId, cap } = request
  void scanUserHistory({
    dir,
    platform,
    userId,
    cap,
    onProgress: (progress) => {
      parentPort?.postMessage({ kind: 'progress', progress: { requestId, ...progress } })
    },
    cancelled: () => false
  })
    .then((result) => {
      parentPort?.postMessage({ kind: 'result', result: { requestId, ...result } })
    })
    .catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error)
      parentPort?.postMessage({ kind: 'result', result: { requestId, ok: false, error: text } })
    })
})
