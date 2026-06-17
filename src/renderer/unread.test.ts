import { describe, expect, it } from 'vitest'
import type { ChatEvent, ChatMessage } from '@shared/model'
import { clearUnread, foldUnread, type UnreadLevel } from '@renderer/unread'

function message(channelId: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `${channelId}-${Math.random()}`,
    platform: 'youtube',
    channelId,
    timestamp: 0,
    author: {
      id: 'u',
      name: 'alice',
      displayName: 'Alice',
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments: [{ type: 'text', text: 'hi' }],
    ...over
  }
}

function msgEvent(channelId: string, over: Partial<ChatMessage> = {}): ChatEvent {
  return { kind: 'message', channelId, message: message(channelId, over) }
}

const fold = (
  prev: ReadonlyMap<string, UnreadLevel>,
  events: ChatEvent[],
  activeId: string | undefined
): ReadonlyMap<string, UnreadLevel> =>
  foldUnread({ prev, events, activeId, flaggedColumnId: 'flagged', flaggedVisible: true })

describe('foldUnread', () => {
  it('raises a non-active column to activity on a new message', () => {
    const out = fold(new Map(), [msgEvent('tw:a')], 'tw:b')
    expect(out.get('tw:a')).toBe('activity')
  })

  it('raises a non-active column to alert on a ping, flag, or held message', () => {
    expect(
      fold(new Map(), [msgEvent('tw:a', { ping: { color: '#f00' } })], 'tw:b').get('tw:a')
    ).toBe('alert')
    expect(fold(new Map(), [msgEvent('tw:a', { flagged: true })], 'tw:b').get('tw:a')).toBe('alert')
    expect(fold(new Map(), [msgEvent('tw:a', { held: { actions: [] } })], 'tw:b').get('tw:a')).toBe(
      'alert'
    )
  })

  it('does not let a later plain message downgrade an alert', () => {
    const first = fold(new Map(), [msgEvent('tw:a', { flagged: true })], 'tw:b')
    const second = fold(first, [msgEvent('tw:a')], 'tw:b')
    expect(second.get('tw:a')).toBe('alert')
  })

  it('never accumulates on the active column', () => {
    const out = fold(new Map(), [msgEvent('tw:a', { ping: { color: '#f00' } })], 'tw:a')
    expect(out.get('tw:a')).toBeUndefined()
    expect(out.size).toBe(0) // a ping in the active tab is not a flag, so nothing escalates
  })

  it('alerts the flagged-view tab on a flagged/held message in any non-active chat', () => {
    expect(fold(new Map(), [msgEvent('tw:a', { flagged: true })], 'tw:b').get('flagged')).toBe(
      'alert'
    )
    expect(
      fold(new Map(), [msgEvent('tw:a', { held: { actions: [] } })], 'tw:b').get('flagged')
    ).toBe('alert')
  })

  it('does not alert the flagged tab on a plain ping (highlights are not moderation flags)', () => {
    const out = fold(new Map(), [msgEvent('tw:a', { ping: { color: '#f00' } })], 'tw:b')
    expect(out.get('tw:a')).toBe('alert') // the chat's own tab still alerts on a ping
    expect(out.get('flagged')).toBeUndefined()
  })

  it('does not alert the flagged tab when it is the active tab', () => {
    const out = fold(new Map(), [msgEvent('tw:a', { flagged: true })], 'flagged')
    expect(out.get('flagged')).toBeUndefined()
  })

  it('does not alert the flagged tab when the flagged view is not visible', () => {
    const out = foldUnread({
      prev: new Map(),
      events: [msgEvent('tw:a', { flagged: true })],
      activeId: 'tw:b',
      flaggedColumnId: 'flagged',
      flaggedVisible: false
    })
    expect(out.get('flagged')).toBeUndefined()
  })

  it('returns the same reference when nothing changed (no re-render)', () => {
    const prev = new Map<string, UnreadLevel>([
      ['tw:a', 'alert'],
      ['flagged', 'alert']
    ])
    // tw:a and the flagged tab are already alert, so a flagged message for tw:a escalates nothing.
    const out = fold(prev, [msgEvent('tw:a', { flagged: true })], 'tw:b')
    expect(out).toBe(prev)
  })
})

describe('clearUnread', () => {
  it('clears a column and returns a new map', () => {
    const prev = new Map<string, UnreadLevel>([['tw:a', 'alert']])
    const out = clearUnread(prev, 'tw:a')
    expect(out.get('tw:a')).toBeUndefined()
    expect(out).not.toBe(prev)
  })

  it('returns the same reference when the column is already clear', () => {
    const prev = new Map<string, UnreadLevel>([['tw:a', 'alert']])
    expect(clearUnread(prev, 'tw:b')).toBe(prev)
  })
})
