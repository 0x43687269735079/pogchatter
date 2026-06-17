import { describe, expect, it } from 'vitest'
import {
  FLAGGED_COLUMN_ID,
  moveColumnBy,
  moveColumnTo,
  rankInsert,
  reconcileColumnOrder
} from '@renderer/columnOrder'

const MONITORS = new Set(['mon-1', 'mon-2'])

describe('moveColumnBy', () => {
  it('swaps a column one step left or right', () => {
    expect(moveColumnBy(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveColumnBy(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
  })

  it('returns the same array reference when it cannot move (edge or absent)', () => {
    const order = ['a', 'b', 'c']
    expect(moveColumnBy(order, 'a', -1)).toBe(order) // already leftmost
    expect(moveColumnBy(order, 'c', 1)).toBe(order) // already rightmost
    expect(moveColumnBy(order, 'gone', -1)).toBe(order) // not present
  })
})

describe('moveColumnTo', () => {
  it('moves a column to a target index (position once removed)', () => {
    expect(moveColumnTo(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveColumnTo(['a', 'b', 'c', 'd'], 'd', 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveColumnTo(['a', 'b', 'c'], 'b', 99)).toEqual(['a', 'c', 'b']) // clamped to the end
  })

  it('returns the same array reference on a no-op (absent or unchanged position)', () => {
    const order = ['a', 'b', 'c']
    expect(moveColumnTo(order, 'gone', 1)).toBe(order)
    expect(moveColumnTo(order, 'b', 1)).toBe(order) // already at index 1 once removed
  })
})

describe('rankInsert', () => {
  it('puts the flagged view leftmost and a monitor after the flagged/monitor block', () => {
    expect(rankInsert(['tw:a', 'yt:b'], FLAGGED_COLUMN_ID, MONITORS)).toEqual([
      'flagged',
      'tw:a',
      'yt:b'
    ])
    expect(rankInsert(['flagged', 'tw:a'], 'mon-1', MONITORS)).toEqual(['flagged', 'mon-1', 'tw:a'])
    expect(rankInsert(['flagged', 'mon-1', 'tw:a'], 'mon-2', MONITORS)).toEqual([
      'flagged',
      'mon-1',
      'mon-2',
      'tw:a'
    ])
  })

  it('appends a chat column after everything', () => {
    expect(rankInsert(['flagged', 'mon-1', 'tw:a'], 'yt:b', MONITORS)).toEqual([
      'flagged',
      'mon-1',
      'tw:a',
      'yt:b'
    ])
  })
})

describe('reconcileColumnOrder', () => {
  it('slots a late-hydrating monitor second, after the flagged view — not rightmost', () => {
    // The reported bug: channels arrive before settings hydrate, so the monitor view used to be
    // appended after every chat column.
    const prev = ['flagged', 'tw:a', 'yt:b']
    const next = reconcileColumnOrder(prev, {
      flaggedVisible: true,
      monitorIds: new Set(['mon-1']),
      channelIds: ['tw:a', 'yt:b']
    })
    expect(next).toEqual(['flagged', 'mon-1', 'tw:a', 'yt:b'])
  })

  it('without a flagged view, a monitor leads; a flagged view appearing later takes precedence', () => {
    const noFlag = reconcileColumnOrder(['tw:a'], {
      flaggedVisible: false,
      monitorIds: new Set(['mon-1']),
      channelIds: ['tw:a']
    })
    expect(noFlag).toEqual(['mon-1', 'tw:a'])
    const withFlag = reconcileColumnOrder(noFlag, {
      flaggedVisible: true,
      monitorIds: new Set(['mon-1']),
      channelIds: ['tw:a']
    })
    expect(withFlag).toEqual(['flagged', 'mon-1', 'tw:a'])
  })

  it('leaves explicitly arranged columns where the session put them', () => {
    // The user moved a chat ahead of the monitor: membership reconciles must not "fix" that.
    const prev = ['flagged', 'tw:a', 'mon-1', 'yt:b']
    const next = reconcileColumnOrder(prev, {
      flaggedVisible: true,
      monitorIds: new Set(['mon-1']),
      channelIds: ['tw:a', 'yt:b']
    })
    expect(next).toBe(prev) // unchanged → same reference, caller skips the re-render
  })

  it('drops removed columns and keeps the rest in place', () => {
    const next = reconcileColumnOrder(['flagged', 'mon-1', 'tw:a', 'yt:b'], {
      flaggedVisible: true,
      monitorIds: new Set(['mon-1']),
      channelIds: ['yt:b'] // tw:a was closed
    })
    expect(next).toEqual(['flagged', 'mon-1', 'yt:b'])
  })

  it('restores the persisted arrangement once, rank-slotting ids the stored order does not name', () => {
    // Stored order says the user keeps a chat leftmost; a new monitor (not in the stored list)
    // still slots by the default rule among what remains.
    const prev = ['flagged', 'mon-1', 'tw:a', 'yt:b'] // default order built pre-hydration
    const next = reconcileColumnOrder(prev, {
      flaggedVisible: true,
      monitorIds: new Set(['mon-1']),
      channelIds: ['tw:a', 'yt:b'],
      stored: ['tw:a', 'flagged', 'yt:b'] // explicit arrangement from the last session
    })
    expect(next).toEqual(['mon-1', 'tw:a', 'flagged', 'yt:b'])
  })

  it('ignores stored ids that no longer exist', () => {
    const next = reconcileColumnOrder(['tw:a'], {
      flaggedVisible: false,
      monitorIds: new Set<string>(),
      channelIds: ['tw:a'],
      stored: ['yt:gone', 'tw:a']
    })
    expect(next).toEqual(['tw:a'])
  })
})
