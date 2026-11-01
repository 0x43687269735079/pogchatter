import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage } from '@shared/model'
import type { ChatterStatsSummary, ChatterSummary } from '@shared/chatterStats'
import { isYouTubeChannelId, isYouTubeVideoId } from '@main/sources/channelId'

/** How long writes are batched: chat is fast, and the record survives a few lost seconds. */
const WRITE_DEBOUNCE_MS = 5_000
/** A stream with no counted message for this long is written and dropped from memory. */
const IDLE_EVICT_MS = 30 * 60_000
/** Creators whose stored totals are cached for the stats view. */
const TOTALS_CACHE_MAX = 8
/** How long a stream whose file couldn't be read waits before the read is tried again. */
const BLOCKED_RETRY_MS = 60_000
/** Message ids remembered per stream to drop YouTube's re-sends within a session. */
const SEEN_CAP = 20_000
/**
 * The newest counted message ids kept on disk per stream, so the chat YouTube replays when a stream
 * is reopened after a restart is recognised by id and not counted twice. Far more than a replay.
 */
const PERSISTED_IDS = 2_000

/** One chatter within one stream, as stored. */
interface StreamChatter {
  /** Name at their latest message. */
  n: string
  msgs: number
  first: number
  last: number
}

/** One stream's file: `<dir>/<creatorId>/<videoId>.json`. */
interface StreamFile {
  v: 1
  videoId: string
  creatorId: string
  title?: string
  firstAt: number
  lastAt: number
  chatters: Record<string, StreamChatter>
}

interface LoadedStream {
  data: StreamFile
  /**
   * Ids of counted messages, oldest first: the newest {@link PERSISTED_IDS} from earlier sessions
   * (`<videoId>.ids.json`) plus this session's. A message whose id is here is never counted again.
   */
  seen: Set<string>
  dirty: boolean
  /** Wall-clock time of the last counted message, for idle eviction. */
  touchedAt: number
  /**
   * Set when the stream's file exists but couldn't be read (a permission or I/O error). Nothing is
   * counted or written until this time, when the read is tried again: writing would replace the
   * counts the file still holds.
   */
  blockedUntil?: number
}

/** The outcome of reading one stream file. */
type ReadResult =
  | { kind: 'ok'; data: StreamFile }
  | { kind: 'missing' }
  /** Readable, but not a stream file for this creator and video. */
  | { kind: 'invalid'; error: unknown }
  /** Present but couldn't be read; its contents are unknown and must be preserved. */
  | { kind: 'unreadable'; error: unknown }

/** Which stream a message belongs to. */
export interface StreamContext {
  creatorId: string
  videoId: string
  title?: string
}

export interface ChatterStatsDeps {
  /** Directory holding one folder per creator. */
  dir: string
  now?: () => number
  /** Injected so tests can fail a write. */
  writeFile?: (path: string, contents: string) => void
  /** Injected so tests can fail a read. */
  readFile?: (path: string) => string
}

/**
 * Who chats in a creator's YouTube streams, and how much: one JSON file per stream, aggregated on
 * request into regulars (streams attended, messages, first and last seen).
 *
 * Chatters are identified by YouTube channel id only — a display name or handle can change and is
 * stored only as the latest label. "Present in a stream" means chatted at least once there:
 * YouTube publishes no viewer list.
 *
 * Counted: ordinary chat from an identified account. Not counted: system lines (memberships,
 * gifts), moderation notices, messages held for review, and anything without a `UC…` channel id.
 * A paid message with text (a Super Chat) counts as a message.
 *
 * Writes are batched and atomic (tmp + rename); a stream idle for half an hour is written and
 * dropped from memory, so memory holds only the streams being watched.
 */
export class ChatterStats {
  readonly #dir: string
  readonly #now: () => number
  readonly #writeFile: (path: string, contents: string) => void
  readonly #readFile: (path: string) => string
  readonly #streams = new Map<string, LoadedStream>()
  #timer: ReturnType<typeof setTimeout> | undefined
  /** The idle-release sweep; see {@link #scheduleIdleSweep}. */
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  /** Stored totals per creator, least recently used first; see {@link #storedTotals}. */
  readonly #totalsCache = new Map<string, { fingerprint: string; totals: Totals }>()

