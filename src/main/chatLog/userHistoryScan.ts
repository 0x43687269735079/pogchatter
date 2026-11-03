import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fragmentsFrom, type LogLine, messageFromLine, parseLogLine } from '@main/chatLog/logReader'
import type { LogMessage } from '@main/chatLog/logLines'
import type { ChatMessage, Platform } from '@shared/model'
import type {
  UserHistoryFailure,
  UserHistoryResult,
  UserHistoryRow,
  UserHistoryStream
} from '@shared/userHistory'

/** Bytes read from a file at a time, into one reused buffer. */
const CHUNK_BYTES = 1024 * 1024
/** A line longer than this is not a log line the logger wrote: it is skipped and counted. */
const MAX_LINE_BYTES = 1024 * 1024
/** Progress is reported at most this often. */
const PROGRESS_INTERVAL_MS = 250
/** Every non-message line carries a kind; message lines never contain this byte sequence. */
const KIND_NEEDLE = Buffer.from('"k":"')
const NEWLINE = 0x0a
/**
 * Removals remembered per stream for a message logged after its own removal. That happens when a
 * chat-history backlog lands just after the live removal, so only the latest removals can still
 * meet their message: the window bounds memory in a stream with many removals.
 */
const REMOVED_CAP = 10_000
/** The stamp StreamLogger adds when it rotates a file: `<stem>.YYYY-MM-DD-HH-MM-SS.jsonl`. */
const ROTATION_STAMP = /\.\d{4}(?:-\d{2}){5}$/u

/** A per-stream log file found under the log directory. */
export interface LogFile {
  path: string
  /** Relative to the log directory, `/`-separated whatever the OS: `<platform>/<owner>/<name>`. */
  relative: string
  bytes: number
}

/** The files found, and the directories or files that could not be listed or measured. */
export interface LogListing {
  files: LogFile[]
  failures: UserHistoryFailure[]
}

export interface ScanProgress {
  bytesDone: number
  bytesTotal: number
  filesDone: number
  filesTotal: number
}

export interface ScanOptions {
  /** The chat-log directory (the one holding the per-platform directories). */
  dir: string
  platform: Platform
  /** The account id, as logged in each message's `uid`. */
  userId: string
  /** Rows to return at most: the newest. */
  cap: number
  onProgress: (progress: ScanProgress) => void
  /** Polled between chunks; true stops the scan with a `cancelled` result. */
  cancelled: () => boolean
  /** Clock for progress pacing (tests). */
  now?: () => number
}

/** A scan's outcome; the caller adds the request id. */
export type ScanResult =
  | Omit<UserHistoryResult & { ok: true }, 'requestId'>
  | { ok: false; error: string }

/**
 * Every log file of one platform: `<dir>/<platform>/<owner>/*.jsonl`, rotated archives included,
 * sorted by relative path so the scan order never depends on the filesystem's. A missing platform
 * directory means nothing was logged there, and gives an empty listing; any other error on it
 * rejects, so the caller reports it rather than an empty history. An owner directory or a file
 * that can't be listed or measured (one rotated or deleted meanwhile) is reported in `failures`
 * and the rest still listed.
 *
 * Args:
 *   dir: The chat-log directory.
 *   platform: The platform whose subtree to list.
 */
export async function listLogFiles(dir: string, platform: Platform): Promise<LogListing> {
  const root = join(dir, platform)
  let owners: string[]
  try {
    owners = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      return { files: [], failures: [] }
    }
    throw error
  }
  const listing: LogListing = { files: [], failures: [] }
  for (const owner of owners) {
    await listOwner(root, platform, owner, listing)
  }
  listing.files.sort((a, b) => compareText(a.relative, b.relative))
  return listing
}

