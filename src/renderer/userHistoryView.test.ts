import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/model'
import type { UserHistoryResult, UserHistoryRow, UserHistoryStream } from '@shared/userHistory'
import { groupHistory, historyStatus } from '@renderer/userHistoryView'

type Found = UserHistoryResult & { ok: true }

const A: UserHistoryStream = {
  id: 'UCcccccccccccccccccccccc/AbCdEfGhIj0',
  platform: 'youtube',
  owner: 'UCcccccccccccccccccccccc',
  streamKey: 'AbCdEfGhIj0',
  channelId: 'youtube:AbCdEfGhIj0',
  startedAt: 2000
}
const B: UserHistoryStream = {
  id: 'UCdddddddddddddddddddddd/ZyXwVuTsRq9',
  platform: 'youtube',
  owner: 'UCdddddddddddddddddddddd',
  streamKey: 'ZyXwVuTsRq9',
  channelId: 'youtube:ZyXwVuTsRq9',
  startedAt: 1000
}
/** No start time: placed by its first message. */
const C: UserHistoryStream = {
  id: 'UCeeeeeeeeeeeeeeeeeeeeee/2026-11-01_no-stream',
  platform: 'youtube',
  owner: 'UCeeeeeeeeeeeeeeeeeeeeee',
  streamKey: '2026-11-01_no-stream',
  channelId: 'youtube:UCeeeeeeeeeeeeeeeeeeeeee'
}

function row(id: string, stream: UserHistoryStream, timestamp: number): UserHistoryRow {
  const message: ChatMessage = {
    id,
    platform: 'youtube',
    channelId: stream.channelId,
    timestamp,
    author: {
      id: 'UCaaaaaaaaaaaaaaaaaaaaaa',
      name: '@ada_l',
      displayName: 'Ada',
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments: [{ type: 'text', text: id }]
  }
  return { message, streamId: stream.id }
}

function found(rows: UserHistoryRow[], over: Partial<Found> = {}): Found {
  return {
    ok: true,
    requestId: 1,
    rows,
    streams: [A, B, C],
    total: rows.length,
    truncated: false,
    filesScanned: 3,
    malformedLines: 0,
    failures: [],
    ...over
  }
}

const ROWS = [
  row('a2', A, 2002),
  row('a1', A, 2001),
  row('b1', B, 1001),
  row('c1', C, 1500),
  row('b2', B, 1001)
]

const ids = (groups: ReturnType<typeof groupHistory>): string[][] =>
  groups.map((group) => [group.stream.id, ...group.rows.map((message) => message.id)])

describe('groupHistory', () => {
  it('orders streams by start (else first message) and rows by time then id', () => {
    expect(ids(groupHistory(found(ROWS), new Set()))).toEqual([
      [B.id, 'b1', 'b2'],
      [C.id, 'c1'],
      [A.id, 'a1', 'a2']
    ])
  })

  it('gives the same grouping for any order of rows and streams', () => {
    const expected = ids(groupHistory(found(ROWS), new Set()))
    const shuffled = found([...ROWS].reverse(), { streams: [C, A, B] })
    expect(ids(groupHistory(shuffled, new Set()))).toEqual(expected)
  })

  it('leaves out rows shown elsewhere, and a stream left with none', () => {
    const groups = groupHistory(found(ROWS), new Set(['c1', 'a2']))
    expect(ids(groups)).toEqual([
      [B.id, 'b1', 'b2'],
      [A.id, 'a1']
    ])
  })

  it('drops a row whose stream is missing from the result', () => {
    expect(groupHistory(found([row('x', A, 1)], { streams: [B] }), new Set())).toEqual([])
  })
})

describe('historyStatus', () => {
  it('says logging is off when nothing was ever logged and logging is off', () => {
    const status = historyStatus(found([], { filesScanned: 0 }), false)
    expect(status).toContain('Chat logging is off')
  })

  it('says there are no logs yet when logging is on but nothing was written', () => {
    expect(historyStatus(found([], { filesScanned: 0 }), true)).toBe(
      'No chat logs on this platform yet'
    )
  })

  it('says how many files were searched when the user never appears', () => {
    expect(historyStatus(found([], { filesScanned: 12 }), true)).toBe(
      'No logged messages in 12 log files'
    )
  })

  it('counts messages, streams and files', () => {
    expect(historyStatus(found(ROWS), true)).toBe(
      '5 logged messages in 3 streams, from 3 log files'
    )
  })

  it('says when only the newest messages are shown', () => {
    const status = historyStatus(found(ROWS, { total: 5813, truncated: true }), true)
    expect(status).toBe(`Newest 5 of ${(5813).toLocaleString()} logged messages, from 3 log files`)
  })

  it('reports unreadable files and lines', () => {
    const status = historyStatus(
      found(ROWS, {
        failures: [{ file: 'youtube/x/y.jsonl', error: 'EACCES' }],
        malformedLines: 2
      }),
      true
    )
    expect(status).toContain('1 file could not be read')
    expect(status).toContain('2 unreadable lines skipped')
  })

  it('says the logs could not be read, not that there are none, when nothing could be listed', () => {
    const status = historyStatus(
      found([], { filesScanned: 0, failures: [{ file: 'youtube/UCx/', error: 'EACCES' }] }),
      true
    )
    expect(status).toBe('Could not read the chat logs · 1 file could not be read')
  })
})

describe('historyStatus with rows recovered from a file that failed partway', () => {
  it('still counts what was found, beside the failure', () => {
    const rows = [row('a1', A, 2001)]
    const status = historyStatus(
      found(rows, { filesScanned: 0, failures: [{ file: 'youtube/x/y.jsonl', error: 'EIO' }] }),
      true
    )
    expect(status).toBe(
      '1 logged message in 3 streams, from files read only in part · 1 file could not be read'
    )
  })
})
