import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  type WriteStream
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatEvent } from '@shared/model'
import {
  type StreamTarget,
  clearLine,
  emoteLines,
  eventKey,
  headerLine,
  lineKey,
  messageLine
} from '@main/chatLog/logLines'

/** Archive a stream's file once it exceeds this size (checked when it is first opened). */
const ROTATE_BYTES = 256 * 1024 * 1024
/**
 * Files up to this size are read whole on open, seeding dedup and emote definitions exactly. The
 * read is synchronous on the main process, so it stays small: past it, a missed emote definition
 * is only written again.
 */
const SEED_FULL_BYTES = 4 * 1024 * 1024
/** Beyond that, only the tail is read: dedup covers the replay window, emotes may be redefined. */
const SEED_TAIL_BYTES = 512 * 1024
/** Event keys remembered per file — far more than any replay window. */
const SEEN_CAP = 8192
/** Write streams held open at once; the least recently written is closed past this. */
const MAX_OPEN = 16
/** Files whose dedup state is remembered after their stream closes, so a reopen needn't re-read. */
const MAX_KNOWN = 256
/** Message ids whose file is remembered for routing a later removal or state change to it. */
const HOME_CAP = 50_000
/** Lines a file may queue while its previous stream finishes closing. */
const MAX_PENDING = 10_000

/** Resolves the stream an event belongs to, at the time it arrives. */
export type StreamResolver = (channelId: string, at: number) => StreamTarget

/**
 * One file's state. It outlives the file's write stream: a stream closed to stay under
 * {@link MAX_OPEN} may be reopened before its tail has flushed, so the dedup keys and emote
 * definitions are kept here rather than re-read from a file that is still being written.
 */
interface FileState {
  path: string
  /** The stream the file was opened for, so a later event can be routed back to it. */
  target: StreamTarget
  /** Insertion-ordered recent event keys; the oldest is evicted past {@link SEEN_CAP}. */
  seen: Set<string>
  /** Emote code → URL already defined in this file. */
  emotes: Map<string, string>
  stream: WriteStream | undefined
  /** The previous stream's close, still flushing. Lines wait in `pending` until it is done. */
  closing: Promise<void> | undefined
  /** Lines written while no stream could take them, in order. */
  pending: string[]
}

/**
 * Writes chat to one compact JSONL file per stream (format: `logLines.ts`), under
 * `<dir>/<platform>/<owner>/<streamKey>.jsonl`.
 *
 * Messages are recorded as they arrive — before any deletion is applied — so the log keeps what a
 * moderator later removes, and the removal is logged too. Each file is opened lazily (append) on
 * its first event; a new file starts with a `stream` header. Events are deduplicated per file by
 * message id, seeded from the file on first open, because YouTube re-sends recent items across
 * polls and replays a backlog on every restart. Several columns reading one stream share its file.
 *
 * At most {@link MAX_OPEN} write streams are open; a file's lines never interleave across the
 * stream it was closed on and the one it is reopened on.
 *
 * Best-effort: any filesystem error disables logging for the session rather than breaking chat.
 */
export class StreamLogger {
  readonly #dir: string
  readonly #resolve: StreamResolver
  readonly #now: () => number
  readonly #onOpen: (path: string) => void
  /** Every known file by path, least recently written first. */
  readonly #files = new Map<string, FileState>()
  /** Message id → path of the file it was written to, oldest first; see {@link #targetFor}. */
  readonly #homes = new Map<string, string>()
  /** Closes still flushing; {@link close} waits for all of them, including ones started meanwhile. */
  readonly #inflight = new Set<Promise<void>>()
  /** No new events are accepted (closed, or failed). */
  #closed = false
  /** A filesystem error happened: nothing more is written, buffered lines are dropped. */
  #failed = false

  constructor(
    dir: string,
    resolve: StreamResolver,
    options: { now?: () => number; onOpen?: (path: string) => void } = {}
  ) {
    this.#dir = dir
    this.#resolve = resolve
    this.#now = options.now ?? Date.now
    this.#onOpen = options.onOpen ?? (() => {})
  }

  /** The directory this logger writes to (so callers can detect a directory change). */
  get dir(): string {
    return this.#dir
  }

  /**
   * Record a chat event: `message`, `replace` (a later state of a message) and `clear` (a
   * moderation removal). Connection and UI events are ignored.
   */
  record(event: ChatEvent): void {
    if (this.#closed) {
      return
    }
    if (event.kind !== 'message' && event.kind !== 'replace' && event.kind !== 'clear') {
      return
    }
    const at = event.kind === 'clear' ? this.#now() : event.message.timestamp
    const file = this.#fileFor(this.#targetFor(event, at))
    if (file === undefined) {
      return
    }
    const key = eventKey(event)
    if (key !== undefined) {
      if (file.seen.has(key)) {
        return
      }
      remember(file.seen, key)
    }
    if (event.kind === 'clear') {
      this.#write(file, clearLine(event.target, at))
      return
    }
    for (const emote of emoteLines(event.message, file.emotes)) {
      this.#write(file, emote)
    }
    this.#write(file, messageLine(event.message, event.kind === 'replace'))
    this.#rememberHome(event.message.id, file.path)
  }

