import { describe, expect, it, vi } from 'vitest'
import { KeepAlive, type KeepAliveDeps } from '@main/KeepAlive'

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function harness(over: Partial<KeepAliveDeps> = {}): {
  keepAlive: KeepAlive
  deps: KeepAliveDeps
  advanceClock: (ms: number) => void
  fireResume: () => void
} {
  let clock = 1_000_000
  const powerHandlers = new Map<string, () => void>()
  const deps: KeepAliveDeps = {
    reconnectAll: vi.fn().mockResolvedValue(undefined),
    isOnline: vi.fn().mockReturnValue(true),
    now: () => clock,
    wait: vi.fn().mockResolvedValue(undefined),
    onPower: (event, handler) => {
      powerHandlers.set(event, handler)
    },
    log: vi.fn(),
    ...over
  }
  const keepAlive = new KeepAlive(deps)
  return {
    keepAlive,
    deps,
    advanceClock: (ms) => {
      clock += ms
    },
    fireResume: () => powerHandlers.get('resume')?.()
  }
}

describe('KeepAlive', () => {
  it('reconnects when the wall-clock gap between ticks exceeds the threshold', async () => {
    const h = harness()
    h.keepAlive.start()
    h.advanceClock(100_000) // > GAP_MS (90s) — the process was frozen (slept)
    h.keepAlive.checkGap()
    await flush()
    expect(h.deps.reconnectAll).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect on a normal, sub-threshold tick gap', async () => {
    const h = harness()
    h.keepAlive.start()
    h.advanceClock(20_000) // one ordinary tick
    h.keepAlive.checkGap()
    await flush()
    expect(h.deps.reconnectAll).not.toHaveBeenCalled()
  })

  it('reconnects on an OS resume event', async () => {
    const h = harness()
    h.keepAlive.start()
    h.fireResume()
    await flush()
    expect(h.deps.reconnectAll).toHaveBeenCalledTimes(1)
  })

  it('does not double-reconnect: resume resets the watchdog baseline so the wake tick sees no gap', async () => {
    const h = harness()
    h.keepAlive.start()
    h.advanceClock(100_000) // the process was frozen (slept) — the clock jumped with no tick in between
    h.fireResume() // the OS resume fires first and drives the reconnect
    await flush()
    expect(h.deps.reconnectAll).toHaveBeenCalledTimes(1)
    h.keepAlive.checkGap() // the watchdog tick lands just after resume; baseline was reset → no gap
    await flush()
    expect(h.deps.reconnectAll).toHaveBeenCalledTimes(1) // still one, not a redundant gap reconnect
  })

  it('coalesces overlapping triggers into one reconnect, then re-runs once', async () => {
    let release: () => void = () => {}
    const reconnectAll = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const h = harness({ reconnectAll })
    void h.keepAlive.reconnectNow('a')
    await flush()
    expect(reconnectAll).toHaveBeenCalledTimes(1)
    void h.keepAlive.reconnectNow('b') // arrives while 'a' is still in flight
    await flush()
    expect(reconnectAll).toHaveBeenCalledTimes(1) // coalesced, not a second call
    release() // 'a' completes → re-run once for 'b'
    await flush()
    expect(reconnectAll).toHaveBeenCalledTimes(2)
    release()
    await flush()
  })

  it('waits for the network to come back before reconnecting after a wake', async () => {
    const isOnline = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true)
    const wait = vi.fn().mockResolvedValue(undefined)
    const h = harness({ isOnline, wait })
    await h.keepAlive.reconnectNow('resume')
    expect(wait).toHaveBeenCalledTimes(2) // waited out the offline window
    expect(h.deps.reconnectAll).toHaveBeenCalledTimes(1) // then reconnected
  })

  it('stays alive (and can fire again) when a reconnect throws', async () => {
    const reconnectAll = vi.fn().mockRejectedValueOnce(new Error('network down'))
    const h = harness({ reconnectAll })
    await expect(h.keepAlive.reconnectNow('resume')).resolves.toBeUndefined()
    await h.keepAlive.reconnectNow('resume')
    expect(reconnectAll).toHaveBeenCalledTimes(2)
  })

  it('stop() halts the watchdog so a later gap does not reconnect', async () => {
    const h = harness()
    h.keepAlive.start()
    h.keepAlive.stop()
    h.advanceClock(100_000)
    h.keepAlive.checkGap()
    await flush()
    // checkGap still runs (it's not guarded), but a stopped instance won't reconnect.
    expect(h.deps.reconnectAll).not.toHaveBeenCalled()
  })
})