async function listOwner(
  root: string,
  platform: Platform,
  owner: string,
  listing: LogListing
): Promise<void> {
  let names: string[]
  try {
    names = (await readdir(join(root, owner), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name)
  } catch (error) {
    listing.failures.push({ file: `${platform}/${owner}/`, error: errorText(error) })
    return
  }
  for (const name of names) {
    const path = join(root, owner, name)
    const relative = `${platform}/${owner}/${name}`
    try {
      listing.files.push({ path, relative, bytes: (await stat(path)).size })
    } catch (error) {
      listing.failures.push({ file: relative, error: errorText(error) })
    }
  }
}

/**
 * Find one account's messages in the logs of its platform, across every streamer and stream.
 *
 * Runs off the main process (see `userHistoryWorker.ts`). Each file is read in chunks; a line is
 * parsed only when its bytes contain the account's `"uid":"<id>"` or a line kind, so the cost of
 * other people's messages is a byte search. A stream's rotated archives and its live file are read
 * as one stream, so a removal in one reaches a message in another. A file that can't be read is
 * reported in `failures` and the rest still scanned.
 *
 * Args:
 *   options: What to search for and where; see {@link ScanOptions}.
 */
export async function scanUserHistory(options: ScanOptions): Promise<ScanResult> {
  let listing: LogListing
  try {
    listing = await listLogFiles(options.dir, options.platform)
  } catch (error) {
    return { ok: false, error: `Could not list the chat logs: ${errorText(error)}` }
  }
  return scanLogFiles(listing.files, options, listing.failures)
}

/**
 * {@link scanUserHistory} over a given file list (any order: the result does not depend on it).
 *
 * Args:
 *   files: The files to read.
 *   options: What to search for.
 *   listingFailures: Failures from listing the files, carried into the result.
 */
export async function scanLogFiles(
  files: LogFile[],
  options: ScanOptions,
  listingFailures: UserHistoryFailure[] = []
): Promise<ScanResult> {
  const groups = streamGroups(files)
  const collected = new Collected(options.cap)
  const progress = new Pacer(files, options)
  const failures = [...listingFailures]
  const needle = Buffer.from(`"uid":${JSON.stringify(options.userId)}`)
  let read = 0
  for (const group of groups) {
    const scan = new StreamScan(group[0]!, options, needle)
    for (const file of group) {
      scan.startFile()
      try {
        await readLines(file, {
          onLine: (line) => {
            scan.take(line)
          },
          onOverlong: () => {
            scan.malformed += 1
          },
          onChunk: (bytes) => {
            progress.advance(bytes)
            return options.cancelled()
          }
        })
        read += 1
      } catch (error) {
        failures.push({ file: file.relative, error: errorText(error) })
      }
      if (options.cancelled()) {
        return { ok: false, error: 'cancelled' }
      }
      progress.fileDone()
    }
    collected.add(scan)
  }
  progress.finish()
  return collected.result(read, failures)
}

/**
 * A stream's files, oldest first: the archives StreamLogger rotated out (by their stamp), then the
 * live file. Groups are ordered by owner and stream, so the scan order is fixed by the data.
 */
function streamGroups(files: LogFile[]): LogFile[][] {
  const groups = new Map<string, LogFile[]>()
  for (const file of files) {
    const key = streamKeyOf(file)
    const group = groups.get(key) ?? []
    group.push(file)
    groups.set(key, group)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([, group]) => group.sort(oldestFileFirst))
}

/** `<owner>/<stem>` with any rotation stamp removed: the same for a stream's every file. */
function streamKeyOf(file: LogFile): string {
  const [, owner = '', name = ''] = file.relative.split('/')
  return `${owner}/${name.replace(/\.jsonl$/u, '').replace(ROTATION_STAMP, '')}`
}

function oldestFileFirst(a: LogFile, b: LogFile): number {
  const archived = (file: LogFile): boolean =>
    ROTATION_STAMP.test(file.relative.replace(/\.jsonl$/u, ''))
  if (archived(a) !== archived(b)) {
    return archived(a) ? -1 : 1
  }
  return compareText(a.relative, b.relative)
}

interface LineSink {
  /** A complete line, without its newline. */
  onLine: (line: Buffer) => void
  /** A line longer than `MAX_LINE_BYTES` was dropped. */
  onOverlong: () => void
  /** Each chunk's size, as read; returning true stops reading. */
  onChunk: (bytes: number) => boolean
}

/**
 * Feed every complete line of a file to the sink, reading `CHUNK_BYTES` at a time. A trailing line
 * with no newline is the live tail of a file still being written: it is left out. A line longer
 * than `MAX_LINE_BYTES` is dropped and reported once, wherever its newline falls.
 *
 * Args:
 *   file: The file to read.
 *   sink: Where lines, overlong lines and chunk sizes go.
 */
async function readLines(file: LogFile, sink: LineSink): Promise<void> {
  const handle = await open(file.path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
    let carry: Buffer = Buffer.alloc(0)
    let skipping = false
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null)
      if (bytesRead === 0 || sink.onChunk(bytesRead)) {
        return
      }
      const chunk = Buffer.concat([carry, buffer.subarray(0, bytesRead)])
      let start = 0
      for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, start)) {
        if (!skipping) {
          deliver(chunk.subarray(start, end), sink)
        }
        skipping = false
        start = end + 1
      }
      // Copied out, so the next read can't overwrite the bytes the carry still refers to.
      carry = Buffer.from(chunk.subarray(start))
      if (!skipping && carry.length > MAX_LINE_BYTES) {
        sink.onOverlong()
        skipping = true
      }
      if (skipping) {
        carry = Buffer.alloc(0)
      }
    }
  } finally {
    await handle.close()
  }
}

