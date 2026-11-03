import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatEvent, ChatMessage } from '@shared/model'
import { StreamLogger } from '@main/chatLog/StreamLogger'
import { messageLine } from '@main/chatLog/logLines'
import { type ColumnState, streamTargetFor } from '@main/chatLog/streamTarget'
import {
  type ScanOptions,
  type ScanResult,
  listLogFiles,
  scanLogFiles,
  scanUserHistory
} from '@main/chatLog/userHistoryScan'

const dir = join(tmpdir(), `pogchatter-userhistory-${process.pid}`)
const TARGET = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const OTHER = 'UCbbbbbbbbbbbbbbbbbbbbbb'
const CREATOR_A = 'UCcccccccccccccccccccccc'
const CREATOR_B = 'UCdddddddddddddddddddddd'
const VIDEO_A1 = 'AbCdEfGhIj0'
const VIDEO_A2 = 'AbCdEfGhIj1'
const VIDEO_B1 = 'ZyXwVuTsRq9'
const EMOTE_URL = 'https://yt3.ggpht.com/abcDEF123=w24-h24-c-k-nd'
const BASE = Date.parse('2026-11-01T19:00:00Z')

/** Each video column belongs to one creator; the stream started an hour before BASE. */
function defaultColumns(): Record<string, ColumnState> {
  return {
    [`youtube:${VIDEO_A1}`]: column(VIDEO_A1, CREATOR_A, 'First stream'),
    [`youtube:${VIDEO_A2}`]: column(VIDEO_A2, CREATOR_A, 'Second stream'),
    [`youtube:${VIDEO_B1}`]: column(VIDEO_B1, CREATOR_B, 'Other creator')
  }
}
let columns = defaultColumns()

function column(video: string, creatorId: string, title: string): ColumnState {
  return {
    channelId: `youtube:${video}`,
    platform: 'youtube',
    creatorId,
    stream: { key: video, title, startedAt: BASE - 3_600_000 }
  }
}