  constructor(deps: ChatterStatsDeps) {
    this.#dir = deps.dir
    this.#now = deps.now ?? Date.now
    this.#writeFile = deps.writeFile ?? ((path, contents) => writeFileSync(path, contents))
    this.#readFile = deps.readFile ?? ((path) => readFileSync(path, 'utf8'))
  }

  /**
   * Count `message` toward its stream. Returns whether it was counted — false for anything not
   * counted (see the class doc), a re-send, or a replay of what an earlier session counted.
   */
  record(message: ChatMessage, context: StreamContext): boolean {
    if (!countable(message)) {
      return false
    }
    if (!isYouTubeChannelId(context.creatorId) || !isYouTubeVideoId(context.videoId)) {
      return false
    }
    const stream = this.#load(context)
    if (stream.blockedUntil !== undefined || stream.seen.has(message.id)) {
      return false
    }
    rememberSeen(stream.seen, message.id)
    countMessage(stream.data, message.author.id, message)
    if (context.title !== undefined) {
      stream.data.title = context.title
    }
    stream.dirty = true
    stream.touchedAt = this.#now()
    this.#schedule()
    return true
  }

  /**
   * Every chatter across the creator's tracked streams. Streams in memory are read from memory
   * (they may be newer than their file); the rest from disk. Read-only: a file that isn't a valid
   * stream file is skipped, never moved.
   *
   * Throws when the creator's folder or one of its files exists but can't be read, rather than
   * presenting partial counts as complete.
   */
  summary(creatorId: string): ChatterStatsSummary {
    const live = [...this.#streams.values()].filter(
      (loaded) => loaded.data.creatorId === creatorId && loaded.blockedUntil === undefined
    )
    const liveIds = new Set(live.map((loaded) => loaded.data.videoId))
    const totals = isYouTubeChannelId(creatorId)
      ? copyTotals(this.#storedTotals(creatorId, liveIds))
      : emptyTotals()
    for (const loaded of live) {
      addStream(totals, loaded.data)
    }
    return finish(creatorId, totals)
  }

  /**
   * Totals over the creator's stream files, leaving out the streams held in memory. Cached against
   * each file's name, modification time and size, so opening the view again — even during a live
   * stream, whose counts come from memory — re-reads only files that changed.
   */
  #storedTotals(creatorId: string, exclude: ReadonlySet<string>): Totals {
    const files = this.#streamFiles(creatorId).filter((file) => !exclude.has(file.videoId))
    const fingerprint = files.map((file) => `${file.videoId}:${file.stamp}`).join('|')
    const cached = this.#totalsCache.get(creatorId)
    this.#totalsCache.delete(creatorId)
    if (cached !== undefined && cached.fingerprint === fingerprint) {
      this.#totalsCache.set(creatorId, cached)
      return cached.totals
    }
    const totals = emptyTotals()
    for (const file of files) {
      const read = readStream(this.#readFile, file.path, { creatorId, videoId: file.videoId })
      if (read.kind === 'ok') {
        addStream(totals, read.data)
      } else if (read.kind === 'unreadable') {
        throw new Error(`Can't read the chatter stats file ${file.path}: ${describe(read.error)}`)
      }
    }
    this.#totalsCache.set(creatorId, { fingerprint, totals })
    while (this.#totalsCache.size > TOTALS_CACHE_MAX) {
      const oldest = this.#totalsCache.keys().next()
      if (oldest.done === true) {
        break
      }
      this.#totalsCache.delete(oldest.value)
    }
    return totals
  }

  /** Write every unsaved stream now (shutdown). */
  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = undefined
    }
    for (const stream of this.#streams.values()) {
      this.#persist(stream)
    }
  }

  #schedule(): void {
    if (this.#timer !== undefined) {
      return
    }
    const timer = setTimeout(() => {
      this.#timer = undefined
      this.#persistAndEvict()
    }, WRITE_DEBOUNCE_MS)
    timer.unref()
    this.#timer = timer
  }

  #persistAndEvict(): void {
    const now = this.#now()
    for (const [key, stream] of this.#streams) {
      this.#persist(stream)
      if (!stream.dirty && now - stream.touchedAt > IDLE_EVICT_MS) {
        this.#streams.delete(key)
      }
    }
    if ([...this.#streams.values()].some((stream) => stream.dirty)) {
      this.#schedule()
    }
    this.#scheduleIdleSweep(now)
  }

  /**
   * Arm one sweep for when the stalest loaded stream goes idle, so streams are released even when
   * no further chat arrives to trigger a batch (chat stopped, a column closed, the setting off).
   * Separate from the write timer: a long idle wait must never delay a pending write.
   */
  #scheduleIdleSweep(now: number): void {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = undefined
    }
    let due: number | undefined
    for (const stream of this.#streams.values()) {
      // An unsaved stream can't be released yet; the write timer retries it, and its next sweep
      // re-arms this one. Counting it here would re-fire at once while a write keeps failing.
      if (stream.dirty) {
        continue
      }
      const at = stream.touchedAt + IDLE_EVICT_MS
      due = due === undefined ? at : Math.min(due, at)
    }
    if (due === undefined) {
      return
    }
    const timer = setTimeout(
      () => {
        this.#idleTimer = undefined
        this.#persistAndEvict()
      },
      Math.max(0, due - now) + 1
    )
    timer.unref()
    this.#idleTimer = timer
  }

  #persist(stream: LoadedStream): void {
    if (!stream.dirty) {
      return
    }
    const folder = join(this.#dir, stream.data.creatorId)
    const path = join(folder, `${stream.data.videoId}.json`)
    const idsPath = join(folder, `${stream.data.videoId}.ids.json`)
    try {
      mkdirSync(folder, { recursive: true })
      // Ids first: a crash between the two writes then loses those messages from the counts (as a
      // crash inside the batch window already does) rather than counting their replay twice.
      const ids = [...stream.seen].slice(-PERSISTED_IDS)
      this.#writeFile(`${idsPath}.tmp`, JSON.stringify({ v: 1, ids }))
      renameSync(`${idsPath}.tmp`, idsPath)
      this.#writeFile(`${path}.tmp`, JSON.stringify(stream.data))
      renameSync(`${path}.tmp`, path)
      stream.dirty = false
    } catch (error) {
      // Kept dirty, so the next batch or shutdown retries. Stats are best-effort: a full disk
      // must not take chat down.
      console.error(`Chatter stats write failed for ${path}:`, error)
    }
  }

  /**
   * The stream's counts, read from its file the first time. A missing file starts empty; an invalid
   * one is set aside first (so the next write can't destroy what's in it); an unreadable one — or
   * an invalid one that couldn't be set aside — blocks the stream until a later retry.
   */
  #load(context: StreamContext): LoadedStream {
    const key = `${context.creatorId}/${context.videoId}`
    const existing = this.#streams.get(key)
    const now = this.#now()
    if (
      existing !== undefined &&
      (existing.blockedUntil === undefined || now < existing.blockedUntil)
    ) {
      return existing
    }
    const path = join(this.#dir, context.creatorId, `${context.videoId}.json`)
    const read = readStream(this.#readFile, path, context)
    let data: StreamFile | undefined
    if (read.kind === 'ok') {
      data = read.data
    } else if (read.kind === 'missing') {
      data = emptyStream(context)
    } else if (read.kind === 'invalid' && setAside(path, read.error)) {
      data = emptyStream(context)
    } else if (read.kind === 'unreadable') {
      console.error(
        `Chatter stats file unreadable, not counting into it for now: ${path}`,
        read.error
      )
    }
    const loaded: LoadedStream = {
      data: data ?? emptyStream(context),
      // Ids belong to the counts they were stored with: only a stream read back intact has any.
      seen: read.kind === 'ok' ? this.#readIds(path) : new Set(),
      dirty: false,
      touchedAt: now
    }
    if (data === undefined) {
      loaded.blockedUntil = now + BLOCKED_RETRY_MS
    }
    this.#streams.set(key, loaded)
    return loaded
  }

  /**
   * The counted-message ids stored beside a stream file. Missing or unusable ids only risk counting
   * a replay twice, never losing counts, so they degrade to an empty set (logged unless missing).
   */
  #readIds(streamPath: string): Set<string> {
    const path = streamPath.replace(/\.json$/u, '.ids.json')
    let text: string
    try {
      text = this.#readFile(path)
    } catch (error) {
      if (!isMissing(error)) {
        console.error(`Chatter stats ids unreadable, a replay may count twice: ${path}`, error)
      }
      return new Set()
    }
    try {
      const ids = (JSON.parse(text) as { ids?: unknown }).ids
      if (!Array.isArray(ids)) {
        throw new Error('no ids array')
      }
      return new Set(ids.filter((id): id is string => typeof id === 'string'))
    } catch (error) {
      console.error(`Chatter stats ids invalid, a replay may count twice: ${path}`, error)
      return new Set()
    }
  }

  /** The creator's stream files with a change stamp each; throws when the folder can't be read. */
  #streamFiles(creatorId: string): Array<{ videoId: string; path: string; stamp: string }> {
    const folder = join(this.#dir, creatorId)
    let names: string[]
    try {
      names = readdirSync(folder)
    } catch (error) {
      if (isMissing(error)) {
        return [] // nothing tracked for this creator yet
      }
      throw new Error(`Can't read the chatter stats folder ${folder}: ${describe(error)}`)
    }
    const out: Array<{ videoId: string; path: string; stamp: string }> = []
    for (const name of names.sort()) {
      const videoId = name.replace(/\.json$/u, '')
      if (!name.endsWith('.json') || !isYouTubeVideoId(videoId)) {
        continue
      }
      const path = join(folder, name)
      try {
        const info = statSync(path)
        out.push({ videoId, path, stamp: `${info.mtimeMs}:${info.size}` })
      } catch (error) {
        if (!isMissing(error)) {
          throw new Error(`Can't read the chatter stats file ${path}: ${describe(error)}`)
        }
      }
    }
    return out
  }
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Move an invalid stream file out of the way; false when it couldn't be moved. */
function setAside(path: string, reason: unknown): boolean {
  const stamp = Date.now()
  const target = `${path}.corrupt-${stamp}`
  try {
    renameSync(path, target)
    console.error(`Chatter stats file invalid, set aside as ${target}:`, reason)
  } catch (error) {
    console.error(`Chatter stats file invalid and couldn't be set aside: ${path}`, error)
    return false
  }
  // Its ids go with it: left in place, they'd make the fresh counts skip messages they never saw.
  const idsPath = path.replace(/\.json$/u, '.ids.json')
  try {
    renameSync(idsPath, `${idsPath}.corrupt-${stamp}`)
  } catch (error) {
    if (!isMissing(error)) {
      console.error(`Chatter stats ids couldn't be set aside: ${idsPath}`, error)
    }
  }
  return true
}

