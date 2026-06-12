import { describe, expect, it } from 'vitest'
import type { ChannelInfo, ChatEvent, ChatMessage } from '@shared/model'
import { applyEventsToMessages } from '@renderer/chatState'
import { buildOrigins, mergeMonitorMessages } from '@renderer/monitor'

function message(id: string, channelId: string, timestamp: number, flagged = false): ChatMessage {
  const msg: ChatMessage = {
    id,
    platform: 'youtube',
    channelId,
    timestamp,
    author: {
      id: 'u',
      name: '@a',
      displayName: 'A',
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments: [{ type: 'text', text: id }]
  }
  if (flagged) {
    msg.flagged = true
  }
  return msg
}

const channel = (id: string, label: string): ChannelInfo => ({
  id,
  platform: 'youtube',
  label,
  status: { state: 'live' }
})

describe('mergeMonitorMessages', () => {
  it('merges members into one feed ordered by timestamp', () => {
    const byChannel = {
      a: [message('a1', 'a', 10), message('a2', 'a', 30)],
      b: [message('b1', 'b', 20), message('b2', 'b', 40)]
    }
    expect(mergeMonitorMessages(['a', 'b'], byChannel, 100).map((m) => m.id)).toEqual([
      'a1',
      'b1',
      'a2',
      'b2'
    ])
  })

  it('keeps same-timestamp messages in member then arrival order (stable)', () => {
    const byChannel = {
      a: [message('a1', 'a', 5)],
      b: [message('b1', 'b', 5)]
    }
    expect(mergeMonitorMessages(['a', 'b'], byChannel, 100).map((m) => m.id)).toEqual(['a1', 'b1'])
  })

  it('keeps only the most recent `cap` messages', () => {
    const byChannel = { a: [message('a1', 'a', 1), message('a2', 'a', 2), message('a3', 'a', 3)] }
    expect(mergeMonitorMessages(['a'], byChannel, 2).map((m) => m.id)).toEqual(['a2', 'a3'])
  })

  it('ignores members with no buffered messages', () => {
    expect(mergeMonitorMessages(['a', 'gone'], { a: [message('a1', 'a', 1)] }, 100)).toHaveLength(1)
  })

  it('with flaggedOnly, keeps only flagged messages across all members, time-ordered', () => {
    const byChannel = {
      a: [message('a1', 'a', 10), message('a2', 'a', 30, true)],
      b: [message('b1', 'b', 20, true), message('b2', 'b', 40)]
    }
    expect(mergeMonitorMessages(['a', 'b'], byChannel, 100, true).map((m) => m.id)).toEqual([
      'b1',
      'a2'
    ])
  })

  it('still shows a flagged hit after enough traffic to turn the channel buffer over', () => {
    // chatState's trim retains flagged rows past the cap; the flagged view reads those buffers.
    const events: ChatEvent[] = [
      { kind: 'message', channelId: 'a', message: message('hit', 'a', 1, true) },
      ...Array.from({ length: 150 }, (_, i): ChatEvent => {
        return { kind: 'message', channelId: 'a', message: message(`m${i}`, 'a', i + 2) }
      })
    ]
    const buffers = applyEventsToMessages({}, events, 100)
    expect(buffers['a']?.map((m) => m.id)).not.toContain('m0')
    expect(mergeMonitorMessages(['a'], buffers, 100, true).map((m) => m.id)).toEqual(['hit'])
  })
})

describe('buildOrigins', () => {
  it('assigns a short label and a stable colour by member position', () => {
    const origins = buildOrigins([channel('a', 'yt:Stream one'), channel('b', 'yt:Stream two')])
    expect(origins.get('a')?.label).toBe('Stream one')
    expect(origins.get('a')?.color).not.toBe(origins.get('b')?.color)
    // Re-building with the same order yields the same colours.
    const again = buildOrigins([channel('a', 'yt:Stream one'), channel('b', 'yt:Stream two')])
    expect(again.get('a')?.color).toBe(origins.get('a')?.color)
  })

  it('truncates a long label', () => {
    expect(
      buildOrigins([channel('a', 'yt:An extremely long stream title here')]).get('a')?.label
    ).toBe('An extremely long…')
  })
})