let clock = BASE + 3_600_000

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
  clock = BASE + 3_600_000
  columns = defaultColumns()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function chat(id: string, video: string, author: string, at: number, text = 'hi'): ChatEvent {
  const message: ChatMessage = {
    id,
    platform: 'youtube',
    channelId: `youtube:${video}`,
    timestamp: at,
    author: {
      id: author,
      name: author === TARGET ? '@ada_l' : '@bob',
      displayName: author === TARGET ? 'Ada' : 'Bob',
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments: [{ type: 'text', text }]
  }
  return { kind: 'message', channelId: message.channelId, message }
}

/** Write events through the real logger, so the files are exactly what the app writes. */
async function writeLogs(events: ChatEvent[]): Promise<void> {
  const logger = new StreamLogger(
    dir,
    (channelId, at) => streamTargetFor(columns[channelId]!, at),
    {
      now: () => clock
    }
  )
  for (const event of events) {
    logger.record(event)
  }
  await logger.close()
}

function options(over: Partial<ScanOptions> = {}): ScanOptions {
  return {
    dir,
    platform: 'youtube',
    userId: TARGET,
    cap: 2000,
    onProgress: () => {},
    cancelled: () => false,
    ...over
  }
}

function ok(result: ScanResult): ScanResult & { ok: true } {
  if (!result.ok) {
    throw new Error(`scan failed: ${result.error}`)
  }
  return result
}

function replaceOf(event: ChatEvent): ChatEvent {
  if (event.kind !== 'message') {
    throw new Error('replaceOf needs a message event')
  }
  return { kind: 'replace', channelId: event.channelId, message: event.message }
}

/** One user across two creators, with every kind of moderation line. */
async function writeSession(): Promise<void> {
  const held = chat('held-1', VIDEO_A1, TARGET, BASE + 3, 'held text')
  if (held.kind === 'message') {
    held.message.held = { headerText: 'Held', actions: [] }
  }
  const shown = chat('held-1', VIDEO_A1, TARGET, BASE + 3, 'held text')
  const emote = chat('a1-emote', VIDEO_A1, TARGET, BASE + 4)
  if (emote.kind === 'message') {
    emote.message.fragments = [
      { type: 'text', text: 'look ' },
      { type: 'emote', code: ':yt:', url: EMOTE_URL, provider: 'youtube' }
    ]
  }
  await writeLogs([
    chat('a1-1', VIDEO_A1, TARGET, BASE + 1, 'first'),
    chat('a1-2', VIDEO_A1, TARGET, BASE + 2, 'second'),
    chat('a1-other', VIDEO_A1, OTHER, BASE + 2, `quote "uid":"${TARGET}"`),
    { kind: 'clear', channelId: `youtube:${VIDEO_A1}`, target: { messageId: 'a1-2' } },
    held,
    replaceOf(shown),
    emote,
    chat('b1-1', VIDEO_B1, TARGET, BASE + 10, 'elsewhere'),
    chat('b1-other', VIDEO_B1, OTHER, BASE + 11),
    // Another user's later state: a `replace` line carries a kind, so it passes the byte filter.
    replaceOf(chat('b1-other', VIDEO_B1, OTHER, BASE + 11, 'edited'))
  ])
  clock = BASE + 20
  await writeLogs([
    { kind: 'clear', channelId: `youtube:${VIDEO_B1}`, target: { userId: TARGET } },
    chat('b1-after', VIDEO_B1, TARGET, BASE + 30, 'after the timeout')
  ])
}

describe('scanUserHistory', () => {
  it("finds one user's messages across creators, with removals and replacements applied", async () => {
    await writeSession()
    const result = ok(await scanUserHistory(options()))
    expect(result.rows.map((row) => row.message.id)).toEqual([
      'a1-1',
      'a1-2',
      'held-1',
      'a1-emote',
      'b1-1',
      'b1-after'
    ])
    const byId = new Map(result.rows.map((row) => [row.message.id, row.message]))
    expect(byId.get('a1-2')?.deleted).toBe(true)
    expect(byId.get('a1-1')?.deleted).toBeUndefined()
    expect(byId.get('held-1')?.held).toBeUndefined()
    expect(byId.get('b1-1')?.deleted).toBe(true)
    expect(byId.get('b1-after')?.deleted).toBeUndefined()
    expect(byId.get('a1-emote')?.fragments).toEqual([
      { type: 'text', text: 'look ' },
      { type: 'emote', code: ':yt:', url: EMOTE_URL, provider: 'youtube' }
    ])
    expect(result.total).toBe(6)
    expect(result.truncated).toBe(false)
    expect(result.malformedLines).toBe(0)
    expect(result.failures).toEqual([])
    expect(result.filesScanned).toBe(2)
  })

  it('names each stream from its header, and links every row to one', async () => {
    await writeSession()
    const result = ok(await scanUserHistory(options()))
    expect(result.streams).toEqual([
      {
        id: `${CREATOR_A}/${VIDEO_A1}`,
        platform: 'youtube',
        owner: CREATOR_A,
        streamKey: VIDEO_A1,
        channelId: `youtube:${VIDEO_A1}`,
        title: 'First stream',
        startedAt: BASE - 3_600_000
      },
      {
        id: `${CREATOR_B}/${VIDEO_B1}`,
        platform: 'youtube',
        owner: CREATOR_B,
        streamKey: VIDEO_B1,
        channelId: `youtube:${VIDEO_B1}`,
        title: 'Other creator',
        startedAt: BASE - 3_600_000
      }
    ])
    const streamIds = new Set(result.streams.map((stream) => stream.id))
    expect(result.rows.every((row) => streamIds.has(row.streamId))).toBe(true)
  })

  it('reads rotated archives as part of their stream', async () => {
    await writeLogs([chat('old-1', VIDEO_A2, TARGET, BASE + 1)])
    const owner = join(dir, 'youtube', CREATOR_A)
    renameSync(
      join(owner, `${VIDEO_A2}.jsonl`),
      join(owner, `${VIDEO_A2}.2026-11-01-10-00-00.jsonl`)
    )
    await writeLogs([chat('new-1', VIDEO_A2, TARGET, BASE + 2)])
    const result = ok(await scanUserHistory(options()))
    expect(result.rows.map((row) => row.message.id)).toEqual(['old-1', 'new-1'])
    expect(result.streams.map((stream) => stream.id)).toEqual([`${CREATOR_A}/${VIDEO_A2}`])
    expect(readdirSync(owner)).toHaveLength(2)
  })

  it('gives the same result whatever order the files are listed in', async () => {
    await writeSession()
    await writeLogs([chat('a2-1', VIDEO_A2, TARGET, BASE + 5)])
    const { files } = await listLogFiles(dir, 'youtube')
    const forward = ok(await scanLogFiles(files, options()))
    const backward = ok(await scanLogFiles([...files].reverse(), options()))
    expect(backward).toEqual(forward)
  })

  it('counts a message logged in two streams once, keeping the later stream', async () => {
    const early = column(VIDEO_A1, CREATOR_A, 'First stream')
    const late = column(VIDEO_A2, CREATOR_A, 'Second stream')
    if (late.stream !== undefined) {
      late.stream.startedAt = BASE
    }
    columns[`youtube:${VIDEO_A1}`] = early
    columns[`youtube:${VIDEO_A2}`] = late
    await writeLogs([chat('dup-1', VIDEO_A1, TARGET, BASE + 1)])
    await writeLogs([chat('dup-1', VIDEO_A2, TARGET, BASE + 1)])
    const result = ok(await scanUserHistory(options()))
    expect(result.total).toBe(1)
    expect(result.rows.map((row) => row.streamId)).toEqual([`${CREATOR_A}/${VIDEO_A2}`])
  })

  it('keeps the newest messages up to the cap and says how many there were', async () => {
    await writeLogs([1, 2, 3, 4, 5].map((n) => chat(`m${n}`, VIDEO_A1, TARGET, BASE + n)))
    const result = ok(await scanUserHistory(options({ cap: 3 })))
    expect(result.rows.map((row) => row.message.id)).toEqual(['m3', 'm4', 'm5'])
    expect(result.total).toBe(5)
    expect(result.truncated).toBe(true)
  })

  it('stays bounded and exact when far more messages than the cap are found', async () => {
    const events = Array.from({ length: 50 }, (_, n) => chat(`n${n}`, VIDEO_A1, TARGET, BASE + n))
    await writeLogs(events)
    const result = ok(await scanUserHistory(options({ cap: 4 })))
    expect(result.rows.map((row) => row.message.id)).toEqual(['n46', 'n47', 'n48', 'n49'])
    expect(result.total).toBe(50)
  })

  it('counts malformed lines and skips the live tail without counting it', async () => {
    await writeLogs([chat('a1-1', VIDEO_A1, TARGET, BASE + 1)])
    const path = join(dir, 'youtube', CREATOR_A, `${VIDEO_A1}.jsonl`)
    appendFileSync(path, `{"t":1,"id":"broken","uid":"${TARGET}"\n`)
    appendFileSync(path, `{"t":"x","id":"bad","uid":"${TARGET}","u":"Ada","m":"x"}\n`)
    appendFileSync(path, `{"t":2,"id":"tail","uid":"${TARGET}","u":"Ada","m":"still writi`)
    const result = ok(await scanUserHistory(options()))
    expect(result.rows.map((row) => row.message.id)).toEqual(['a1-1'])
    expect(result.malformedLines).toBe(2)
  })

  it('skips a line too long to be a log line, and reads the lines after it', async () => {
    const owner = join(dir, 'youtube', CREATOR_A)
    mkdirSync(owner, { recursive: true })
    const after = chat('after-long', VIDEO_A1, TARGET, BASE + 1)
    const line = after.kind === 'message' ? JSON.stringify(messageLine(after.message)) : ''
    writeFileSync(join(owner, 'long.jsonl'), `${'x'.repeat(3 * 1024 * 1024)}\n${line}\n`)
    const result = ok(await scanUserHistory(options()))
    expect(result.rows.map((row) => row.message.id)).toEqual(['after-long'])
    expect(result.malformedLines).toBe(1)
  })

  it('reports a file it cannot read and still returns the others', async () => {
    await writeSession()
    const { files } = await listLogFiles(dir, 'youtube')
    const missing = {
      path: join(dir, 'youtube', CREATOR_A, 'gone.jsonl'),
      relative: 'youtube/x/gone.jsonl',
      bytes: 10
    }
    const result = ok(await scanLogFiles([...files, missing], options()))
    expect(result.rows).toHaveLength(6)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.file).toBe('youtube/x/gone.jsonl')
  })

  it('returns an empty history when nothing was ever logged on that platform', async () => {
    await writeSession()
    const result = ok(await scanUserHistory(options({ platform: 'twitch', userId: '123456789' })))
    expect(result).toMatchObject({ rows: [], streams: [], total: 0, filesScanned: 0, failures: [] })
  })

  it('fails, rather than reporting nothing, when the platform directory cannot be listed', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'youtube'), 'not a directory')
    const result = await scanUserHistory(options())
    expect(result.ok).toBe(false)
  })

  it('stops when cancelled', async () => {
    await writeSession()
    const result = await scanUserHistory(options({ cancelled: () => true }))
    expect(result).toEqual({ ok: false, error: 'cancelled' })
  })

  it('reports progress through to every byte of every file', async () => {
    await writeSession()
    const seen: Array<{ bytesDone: number; bytesTotal: number; filesDone: number }> = []
    await scanUserHistory(options({ onProgress: (progress) => seen.push(progress) }))
    const last = seen.at(-1)
    expect(last?.filesDone).toBe(2)
    expect(last?.bytesDone).toBe(last?.bytesTotal)
    expect(last?.bytesTotal).toBeGreaterThan(0)
  })
})