function deliver(line: Buffer, sink: LineSink): void {
  if (line.length > MAX_LINE_BYTES) {
    sink.onOverlong()
  } else {
    sink.onLine(line)
  }
}

/**
 * One stream's matches, across its files, and the removals that apply to them.
 *
 * A removal can be logged before the message it removes (a chat-history backlog arriving after the
 * live removal), so removals are remembered, not only applied: a message logged later is still
 * deleted when its id was removed, or when it was sent before a timeout, ban or chat clear. Rows
 * still undeleted are kept apart, so each clear walks only those. Past twice the cap the oldest rows
 * are dropped: they can't be among the newest `cap`, and `counted` still counts them.
 */
class StreamScan {
  readonly #options: ScanOptions
  readonly #needle: Buffer
  readonly #emotes = new Map<string, string>()
  readonly rows = new Map<string, ChatMessage>()
  /** Every id this stream matched, dropped rows included, for an exact total. */
  readonly counted = new Set<string>()
  /** Rows not yet deleted, by id. */
  readonly #undeleted = new Set<string>()
  /** Recent ids a `del` removed, applied to rows logged after it too; oldest first. */
  readonly #removed = new Set<string>()
  /**
   * Rows a moderator removed (a `del`, timeout, ban or chat clear), kept while the row is, however
   * many removals follow. Distinct from `deleted`, which a held review's hide also sets and a later
   * show in the same stream undoes: a later `replace` must not undo these.
   */
  readonly removedRows = new Set<string>()
  /** The newest timeout, ban or chat clear that applies to this account. */
  #clearedUntil = -Infinity
  stream: UserHistoryStream
  malformed = 0

  constructor(first: LogFile, options: ScanOptions, needle: Buffer) {
    this.#options = options
    this.#needle = needle
    this.stream = streamFromPath(first, options.platform)
  }

  /** Read one line, if it could matter: the account's own, or any line with a kind. */
  take(bytes: Buffer): void {
    if (bytes.indexOf(this.#needle) === -1 && bytes.indexOf(KIND_NEEDLE) === -1) {
      return
    }
    const line = parseLogLine(bytes.toString('utf8'))
    if (line === undefined) {
      this.malformed += 1
      return
    }
    this.#apply(line)
  }

  #apply(line: LogLine): void {
    switch (line.kind) {
      case 'header':
        this.#header(line)
        return
      case 'emote':
        this.#emotes.set(line.code, line.url)
        return
      case 'message':
      case 'replace':
        this.#message(line.line, line.kind === 'replace')
        return
      case 'del':
        this.#remove(line.id)
        return
      case 'clearUser':
        if (line.uid === this.#options.userId) {
          this.#clearUntil(line.at)
        }
        return
      case 'clearAll':
        this.#clearUntil(line.at)
        return
      case 'unknown':
        return
    }
  }

