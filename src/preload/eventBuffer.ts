import type { ChatEvent } from '@shared/model'

/** Queued-event ceiling while no subscriber is registered; beyond it the oldest are dropped. */
export const MAX_QUEUED_EVENTS = 1000

/** Single-subscriber gate between the IPC event stream and the renderer's callback. */
export interface EventBuffer {
  /** Hand a batch to the subscriber, or queue it (bounded, drop-oldest) until one registers. */
  deliver(events: ChatEvent[]): void
  /** Register the (sole) subscriber, draining anything queued in order. Returns unsubscribe. */
  subscribe(callback: (events: ChatEvent[]) => void): () => void
}

/**
 * Buffers chat-event batches that arrive before the renderer registers its callback — the window
 * between page load and React mount (and between a StrictMode unsubscribe/resubscribe) — so early
 * batches aren't dropped into a listenerless page. Unsubscribing resumes queueing for the next
 * subscriber (a remount), keeping delivery gapless across the renderer's lifecycle.
 */
export function createEventBuffer(): EventBuffer {
  let queued: ChatEvent[] = []
  let subscriber: ((events: ChatEvent[]) => void) | undefined
  return {
    deliver(events: ChatEvent[]): void {
      if (subscriber !== undefined) {
        subscriber(events)
        return
      }
      queued.push(...events)
      if (queued.length > MAX_QUEUED_EVENTS) {
        queued.splice(0, queued.length - MAX_QUEUED_EVENTS)
      }
    },
    subscribe(callback: (events: ChatEvent[]) => void): () => void {
      subscriber = callback
      if (queued.length > 0) {
        const drained = queued
        queued = []
        callback(drained)
      }
      return () => {
        if (subscriber === callback) {
          subscriber = undefined
        }
      }
    }
  }
}
