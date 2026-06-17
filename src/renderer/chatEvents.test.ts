import { describe, expect, it } from 'vitest'
import type { AppSettings, AuthState, ChatEvent, ChatMessage } from '@shared/model'
import { BACKLOG_MESSAGES_PER_CHANNEL, DEFAULT_SETTINGS, MIN_BUFFER_SIZE } from '@shared/model'
import { processEvents, seenIdCapacity, SeenMessageIds } from '@renderer/chatEvents'

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm',
    platform: 'youtube',
    channelId: 'c',
    timestamp: 0,
    author: {
      id: 'u',
      name: '@alice',
      displayName: 'Alice',
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments: [{ type: 'text', text: 'hello world' }],
    ...over
  }
}

function messageEvent(over: Partial<ChatMessage> = {}): ChatEvent & { kind: 'message' } {
  const msg = message(over)
  return { kind: 'message', channelId: msg.channelId, message: msg }
}

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...over }
}

const AUTH: AuthState = {
  twitch: { configured: true, loggedIn: true, userName: 'alice' },
  youtube: { loggedIn: false, channels: [] },
  credentialStorage: 'encrypted'
}

describe('processEvents', () => {
  it('tags a highlighted message in place and alerts with the rule defaults (flash + sound on)', () => {
    const event = messageEvent()
    const result = processEvents(
      [event],
      settings({ highlights: [{ pattern: 'alice', isRegex: false, target: 'user' }] })
    )
    expect(event.message.ping).toEqual({ color: expect.any(String) })
    expect(event.message.flagged).toBeUndefined()
    expect(result.added).toBe(1)
    expect(result.flashed).toEqual(new Set(['c']))
    expect(result.sound).toBe(true)
    expect(result.notify).toBeUndefined()
  })

  it('honours a rule that unticks flash/sound — the tag still applies, the alerts do not', () => {
    const event = messageEvent()
    const result = processEvents(
      [event],
      settings({
        highlights: [
          {
            pattern: 'alice',
            isRegex: false,
            target: 'user',
            color: '#f00',
            flash: false,
            sound: false
          }
        ]
      })
    )
    expect(event.message.ping).toEqual({ color: '#f00' })
    expect(result.flashed.size).toBe(0)
    expect(result.sound).toBe(false)
  })

  it('builds the ★ notify payload only for a highlight rule with notify ticked (default off)', () => {
    const rule = { pattern: 'alice', isRegex: false, target: 'user' as const }
    const silent = processEvents([messageEvent()], settings({ highlights: [rule] }))
    expect(silent.notify).toBeUndefined()

    const result = processEvents(
      [messageEvent()],
      settings({ highlights: [{ ...rule, notify: true }] })
    )
    expect(result.notify).toEqual({ title: '★ Alice', body: 'hello world' })
  })

  it('keeps the last notifying highlight hit in a batch as the payload', () => {
    const first = messageEvent()
    const second = messageEvent({
      id: 'm2',
      author: { ...message().author, displayName: 'Bob' },
      fragments: [{ type: 'text', text: 'hi again' }]
    })
    const result = processEvents(
      [first, second],
      settings({ highlights: [{ pattern: 'alice', isRegex: false, target: 'user', notify: true }] })
    )
    expect(result.notify).toEqual({ title: '★ Bob', body: 'hi again' })
  })

  it('notifies as ⚑ when a message hits both a notify highlight and the watchlist', () => {
    const event = messageEvent()
    const result = processEvents(
      [event],
      settings({
        highlights: [{ pattern: 'alice', isRegex: false, target: 'user', notify: true }],
        moderation: { rules: [{ pattern: 'world', isRegex: false }], sound: true, notify: true }
      })
    )
    expect(event.message.ping).toBeDefined()
    expect(event.message.flagged).toBe(true)
    expect(result.notify).toEqual({ title: '⚑ Alice', body: 'hello world' })
  })

  it('flags a watchlist hit in place and builds the notify payload when notify is on', () => {
    const event = messageEvent()
    const result = processEvents(
      [event],
      settings({
        moderation: { rules: [{ pattern: 'world', isRegex: false }], sound: false, notify: true }
      })
    )
    expect(event.message.flagged).toBe(true)
    expect(result.flashed).toEqual(new Set(['c']))
    expect(result.sound).toBe(false)
    expect(result.notify).toEqual({ title: '⚑ Alice', body: 'hello world' })
  })

  it('keeps the last watchlist hit as the notify payload and omits it when notify is off', () => {
    const first = messageEvent()
    const second = messageEvent({
      id: 'm2',
      author: { ...message().author, displayName: 'Bob' },
      fragments: [{ type: 'text', text: 'world again' }]
    })
    const moderation = { rules: [{ pattern: 'world', isRegex: false }], sound: true, notify: true }
    const result = processEvents([first, second], settings({ moderation }))
    expect(result.notify).toEqual({ title: '⚑ Bob', body: 'world again' })
    expect(result.sound).toBe(true)

    const muted = processEvents(
      [messageEvent()],
      settings({ moderation: { ...moderation, notify: false } })
    )
    expect(muted.notify).toBeUndefined()
  })

  it('never tags system lines, but still counts them', () => {
    const event = messageEvent({ system: true })
    const result = processEvents(
      [event],
      settings({
        highlights: [{ pattern: 'alice', isRegex: false, target: 'user' }],
        moderation: { rules: [{ pattern: 'world', isRegex: false }], sound: true, notify: true }
      })
    )
    expect(event.message.ping).toBeUndefined()
    expect(event.message.flagged).toBeUndefined()
    expect(result.added).toBe(1)
    expect(result.flashed.size).toBe(0)
    expect(result.sound).toBe(false)
    expect(result.notify).toBeUndefined()
  })

  it('passes auth events through untouched and surfaces the last auth state', () => {
    const stale: ChatEvent = { kind: 'auth', auth: { ...AUTH, credentialStorage: 'memory' } }
    const fresh: ChatEvent = { kind: 'auth', auth: AUTH }
    const result = processEvents([stale, fresh], settings())
    expect(result.auth).toBe(AUTH)
    expect(result.added).toBe(0)
    expect(fresh).toEqual({ kind: 'auth', auth: AUTH })
  })

  it('counts only message events and ignores status/clear/channels events', () => {
    const events: ChatEvent[] = [
      messageEvent(),
      { kind: 'status', channelId: 'c', status: { state: 'live' } },
      { kind: 'clear', channelId: 'c', target: { messageId: 'm' } },
      { kind: 'channels', channels: [] },
      messageEvent({ id: 'm2' })
    ]
    const result = processEvents(events, settings())
    expect(result.added).toBe(2)
    expect(result.auth).toBeUndefined()
  })

  it('returns the empty outcome for an empty batch', () => {
    expect(processEvents([], settings())).toEqual({
      added: 0,
      flashed: new Set(),
      sound: false,
      notify: undefined,
      auth: undefined
    })
  })
})