/** Rename a stream's live file the way StreamLogger rotates one past its size limit. */
function rotate(video: string, owner: string, stamp: string): void {
  const folder = join(dir, 'youtube', owner)
  renameSync(join(folder, `${video}.jsonl`), join(folder, `${video}.${stamp}.jsonl`))
}

function clearUser(video: string, userId: string): ChatEvent {
  return { kind: 'clear', channelId: `youtube:${video}`, target: { userId } }
}

function held(id: string, video: string, at: number): ChatEvent {
  const event = chat(id, video, TARGET, at, 'held text')
  if (event.kind === 'message') {
    event.message.held = { headerText: 'Held', actions: [] }
  }
  return event
}

describe('scanUserHistory across a stream’s files and removal order', () => {
  it('applies a removal in the live file to a message in its rotated archive', async () => {
    await writeLogs([
      chat('old-del', VIDEO_A1, TARGET, BASE + 1),
      chat('old-ban', VIDEO_A1, TARGET, BASE + 2)
    ])
    rotate(VIDEO_A1, CREATOR_A, '2026-11-01-10-00-00')
    clock = BASE + 10
    await writeLogs([
      { kind: 'clear', channelId: `youtube:${VIDEO_A1}`, target: { messageId: 'old-del' } },
      clearUser(VIDEO_A1, TARGET)
    ])
    const result = ok(await scanUserHistory(options()))
    expect(result.rows.map((row) => [row.message.id, row.message.deleted])).toEqual([
      ['old-del', true],
      ['old-ban', true]
    ])
    expect(result.streams.map((stream) => stream.id)).toEqual([`${CREATOR_A}/${VIDEO_A1}`])
  })

  it('lets a later state in the live file override the archived one', async () => {
    await writeLogs([held('held-a', VIDEO_A1, BASE + 1)])
    rotate(VIDEO_A1, CREATOR_A, '2026-11-01-10-00-00')
    await writeLogs([replaceOf(chat('held-a', VIDEO_A1, TARGET, BASE + 1, 'approved text'))])
    const [row] = ok(await scanUserHistory(options())).rows
    expect(row?.message.held).toBeUndefined()
    expect(row?.message.fragments).toEqual([{ type: 'text', text: 'approved text' }])
  })

  it('reads a stream’s archives before its live file whatever the listing order', async () => {
    await writeLogs([held('held-b', VIDEO_A1, BASE + 1)])
    rotate(VIDEO_A1, CREATOR_A, '2026-11-01-09-00-00')
    await writeLogs([replaceOf(chat('held-b', VIDEO_A1, TARGET, BASE + 1, 'shown'))])
    rotate(VIDEO_A1, CREATOR_A, '2026-11-01-11-00-00')
    await writeLogs([chat('live-1', VIDEO_A1, TARGET, BASE + 2)])
    const { files } = await listLogFiles(dir, 'youtube')
    const forward = ok(await scanLogFiles(files, options()))
    expect(forward.rows[0]?.message.held).toBeUndefined()
    expect(ok(await scanLogFiles([...files].reverse(), options()))).toEqual(forward)
  })

  it('deletes an older message logged after the removal that covers it', async () => {
    clock = BASE + 20
    await writeLogs([
      clearUser(VIDEO_A1, TARGET),
      { kind: 'clear', channelId: `youtube:${VIDEO_A1}`, target: { messageId: 'late-del' } },
      // Backlog arriving after the live removals, then a message sent after them.
      chat('late-ban', VIDEO_A1, TARGET, BASE + 5),
      chat('late-del', VIDEO_A1, TARGET, BASE + 30),
      chat('after', VIDEO_A1, TARGET, BASE + 40)
    ])
    clock = BASE + 60
    await writeLogs([{ kind: 'clear', channelId: `youtube:${VIDEO_B1}`, target: {} }])
    clock = BASE + 70
    await writeLogs([chat('late-all', VIDEO_B1, TARGET, BASE + 50)])
    const rows = ok(await scanUserHistory(options())).rows
    expect(rows.map((row) => [row.message.id, row.message.deleted === true])).toEqual([
      ['late-ban', true],
      ['late-del', true],
      ['after', false],
      ['late-all', true]
    ])
  })

  it('shows a removed held message as removed, not as awaiting review', async () => {
    await writeLogs([
      held('held-c', VIDEO_A1, BASE + 1),
      { kind: 'clear', channelId: `youtube:${VIDEO_A1}`, target: { messageId: 'held-c' } }
    ])
    const [row] = ok(await scanUserHistory(options())).rows
    expect(row?.message.deleted).toBe(true)
    expect(row?.message.held).toBeUndefined()
  })

  it('skips an oversized line even when it ends in a later chunk', async () => {
    const big = chat('huge', VIDEO_A1, TARGET, BASE + 1, 'x'.repeat(1.5 * 1024 * 1024))
    await writeLogs([big, chat('small', VIDEO_A1, TARGET, BASE + 2)])
    const result = ok(await scanUserHistory(options()))
    expect(result.rows.map((row) => row.message.id)).toEqual(['small'])
    expect(result.malformedLines).toBe(1)
  })

  // chmod can't make a directory unreadable on Windows, or to root.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an owner directory it cannot list and still returns the others',
    async () => {
      await writeSession()
      const blocked = join(dir, 'youtube', CREATOR_B)
      chmodSync(blocked, 0o000)
      try {
        const result = ok(await scanUserHistory(options()))
        expect(result.rows.every((row) => row.streamId.startsWith(CREATOR_A))).toBe(true)
        expect(result.rows.length).toBeGreaterThan(0)
        expect(result.failures.map((failure) => failure.file)).toEqual([`youtube/${CREATOR_B}/`])
      } finally {
        chmodSync(blocked, 0o755)
      }
    }
  )
})

