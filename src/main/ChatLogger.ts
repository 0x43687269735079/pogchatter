import {
  closeSync,
  createWriteStream,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  type WriteStream
} from 'node:fs'
import { join } from 'node:path'
import type { ChatEvent } from '@shared/model'

/** Rotate the log to a dated archive once it exceeds this size (checked when the file is opened). */
const ROTATE_BYTES = 256 * 1024 * 1024
/** How much of the existing file's tail to scan on open, to avoid re-logging a replayed backlog. */
const SEED_TAIL_BYTES = 512 * 1024
/** Recently-logged event keys remembered for dedup (YouTube re-sends recent items across polls/restarts). */
const SEEN_CAP = 8192

/**
 * Dedup key for a loggable event: the message id, or the cleared message's id. User- and whole-chat
 * clears have no stable identity and always log.
 */
function eventKey(event: ChatEvent): string | undefined {
  if (event.kind === 'message') {
    return `m:${event.message.id}`
  }
  if (event.kind === 'clear' && event.target.messageId !== undefined) {
    return `c:${event.target.messageId}`
  }
  return undefined
}

/**
 * Appends every chat message and moderation clear to one local JSONL file (one event per line),
 * across every open chat and every session, for a long-term moderation record that's easy to search.
 * Messages are recorded as they arrive — before any deletion is applied — so the log preserves
 * messages a moderator later removes; the matching `clear` events are logged too, so the record shows
 * what was deleted. Each line carries its `at` timestamp and `channelId`. Enabled from Settings → Chat
 * logging; off by default.
 *
 * The single `chat.jsonl` is opened lazily (append) on the first event, so a session with no chat
 * leaves it untouched. Events are deduplicated by message id — within the session and against the
 * tail of the existing file — because YouTube re-sends recent items across polls and replays a
 * backlog on every restart; without this the long-term record accumulates duplicates. An oversized
 * file is archived under a dated name on open so the live log stays bounded.
 *
 * Best-effort: any filesystem error (including an async write error such as a full disk or a
 * removed volume) disables logging for the session rather than breaking chat.
 */
export class ChatLogger {
  readonly #dir: string
  readonly #onOpen: (path: string) => void
  #stream: WriteStream | undefined
  #disabled = false
  /** Insertion-ordered recent event keys; the oldest is evicted past {@link SEEN_CAP}. */
  readonly #seen = new Set<string>()

  constructor(dir: string, onOpen: (path: string) => void = () => {}) {
    this.#dir = dir
    this.#onOpen = onOpen
  }

  /** The directory this logger writes to (so callers can detect a directory change). */
  get dir(): string {
    return this.#dir
  }

  /** Record a chat event. Only `message` and `clear` events are logged; the rest are ignored. */
  record(event: ChatEvent): void {
    if (event.kind !== 'message' && event.kind !== 'clear') {
      return
    }
    const stream = this.#ensureStream()
    if (stream === undefined) {
      return
    }
    const key = eventKey(event)
    if (key !== undefined) {
      if (this.#seen.has(key)) {
        return
      }
      this.#remember(key)
    }
    stream.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
  }

  /**
   * Close the log, resolving once buffered lines have flushed to disk (so a quit handler can
   * hold the app until the tail is safe). Terminal: a logger is replaced, not reopened, so late
   * events can't resurrect it. Safe to call twice; the second call resolves immediately.
   */
  close(): Promise<void> {
    this.#disabled = true
    const stream = this.#stream
    this.#stream = undefined
    if (stream === undefined) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      try {
        stream.end(() => {
          resolve()
        })
      } catch {
        // The stream was already destroyed by a write error — nothing left to flush.
        resolve()
      }
    })
  }

  #remember(key: string): void {
    this.#seen.add(key)
    if (this.#seen.size > SEEN_CAP) {
      for (const oldest of this.#seen) {
        this.#seen.delete(oldest)
        break
      }
    }
  }

  #ensureStream(): WriteStream | undefined {
    if (this.#stream !== undefined || this.#disabled) {
      return this.#stream
    }
    try {
      mkdirSync(this.#dir, { recursive: true })
      // One stable file, opened in append mode, so every session adds to the same long-term record.
      const path = join(this.#dir, 'chat.jsonl')
      this.#rotateIfHuge(path)
      this.#seedSeen(path)
      const stream = createWriteStream(path, { flags: 'a' })
      // The fd opens (and writes flush) asynchronously: without a listener, an 'error' event
      // (disk full, removed volume, revoked permissions) is an uncaught exception that would
      // take down the whole main process.
      stream.on('error', (error) => {
        console.error('Chat log write failed — logging disabled for this session:', error)
        this.#disabled = true
        this.#stream = undefined
      })
      this.#stream = stream
      this.#onOpen(path)
      return stream
    } catch {
      // Don't retry every event once the directory/file proved unwritable.
      this.#disabled = true
      return undefined
    }
  }

  /** Archive an oversized log under a dated name so the live `chat.jsonl` stays bounded. */
  #rotateIfHuge(path: string): void {
    try {
      if (statSync(path).size <= ROTATE_BYTES) {
        return
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      renameSync(path, join(this.#dir, `chat-${stamp}.jsonl`))
    } catch {
      // No existing file (nothing to rotate), or the rename failed — appending works either way.
    }
  }

  /** Seed dedup from the tail of the existing log, so a restart's replayed backlog isn't re-logged. */
  #seedSeen(path: string): void {
    let fd: number
    try {
      fd = openSync(path, 'r')
    } catch {
      return // no existing file — nothing to seed
    }
    try {
      const size = statSync(path).size
      const start = Math.max(0, size - SEED_TAIL_BYTES)
      const buffer = Buffer.alloc(Math.min(size, SEED_TAIL_BYTES))
      readSync(fd, buffer, 0, buffer.length, start)
      for (const line of buffer.toString('utf8').split('\n')) {
        if (line === '') {
          continue
        }
        try {
          const key = eventKey(JSON.parse(line) as ChatEvent)
          if (key !== undefined) {
            this.#remember(key)
          }
        } catch {
          // The first chunk of a truncated tail is a partial line — skip it.
        }
      }
    } catch {
      // Best-effort: failing to seed only risks duplicate lines, never broken logging.
    } finally {
      closeSync(fd)
    }
  }
}
