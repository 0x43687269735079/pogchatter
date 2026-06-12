import { describe, expect, it } from 'vitest'
import type { ChatEvent, ChatMessage } from '@shared/model'
import { createEventBuffer, MAX_QUEUED_EVENTS } from '@preload/eventBuffer'

function message(id: string): ChatMessage {
  return {
    id,
    platform: 'youtube',
    channelId: 'youtube:c',
    timestamp: 0,
    author: {
      id: 'u1',
      name: 'alice',
      displayName: 'Alice',
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments: [{ type: 'text', text: id }]
  }
}

function messageEvent(id: string): ChatEvent {
  return { kind: 'message', channelId: 'youtube:c', message: message(id) }
}

function idsOf(batches: ChatEvent[][]): string[] {
  return batches.flat().map((event) => (event.kind === 'message' ? event.message.id : event.kind))
}

describe('createEventBuffer', () => {
  it('queues batches that arrive before a subscriber and drains them in order on subscribe', () => {
    const buffer = createEventBuffer()
    buffer.deliver([messageEvent('a')])
    buffer.deliver([messageEvent('b'), messageEvent('c')])
    const received: ChatEvent[][] = []
    buffer.subscribe((events) => {
      received.push(events)
    })
    expect(idsOf(received)).toEqual(['a', 'b', 'c'])
  })

  it('delivers straight through once subscribed', () => {
    const buffer = createEventBuffer()
    const received: ChatEvent[][] = []
    buffer.subscribe((events) => {
      received.push(events)
    })
    buffer.deliver([messageEvent('a')])
    buffer.deliver([messageEvent('b')])
    expect(received).toHaveLength(2)
    expect(idsOf(received)).toEqual(['a', 'b'])
  })

  it('drops the oldest queued events past the ceiling', () => {
    const buffer = createEventBuffer()
    for (let i = 0; i < MAX_QUEUED_EVENTS + 5; i += 1) {
      buffer.deliver([messageEvent(`m${i}`)])
    }
    const received: ChatEvent[][] = []
    buffer.subscribe((events) => {
      received.push(events)
    })
    const ids = idsOf(received)
    expect(ids).toHaveLength(MAX_QUEUED_EVENTS)
    expect(ids[0]).toBe('m5')
    expect(ids.at(-1)).toBe(`m${MAX_QUEUED_EVENTS + 4}`)
  })

  it('resumes queueing after unsubscribe and drains to the next subscriber (remount)', () => {
    const buffer = createEventBuffer()
    const first: ChatEvent[][] = []
    const unsubscribe = buffer.subscribe((events) => {
      first.push(events)
    })
    buffer.deliver([messageEvent('a')])
    unsubscribe()
    buffer.deliver([messageEvent('b')])
    const second: ChatEvent[][] = []
    buffer.subscribe((events) => {
      second.push(events)
    })
    expect(idsOf(first)).toEqual(['a'])
    expect(idsOf(second)).toEqual(['b'])
  })

  it('ignores a stale unsubscribe after a new subscriber registered', () => {
    const buffer = createEventBuffer()
    const unsubscribeStale = buffer.subscribe(() => {})
    const received: ChatEvent[][] = []
    buffer.subscribe((events) => {
      received.push(events)
    })
    unsubscribeStale()
    buffer.deliver([messageEvent('a')])
    expect(idsOf(received)).toEqual(['a'])
  })
})