describe('scanUserHistory per-file state within a stream', () => {
  const LUL = 'https://static-cdn.jtvnw.net/emoticons/v2/425618/default/dark/1.0'

  it('uses each file’s own emote definitions', async () => {
    const withEmote = chat('emote-old', VIDEO_A1, TARGET, BASE + 1)
    if (withEmote.kind === 'message') {
      withEmote.message.fragments = [{ type: 'emote', code: 'LUL', url: LUL, provider: 'twitch' }]
    }
    await writeLogs([withEmote])
    rotate(VIDEO_A1, CREATOR_A, '2026-11-01-10-00-00')
    await writeLogs([chat('plain-new', VIDEO_A1, TARGET, BASE + 2, 'LUL')])
    const rows = ok(await scanUserHistory(options())).rows
    expect(rows.map((row) => row.message.fragments[0]?.type)).toEqual(['emote', 'text'])
  })

  it('keeps what a later file’s header knows about the stream', async () => {
    columns[`youtube:${VIDEO_A1}`] = {
      channelId: `youtube:${VIDEO_A1}`,
      platform: 'youtube',
      creatorId: CREATOR_A,
      stream: { key: VIDEO_A1 }
    }
    await writeLogs([chat('before-title', VIDEO_A1, TARGET, BASE + 1)])
    rotate(VIDEO_A1, CREATOR_A, '2026-11-01-10-00-00')
    columns = defaultColumns()
    await writeLogs([chat('after-title', VIDEO_A1, TARGET, BASE + 2)])
    const [stream] = ok(await scanUserHistory(options())).streams
    expect(stream?.title).toBe('First stream')
    expect(stream?.startedAt).toBe(BASE - 3_600_000)
  })

  it('remembers only the most recent removals for messages logged after them', async () => {
    const removals: ChatEvent[] = Array.from({ length: 10_001 }, (_, n) => ({
      kind: 'clear',
      channelId: `youtube:${VIDEO_A1}`,
      target: { messageId: `gone-${n}` }
    }))
    await writeLogs([
      ...removals,
      chat('gone-0', VIDEO_A1, TARGET, BASE + 1),
      chat('gone-10000', VIDEO_A1, TARGET, BASE + 2)
    ])
    const rows = ok(await scanUserHistory(options())).rows
    expect(rows.map((row) => [row.message.id, row.message.deleted === true])).toEqual([
      ['gone-0', false],
      ['gone-10000', true]
    ])
  })
})

