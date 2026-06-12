import type { ChatEvent } from '@shared/model'

const FLUSH_INTERVAL_MS = 120
const MAX_BUFFER = 200

/**
 * Coalesces chat events and flushes them to the renderer in batches, so a busy
 * channel produces a few IPC messages per second instead of hundreds.
 */
export class EventBatcher {
  readonly #flush: (events: ChatEvent[]) => void
  #buffer: ChatEvent[] = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #disposed = false

  constructor(flush: (events: ChatEvent[]) => void) {
    this.#flush = flush
  }

  push(event: ChatEvent): void {
    if (this.#disposed) {
      return
    }
    this.#buffer.push(event)
    if (this.#buffer.length >= MAX_BUFFER) {
      this.flushNow()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.flushNow()
      }, FLUSH_INTERVAL_MS)
    }
  }

  flushNow(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    if (this.#buffer.length === 0) {
      return
    }
    const events = this.#buffer
    this.#buffer = []
    this.#flush(events)
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#buffer = []
  }
}