describe('SeenMessageIds', () => {
  const alerting = settings({
    highlights: [{ pattern: 'alice', isRegex: false, target: 'user' }],
    moderation: { rules: [{ pattern: 'world', isRegex: false }], sound: true, notify: true }
  })

  it('passes a first delivery through and drops the re-send before the alert policy runs', () => {
    const seen = new SeenMessageIds()
    const first = seen.filter([messageEvent()], 100)
    expect(processEvents(first, alerting).sound).toBe(true)

    const resend = seen.filter([messageEvent()], 100)
    expect(resend).toEqual([])
    const muted = processEvents(resend, alerting)
    expect(muted.added).toBe(0)
    expect(muted.sound).toBe(false)
    expect(muted.flashed.size).toBe(0)
    expect(muted.notify).toBeUndefined()
  })

  it('records a held/hidden replacement id so a later same-id message raises no alert (F3-6)', () => {
    const seen = new SeenMessageIds()
    // An unbuffered held replacement surfaces a visible row; its id must be remembered.
    const replace: ChatEvent = {
      kind: 'replace',
      channelId: 'c',
      message: message({ held: { actions: [] } })
    }
    expect(seen.filter([replace], 100)).toHaveLength(1) // the replace itself passes through

    const live = seen.filter([messageEvent()], 100)
    expect(live).toEqual([]) // a later same-id message is dropped before the alert policy
    expect(processEvents(live, alerting).sound).toBe(false)
  })

  it('does not record a plain (approved/edited) replacement id (F3-6)', () => {
    const seen = new SeenMessageIds()
    // A plain replacement creates no row in the renderer, so it must not pre-empt a real message.
    seen.filter([{ kind: 'replace', channelId: 'c', message: message() }], 100)
    expect(seen.filter([messageEvent()], 100)).toHaveLength(1)
  })

  it('marks backlog ids as seen so the overlapping live delivery raises no alerts', () => {
    const seen = new SeenMessageIds()
    // Backlog fold: filter marks the ids; the caller tags via processEvents but ignores alerts.
    const backlog = seen.filter([messageEvent()], 100)
    processEvents(backlog, alerting)
    const folded = backlog[0]
    expect(folded?.kind === 'message' ? folded.message.flagged : undefined).toBe(true)

    const live = seen.filter([messageEvent()], 100)
    expect(live).toEqual([])
    expect(processEvents(live, alerting).added).toBe(0)
  })

  it('tracks channels independently and passes non-message events through', () => {
    const seen = new SeenMessageIds()
    seen.filter([messageEvent()], 100)
    const out = seen.filter(
      [
        messageEvent(), // duplicate in channel c
        messageEvent({ channelId: 'd' }), // same id, different channel — fresh
        { kind: 'status', channelId: 'c', status: { state: 'live' } }
      ],
      100
    )
    expect(out.map((event) => event.kind)).toEqual(['message', 'status'])
  })

  it('evicts the oldest ids first at capacity', () => {
    const seen = new SeenMessageIds()
    seen.filter([messageEvent({ id: 'a' }), messageEvent({ id: 'b' })], 2)
    seen.filter([messageEvent({ id: 'c' })], 2) // evicts 'a'
    expect(seen.filter([messageEvent({ id: 'a' })], 2)).toHaveLength(1) // 'a' re-enters, evicts 'b'
    expect(seen.filter([messageEvent({ id: 'c' })], 2)).toHaveLength(0) // 'c' still remembered
    expect(seen.filter([messageEvent({ id: 'b' })], 2)).toHaveLength(1)
  })

  it('forgets a channel on a whole-chat clear so a post-clear re-send can re-enter', () => {
    const seen = new SeenMessageIds()
    seen.filter([messageEvent()], 100)
    const out = seen.filter([{ kind: 'clear', channelId: 'c', target: {} }, messageEvent()], 100)
    expect(out.map((event) => event.kind)).toEqual(['clear', 'message'])
  })

  it('keeps remembering ids across per-message and per-user clears', () => {
    const seen = new SeenMessageIds()
    seen.filter([messageEvent()], 100)
    const out = seen.filter(
      [{ kind: 'clear', channelId: 'c', target: { messageId: 'm' } }, messageEvent()],
      100
    )
    expect(out.map((event) => event.kind)).toEqual(['clear'])
  })

  it('drops state for channels removed by a channels event', () => {
    const seen = new SeenMessageIds()
    seen.filter([messageEvent()], 100)
    seen.filter([{ kind: 'channels', channels: [] }], 100)
    expect(seen.filter([messageEvent()], 100)).toHaveLength(1)
  })
})

describe('seenIdCapacity', () => {
  it('floors the dedup window at the backlog replay size', () => {
    expect(seenIdCapacity(MIN_BUFFER_SIZE)).toBe(BACKLOG_MESSAGES_PER_CHANNEL * 2)
    expect(seenIdCapacity(5000)).toBe(10_000)
  })

  it('a full backlog replay never evicts its own ids, so dedup survives a crash-reload fold', () => {
    const seen = new SeenMessageIds()
    const capacity = seenIdCapacity(MIN_BUFFER_SIZE)
    const replay: ChatEvent[] = []
    for (let i = 0; i < BACKLOG_MESSAGES_PER_CHANNEL; i += 1) {
      replay.push(messageEvent({ id: `m${i}` }))
    }
    expect(seen.filter(replay, capacity)).toHaveLength(BACKLOG_MESSAGES_PER_CHANNEL)

    // A YouTube invalidation re-send of the OLDEST replayed message must still be deduped —
    // with a bufferSize*2 window (200 < 300) it would have been evicted within the fold.
    expect(seen.filter([messageEvent({ id: 'm0' })], capacity)).toHaveLength(0)
  })
})
