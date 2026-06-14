/**
 * Drift tripwires: sanitized real InnerTube/signaler captures (see the headers in
 * `__fixtures__/`), pinned end to end. When YouTube changes a shape these tests fail naming the
 * field, instead of chat silently degrading in the field.
 */
import { describe, expect, it, vi } from 'vitest'
import { LiveChatReader, type LiveChatHandlers } from '@main/sources/youtube/liveChatReader'
import { normalizeAction, unknownActionKeys, type RawAction } from '@main/sources/youtube/normalize'
import { classifyFrame, parseFrames } from '@main/sources/youtube/signalerProtocol'
import { liveChatBootstrap2 } from '@main/sources/youtube/__fixtures__/liveChatBootstrap2'
import { liveChatUpdate10 } from '@main/sources/youtube/__fixtures__/liveChatUpdate10'
import { liveChatUpdate12 } from '@main/sources/youtube/__fixtures__/liveChatUpdate12'
import {
  signalerAckFrame5,
  signalerBackChannel9,
  signalerOpenFrame5
} from '@main/sources/youtube/__fixtures__/signalerBackChannel9'

function handlers(over: Partial<LiveChatHandlers> = {}): LiveChatHandlers {
  return {
    onMessages: vi.fn(),
    onReplacements: vi.fn(),
    onClears: vi.fn(),
    onEnd: vi.fn(),
    onStall: vi.fn(),
    onResume: vi.fn(),
    ...over
  }
}

/** A reader polling a mocked get_live_chat that serves the given responses, then hangs. */
function readerWith(responses: unknown[], over: Partial<LiveChatHandlers> = {}) {
  const execute = vi.fn()
  for (const response of responses) {
    execute.mockResolvedValueOnce({ data: response })
  }
  execute.mockReturnValue(new Promise(() => {}))
  const handler = handlers(over)
  const reader = new LiveChatReader({ execute } as never, 'youtube:x', 'c0', false, handler)
  return { reader, execute, handler }
}

const noRoles = { broadcaster: false, moderator: false, member: false, verified: false }

