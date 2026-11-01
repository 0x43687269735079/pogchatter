import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatMessage } from '@shared/model'
import { StreamLogger, safeSegment } from '@main/chatLog/StreamLogger'
import { eventKey, lineKey, messageLine } from '@main/chatLog/logLines'
import { type ColumnState, streamTargetFor } from '@main/chatLog/streamTarget'

const dir = join(tmpdir(), `pogchatter-streamlog-${process.pid}`)
const CREATOR = 'UCxxxxxxxxxxxxxxxxxxxxxx'
const VIDEO = 'AbCdEfGhIj0'

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  // A failed assertion skips a test's own mockRestore; never let a console spy leak onward.
  vi.restoreAllMocks()
})

function msg(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    platform: 'youtube',
    channelId: `youtube:${VIDEO}`,
    timestamp: Date.parse('2026-11-01T19:07:32Z'),
    author: {
      id: 'UCaaaaaaaaaaaaaaaaaaaaaa',
      name: '@ada_l',
      displayName: 'Ada',
      color: '#ff0000',
      avatarUrl: 'https://yt3.example/avatar.jpg',
      badges: [{ type: 'member', label: 'Member', imageUrl: 'https://yt3.example/badge.png' }],
      roles: { broadcaster: false, moderator: false, member: true }
    },
    fragments: [{ type: 'text', text: 'hello' }],
    ...over
  }
}

const message = (m: ChatMessage, channelId = m.channelId): ChatEvent => ({
  kind: 'message',
  channelId,
  message: m
})

/** Every column reads one YouTube video of one creator unless a test says otherwise. */
const columns = new Map<string, ColumnState>()
function resolver(channelId: string, at: number): ReturnType<typeof streamTargetFor> {
  const column = columns.get(channelId) ?? {
    channelId,
    platform: 'youtube',
    creatorId: CREATOR,
    stream: { key: VIDEO, title: 'Stream title' }
  }
  return streamTargetFor(column, at)
}

function logger(): StreamLogger {
  return new StreamLogger(dir, resolver, { now: () => Date.parse('2026-11-01T20:00:00Z') })
}

function lines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const videoFile = join(dir, 'youtube', CREATOR, `${VIDEO}.jsonl`)