describe('scanUserHistory keeps removals through later states and copies', () => {
  it('keeps a del on a known row however many removals follow, through a later replace', async () => {
    const others: ChatEvent[] = Array.from({ length: 10_001 }, (_, n) => ({
      kind: 'clear',
      channelId: `youtube:${VIDEO_A1}`,
      target: { messageId: `other-${n}` }
    }))
    await writeLogs([
      chat('kept-del', VIDEO_A1, TARGET, BASE + 1),
      { kind: 'clear', channelId: `youtube:${VIDEO_A1}`, target: { messageId: 'kept-del' } },
      ...others,
      replaceOf(chat('kept-del', VIDEO_A1, TARGET, BASE + 1, 'edited'))
    ])
    const [row] = ok(await scanUserHistory(options())).rows
    expect(row?.message.deleted).toBe(true)
  })

  it('lets a held review be shown again after it was hidden', async () => {
    const hidden = chat('review', VIDEO_A1, TARGET, BASE + 1, 'held text')
    if (hidden.kind === 'message') {
      hidden.message.deleted = true
    }
    await writeLogs([
      held('review', VIDEO_A1, BASE + 1),
      replaceOf(hidden),
      replaceOf(chat('review', VIDEO_A1, TARGET, BASE + 1, 'held text'))
    ])
    const [row] = ok(await scanUserHistory(options())).rows
    expect(row?.message.deleted).toBeUndefined()
  })

  it('keeps a removal seen in either copy of a message logged in two streams', async () => {
    const late = column(VIDEO_A2, CREATOR_A, 'Second stream')
    if (late.stream !== undefined) {
      late.stream.startedAt = BASE
    }
    columns[`youtube:${VIDEO_A2}`] = late
    await writeLogs([
      chat('dup-del', VIDEO_A1, TARGET, BASE + 1),
      { kind: 'clear', channelId: `youtube:${VIDEO_A1}`, target: { messageId: 'dup-del' } }
    ])
    await writeLogs([chat('dup-del', VIDEO_A2, TARGET, BASE + 1)])
    const { files } = await listLogFiles(dir, 'youtube')
    for (const order of [files, [...files].reverse()]) {
      const [row] = ok(await scanLogFiles(order, options())).rows
      expect(row?.streamId).toBe(`${CREATOR_A}/${VIDEO_A2}`)
      expect(row?.message.deleted).toBe(true)
    }
  })

  it('counts only the files it could read', async () => {
    await writeSession()
    const { files } = await listLogFiles(dir, 'youtube')
    const missing = {
      path: join(dir, 'youtube', CREATOR_A, 'gone.jsonl'),
      relative: 'youtube/x/gone.jsonl',
      bytes: 1
    }
    const result = ok(await scanLogFiles([...files, missing], options()))
    expect(result.filesScanned).toBe(files.length)
  })
})