describe('get_live_chat fixture: capture 10-live-chat-update-response', () => {
  it('yields exactly its one message and polls on from the advancing invalidation continuation', async () => {
    vi.useFakeTimers()
    try {
      const onMessages = vi.fn()
      const { reader, execute, handler } = readerWith([liveChatUpdate10], { onMessages })

      reader.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(onMessages).toHaveBeenCalledTimes(1)
      expect(onMessages.mock.calls[0]?.[0]).toEqual([
        {
          id: 'ChwKGkNOV3A1N2lLNXBRREZjRldxd0lkZVM0ZUVB',
          platform: 'youtube',
          channelId: 'youtube:x',
          timestamp: 1780318287291,
          author: {
            id: 'UC67EV81fvGR6NIV7jxV17pQ',
            name: '@Suzanne_-_z8l',
            displayName: '@Suzanne_-_z8l',
            badges: [],
            roles: noRoles,
            avatarUrl:
              'https://yt4.ggpht.com/LzMuVDfHAfb0uytyrzLA45MOQE3-0x-KffBoOsVgy0A41Y4vuxv29BFu-nkRmoPP3dXMwHgyyA=s64-c-k-c0x00ffffff-no-rj'
          },
          // The 🇬🇧 run is a standard unicode emoji (noto image, no slash id) — it stays text.
          fragments: [
            { type: 'text', text: 'UK Aani ' },
            { type: 'text', text: '🇬🇧' },
            { type: 'text', text: ' ' }
          ],
          menuToken: 'menu-params-10'
        }
      ])
      expect(handler.onClears).not.toHaveBeenCalled()

      // The next poll (fast cadence — the batch had messages) uses the response's new continuation.
      await vi.advanceTimersByTimeAsync(1000)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(execute.mock.calls[1]?.[1]).toMatchObject({ continuation: 'continuation-10-next' })
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('get_live_chat fixture: capture 12-second-live-chat-update-response', () => {
  it('yields exactly its two messages (custom member emoji intact) and advances the continuation', async () => {
    vi.useFakeTimers()
    try {
      const onMessages = vi.fn()
      const { reader, execute, handler } = readerWith([liveChatUpdate12], { onMessages })

      reader.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(onMessages).toHaveBeenCalledTimes(1)
      expect(onMessages.mock.calls[0]?.[0]).toEqual([
        {
          id: 'ChwKGkNLYVN3Ym1LNXBRREZmN2k1d01keVdZcDF3',
          platform: 'youtube',
          channelId: 'youtube:x',
          timestamp: 1780318288762,
          author: {
            id: 'UCqOMObrAq8xLnh6R9XlX22g',
            name: '@ren-x9e',
            displayName: '@ren-x9e',
            badges: [],
            roles: noRoles,
            avatarUrl:
              'https://yt4.ggpht.com/aDyPCYUWu72I9ZExvbWVzCwEDiugQbUdCxjgZy8P7Gme2EC_hVhgt_WKnvvPQZFdOR2_J-Q0=s64-c-k-c0x00ffffff-no-rj'
          },
          fragments: [
            { type: 'text', text: 'tumne doe rkha h fir v slow ho' },
            {
              type: 'emote',
              code: ':eyes-purple-crying:',
              url: 'https://yt3.ggpht.com/FrYgdeZPpvXs-6Mp305ZiimWJ0wV5bcVZctaUy80mnIdwe-P8HRGYAm0OyBtVx8EB9_Dxkc=w48-h48-c-k-nd',
              provider: 'youtube',
              zeroWidth: false,
              animated: false
            }
          ],
          menuToken: 'menu-params-12a'
        },
        {
          id: 'ChwKGkNOYXN4cnFLNXBRREZRdmV3Z1FkY2tRdE13',
          platform: 'youtube',
          channelId: 'youtube:x',
          timestamp: 1780318290944,
          author: {
            id: 'UC3fDAZdoagTE_aqlAWhQY-w',
            name: '@lily13366',
            displayName: '@lily13366',
            badges: [],
            roles: noRoles,
            avatarUrl:
              'https://yt4.ggpht.com/Sn0Kd_QVKt4u9_Fp61PqVzzu4ve7O-JkYE0_RJdBhf2JxMkAmnLQuhIa3IeboVmOiClJyoTfIg=s64-c-k-c0x00ffffff-no-rj'
          },
          fragments: [{ type: 'text', text: 'gud wbu' }],
          menuToken: 'menu-params-12b'
        }
      ])
      expect(handler.onClears).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1000)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(execute.mock.calls[1]?.[1]).toMatchObject({ continuation: 'continuation-12-next' })
      reader.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('signaler fixture: capture 9-signaler-response', () => {
  it('parses the captured back-channel body into its two frames with nothing left over', () => {
    const { frames, rest } = parseFrames(signalerBackChannel9)
    expect(frames.map((frame) => frame.id)).toEqual([241, 242])
    expect(rest).toBe('')
  })

  it('extracts the real invalidation publish timestamp and treats the keepalive as a non-signal', () => {
    const { frames } = parseFrames(signalerBackChannel9)
    expect(frames.map((frame) => classifyFrame(frame))).toEqual([
      { kind: 'noop' },
      { kind: 'signal', publishUsec: '1780318288318227' }
    ])
  })

  it('classifies the captured open and ack frames as non-signals', () => {
    expect(classifyFrame(signalerOpenFrame5)).toEqual({ kind: 'open' })
    expect(classifyFrame(signalerAckFrame5)).toEqual({ kind: 'ack' })
  })
})

describe('iframe bootstrap fixture: capture 2-response', () => {
  const bootstrapActions = liveChatBootstrap2.continuationContents.liveChatContinuation
    .actions as RawAction[]

  it('surfaces the Top chat snapshot on the switch, then again from the Live reload', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const onMessages = vi.fn()
      const onClears = vi.fn()
      // First poll returns the bootstrap snapshot (view selector → dispatch its batch, then switch);
      // the immediate re-poll from the Live chat continuation serves the same batch and dispatches it
      // again. The snapshot is surfaced rather than discarded because it carries the chat's pending
      // state (e.g. the automod held-for-review backlog); the renderer dedups the overlap by id.
      const { reader, execute } = readerWith([liveChatBootstrap2, liveChatBootstrap2], {
        onMessages,
        onClears
      })

      reader.start()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(execute.mock.calls[1]?.[1]).toMatchObject({
        continuation: 'continuation-2-live-reload'
      })

      // The same batch is delivered twice (switch snapshot + Live reload); downstream dedup collapses
      // it. Each removeChatItemAction clears one message by id — never a whole-user clear.
      const expectedClears = [
        { messageId: 'ChwKGkNJM3h3cWJ2NUpRREZmSGVQd1FkcVZBSjVB' },
        { messageId: 'ChwKGkNKcWY5S0R2NUpRREZXcnRQd1FkNTlBQS1n' }
      ]
      expect(onMessages).toHaveBeenCalledTimes(2)
      expect(onMessages.mock.calls[0]?.[0]).toHaveLength(1)
      expect(onMessages.mock.calls[1]?.[0]).toHaveLength(1)
      expect(onClears).toHaveBeenCalledTimes(2)
      expect(onClears.mock.calls[0]?.[0]).toEqual(expectedClears)
      expect(onClears.mock.calls[1]?.[0]).toEqual(expectedClears)

      // The real addBannerToLiveChatCommand is skipped; it warns once per reader even though the
      // batch is now dispatched twice (the unknown type is remembered after the first warning).
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[1]).toMatchObject({
        newTypes: ['addBannerToLiveChatCommand']
      })
      reader.stop()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('maps each removeChatItemAction to a single-message clear', () => {
    const clears = bootstrapActions.flatMap((action) => normalizeAction('src', action).clears)
    expect(clears).toEqual([
      { messageId: 'ChwKGkNJM3h3cWJ2NUpRREZmSGVQd1FkcVZBSjVB' },
      { messageId: 'ChwKGkNKcWY5S0R2NUpRREZXcnRQd1FkNTlBQS1n' }
    ])
  })

  it('flags only the banner command as unknown — clickTrackingParams is metadata, not a type', () => {
    expect(bootstrapActions.flatMap((action) => unknownActionKeys(action))).toEqual([
      'addBannerToLiveChatCommand'
    ])
  })
})