/** Ordinary chat from an identified YouTube account. */
function countable(message: ChatMessage): boolean {
  return (
    message.platform === 'youtube' &&
    message.system !== true &&
    message.moderationNotice !== true &&
    message.held === undefined &&
    message.backlog !== true &&
    isYouTubeChannelId(message.author.id)
  )
}

function countMessage(data: StreamFile, uid: string, message: ChatMessage): void {
  const at = message.timestamp
  const chatter = data.chatters[uid]
  if (chatter === undefined) {
    data.chatters[uid] = { n: message.author.displayName, msgs: 1, first: at, last: at }
  } else {
    chatter.msgs += 1
    chatter.first = Math.min(chatter.first, at)
    if (at >= chatter.last) {
      chatter.last = at
      chatter.n = message.author.displayName
    }
  }
  data.firstAt = data.firstAt === 0 ? at : Math.min(data.firstAt, at)
  data.lastAt = Math.max(data.lastAt, at)
}

function rememberSeen(seen: Set<string>, id: string): void {
  seen.add(id)
  if (seen.size > SEEN_CAP) {
    const oldest = seen.values().next()
    if (oldest.done !== true) {
      seen.delete(oldest.value)
    }
  }
}

function emptyStream(context: StreamContext): StreamFile {
  const data: StreamFile = {
    v: 1,
    videoId: context.videoId,
    creatorId: context.creatorId,
    firstAt: 0,
    lastAt: 0,
    chatters: {}
  }
  if (context.title !== undefined) {
    data.title = context.title
  }
  return data
}