  /**
   * Each file of the stream opens with a header; a later one can know more (a title or start time
   * learned after the first file was opened), so what it carries replaces what was known.
   */
  #header(header: LogLine & { kind: 'header' }): void {
    this.stream = streamFromHeader(this.stream, header)
  }

  /** A new file of the stream: the logger defines emotes per file, so earlier ones don't apply. */
  startFile(): void {
    this.#emotes.clear()
  }

  /**
   * A message of this account: the first sighting, or a `replace` (its latest state wins). A `del`
   * or clear still applies to the new state: a replace changes how a message reads (a held review
   * shown or hidden again), not a moderator's removal.
   */
  #message(line: LogMessage, replace: boolean): void {
    if (line.uid !== this.#options.userId || (!replace && this.rows.has(line.id))) {
      return
    }
    const fragments = fragmentsFrom(line.m, this.#emotes, line.e, this.stream.platform)
    const message = messageFromLine(line, this.stream, fragments)
    this.counted.add(line.id)
    this.rows.set(line.id, message)
    const removed = this.removedRows.has(line.id) || this.#removed.has(line.id)
    if (removed || message.timestamp <= this.#clearedUntil) {
      markDeleted(message)
      this.removedRows.add(line.id)
    }
    if (message.deleted === true) {
      this.#undeleted.delete(line.id)
    } else {
      this.#undeleted.add(line.id)
    }
    if (this.rows.size > this.#options.cap * 2) {
      this.#trim()
    }
  }

  #remove(id: string): void {
    this.#removed.add(id)
    if (this.#removed.size > REMOVED_CAP) {
      // Every user's removals are logged; only a recent window can still meet its message late.
      const oldest = this.#removed.values().next().value
      if (oldest !== undefined) {
        this.#removed.delete(oldest)
      }
    }
    const row = this.rows.get(id)
    if (row !== undefined) {
      markDeleted(row)
      this.removedRows.add(id)
      this.#undeleted.delete(id)
    }
  }

  /** A timeout, ban or chat clear at `at` removes what was said before it. */
  #clearUntil(at: number): void {
    this.#clearedUntil = Math.max(this.#clearedUntil, at)
    for (const id of this.#undeleted) {
      const message = this.rows.get(id)
      if (message !== undefined && message.timestamp <= at) {
        markDeleted(message)
        this.removedRows.add(id)
        this.#undeleted.delete(id)
      }
    }
  }

  /** Keep the newest `cap` rows. */
  #trim(): void {
    const kept = [...this.rows.values()].sort(newestMessageFirst).slice(0, this.#options.cap)
    const keep = new Set(kept.map((message) => message.id))
    for (const id of this.rows.keys()) {
      if (!keep.has(id)) {
        this.rows.delete(id)
        this.#undeleted.delete(id)
        this.removedRows.delete(id)
      }
    }
  }
}

/** A deleted message is no longer held for review, whatever its last held state said. */
function markDeleted(message: ChatMessage | undefined): void {
  if (message !== undefined) {
    message.deleted = true
    delete message.held
  }
}

/** The stream a file holds, as far as its place in the tree tells. */
function streamFromPath(file: LogFile, platform: Platform): UserHistoryStream {
  const key = streamKeyOf(file)
  const [owner = '', streamKey = ''] = key.split('/')
  return { id: key, platform, owner, streamKey, channelId: '' }
}

/** The file's header names the stream exactly: an archive's stem also carries its rotation stamp. */
function streamFromHeader(
  base: UserHistoryStream,
  header: LogLine & { kind: 'header' }
): UserHistoryStream {
  const streamKey = header.streamKey ?? base.streamKey
  const stream: UserHistoryStream = {
    ...base,
    id: `${base.owner}/${streamKey}`,
    streamKey,
    channelId: header.channelId
  }
  if (header.title !== undefined) {
    stream.title = header.title
  }
  if (header.startedAt !== undefined) {
    stream.startedAt = header.startedAt
  }
  return stream
}

/** Rows kept across streams: deduplicated by message id, bounded near the cap. */
class Collected {
  readonly #cap: number
  /** Every id counted, so a message logged in two streams counts once even after trimming. */
  readonly #seen = new Set<string>()
  readonly #rows = new Map<string, UserHistoryRow>()
  /** Kept rows shown removed or hidden in any copy. */
  readonly #removed = new Set<string>()
  readonly #streams = new Map<string, UserHistoryStream>()
  #malformed = 0

