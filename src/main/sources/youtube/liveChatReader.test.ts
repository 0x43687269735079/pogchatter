import { describe, expect, it, vi } from 'vitest'
import { LiveChatReader, type LiveChatHandlers } from '@main/sources/youtube/liveChatReader'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const textAction = {
  addChatItemAction: {
    item: {
      liveChatTextMessageRenderer: {
        id: 'm1',
        authorName: { simpleText: 'Alice' },
        message: { runs: [{ text: 'hello' }] },
        timestampUsec: '1700000000000000'
      }
    }
  }
}

function liveResponse(actions: unknown[], continuation = 'next', timeoutMs = 5000): unknown {
  return {
    data: {
      continuationContents: {
        liveChatContinuation: {
          actions,
          continuations: [{ timedContinuationData: { continuation, timeoutMs } }]
        }
      }
    }
  }
}

function handlers(over: Partial<LiveChatHandlers> = {}): LiveChatHandlers {
  return {
    onMessages: vi.fn(),
    onReplacements: vi.fn(),
    onClears: vi.fn(),
    onEnd: vi.fn(),
    onStall: vi.fn(),
    onResume: vi.fn(),
    onDegraded: vi.fn(),
    ...over
  }
}

describe('LiveChatReader cancellation', () => {
  it('does not dispatch messages when stopped while a poll is in flight', async () => {
    const inflight = deferred<unknown>()
    const actions = { execute: vi.fn().mockReturnValue(inflight.promise) }
    const handler = handlers()
    const reader = new LiveChatReader(actions as never, 'youtube:x', 'c0', false, handler)

    reader.start()
    reader.stop()
    inflight.resolve(liveResponse([textAction]))
    await Promise.resolve()
    await Promise.resolve()

    expect(handler.onMessages).not.toHaveBeenCalled()
  })

  it('dispatches messages from a normal poll', async () => {
    const inflight = deferred<unknown>()
    const actions = {
      execute: vi
        .fn()
        .mockReturnValueOnce(inflight.promise)
        .mockReturnValue(new Promise(() => {}))
    }
    const onMessages = vi.fn()
    const reader = new LiveChatReader(
      actions as never,
      'youtube:x',
      'c0',
      false,
      handlers({ onMessages })
    )

    reader.start()
    inflight.resolve(liveResponse([textAction]))
    await Promise.resolve()
    await Promise.resolve()

    expect(onMessages).toHaveBeenCalledTimes(1)
    expect(onMessages.mock.calls[0]?.[0]).toHaveLength(1)
    reader.stop()
  })
})