describe('StreamLogger', () => {
  beforeEach(() => {
    columns.clear()
  })

  it('writes a header, then one compact line per message, without badges or colours', async () => {
    const log = logger()
    log.record(message(msg('m1')))
    await log.close()
    const [header, line] = lines(videoFile)
    expect(header).toEqual({
      k: 'stream',
      v: 1,
      p: 'youtube',
      ch: `youtube:${VIDEO}`,
      key: VIDEO,
      creator: CREATOR,
      title: 'Stream title'
    })
    expect(line).toEqual({
      t: Date.parse('2026-11-01T19:07:32Z'),
      id: 'm1',
      uid: 'UCaaaaaaaaaaaaaaaaaaaaaa',
      u: 'Ada',
      h: '@ada_l',
      m: 'hello'
    })
  })

  it('opens nothing until there is something to log, and ignores UI events', async () => {
    const log = logger()
    log.record({ kind: 'status', channelId: `youtube:${VIDEO}`, status: { state: 'offline' } })
    await log.close()
    expect(existsSync(dir)).toBe(false)
  })

  it('files each stream separately, and shares one stream between its columns', async () => {
    columns.set('twitch:somechannel', {
      channelId: 'twitch:somechannel',
      platform: 'twitch',
      stream: { key: '2026-11-01_1830_40001234567', startedAt: 1 }
    })
    const log = logger()
    log.record(message(msg('m1')))
    log.record(message(msg('m1'), 'youtube:@ada_creator'))
    log.record(message(msg('m2'), 'youtube:@ada_creator'))
    log.record(message(msg('t1', { platform: 'twitch' }), 'twitch:somechannel'))
    await log.close()
    expect(lines(videoFile).map((line) => line['id'] ?? line['k'])).toEqual(['stream', 'm1', 'm2'])
    const twitch = join(dir, 'twitch', 'somechannel', '2026-11-01_1830_40001234567.jsonl')
    expect(lines(twitch).map((line) => line['id'] ?? line['k'])).toEqual(['stream', 't1'])
  })

  it('writes a definition line the first time each emote appears in a file', async () => {
    const wave = {
      type: 'emote' as const,
      code: ':wave:',
      url: 'https://yt3.example/wave.png',
      provider: 'youtube' as const
    }
    const log = logger()
    log.record(message(msg('m1', { fragments: [{ type: 'text', text: 'hi ' }, wave] })))
    log.record(message(msg('m2', { fragments: [wave, wave] })))
    log.record(message(msg('m3', { fragments: [{ ...wave, url: 'https://yt3.example/v2.png' }] })))
    await log.close()
    const body = lines(videoFile).slice(1)
    expect(body.map((line) => line['k'] ?? line['m'])).toEqual([
      'emote',
      'hi :wave:',
      ':wave::wave:',
      'emote',
      ':wave:'
    ])
    expect(body[0]).toEqual({ k: 'emote', c: ':wave:', url: 'https://yt3.example/wave.png' })
    expect(body[3]?.['url']).toBe('https://yt3.example/v2.png')
  })

  it('logs a removal and keeps the removed message', async () => {
    const log = logger()
    log.record(message(msg('m1')))
    log.record({ kind: 'clear', channelId: `youtube:${VIDEO}`, target: { messageId: 'm1' } })
    log.record({ kind: 'clear', channelId: `youtube:${VIDEO}`, target: { userId: 'UCbad' } })
    log.record({ kind: 'clear', channelId: `youtube:${VIDEO}`, target: {} })
    await log.close()
    const at = Date.parse('2026-11-01T20:00:00Z')
    expect(lines(videoFile).slice(1)).toEqual([
      expect.objectContaining({ id: 'm1', m: 'hello' }),
      { t: at, k: 'del', id: 'm1' },
      { t: at, k: 'clear-user', uid: 'UCbad' },
      { t: at, k: 'clear-all' }
    ])
  })

  it('files a removal or state change with its message after the column moves stream', async () => {
    const channel = 'twitch:somechannel'
    columns.set(channel, { channelId: channel, platform: 'twitch' })
    const log = logger()
    log.record(message(msg('early', { platform: 'twitch' }), channel))
    log.record(message(msg('held', { platform: 'twitch', held: { actions: [] } }), channel))
    columns.set(channel, {
      channelId: channel,
      platform: 'twitch',
      stream: { key: '2026-11-01_1830_40001234567', startedAt: 1 }
    })
    log.record({ kind: 'clear', channelId: channel, target: { messageId: 'early' } })
    log.record({
      kind: 'replace',
      channelId: channel,
      message: msg('held', { platform: 'twitch' })
    })
    log.record({
      kind: 'replace',
      channelId: channel,
      message: msg('held', { platform: 'twitch' })
    })
    log.record({ kind: 'clear', channelId: channel, target: { messageId: 'never-seen' } })
    log.record({ kind: 'clear', channelId: channel, target: { userId: 'u9' } })
    log.record(message(msg('later', { platform: 'twitch' }), channel))
    await log.close()
    const fallback = join(dir, 'twitch', 'somechannel', '2026-11-01_no-stream.jsonl')
    const live = join(dir, 'twitch', 'somechannel', '2026-11-01_1830_40001234567.jsonl')
    const describe = (line: Record<string, unknown>): string =>
      `${String(line['k'] ?? 'msg')}:${String(line['id'] ?? line['uid'] ?? '')}`
    expect(lines(fallback).map(describe)).toEqual([
      'stream:',
      'msg:early',
      'msg:held',
      'del:early',
      'replace:held'
    ])
    expect(lines(live).map(describe)).toEqual([
      'stream:',
      'del:never-seen',
      'clear-user:u9',
      'msg:later'
    ])
  })

  it('logs each held-message outcome once, however often YouTube re-sends it', async () => {
    const held = msg('h1', { held: { actions: [{ id: 'a', label: 'Show', token: 'tok' }] } })
    const log = logger()
    log.record(message(held))
    log.record({ kind: 'replace', channelId: held.channelId, message: held })
    const shown = msg('h1')
    log.record({ kind: 'replace', channelId: held.channelId, message: shown })
    log.record({ kind: 'replace', channelId: held.channelId, message: shown })
    await log.close()
    expect(lines(videoFile).slice(1)).toEqual([
      expect.objectContaining({ id: 'h1', held: 1 }),
      expect.objectContaining({ k: 'replace', id: 'h1', held: 1 }),
      expect.objectContaining({ k: 'replace', id: 'h1' })
    ])
  })

  it('does not re-log a restart replay, nor redefine emotes the file already defines', async () => {
    const wave = {
      type: 'emote' as const,
      code: ':wave:',
      url: 'https://yt3.example/wave.png',
      provider: 'youtube' as const
    }
    const first = logger()
    first.record(message(msg('m1', { fragments: [wave] })))
    first.record({ kind: 'clear', channelId: `youtube:${VIDEO}`, target: { messageId: 'm1' } })
    await first.close()
    const second = logger()
    second.record(message(msg('m1', { fragments: [wave] })))
    second.record({ kind: 'clear', channelId: `youtube:${VIDEO}`, target: { messageId: 'm1' } })
    second.record(message(msg('m2', { fragments: [wave] })))
    await second.close()
    const all = lines(videoFile)
    expect(all.filter((line) => line['k'] === 'stream')).toHaveLength(1)
    expect(all.filter((line) => line['k'] === 'emote')).toHaveLength(1)
    expect(all.filter((line) => line['id'] === 'm1' && line['k'] === undefined)).toHaveLength(1)
    expect(all.filter((line) => line['k'] === 'del')).toHaveLength(1)
    expect(all.at(-1)?.['id']).toBe('m2')
  })

  it('keeps writing correctly past the open-file limit', async () => {
    const log = logger()
    for (let round = 0; round < 2; round += 1) {
      for (let n = 0; n < 20; n += 1) {
        columns.set(`twitch:c${n}`, { channelId: `twitch:c${n}`, platform: 'twitch' })
        log.record(message(msg(`r${round}-${n}`, { platform: 'twitch' }), `twitch:c${n}`))
      }
    }
    await log.close()
    const file = join(dir, 'twitch', 'c3', '2026-11-01_no-stream.jsonl')
    expect(lines(file).map((line) => line['id'] ?? line['k'])).toEqual(['stream', 'r0-3', 'r1-3'])
  })

  it('stops logging, visibly, when a closing file queues past its bound', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = logger()
    for (let n = 0; n < 17; n += 1) {
      columns.set(`twitch:c${n}`, { channelId: `twitch:c${n}`, platform: 'twitch' })
      log.record(message(msg(`open-${n}`, { platform: 'twitch' }), `twitch:c${n}`))
    }
    // c0's stream was closed to stay under the limit and can't finish closing until this
    // synchronous loop yields, so every line here queues.
    for (let n = 0; n < 10_001; n += 1) {
      log.record(message(msg(`q-${n}`, { platform: 'twitch' }), 'twitch:c0'))
    }
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('logging disabled'),
      expect.objectContaining({ message: expect.stringContaining('never finished closing') })
    )
    log.record(message(msg('after', { platform: 'twitch' }), 'twitch:c1'))
    await log.close()
    const c1 = join(dir, 'twitch', 'c1', '2026-11-01_no-stream.jsonl')
    expect(readFileSync(c1, 'utf8')).not.toContain('"after"')
    error.mockRestore()
  })

  it('reads only the tail of a large file on reopen, keeping dedup for recent messages', async () => {
    mkdirSync(join(dir, 'youtube', CREATOR), { recursive: true })
    const filler = `${JSON.stringify({ t: 1, id: 'old', uid: 'x', u: 'x', m: 'x'.repeat(200) })}\n`
    const recent = `${JSON.stringify({ t: 2, id: 'recent', uid: 'x', u: 'x', m: 'hi' })}\n`
    writeFileSync(videoFile, filler.repeat(Math.ceil((5 * 1024 * 1024) / filler.length)) + recent)
    const log = logger()
    log.record(message(msg('recent')))
    log.record(message(msg('fresh')))
    await log.close()
    const tail = readFileSync(videoFile, 'utf8').trim().split('\n').slice(-2)
    expect(tail.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(['recent', 'fresh'])
  })

  it('keeps a hostile owner or stream name inside the log directory', async () => {
    columns.set('youtube:x', {
      channelId: 'youtube:x',
      platform: 'youtube',
      creatorId: '../../escape',
      stream: { key: '..\\..\\evil/../x' }
    })
    const log = logger()
    log.record(message(msg('m1'), 'youtube:x'))
    await log.close()
    // Separators become `_` and a leading run of dots collapses to one `_`.
    expect(readdirSync(join(dir, 'youtube'))).toEqual(['__.._escape'])
    expect(readdirSync(join(dir, 'youtube', '__.._escape'))).toEqual(['__.._evil_.._x.jsonl'])
  })

  it('disables itself on an unwritable directory instead of throwing', async () => {
    mkdirSync(join(dir, '..'), { recursive: true })
    writeFileSync(dir, 'not a directory')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = logger()
    expect(() => {
      log.record(message(msg('m1')))
      log.record(message(msg('m2')))
    }).not.toThrow()
    await log.close()
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })

  it('resolves close once, and a late event cannot reopen it', async () => {
    const log = logger()
    log.record(message(msg('m1')))
    await log.close()
    log.record(message(msg('m2')))
    await log.close()
    expect(lines(videoFile).map((line) => line['id'] ?? line['k'])).toEqual(['stream', 'm1'])
  })
})