/**
 * Read and validate one stream file, without side effects. Only a file that is absent counts as
 * missing; any other read error leaves its contents unknown, so it is reported as unreadable.
 */
function readStream(
  readFile: (path: string) => string,
  path: string,
  context: { creatorId: string; videoId: string }
): ReadResult {
  let text: string
  try {
    text = readFile(path)
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'unreadable', error }
  }
  try {
    return { kind: 'ok', data: sanitizeStream(JSON.parse(text), context) }
  } catch (error) {
    return { kind: 'invalid', error }
  }
}

/**
 * A stream file from untrusted JSON. The file's own ids must match where it is filed; chatter
 * entries that aren't well-formed are dropped, not the whole stream. Throws when the file is not a
 * stream file at all.
 */
function sanitizeStream(
  value: unknown,
  context: { creatorId: string; videoId: string }
): StreamFile {
  if (typeof value !== 'object' || value === null) {
    throw new Error('not an object')
  }
  const input = value as Record<string, unknown>
  if (input['v'] !== 1 || input['videoId'] !== context.videoId) {
    throw new Error('wrong version or video id')
  }
  if (input['creatorId'] !== context.creatorId) {
    throw new Error('wrong creator id')
  }
  const data = emptyStream(context)
  if (typeof input['title'] === 'string') {
    data.title = input['title']
  }
  const raw = input['chatters']
  if (typeof raw === 'object' && raw !== null) {
    for (const [uid, entry] of Object.entries(raw as Record<string, unknown>)) {
      const chatter = sanitizeChatter(entry)
      if (chatter !== undefined && isYouTubeChannelId(uid)) {
        data.chatters[uid] = chatter
        data.firstAt = data.firstAt === 0 ? chatter.first : Math.min(data.firstAt, chatter.first)
        data.lastAt = Math.max(data.lastAt, chatter.last)
      }
    }
  }
  return data
}