describe('LiveChatReader failure handling', () => {
  it('surfaces a stall after repeated failures and resumes on the next success', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi
        .fn()
        .mockRejectedValueOnce(new Error('net'))
        .mockRejectedValueOnce(new Error('net'))
        .mockRejectedValueOnce(new Error('net'))
        .mockResolvedValue(liveResponse([]))
      const handler = handlers()
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handler)

      reader.start()
      await vi.advanceTimersByTimeAsync(300_000)

      expect(handler.onStall).toHaveBeenCalledTimes(1)
      expect(handler.onResume).toHaveBeenCalledTimes(1)
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends only after two consecutive unreadable responses, retrying the same continuation first', async () => {
    vi.useFakeTimers()
    try {
      const onEnd = vi.fn()
      const execute = vi.fn().mockResolvedValue({ data: { continuationContents: {} } })
      const reader = new LiveChatReader(
        { execute } as never,
        'youtube:x',
        'c0',
        false,
        handlers({ onEnd })
      )

      reader.start()
      await vi.advanceTimersByTimeAsync(0) // poll 1: unreadable → treated as a failure, not the end
      expect(onEnd).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10_000) // backoff passes → poll 2: unreadable again → ended
      expect(onEnd).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledTimes(2)
      // The retry reused the continuation rather than skipping ahead.
      expect(execute.mock.calls[1]?.[1]).toMatchObject({ continuation: 'c0' })
      await vi.advanceTimersByTimeAsync(120_000) // the reader stopped — no further polls
      expect(execute).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not end on lone unreadable responses between readable polls', async () => {
    vi.useFakeTimers()
    try {
      const onEnd = vi.fn()
      const onMessages = vi.fn()
      const unrecognizedContinuation = {
        data: {
          continuationContents: {
            liveChatContinuation: { actions: [], continuations: [{ someNewKind: {} }] }
          }
        }
      }
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ data: {} }) // missing continuationContents entirely
        .mockResolvedValueOnce(liveResponse([textAction]))
        .mockResolvedValueOnce(unrecognizedContinuation) // continuation type drifted
        .mockResolvedValue(liveResponse([textAction]))
      const reader = new LiveChatReader(
        { execute } as never,
        'youtube:x',
        'c0',
        false,
        handlers({ onEnd, onMessages })
      )

      reader.start()
      await vi.advanceTimersByTimeAsync(40_000)
      expect(onEnd).not.toHaveBeenCalled()
      expect(onMessages).toHaveBeenCalled()
      expect(execute.mock.calls.length).toBeGreaterThanOrEqual(4)
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fires onBroken once after sustained consecutive failures so the owner can re-bootstrap', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn().mockRejectedValue(new Error('400'))
      let reader: LiveChatReader | undefined
      const onStall = vi.fn()
      // Mirror the real wiring: the owner tears the reader down on onBroken.
      const onBroken = vi.fn(() => reader?.stop())
      reader = new LiveChatReader(
        { execute } as never,
        'youtube:x',
        'c0',
        false,
        handlers({ onStall, onBroken })
      )

      reader.start()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(onStall).toHaveBeenCalledTimes(1)
      expect(onBroken).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledTimes(10)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('LiveChatReader cadence', () => {
  it('polls a live chat at the fast cadence while messages are flowing', async () => {
    vi.useFakeTimers()
    try {
      // Server suggests 10s, but each poll carries a message → poll at the 1s active cadence.
      const execute = vi.fn().mockResolvedValue(liveResponse([textAction], 'next', 10_000))
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handlers())

      reader.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(execute).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(execute).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1000)
      expect(execute).toHaveBeenCalledTimes(3)
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off geometrically toward the server cadence while a live chat is quiet', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn().mockResolvedValue(liveResponse([], 'next', 10_000))
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handlers())

      reader.start()
      await vi.advanceTimersByTimeAsync(0) // poll 1 (empty) → next in 2s
      expect(execute).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2000) // poll 2 (empty) → next in 4s
      expect(execute).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(2000) // only 2s elapsed of the 4s gap → no poll yet
      expect(execute).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(2000) // 4s reached → poll 3
      expect(execute).toHaveBeenCalledTimes(3)
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('snaps back to the fast cadence when a message arrives after a quiet spell', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi
        .fn()
        .mockResolvedValueOnce(liveResponse([], 'next', 10_000)) // empty → backs off to 2s
        .mockResolvedValue(liveResponse([textAction], 'next', 10_000)) // messages → 1s again
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handlers())

      reader.start()
      await vi.advanceTimersByTimeAsync(0) // poll 1 (empty) → next in 2s
      await vi.advanceTimersByTimeAsync(2000) // poll 2 (message) → snaps to 1s
      expect(execute).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1000) // poll 3 at the fast cadence
      expect(execute).toHaveBeenCalledTimes(3)
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps replay at the server cadence even while active', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn().mockResolvedValue(liveResponse([textAction], 'next', 5000))
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', true, handlers())

      reader.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(execute).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2000) // < 5s → no fast poll for replay
      expect(execute).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(3000) // 5s total → next poll
      expect(execute).toHaveBeenCalledTimes(2)
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('LiveChatReader signaler integration', () => {
  it('polls immediately on a nudge instead of waiting out the timer', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn().mockResolvedValue(liveResponse([], 'next', 10_000))
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handlers())

      reader.start()
      await vi.advanceTimersByTimeAsync(0) // poll 1 → next scheduled in 2s
      expect(execute).toHaveBeenCalledTimes(1)
      reader.nudge(undefined)
      await vi.advanceTimersByTimeAsync(0) // nudge polls now, not in 2s
      expect(execute).toHaveBeenCalledTimes(2)
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let a nudge defeat the failure backoff', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi
        .fn()
        .mockRejectedValueOnce(new Error('net'))
        .mockResolvedValue(liveResponse([], 'next', 10_000))
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handlers())

      reader.start()
      await vi.advanceTimersByTimeAsync(0) // poll 1 fails → backoff of at least 5s scheduled
      expect(execute).toHaveBeenCalledTimes(1)
      reader.nudge('1780318288318227')
      await vi.advanceTimersByTimeAsync(0) // the nudge must not trigger an immediate retry
      expect(execute).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2000) // still inside the minimum backoff window
      expect(execute).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(8000) // backoff elapsed → the timer polls, carrying the nudge
      expect(execute.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(execute.mock.calls[1]?.[1]).toMatchObject({
        invalidationPayloadLastPublishAtUsec: '1780318288318227'
      })
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a nudge landing during a failing poll waits out the backoff instead of re-polling at once', async () => {
    vi.useFakeTimers()
    try {
      let rejectFirst!: (error: Error) => void
      const firstPoll = new Promise<never>((_resolve, reject) => {
        rejectFirst = reject
      })
      const execute = vi
        .fn()
        .mockReturnValueOnce(firstPoll)
        .mockResolvedValue(liveResponse([], 'next', 10_000))
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handlers())

      reader.start() // poll 1 is in flight
      reader.nudge(undefined) // lands mid-poll
      rejectFirst(new Error('net'))
      await vi.advanceTimersByTimeAsync(0) // the poll failed — no immediate re-poll
      expect(execute).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(4000) // still backing off
      expect(execute).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(6000) // backoff elapsed → retry
      expect(execute.mock.calls.length).toBeGreaterThanOrEqual(2)
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces a nudge that arrives during an in-flight poll into one re-poll', async () => {
    vi.useFakeTimers()
    try {
      const first = deferred<unknown>()
      const execute = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue(liveResponse([], 'next', 10_000))
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handlers())

      reader.start() // poll 1 is in flight, awaiting `first`
      reader.nudge(undefined) // lands mid-poll → re-poll once after it finishes
      first.resolve(liveResponse([], 'next', 10_000))
      await vi.advanceTimersByTimeAsync(0)
      expect(execute).toHaveBeenCalledTimes(2)
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds the slow backstop cadence while signal-driven and the push keeps up', async () => {
    vi.useFakeTimers()
    try {
      // Empty polls: the push delivers via nudges, so the backstop only checks in periodically.
      const execute = vi.fn().mockResolvedValue(liveResponse([], 'next', 10_000))
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handlers())

      reader.setSignalDriven(true)
      reader.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(execute).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000) // active cadence would poll here; backstop won't
      expect(execute).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(7000) // 8s backstop → poll 2
      expect(execute).toHaveBeenCalledTimes(2)
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('polls fast when a backstop poll finds messages the push never nudged for', async () => {
    vi.useFakeTimers()
    try {
      // Messages every poll but no nudges = a silently-stalled signaler; the backstop must catch up.
      const execute = vi.fn().mockResolvedValue(liveResponse([textAction], 'next', 10_000))
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handlers())

      reader.setSignalDriven(true)
      reader.start()
      await vi.advanceTimersByTimeAsync(0) // poll 1: signal-driven, not nudged, has messages → behind
      expect(execute).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000) // now polling fast → poll 2
      expect(execute).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1000) // still fast → poll 3
      expect(execute).toHaveBeenCalledTimes(3)
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns to the backstop once a nudge shows the push is delivering again', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn().mockResolvedValue(liveResponse([textAction], 'next', 10_000))
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handlers())

      reader.setSignalDriven(true)
      reader.start()
      await vi.advanceTimersByTimeAsync(0) // poll 1: behind (messages, no nudge)
      await vi.advanceTimersByTimeAsync(1000) // poll 2: fast
      expect(execute).toHaveBeenCalledTimes(2)
      reader.nudge(undefined) // a real signal → poll 3, push is delivering again
      await vi.advanceTimersByTimeAsync(0)
      expect(execute).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(1000) // fast cadence would poll; back on the backstop now → won't
      expect(execute).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(7000) // 8s backstop → poll 4
      expect(execute).toHaveBeenCalledTimes(4)
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('LiveChatReader parse health', () => {
  it('warns once per distinct unknown action type — never per message or per batch', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const unknownAction = { someNewAction: { ignored: true } }
      const execute = vi
        .fn()
        // Batch 1: the same new type twice plus a known message → exactly one warning.
        .mockResolvedValueOnce(liveResponse([unknownAction, unknownAction, textAction]))
        // Batch 2: the already-warned type again → no new warning.
        .mockResolvedValueOnce(liveResponse([unknownAction]))
        // Batch 3: a different new type → one more warning.
        .mockResolvedValueOnce(liveResponse([{ anotherNewAction: {} }]))
        .mockReturnValue(new Promise(() => {}))
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handlers())

      reader.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[1]).toEqual({
        newTypes: ['someNewAction'],
        knownActions: 1,
        unknownActions: 2
      })
      await vi.advanceTimersByTimeAsync(1000)
      expect(warn).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5000)
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn.mock.calls[1]?.[1]).toEqual({
        newTypes: ['anotherNewAction'],
        knownActions: 1,
        unknownActions: 4
      })
      reader.stop()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('stays silent for batches of known actions', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const actions = {
        execute: vi
          .fn()
          .mockResolvedValueOnce(liveResponse([textAction]))
          .mockReturnValue(new Promise(() => {}))
      }
      const reader = new LiveChatReader(actions as never, 'youtube:x', 'c0', false, handlers())

      reader.start()
      await Promise.resolve()
      await Promise.resolve()

      expect(warn).not.toHaveBeenCalled()
      reader.stop()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('LiveChatReader sustained degradation', () => {
  const unknownAction = { someNewAction: {} }
  // One unknown per three actions = ~33% unknown share, above the 25% entry threshold.
  const unhealthyBatch = [unknownAction, textAction, textAction]
  const cleanBatch = [textAction]

  it('enters degraded after three consecutive unknown-heavy polls, firing the transition once', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const execute = vi.fn().mockResolvedValue(liveResponse(unhealthyBatch))
      const onDegraded = vi.fn()
      const reader = new LiveChatReader(
        { execute } as never,
        'youtube:x',
        'c0',
        false,
        handlers({ onDegraded })
      )

      reader.start()
      await vi.advanceTimersByTimeAsync(0) // poll 1
      await vi.advanceTimersByTimeAsync(1000) // poll 2 — two unhealthy polls aren't enough
      expect(onDegraded).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1000) // poll 3 → degraded
      expect(onDegraded).toHaveBeenCalledTimes(1)
      expect(onDegraded).toHaveBeenCalledWith(true)
      await vi.advanceTimersByTimeAsync(1000) // poll 4: still unhealthy → no re-fire
      expect(onDegraded).toHaveBeenCalledTimes(1)
      reader.stop()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not enter on a single mixed poll', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const execute = vi
        .fn()
        .mockResolvedValueOnce(liveResponse(unhealthyBatch))
        .mockResolvedValue(liveResponse(cleanBatch))
      const onDegraded = vi.fn()
      const reader = new LiveChatReader(
        { execute } as never,
        'youtube:x',
        'c0',
        false,
        handlers({ onDegraded })
      )

      reader.start()
      await vi.advanceTimersByTimeAsync(0) // poll 1: mixed
      await vi.advanceTimersByTimeAsync(5000) // several clean polls follow
      expect(onDegraded).not.toHaveBeenCalled()
      reader.stop()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not enter while unknowns stay a small share of the streak', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // One unknown per five actions = 20% share — persistent, but below the 25% threshold.
      const trickle = [unknownAction, textAction, textAction, textAction, textAction]
      const execute = vi.fn().mockResolvedValue(liveResponse(trickle))
      const onDegraded = vi.fn()
      const reader = new LiveChatReader(
        { execute } as never,
        'youtube:x',
        'c0',
        false,
        handlers({ onDegraded })
      )

      reader.start()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(5000) // six trickle polls in total
      expect(onDegraded).not.toHaveBeenCalled()
      reader.stop()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('ignores quiet polls — they neither advance nor reset the unhealthy streak', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const execute = vi
        .fn()
        .mockResolvedValueOnce(liveResponse(unhealthyBatch))
        .mockResolvedValueOnce(liveResponse(unhealthyBatch))
        .mockResolvedValueOnce(liveResponse([])) // quiet poll mid-streak
        .mockResolvedValue(liveResponse(unhealthyBatch))
      const onDegraded = vi.fn()
      const reader = new LiveChatReader(
        { execute } as never,
        'youtube:x',
        'c0',
        false,
        handlers({ onDegraded })
      )

      reader.start()
      await vi.advanceTimersByTimeAsync(0) // poll 1
      await vi.advanceTimersByTimeAsync(1000) // poll 2
      await vi.advanceTimersByTimeAsync(1000) // poll 3: quiet → streak unchanged
      expect(onDegraded).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2000) // poll 4 (backed-off): third unhealthy → degraded
      expect(onDegraded).toHaveBeenCalledTimes(1)
      expect(onDegraded).toHaveBeenCalledWith(true)
      reader.stop()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('exits after a comparable clean stretch, firing the transition once', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const execute = vi
        .fn()
        .mockResolvedValueOnce(liveResponse(unhealthyBatch))
        .mockResolvedValueOnce(liveResponse(unhealthyBatch))
        .mockResolvedValueOnce(liveResponse(unhealthyBatch))
        .mockResolvedValue(liveResponse(cleanBatch))
      const onDegraded = vi.fn()
      const reader = new LiveChatReader(
        { execute } as never,
        'youtube:x',
        'c0',
        false,
        handlers({ onDegraded })
      )

      reader.start()
      await vi.advanceTimersByTimeAsync(0) // poll 1
      await vi.advanceTimersByTimeAsync(2000) // polls 2–3 → degraded
      expect(onDegraded).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2000) // clean polls 4–5: not enough to exit
      expect(onDegraded).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000) // clean poll 6 → recovered
      expect(onDegraded).toHaveBeenCalledTimes(2)
      expect(onDegraded).toHaveBeenLastCalledWith(false)
      await vi.advanceTimersByTimeAsync(2000) // further clean polls → no re-fire
      expect(onDegraded).toHaveBeenCalledTimes(2)
      reader.stop()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('LiveChatReader live-chat selection (CUB-7)', () => {
  function withViewSelector(): unknown {
    return {
      data: {
        continuationContents: {
          liveChatContinuation: {
            actions: [],
            continuations: [
              { timedContinuationData: { continuation: 'top-next', timeoutMs: 5000 } }
            ],
            header: {
              liveChatHeaderRenderer: {
                viewSelector: {
                  sortFilterSubMenuRenderer: {
                    subMenuItems: [
                      {
                        selected: true,
                        continuation: { reloadContinuationData: { continuation: 'top' } }
                      },
                      {
                        selected: false,
                        continuation: { reloadContinuationData: { continuation: 'live' } }
                      }
                    ]
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  it('switches from the default Top chat continuation to Live chat, then polls from it', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi
        .fn()
        .mockResolvedValueOnce(withViewSelector()) // first poll carries the view selector
        .mockResolvedValue(liveResponse([textAction], 'next', 5000))
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'top', false, handlers())

      reader.start()
      await vi.advanceTimersByTimeAsync(0) // poll 1 (Top chat) → switch + immediate re-poll
      await vi.advanceTimersByTimeAsync(0)
      expect(execute).toHaveBeenCalledTimes(2)
      // The re-poll used the Live chat continuation, not Top chat's "top-next".
      expect(execute.mock.calls[1]?.[1]).toMatchObject({ continuation: 'live' })
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards a nudge publish timestamp as invalidationPayloadLastPublishAtUsec', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn().mockResolvedValue(liveResponse([], 'next', 10_000))
      const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handlers())

      reader.start()
      await vi.advanceTimersByTimeAsync(0) // poll 1 (no timestamp)
      reader.nudge('1780318288318227')
      await vi.advanceTimersByTimeAsync(0) // poll 2 from the nudge carries the timestamp
      expect(execute).toHaveBeenCalledTimes(2)
      expect(execute.mock.calls[1]?.[1]).toMatchObject({
        invalidationPayloadLastPublishAtUsec: '1780318288318227',
        webClientInfo: { isDocumentHidden: true }
      })
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