describe('messageLine', () => {
  it('keeps content and paid-event essentials', () => {
    const line = messageLine(
      msg('m1', {
        highlight: { kind: 'superchat', displayAmount: '£5.00', color: '#ff0' },
        reply: { parentId: 'p1', parentAuthor: 'Bob', parentText: 'q', threadToken: 'secret-t' },
        fragments: [
          { type: 'text', text: 'gg ' },
          { type: 'mention', text: '@bob' },
          { type: 'gif', text: '[GIF]', url: 'https://media.example/x.gif', id: 'g1' }
        ]
      })
    )
    expect(line).toEqual({
      t: Date.parse('2026-11-01T19:07:32Z'),
      id: 'm1',
      uid: 'UCaaaaaaaaaaaaaaaaaaaaaa',
      u: 'Ada',
      h: '@ada_l',
      m: 'gg @bob[GIF]',
      r: 'p1',
      d: { k: 'superchat', amt: '£5.00' },
      media: ['https://media.example/x.gif']
    })
  })

  it('never carries the action tokens a message holds', () => {
    const text = JSON.stringify(
      messageLine(
        msg('m1', {
          menuToken: 'menu-secret',
          held: { actions: [{ id: 'a', label: 'Show', token: 'held-secret' }] },
          reply: { parentId: 'p', parentAuthor: 'B', parentText: 'q', threadToken: 'thread-secret' }
        })
      )
    )
    expect(text).not.toMatch(/secret/u)
    expect(text).toContain('"m":"hello"')
  })

  it('lists emote URLs in order only when one code stands for two images', () => {
    const emote = (url: string): ChatMessage['fragments'][number] => ({
      type: 'emote',
      code: 'same',
      url,
      provider: '7tv'
    })
    const space = { type: 'text' as const, text: ' ' }
    const clash = messageLine(
      msg('c', { fragments: [emote('https://a'), space, emote('https://b')] })
    )
    expect(clash.m).toBe('same same')
    expect(clash.e).toEqual(['https://a', 'https://b'])
    const repeat = messageLine(
      msg('r', { fragments: [emote('https://a'), space, emote('https://a')] })
    )
    expect(repeat.e).toBeUndefined()
  })

  it('omits the handle when it is the display name', () => {
    const line = messageLine(msg('m1', { author: { ...msg('x').author, name: 'Ada' } }))
    expect(line.h).toBeUndefined()
  })

  it('records a resub tenure apart from a gift count', () => {
    const resub = messageLine(msg('s', { highlight: { kind: 'subscription', months: 24 } }))
    const gift = messageLine(msg('g', { highlight: { kind: 'membership_gift', count: 5 } }))
    expect(resub.d).toEqual({ k: 'subscription', mo: 24 })
    expect(gift.d).toEqual({ k: 'membership_gift', n: 5 })
  })
})

