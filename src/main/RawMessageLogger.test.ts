import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RawMessageLogger, rawLogBytes } from '@main/RawMessageLogger'

// Real filesystem, under a fresh per-test tmp dir (as ConfigStore.test.ts does), so the byte-count
// and flush-on-close behaviour is exercised against real I/O rather than a mocked fs.
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pogchatter-rawlog-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function readLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('RawMessageLogger', () => {
  it('opens a new file when the local date rolls over, keeping the old one', async () => {
    let now = new Date(2026, 0, 15, 10, 0, 0)
    const logger = new RawMessageLogger(dir, () => now)

    logger.record('twitch', 'chan-a', 'raw one')
    now = new Date(2026, 0, 16, 9, 30, 0)
    logger.record('twitch', 'chan-a', 'raw two')
    await logger.close()

    // Stream file creation/flush is asynchronous; poll rather than assume it landed synchronously.
    await vi.waitFor(() => {
      expect(readdirSync(dir).sort()).toEqual([
        'twitch-2026-01-15.jsonl',
        'twitch-2026-01-16.jsonl'
      ])
    })
  })

  it('round-trips a Twitch string payload and a YouTube object payload through JSON.parse', async () => {
    const now = new Date(2026, 2, 1, 12, 0, 0)
    const logger = new RawMessageLogger(dir, () => now)

    logger.record('twitch', 'chan-a', 'PRIVMSG #chan :hello')
    logger.record(
      'youtube',
      'chan-b',
      { type: 'liveChatTextMessageRenderer', text: 'hi' },
      'recent-messages'
    )
    await logger.close()

    const [twitchLine] = readLines(join(dir, 'twitch-2026-03-01.jsonl'))
    expect(twitchLine).toMatchObject({
      platform: 'twitch',
      channelId: 'chan-a',
      source: 'live',
      raw: 'PRIVMSG #chan :hello'
    })
    expect(new Date(twitchLine?.['at'] as string).toISOString()).toBe(twitchLine?.['at'])

    const [youtubeLine] = readLines(join(dir, 'youtube-2026-03-01.jsonl'))
    expect(youtubeLine).toMatchObject({
      platform: 'youtube',
      channelId: 'chan-b',
      source: 'recent-messages',
      raw: { type: 'liveChatTextMessageRenderer', text: 'hi' }
    })
  })

  it('routes twitch and youtube records on the same day to two separate files', async () => {
    const now = new Date(2026, 5, 1, 8, 0, 0)
    const logger = new RawMessageLogger(dir, () => now)

    logger.record('twitch', 'chan-a', 'a')
    logger.record('youtube', 'chan-b', 'b')
    await logger.close()

    expect(readdirSync(dir).sort()).toEqual(['twitch-2026-06-01.jsonl', 'youtube-2026-06-01.jsonl'])
  })

  it('disables without throwing when the directory is unwritable, and no-ops further records', () => {
    const blocker = join(dir, 'blocker-file')
    writeFileSync(blocker, 'not a directory')
    const unwritableDir = join(blocker, 'sub')
    const logger = new RawMessageLogger(unwritableDir, () => new Date(2026, 0, 1))

    expect(() => logger.record('twitch', 'chan-a', 'x')).not.toThrow()

    const status = logger.status()
    expect(status.enabled).toBe(false)
    expect(status.disabledReason).toBeTruthy()

    expect(() => logger.record('twitch', 'chan-a', 'y')).not.toThrow()
    expect(existsSync(unwritableDir)).toBe(false)
  })

  it('close() resolves once the tail line has been flushed to disk', async () => {
    const now = new Date(2026, 3, 10, 14, 0, 0)
    const logger = new RawMessageLogger(dir, () => now)
    logger.record('twitch', 'chan-a', 'tail line')

    await logger.close()

    const lines = readLines(join(dir, 'twitch-2026-04-10.jsonl'))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.['raw']).toBe('tail line')
  })

  it('status().bytes reflects the combined size of every written file', async () => {
    let now = new Date(2026, 6, 4, 9, 0, 0)
    const logger = new RawMessageLogger(dir, () => now)
    expect(logger.status().bytes).toBe(0)

    // Past the 5s status() cache window, so the post-write check below recomputes rather than
    // reusing the pre-write (empty) reading cached above.
    now = new Date(now.getTime() + 6000)
    logger.record('twitch', 'chan-a', 'hello')
    logger.record('youtube', 'chan-b', 'world')
    await logger.close()

    const expectedBytes = readdirSync(dir).reduce(
      (total, name) => total + readFileSync(join(dir, name)).byteLength,
      0
    )
    expect(expectedBytes).toBeGreaterThan(0)
    expect(logger.status().bytes).toBe(expectedBytes)
  })
})

describe('RawMessageLogger under pressure and at rollover', () => {
  it('drops records while the stream is backed up rather than queueing them in memory', async () => {
    const logger = new RawMessageLogger(dir, () => new Date(2026, 0, 15, 10, 0, 0))
    // Larger than the write stream's high-water mark, so the first write reports backpressure.
    logger.record('twitch', 'chan-a', 'x'.repeat(64 * 1024))
    logger.record('twitch', 'chan-a', 'dropped while backed up')
    await logger.close()
    const lines = readLines(join(dir, 'twitch-2026-01-15.jsonl'))
    expect(lines).toHaveLength(1)
  })

  it('waits for a stream ended by a date rollover before close() resolves', async () => {
    let now = new Date(2026, 0, 15, 23, 59, 0)
    const logger = new RawMessageLogger(dir, () => now)
    logger.record('youtube', 'chan-a', { big: 'y'.repeat(64 * 1024) })
    now = new Date(2026, 0, 16, 0, 0, 1)
    logger.record('youtube', 'chan-a', { day: 2 })
    await logger.close()
    // Read immediately: the old day's tail must already be on disk.
    const old = readLines(join(dir, 'youtube-2026-01-15.jsonl'))
    expect(old).toHaveLength(1)
    const raw = old[0]?.['raw'] as { big: string } | undefined
    expect(raw?.big).toHaveLength(64 * 1024)
  })

  it('sizes retained files even when no logger is open', async () => {
    const logger = new RawMessageLogger(dir, () => new Date(2026, 0, 15, 10, 0, 0))
    logger.record('twitch', 'chan-a', 'kept after logging is turned off')
    await logger.close()
    expect(rawLogBytes(dir)).toBeGreaterThan(0)
    expect(rawLogBytes(join(dir, 'nope'))).toBe(0)
  })
})
