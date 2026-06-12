import type { ChatEvent } from '@shared/model'

/**
 * Holds live event batches until the backlog snapshot has been folded, so replayed history fills
 * the buffers before live messages append (the seen-id filter absorbs any overlap).
 *
 * Lives in a ref shared across effect runs: under StrictMode (dev) the first mount drains the
 * preload queue into its hold and is immediately cleaned up — a closure-local hold would discard
 * those batches when the first mount's backlog fetch settles, and the remount could never see
 * them (the preload queue is already empty). The gate keeps them for the next mount to release.
 */
export class BacklogGate {
  #held: ChatEvent[][] | undefined = []

  /** Apply a live batch now, or hold it while the backlog fold is still pending. */
  deliver(events: ChatEvent[], apply: (events: ChatEvent[]) => void): void {
    if (this.#held !== undefined) {
      this.#held.push(events)
      return
    }
    apply(events)
  }

  /** The backlog is folded: apply held batches in order; later deliveries apply directly. */
  release(apply: (events: ChatEvent[]) => void): void {
    const held = this.#held ?? []
    this.#held = undefined
    for (const batch of held) {
      apply(batch)
    }
  }

  /** Resume holding for the next subscriber (effect cleanup → StrictMode remount). */
  rearm(): void {
    this.#held ??= []
  }
}