describe('scanUserHistory removal provenance', () => {
  it('keeps a removal logged before its message through many later removals and a replace', async () => {
    const others: ChatEvent[] = Array.from({ length: 10_001 }, (_, n) => ({
      kind: 'clear',
      channelId: `youtube:${VIDEO_A1}`,
      target: { messageId: `other-${n}` }
    }))
    await writeLogs([
      { kind: 'clear', channelId: `youtube:${VIDEO_A1}`, target: { messageId: 'early-del' } },
      chat('early-del', VIDEO_A1, TARGET, BASE + 1),
      ...others,
      replaceOf(chat('early-del', VIDEO_A1, TARGET, BASE + 1, 'edited'))
    ])
    const [row] = ok(await scanUserHistory(options())).rows
    expect(row?.message.deleted).toBe(true)
  })

  // Owner decision: a message hidden in either copy stays hidden, even when the preferred copy shows
  // it. The hide here arrives only as a deleted `replace`, with no del or clear line.
  it('keeps a message hidden when either copy of it was hidden', async () => {
    const late = column(VIDEO_A2, CREATOR_A, 'Second stream')
    if (late.stream !== undefined) {
      late.stream.startedAt = BASE
    }
    columns[`youtube:${VIDEO_A2}`] = late
    const hidden = chat('review-dup', VIDEO_A1, TARGET, BASE + 1, 'held text')
    if (hidden.kind === 'message') {
      hidden.message.deleted = true
    }
    await writeLogs([held('review-dup', VIDEO_A1, BASE + 1), replaceOf(hidden)])
    await writeLogs([chat('review-dup', VIDEO_A2, TARGET, BASE + 1, 'held text')])
    const { files } = await listLogFiles(dir, 'youtube')
    for (const order of [files, [...files].reverse()]) {
      const [row] = ok(await scanLogFiles(order, options())).rows
      expect(row?.streamId).toBe(`${CREATOR_A}/${VIDEO_A2}`)
      expect(row?.message.deleted).toBe(true)
    }
  })
})
