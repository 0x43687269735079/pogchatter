import { describe, expect, it } from 'vitest'
import { emoteRetryBus, retryDelayMs } from '@renderer/emoteRetry'

describe('retryDelayMs', () => {
  it('uses quick backoff for the first few attempts', () => {
    expect(retryDelayMs(0)).toBe(500)
    expect(retryDelayMs(1)).toBe(1500)
    expect(retryDelayMs(2)).toBe(4000)
  })

  it('settles to a slow heartbeat so a late-resolving emote still recovers', () => {
    expect(retryDelayMs(3)).toBe(15_000)
    expect(retryDelayMs(50)).toBe(15_000)
  })
})

describe('emoteRetryBus', () => {
  it('notifies every subscriber on a refresh signal', () => {
    let a = 0
    let b = 0
    const offA = emoteRetryBus.subscribe(() => (a += 1))
    const offB = emoteRetryBus.subscribe(() => (b += 1))
    emoteRetryBus.signalRefresh()
    expect([a, b]).toEqual([1, 1])
    offA()
    offB()
  })

  it('stops notifying after unsubscribe', () => {
    let count = 0
    const off = emoteRetryBus.subscribe(() => (count += 1))
    emoteRetryBus.signalRefresh()
    off()
    emoteRetryBus.signalRefresh()
    expect(count).toBe(1)
  })
})