describe('lineKey', () => {
  it('reads back the same dedup key the event was logged under', () => {
    const held = msg('h', { held: { actions: [] } })
    const events: ChatEvent[] = [
      message(msg('m')),
      { kind: 'replace', channelId: 'c', message: held },
      { kind: 'replace', channelId: 'c', message: msg('h', { deleted: true }) },
      { kind: 'replace', channelId: 'c', message: msg('h') },
      { kind: 'clear', channelId: 'c', target: { messageId: 'm' } }
    ]
    for (const event of events) {
      const line =
        event.kind === 'clear'
          ? { t: 0, k: 'del', id: event.target.messageId }
          : (messageLine(
              (event as { message: ChatMessage }).message,
              event.kind === 'replace'
            ) as unknown as Record<string, unknown>)
      expect(lineKey(line)).toBe(eventKey(event))
    }
  })

  it('gives identity-less and foreign lines no key', () => {
    expect(lineKey({ k: 'clear-all', t: 1 })).toBeUndefined()
    expect(lineKey({ k: 'stream' })).toBeUndefined()
    expect(lineKey({ id: 5 })).toBeUndefined()
  })
})

describe('streamTargetFor', () => {
  const at = Date.parse('2026-11-01T23:59:00Z')

  it('files YouTube by creator id and video id', () => {
    expect(
      streamTargetFor(
        {
          channelId: 'youtube:@ada_creator',
          platform: 'youtube',
          creatorId: CREATOR,
          stream: { key: VIDEO }
        },
        at
      )
    ).toEqual({
      platform: 'youtube',
      channelId: 'youtube:@ada_creator',
      owner: CREATOR,
      streamKey: VIDEO,
      creatorId: CREATOR
    })
  })

  it('files an event from before the broadcast started by its own date, not the broadcast', () => {
    const live: ColumnState = {
      channelId: 'twitch:somechannel',
      platform: 'twitch',
      stream: { key: '2026-11-01_1830_40001234567', startedAt: Date.parse('2026-11-01T18:30:00Z') }
    }
    const before = streamTargetFor(live, Date.parse('2026-10-31T22:00:00Z'))
    expect(before.streamKey).toBe('2026-10-31_no-stream')
    expect(before.startedAt).toBeUndefined()
    const during = streamTargetFor(live, Date.parse('2026-11-01T18:30:00Z'))
    expect(during.streamKey).toBe('2026-11-01_1830_40001234567')
  })

  it('falls back to the column and a dated file while nothing identifies the broadcast', () => {
    const target = streamTargetFor({ channelId: 'twitch:somechannel', platform: 'twitch' }, at)
    expect(target.owner).toBe('somechannel')
    expect(target.streamKey).toBe('2026-11-01_no-stream')
    const youtube = streamTargetFor({ channelId: 'youtube:@ada_creator', platform: 'youtube' }, at)
    expect(youtube.owner).toBe('@ada_creator')
  })
})

describe('safeSegment', () => {
  it('keeps ordinary ids and handles intact', () => {
    expect(safeSegment(CREATOR)).toBe(CREATOR)
    expect(safeSegment('@ada.l-2')).toBe('@ada.l-2')
  })

  it('suffixes names Windows reserves for devices, with or without an extension', () => {
    expect(safeSegment('com1')).toBe('com1-')
    expect(safeSegment('LPT9')).toBe('LPT9-')
    // Windows checks the part before the first dot, so the escape goes there.
    expect(safeSegment('nul.jsonl')).toBe('nul-.jsonl')
    expect(safeSegment('com10')).toBe('com10')
    expect(safeSegment('console')).toBe('console')
    // A valid login that looks like an escaped one keeps its own name.
    expect(safeSegment('com1_')).toBe('com1_')
    expect(safeSegment('com1_')).not.toBe(safeSegment('com1'))
  })

  it('neutralises separators, dot-prefixes and empty names', () => {
    expect(safeSegment('a/b\\c')).toBe('a_b_c')
    expect(safeSegment('..')).toBe('_')
    expect(safeSegment('')).toBe('_')
  })
})