  /**
   * Where an event goes. A later state of a message (`replace`) or its removal goes to the file the
   * message was written to — the column may have moved to another stream since (a YouTube channel
   * column rolling to its next video, Twitch going from no-stream to live, a UTC date change), and
   * a removal filed apart from its message is lost to anyone reading that stream. Everything else,
   * and a message this session never wrote, goes to the column's current stream.
   */
  #targetFor(event: ChatEvent & { channelId: string }, at: number): StreamTarget {
    const messageId =
      event.kind === 'replace'
        ? event.message.id
        : event.kind === 'clear'
          ? event.target.messageId
          : undefined
    if (messageId !== undefined) {
      const home = this.#homes.get(messageId)
      const file = home === undefined ? undefined : this.#files.get(home)
      if (file !== undefined) {
        return file.target
      }
    }
    return this.#resolve(event.channelId, at)
  }

  #rememberHome(messageId: string, path: string): void {
    this.#homes.delete(messageId)
    this.#homes.set(messageId, path)
    if (this.#homes.size > HOME_CAP) {
      const oldest = this.#homes.keys().next()
      if (oldest.done !== true) {
        this.#homes.delete(oldest.value)
      }
    }
  }

  /**
   * Close every file, resolving once buffered lines have flushed (so a quit handler can hold the
   * app until the tails are safe). Terminal: a logger is replaced, not reopened. Safe to call twice.
   */
  async close(): Promise<void> {
    this.#closed = true
    for (const file of this.#files.values()) {
      if (file.stream !== undefined) {
        this.#closeStream(file)
      }
    }
    while (this.#inflight.size > 0) {
      // Promise.all reads the set once, now; closes it starts later are caught by the loop.
      await Promise.all(this.#inflight)
    }
  }

  #write(file: FileState, line: object): void {
    const text = `${JSON.stringify(line)}\n`
    if (file.stream === undefined) {
      // Only a close that never completes (a stalled disk) lets this grow; stop logging visibly
      // rather than hold chat in memory without limit.
      if (file.pending.length >= MAX_PENDING) {
        this.#fail('write', new Error(`${file.path}: previous stream never finished closing`))
        return
      }
      file.pending.push(text)
      return
    }
    file.stream.write(text)
  }

  /** The file for `target`, opened if need be; undefined once logging has failed. */
  #fileFor(target: StreamTarget): FileState | undefined {
    const path = join(
      this.#dir,
      target.platform,
      safeSegment(target.owner),
      `${safeSegment(target.streamKey)}.jsonl`
    )
    try {
      let file = this.#files.get(path)
      if (file === undefined) {
        file = this.#discover(path, target)
      } else {
        // Re-insert so the map stays ordered least recently written first.
        this.#files.delete(path)
      }
      this.#files.set(path, file)
      this.#ensureStream(file)
      this.#pruneKnown()
      return this.#failed ? undefined : file
    } catch (error) {
      this.#fail('open', error)
      return undefined
    }
  }

  /** First sight of a file this session: rotate it if huge, seed from it, or start its header. */
  #discover(path: string, target: StreamTarget): FileState {
    mkdirSync(dirname(path), { recursive: true })
    rotateIfHuge(path)
    const file: FileState = {
      path,
      target,
      seen: new Set(),
      emotes: new Map(),
      stream: undefined,
      closing: undefined,
      pending: []
    }
    if (existsSync(path) && statSync(path).size > 0) {
      seed(path, file.seen, file.emotes)
    } else {
      this.#write(file, headerLine(target))
    }
    return file
  }

  /** Give the file a write stream unless it has one or its last one is still closing. */
  #ensureStream(file: FileState): void {
    if (file.stream !== undefined || file.closing !== undefined || this.#failed) {
      return
    }
    const stream = createWriteStream(file.path, { flags: 'a' })
    // The fd opens and writes flush asynchronously: without a listener, an 'error' event (disk
    // full, removed volume, revoked permissions) is an uncaught exception that would take down the
    // whole main process.
    stream.on('error', (error) => {
      this.#fail('write', error)
    })
    file.stream = stream
    for (const text of file.pending.splice(0)) {
      stream.write(text)
    }
    this.#onOpen(file.path)
    this.#closeOverflow(file)
  }

  /** Close the least recently written streams beyond {@link MAX_OPEN}, never `keep`. */
  #closeOverflow(keep: FileState): void {
    const open = [...this.#files.values()].filter(
      (file) => file.stream !== undefined && file !== keep
    )
    for (const file of open.slice(0, Math.max(0, open.length + 1 - MAX_OPEN))) {
      this.#closeStream(file)
    }
  }

  #closeStream(file: FileState): void {
    const stream = file.stream
    if (stream === undefined) {
      return
    }
    file.stream = undefined
    const closing: Promise<void> = end(stream).then(() => {
      this.#inflight.delete(closing)
      file.closing = undefined
      this.#afterClose(file)
    })
    file.closing = closing
    this.#inflight.add(closing)
  }

  /** Lines that arrived while the file's stream was closing go out now, on a fresh stream. */
  #afterClose(file: FileState): void {
    if (this.#failed) {
      file.pending = []
      return
    }
    if (file.pending.length === 0) {
      return
    }
    this.#ensureStream(file)
    if (this.#closed) {
      this.#closeStream(file)
    }
  }

  /** Forget the dedup state of the oldest idle files past {@link MAX_KNOWN}. */
  #pruneKnown(): void {
    for (const [path, file] of this.#files) {
      if (this.#files.size <= MAX_KNOWN) {
        return
      }
      if (file.stream === undefined && file.closing === undefined && file.pending.length === 0) {
        this.#files.delete(path)
      }
    }
  }

  #fail(phase: 'open' | 'write', error: unknown): void {
    if (this.#failed) {
      return
    }
    console.error(`Chat log ${phase} failed — logging disabled for this session:`, error)
    this.#failed = true
    this.#closed = true
    for (const file of this.#files.values()) {
      file.pending = []
      file.stream?.destroy()
    }
  }
}

