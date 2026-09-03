import { createWriteStream, mkdirSync, readdirSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { Platform, RawLogStatus } from '@shared/model'

/** How long a cached {@link RawMessageLogger.status} byte total stays valid, in `now()` time. */
const BYTES_CACHE_MS = 5000

/** One platform's currently-open raw log stream, and the local date it was opened for. */
interface OpenStream {
  stream: WriteStream
  dateKey: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Local (not UTC) calendar date of `date`, as `YYYY-MM-DD`. */
/** Bytes of raw log files in `dir`, whether or not a logger is open on it — retained logs still count. */
export function rawLogBytes(dir: string): number {
  let bytes = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) {
        continue
      }
      try {
        bytes += statSync(join(dir, name)).size
      } catch {
        // Removed between listing and stat.
      }
    }
  } catch {
    // No directory yet: nothing logged.
  }
  return bytes
}

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Appends every raw connector payload — the untouched wire message, before any parsing — to one
 * JSONL file per platform per local day. This is the ONE deliberate full-content sink besides the
 * human-readable chat log ({@link ChatLogger}): it exists to troubleshoot a platform's response
 * shape (a parser miss, an unrecognized action) against exactly what the platform sent, not a
 * reconstruction of it. Off by default; enabled from Settings → raw logging.
 *
 * A file is opened lazily (append) on the first record for a platform, so a session that never sees
 * a given platform leaves its file untouched. When the local calendar date rolls over, the day's
 * stream is closed and the next day's file is opened, keeping at most one open stream per platform.
 *
 * Best-effort: any stream error (disk full, removed volume, revoked permissions) or synchronous
 * write failure disables the logger for the rest of this instance's life — mirroring
 * {@link ChatLogger}'s posture that a session with unwritable storage degrades logging rather than
 * chat itself.
 */
export class RawMessageLogger {
  readonly #dir: string
  readonly #now: () => Date
  #disabled = false
  #disabledReason: string | undefined
  /** Set by {@link close}: distinct from {@link #disabled} so a deliberate close never reports a
   * fabricated error reason. Either flag stops further writes. */
  #closed = false
  readonly #streams = new Map<Platform, OpenStream>()
  #bytesCache: { at: number; bytes: number } | undefined
  /** Platforms whose stream reported backpressure; records are dropped until it drains. */
  readonly #paused = new Set<Platform>()
  /** Streams ended by a date rollover that have not flushed yet, so close() can wait for them. */
  readonly #ending = new Set<Promise<void>>()

  constructor(dir: string, now: () => Date = () => new Date()) {
    this.#dir = dir
    this.#now = now
  }

  /**
   * Record one raw connector payload for `platform`/`channelId`. `source` marks whether it arrived
   * live or from a chat-history backfill (defaults to `'live'`). A no-op once the logger is disabled.
   */
  record(
    platform: Platform,
    channelId: string,
    raw: unknown,
    source?: 'live' | 'recent-messages'
  ): void {
    if (this.#disabled || this.#closed || this.#paused.has(platform)) {
      return
    }
    const stream = this.#ensureStream(platform)
    if (stream === undefined) {
      return
    }
    const line = JSON.stringify({
      at: this.#now().toISOString(),
      platform,
      channelId,
      source: source ?? 'live',
      raw
    })
    try {
      // A slow volume must not queue every line in memory: past the stream's high-water mark the
      // platform is paused and lines are dropped until it drains. This is a diagnostic log; chat
      // itself is unaffected.
      if (!stream.write(`${line}\n`)) {
        this.#paused.add(platform)
        stream.once('drain', () => {
          this.#paused.delete(platform)
        })
      }
    } catch (error) {
      this.#disable(errorMessage(error))
    }
  }

  /**
   * Current state: `enabled` while writable, plus the combined size of every `*.jsonl` file in the
   * log directory (synchronous stat, cached for {@link BYTES_CACHE_MS} of `now()` time). When
   * disabled, `disabledReason` carries the error that caused it.
   */
  status(): RawLogStatus {
    const bytes = this.#bytes()
    if (!this.#disabled && !this.#closed) {
      return { enabled: true, bytes }
    }
    return this.#disabledReason === undefined
      ? { enabled: false, bytes }
      : { enabled: false, bytes, disabledReason: this.#disabledReason }
  }

  /**
   * Close every open stream, resolving once their buffered lines have flushed to disk. Terminal:
   * no further record() call writes, mirroring {@link ChatLogger#close}. Safe to call twice.
   */
  close(): Promise<void> {
    this.#closed = true
    const streams = [...this.#streams.values()]
    this.#streams.clear()
    const pending = [...streams.map(({ stream }) => this.#endStream(stream)), ...this.#ending]
    if (pending.length === 0) {
      return Promise.resolve()
    }
    return Promise.all(pending).then(() => undefined)
  }

  #endStream(stream: WriteStream): Promise<void> {
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

  #ensureStream(platform: Platform): WriteStream | undefined {
    const dateKey = localDateKey(this.#now())
    const existing = this.#streams.get(platform)
    if (existing !== undefined) {
      if (existing.dateKey === dateKey) {
        return existing.stream
      }
      const ended = this.#endStream(existing.stream)
      this.#ending.add(ended)
      void ended.then(() => this.#ending.delete(ended))
      this.#streams.delete(platform)
      this.#paused.delete(platform)
    }
    try {
      mkdirSync(this.#dir, { recursive: true })
      const path = join(this.#dir, `${platform}-${dateKey}.jsonl`)
      const stream = createWriteStream(path, { flags: 'a' })
      // The fd opens (and writes flush) asynchronously: without a listener, an 'error' event
      // (disk full, removed volume, revoked permissions) is an uncaught exception that would
      // take down the whole main process.
      stream.on('error', (error) => {
        this.#disable(error.message)
      })
      this.#streams.set(platform, { stream, dateKey })
      return stream
    } catch (error) {
      this.#disable(errorMessage(error))
      return undefined
    }
  }

  /** Disable the whole logger: the log directory is shared across platforms, so one failure ends it. */
  #disable(reason: string): void {
    if (this.#disabled) {
      return
    }
    this.#disabledReason = reason
    this.#disabled = true
    for (const { stream } of this.#streams.values()) {
      try {
        stream.end()
      } catch {
        // Already dead.
      }
    }
    this.#streams.clear()
  }

  /** Sum of every `*.jsonl` file's size in the log directory, cached for {@link BYTES_CACHE_MS}. */
  #bytes(): number {
    const now = this.#now().getTime()
    if (this.#bytesCache !== undefined && now - this.#bytesCache.at < BYTES_CACHE_MS) {
      return this.#bytesCache.bytes
    }
    const bytes = rawLogBytes(this.#dir)
    this.#bytesCache = { at: now, bytes }
    return bytes
  }
}