function sanitizeChatter(value: unknown): StreamChatter | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = value as Record<string, unknown>
  const { n, msgs, first, last } = input
  if (
    typeof n !== 'string' ||
    typeof msgs !== 'number' ||
    !Number.isInteger(msgs) ||
    msgs < 1 ||
    typeof first !== 'number' ||
    typeof last !== 'number' ||
    !Number.isFinite(first) ||
    !Number.isFinite(last) ||
    first > last
  ) {
    return undefined
  }
  return { n, msgs, first, last }
}

/** Fold per-stream records into per-chatter totals, most regular first. */
/** Per-chatter totals over some set of streams, mergeable one stream at a time. */
interface Totals {
  byId: Map<string, ChatterSummary>
  /** Streams with at least one counted message. */
  streams: number
  trackedSince?: number
}

function emptyTotals(): Totals {
  return { byId: new Map(), streams: 0 }
}

/** A copy safe to merge more streams into without changing the original (the cached one). */
function copyTotals(totals: Totals): Totals {
  const copy: Totals = {
    byId: new Map([...totals.byId].map(([id, entry]) => [id, { ...entry }])),
    streams: totals.streams
  }
  if (totals.trackedSince !== undefined) {
    copy.trackedSince = totals.trackedSince
  }
  return copy
}

function addStream(totals: Totals, stream: StreamFile): void {
  const entries = Object.entries(stream.chatters)
  if (entries.length === 0) {
    return
  }
  totals.streams += 1
  totals.trackedSince =
    totals.trackedSince === undefined
      ? stream.firstAt
      : Math.min(totals.trackedSince, stream.firstAt)
  for (const [id, chatter] of entries) {
    const total = totals.byId.get(id)
    if (total === undefined) {
      totals.byId.set(id, {
        id,
        name: chatter.n,
        streams: 1,
        messages: chatter.msgs,
        firstSeen: chatter.first,
        lastSeen: chatter.last
      })
      continue
    }
    total.streams += 1
    total.messages += chatter.msgs
    total.firstSeen = Math.min(total.firstSeen, chatter.first)
    if (chatter.last > total.lastSeen) {
      total.lastSeen = chatter.last
      total.name = chatter.n
    }
  }
}

/** The summary for `totals`, most regular first. */
function finish(creatorId: string, totals: Totals): ChatterStatsSummary {
  const chatters = [...totals.byId.values()].sort(
    (a, b) =>
      b.streams - a.streams ||
      b.messages - a.messages ||
      b.lastSeen - a.lastSeen ||
      a.id.localeCompare(b.id)
  )
  const summary: ChatterStatsSummary = { creatorId, streams: totals.streams, chatters }
  if (totals.trackedSince !== undefined) {
    summary.trackedSince = totals.trackedSince
  }
  return summary
}