  constructor(cap: number) {
    this.#cap = cap
  }

  add(scan: StreamScan): void {
    this.#malformed += scan.malformed
    for (const id of scan.counted) {
      this.#seen.add(id)
    }
    this.#streams.set(scan.stream.id, scan.stream)
    for (const message of scan.rows.values()) {
      if (message.deleted === true) {
        this.#removed.add(message.id)
      }
      this.#addRow({ message, streamId: scan.stream.id }, scan.stream)
    }
    if (this.#rows.size > this.#cap * 2) {
      this.#trim()
    }
  }

  /**
   * The preferred copy supplies the row. A message removed or hidden in either copy stays so
   * (owner decision): the logs can't always tell a removal from a review that was later reversed,
   * and for moderation it is safer to show a message as removed than to lose a removal.
   */
  #addRow(row: UserHistoryRow, stream: UserHistoryStream): void {
    const existing = this.#rows.get(row.message.id)
    const keep =
      existing === undefined || prefers(stream, this.#streams.get(existing.streamId))
        ? row
        : existing
    if (this.#removed.has(row.message.id)) {
      markDeleted(keep.message)
    }
    this.#rows.set(row.message.id, keep)
  }

  /** Keep the newest `cap` rows. */
  #trim(): void {
    const kept = [...this.#rows.values()].sort(newestFirst).slice(0, this.#cap)
    this.#rows.clear()
    for (const row of kept) {
      this.#rows.set(row.message.id, row)
    }
    for (const id of this.#removed) {
      if (!this.#rows.has(id)) {
        this.#removed.delete(id)
      }
    }
  }

  result(filesScanned: number, failures: UserHistoryFailure[]): ScanResult {
    const rows = [...this.#rows.values()].sort(newestFirst).slice(0, this.#cap).reverse()
    const streamIds = new Set(rows.map((row) => row.streamId))
    const streams = [...this.#streams.values()]
      .filter((stream) => streamIds.has(stream.id))
      .sort((a, b) => compareText(a.id, b.id))
    return {
      ok: true,
      rows,
      streams,
      total: this.#seen.size,
      truncated: this.#seen.size > this.#cap,
      filesScanned,
      malformedLines: this.#malformed,
      failures: [...failures].sort((a, b) => compareText(a.file, b.file))
    }
  }
}

/**
 * Which copy of a message logged in two streams to keep: the later stream's (a column that moved on
 * to a new broadcast), else the lower stream id, so the choice never depends on order.
 */
function prefers(candidate: UserHistoryStream, current: UserHistoryStream | undefined): boolean {
  if (current === undefined) {
    return true
  }
  const a = candidate.startedAt ?? -Infinity
  const b = current.startedAt ?? -Infinity
  return a !== b ? a > b : compareText(candidate.id, current.id) < 0
}

function newestFirst(a: UserHistoryRow, b: UserHistoryRow): number {
  return newestMessageFirst(a.message, b.message)
}

function newestMessageFirst(a: ChatMessage, b: ChatMessage): number {
  const byTime = b.timestamp - a.timestamp
  return byTime !== 0 ? byTime : compareText(b.id, a.id)
}

/** Code-unit order: the same on every OS and locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Reports progress at most every {@link PROGRESS_INTERVAL_MS}, and once at the end. */
class Pacer {
  readonly #options: ScanOptions
  readonly #now: () => number
  readonly #progress: ScanProgress
  #last = -Infinity

  constructor(files: LogFile[], options: ScanOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    const bytesTotal = files.reduce((sum, file) => sum + file.bytes, 0)
    this.#progress = { bytesDone: 0, bytesTotal, filesDone: 0, filesTotal: files.length }
  }

  advance(bytes: number): void {
    this.#progress.bytesDone += bytes
    this.#maybeReport()
  }

  fileDone(): void {
    this.#progress.filesDone += 1
    this.#maybeReport()
  }

  /** The final count, always reported. */
  finish(): void {
    this.#report()
  }

  #maybeReport(): void {
    if (this.#now() - this.#last >= PROGRESS_INTERVAL_MS) {
      this.#report()
    }
  }

  #report(): void {
    this.#last = this.#now()
    this.#options.onProgress({ ...this.#progress })
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
