/**
 * Retry timing and a refresh signal for emote images that fail to load.
 *
 * An emote URL is correct but its CDN request occasionally drops (YouTube ggpht, 7TV/BTTV/FFZ), which
 * otherwise leaves a broken-image icon in chat forever. {@link retryDelayMs} spaces out re-attempts —
 * a few quick tries for a transient blip, then a slow heartbeat so an image that only becomes
 * available later still recovers. {@link emoteRetryBus} lets the app nudge every still-broken image to
 * re-attempt at once (e.g. when a channel's emote catalog finishes loading, or the window regains
 * focus), so old messages refresh instead of staying broken.
 */

const QUICK_RETRY_MS = [500, 1500, 4000]
const SLOW_RETRY_MS = 15_000

/** Delay before the next load attempt: quick tries for a transient failure, then a slow heartbeat. */
export function retryDelayMs(attempt: number): number {
  return QUICK_RETRY_MS[attempt] ?? SLOW_RETRY_MS
}

type Listener = () => void

/** A broadcast so currently-broken emote images re-attempt their load together. */
class EmoteRetryBus {
  readonly #listeners = new Set<Listener>()
  #windowBound = false

  subscribe(listener: Listener): () => void {
    this.#bindWindow()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Tell every broken emote image to try loading again now. */
  signalRefresh(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  /** Re-attempt on focus / tab visibility, when a dropped request is likely to succeed again. */
  #bindWindow(): void {
    if (this.#windowBound || typeof window === 'undefined') {
      return
    }
    this.#windowBound = true
    const refresh = (): void => {
      this.signalRefresh()
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    })
  }
}

export const emoteRetryBus = new EmoteRetryBus()
