import { describe, expect, it } from 'vitest'
import type { ChatterSummary } from '@shared/chatterStats'
import { viewChatters } from '@renderer/chatterStatsView'

const row = (id: string, name: string, streams: number, messages: number, lastSeen: number) =>
  ({ id, name, streams, messages, firstSeen: 0, lastSeen }) satisfies ChatterSummary

const ada = row('UCaaaaaaaaaaaaaaaaaaaaaa', '@ada', 5, 10, 300)
const bob = row('UCbbbbbbbbbbbbbbbbbbbbbb', '@Bobby', 2, 90, 100)
const cara = row('UCcccccccccccccccccccccc', '@cara', 5, 40, 200)
const all = [bob, ada, cara]

describe('viewChatters', () => {
  it('orders by streams, breaking ties by messages', () => {
    expect(viewChatters(all, 'streams', '').map((c) => c.name)).toEqual(['@cara', '@ada', '@Bobby'])
  })

  it('orders by messages or by last seen on request', () => {
    expect(viewChatters(all, 'messages', '').map((c) => c.name)).toEqual([
      '@Bobby',
      '@cara',
      '@ada'
    ])
    expect(viewChatters(all, 'lastSeen', '').map((c) => c.name)).toEqual([
      '@ada',
      '@cara',
      '@Bobby'
    ])
  })

  it('filters by name case-insensitively, or by exact channel id', () => {
    expect(viewChatters(all, 'streams', 'bob').map((c) => c.name)).toEqual(['@Bobby'])
    expect(viewChatters(all, 'streams', ` ${ada.id} `).map((c) => c.name)).toEqual(['@ada'])
    expect(viewChatters(all, 'streams', 'UCaaa')).toEqual([])
  })

  it('caps the rows and leaves the input untouched', () => {
    expect(viewChatters(all, 'streams', '', 2)).toHaveLength(2)
    expect(all.map((c) => c.name)).toEqual(['@Bobby', '@ada', '@cara'])
  })

  it('shows nothing for no chatters', () => {
    expect(viewChatters([], 'streams', '')).toEqual([])
  })
})