function remember(seen: Set<string>, key: string): void {
  seen.add(key)
  if (seen.size > SEEN_CAP) {
    const oldest = seen.values().next()
    if (oldest.done !== true) {
      seen.delete(oldest.value)
    }
  }
}

/**
 * Resolves once the stream has flushed and closed — or was destroyed by an error, which emits
 * `close` without ever finishing, so waiting on `finish` alone could hang shutdown.
 */
function end(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.closed) {
      resolve()
      return
    }
    stream.once('close', () => {
      resolve()
    })
    if (!stream.destroyed) {
      stream.end()
    }
  })
}

/**
 * A path segment from a platform-supplied name: a handle, login, creator id or video id. Anything
 * outside a conservative filename alphabet becomes `_`, so a name can never climb out of the log
 * directory or produce a name one of the target platforms rejects.
 */
export function safeSegment(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9@._-]/gu, '_')
    .replace(/^\.+/u, '_')
    .slice(0, 120)
  if (cleaned === '') {
    return '_'
  }
  // Windows reserves device names whatever follows the first dot, and `com1`–`com9` /
  // `lpt1`–`lpt9` are valid Twitch logins; failing to create one would disable logging for every
  // chat. The escape goes on the stem and uses `-`, which no Twitch login contains, so it can't
  // collide with another channel's name (`com1_` is a valid login; `com1-` is not).
  const [stem = '', ...rest] = cleaned.split('.')
  return WINDOWS_RESERVED.test(stem) ? [`${stem}-`, ...rest].join('.') : cleaned
}

/** Device names Windows refuses as a file or directory name (Microsoft "Naming Files" rules). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu

/** Archive an oversized file under a dated name, so one endless stream can't grow one file forever. */
function rotateIfHuge(path: string): void {
  if (!existsSync(path) || statSync(path).size <= ROTATE_BYTES) {
    return
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/gu, '-')
  renameSync(path, path.replace(/\.jsonl$/u, `.${stamp}.jsonl`))
}

/** Seed a reopened file's dedup keys and emote definitions from what it already holds. */
function seed(path: string, seen: Set<string>, emotes: Map<string, string>): void {
  const size = statSync(path).size
  const length = size <= SEED_FULL_BYTES ? size : SEED_TAIL_BYTES
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, length, size - length)
  } finally {
    closeSync(fd)
  }
  for (const text of buffer.toString('utf8').split('\n')) {
    const line = parseLine(text)
    if (line === undefined) {
      continue
    }
    if (line['k'] === 'emote' && typeof line['c'] === 'string' && typeof line['url'] === 'string') {
      emotes.set(line['c'], line['url'])
      continue
    }
    const key = lineKey(line)
    if (key !== undefined) {
      remember(seen, key)
    }
  }
}

/** One line as an object, or undefined for a blank, partial (a tail's first) or foreign line. */
function parseLine(text: string): Record<string, unknown> | undefined {
  if (text === '') {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
