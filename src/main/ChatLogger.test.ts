import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatMessage } from '@shared/model'

// Mock the filesystem boundary so the test captures what the logger writes without real I/O timing.
// `existing` simulates the persisted chat.jsonl: its size drives rotation, its content drives seeding.
const fs = vi.hoisted(() => ({
  created: [] as string[],
  writes: [] as string[],
  mkdirs: [] as string[],
  renames: [] as Array<{ from: string; to: string }>,
  ended: 0,
  endCallbacks: [] as Array<(() => void) | undefined>,
  existing: undefined as { size: number; tail: string } | undefined,
  errorHandlers: [] as Array<(error: Error) => void>
}))
vi.mock('node:fs', () => ({
  mkdirSync: (dir: string): void => {
    fs.mkdirs.push(dir)
  },
  statSync: (): { size: number } => {
    if (fs.existing === undefined) {
      throw new Error('ENOENT')
    }
    return { size: fs.existing.size }
  },
  renameSync: (from: string, to: string): void => {
    fs.renames.push({ from, to })
    fs.existing = undefined
  },
  openSync: (): number => {
    if (fs.existing === undefined) {
      throw new Error('ENOENT')
    }
    return 3
  },
  readSync: (_fd: number, buffer: Buffer): number => {
    const tail = Buffer.from(fs.existing?.tail ?? '', 'utf8')
    tail.copy(buffer, 0, Math.max(0, tail.length - buffer.length))
    return Math.min(tail.length, buffer.length)
  },
  closeSync: (): void => {},
  createWriteStream: (path: string): unknown => {
    fs.created.push(path)
    return {
      write: (line: string): void => {
        fs.writes.push(line)
      },
      end: (callback?: () => void): void => {
        fs.ended += 1
        fs.endCallbacks.push(callback)
      },
      on: (event: string, handler: (error: Error) => void): void => {
        if (event === 'error') {
          fs.errorHandlers.push(handler)
        }
      }
    }
  }
}))

const { ChatLogger } = await import('@main/ChatLogger')

function message(id: string, channelId = 'youtube:c'): ChatEvent {
  const msg = { id, channelId, platform: 'youtube', timestamp: 0 } as ChatMessage
  return { kind: 'message', channelId, message: msg }
}

function reset(): void {
  fs.created.length = 0
  fs.writes.length = 0
  fs.mkdirs.length = 0
  fs.renames.length = 0
  fs.ended = 0
  fs.endCallbacks.length = 0
  fs.existing = undefined
  fs.errorHandlers.length = 0
}

describe('ChatLogger', () => {
  it('writes one JSONL line per message, opening the file lazily on the first event', () => {
    reset()
    const logger = new ChatLogger('/tmp/logs')
    expect(fs.created).toHaveLength(0) // nothing opened until an event arrives

    logger.record(message('m1'))
    logger.record(message('m2'))

    expect(fs.created).toHaveLength(1)
    expect(fs.created[0]).toMatch(/\/tmp\/logs\/chat\.jsonl$/)
    expect(fs.writes).toHaveLength(2)
    const first = JSON.parse(fs.writes[0]?.trimEnd() ?? '{}') as Record<string, unknown>
    expect(first['kind']).toBe('message')
    expect(fs.writes[0]?.endsWith('\n')).toBe(true)
  })

  it('logs a message and a later clear that deletes it (deleted message is preserved)', () => {
    reset()
    const logger = new ChatLogger('/tmp/logs')
    logger.record(message('doomed'))
    logger.record({ kind: 'clear', channelId: 'youtube:c', target: { messageId: 'doomed' } })

    expect(fs.writes).toHaveLength(2)
    expect(JSON.parse(fs.writes[0] ?? '{}')['message'].id).toBe('doomed')
    expect(JSON.parse(fs.writes[1] ?? '{}')['target'].messageId).toBe('doomed')
  })

  it('ignores non-message/clear events', () => {
    reset()
    const logger = new ChatLogger('/tmp/logs')
    logger.record({ kind: 'status', channelId: 'youtube:c', status: { state: 'live' } })
    logger.record({ kind: 'channels', channels: [] })

    expect(fs.created).toHaveLength(0)
    expect(fs.writes).toHaveLength(0)
  })

  it('ends the stream on close, and a late event cannot reopen it', () => {
    reset()
    const logger = new ChatLogger('/tmp/logs')
    logger.record(message('m'))
    void logger.close()
    expect(fs.ended).toBe(1)

    logger.record(message('after-close'))
    expect(fs.created).toHaveLength(1) // not reopened
    expect(fs.writes).toHaveLength(1)
  })

  it('close() resolves only once the stream flush completes, and a second close is a no-op', async () => {
    reset()
    const logger = new ChatLogger('/tmp/logs')
    logger.record(message('m'))

    let flushed = false
    const closed = logger.close().then(() => {
      flushed = true
    })
    expect(fs.ended).toBe(1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(flushed).toBe(false) // tail still buffered — nothing resolved yet

    fs.endCallbacks[0]?.() // the WriteStream finishes flushing
    await closed
    expect(flushed).toBe(true)

    await logger.close() // resolves immediately; the stream is already gone
    expect(fs.ended).toBe(1)
  })

  it('close() resolves immediately when nothing was ever logged', async () => {
    reset()
    const logger = new ChatLogger('/tmp/logs')
    await logger.close()
    expect(fs.ended).toBe(0)
  })

  it('drops a re-sent message id instead of logging a duplicate line', () => {
    reset()
    const logger = new ChatLogger('/tmp/logs')
    logger.record(message('dup'))
    logger.record(message('dup')) // YouTube re-sends recent items across polls
    logger.record({ kind: 'clear', channelId: 'youtube:c', target: { messageId: 'dup' } })
    logger.record({ kind: 'clear', channelId: 'youtube:c', target: { messageId: 'dup' } })

    expect(fs.writes).toHaveLength(2) // one message line + one clear line
  })

  it('seeds dedup from the existing file tail, so a restart backlog is not re-logged', () => {
    reset()
    const tail = [
      JSON.stringify({ at: 't', ...message('old-1') }),
      JSON.stringify({ at: 't', ...message('old-2') }),
      ''
    ].join('\n')
    fs.existing = { size: tail.length, tail }

    const logger = new ChatLogger('/tmp/logs')
    logger.record(message('old-1')) // replayed backlog
    logger.record(message('old-2'))
    logger.record(message('new-1'))

    expect(fs.writes).toHaveLength(1)
    expect(JSON.parse(fs.writes[0] ?? '{}')['message'].id).toBe('new-1')
  })

  it('disables logging on an async stream error instead of crashing', () => {
    reset()
    const logger = new ChatLogger('/tmp/logs')
    logger.record(message('m1'))
    expect(fs.errorHandlers).toHaveLength(1)

    fs.errorHandlers[0]?.(new Error('ENOSPC: no space left on device'))
    logger.record(message('m2'))

    expect(fs.created).toHaveLength(1) // no reopen attempt
    expect(fs.writes).toHaveLength(1) // m2 dropped, app alive
  })

  it('archives an oversized log before appending', () => {
    reset()
    fs.existing = { size: 300 * 1024 * 1024, tail: '' }

    const logger = new ChatLogger('/tmp/logs')
    logger.record(message('m'))

    expect(fs.renames).toHaveLength(1)
    expect(fs.renames[0]?.from).toMatch(/chat\.jsonl$/)
    expect(fs.renames[0]?.to).toMatch(/chat-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.jsonl$/)
    expect(fs.writes).toHaveLength(1)
  })
})
