import type { LogHighlight, LogMessage } from '@main/chatLog/logLines'
import { isApprovedEmoteUrl } from '@main/net/imageUrl'
import type { ChatMessage, Fragment, Highlight, HighlightKind, Platform } from '@shared/model'
import type { UserHistoryStream } from '@shared/userHistory'

/**
 * One line of a per-stream chat log, read back (format: `logLines.ts`). Every field is checked:
 * a line that claims a kind but lacks what that kind needs is malformed, not guessed at.
 */
export type LogLine =
  | { kind: 'header'; channelId: string; streamKey?: string; title?: string; startedAt?: number }
  | { kind: 'emote'; code: string; url: string }
  | { kind: 'message' | 'replace'; line: LogMessage }
  | { kind: 'del'; id: string }
  | { kind: 'clearUser'; uid: string; at: number }
  | { kind: 'clearAll'; at: number }
  /** A kind a newer version writes; skipped, not counted as malformed. */
  | { kind: 'unknown' }

type Fields = Record<string, unknown>

const HIGHLIGHT_KINDS: ReadonlySet<string> = new Set<HighlightKind>([
  'superchat',
  'supersticker',
  'bits',
  'membership',
  'membership_gift',
  'subscription',
  'first_message'
])

/**
 * Read one log line. Total: any string gives a line or `undefined` (malformed), never a throw.
 *
 * Args:
 *   text: One line of a log file, without its newline.
 */
export function parseLogLine(text: string): LogLine | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const fields = value as Fields
  const kind = fields['k']
  if (kind === undefined || kind === 'replace') {
    const line = messageFields(fields)
    return line === undefined
      ? undefined
      : { kind: kind === undefined ? 'message' : 'replace', line }
  }
  return typeof kind === 'string' ? otherLine(kind, fields) : undefined
}

/** The lines that aren't messages, by their `k`. */
function otherLine(kind: string, fields: Fields): LogLine | undefined {
  switch (kind) {
    case 'stream':
      return headerFields(fields)
    case 'emote': {
      const { c: code, url } = fields
      return typeof code === 'string' && typeof url === 'string'
        ? { kind: 'emote', code, url }
        : undefined
    }
    case 'del':
      return typeof fields['id'] === 'string' ? { kind: 'del', id: fields['id'] } : undefined
    case 'clear-user': {
      const { uid, t } = fields
      return typeof uid === 'string' && isTime(t) ? { kind: 'clearUser', uid, at: t } : undefined
    }
    case 'clear-all':
      return isTime(fields['t']) ? { kind: 'clearAll', at: fields['t'] } : undefined
    default:
      return { kind: 'unknown' }
  }
}

function headerFields(fields: Fields): LogLine | undefined {
  const { ch, key, title, started } = fields
  if (typeof ch !== 'string') {
    return undefined
  }
  const header: LogLine & { kind: 'header' } = { kind: 'header', channelId: ch }
  if (typeof key === 'string') {
    header.streamKey = key
  }
  if (typeof title === 'string') {
    header.title = title
  }
  if (isTime(started)) {
    header.startedAt = started
  }
  return header
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** A message line's fields, keeping only optional ones of the right type. */
function messageFields(fields: Fields): LogMessage | undefined {
  const { t, id, uid, u, m } = fields
  if (!isTime(t) || typeof id !== 'string' || typeof uid !== 'string') {
    return undefined
  }
  if (typeof u !== 'string' || typeof m !== 'string') {
    return undefined
  }
  const line: LogMessage = { t, id, uid, u, m }
  copyFlags(line, fields)
  copyExtras(line, fields)
  return line
}

const FLAG_NAMES = ['sys', 'mod', 'held', 'del', 'bl', 'self'] as const

function copyFlags(line: LogMessage, fields: Fields): void {
  for (const name of FLAG_NAMES) {
    if (fields[name] === 1) {
      line[name] = 1
    }
  }
}

function copyExtras(line: LogMessage, fields: Fields): void {
  const { h, rw, e, d } = fields
  if (typeof h === 'string') {
    line.h = h
  }
  if (typeof rw === 'string') {
    line.rw = rw
  }
  if (Array.isArray(e) && e.every((url) => typeof url === 'string')) {
    line.e = e
  }
  const highlight = highlightFields(d)
  if (highlight !== undefined) {
    line.d = highlight
  }
}

function highlightFields(value: unknown): LogHighlight | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const fields = value as Fields
  const kind = fields['k']
  if (typeof kind !== 'string' || !HIGHLIGHT_KINDS.has(kind)) {
    return undefined
  }
  const out: LogHighlight = { k: kind as HighlightKind }
  for (const name of ['amt', 'tier', 'hdr'] as const) {
    const text = fields[name]
    if (typeof text === 'string') {
      out[name] = text
    }
  }
  for (const name of ['bits', 'n', 'mo'] as const) {
    const count = fields[name]
    if (isTime(count)) {
      out[name] = count
    }
  }
  if (fields['np'] === 1) {
    out.np = 1
  }
  return out
}

/**
 * A logged message's text as fragments: whitespace-separated tokens that are emote codes become
 * emotes, everything else text. A code's URL is the per-message `override` (the message's emote
 * URLs in order, written when one code meant two images) or else the file's definition so far. An
 * image from a host outside the emote CDNs stays text, so a log line can't make the app fetch from
 * a host of its choosing.
 *
 * Args:
 *   text: The logged `m`.
 *   emotes: Code → URL, from the file's `emote` lines read so far.
 *   override: The message's `e`, when present.
 *   platform: Stands in for the provider, which the log doesn't record.
 */
export function fragmentsFrom(
  text: string,
  emotes: ReadonlyMap<string, string>,
  override: readonly string[] | undefined,
  platform: Platform
): Fragment[] {
  const out = new FragmentBuilder(emotes, override, platform)
  for (const token of text.split(/(\s+)/u)) {
    if (token === '' || out.emote(token)) {
      continue
    }
    // YouTube writes adjacent emoji with no space between them (`hi:wave::wave:`); its `:name:`
    // shortcuts are the one code form that can be found inside a word without false matches.
    for (const piece of token.split(/(:[^\s:]+:)/u)) {
      if (piece !== '' && !(piece.startsWith(':') && out.emote(piece))) {
        out.text(piece)
      }
    }
  }
  return out.done()
}

/** Collects fragments, merging adjacent text, and hands out override URLs in emote order. */
class FragmentBuilder {
  readonly #emotes: ReadonlyMap<string, string>
  readonly #override: readonly string[] | undefined
  readonly #platform: Platform
  readonly #fragments: Fragment[] = []
  #pending = ''
  #nextOverride = 0

  constructor(
    emotes: ReadonlyMap<string, string>,
    override: readonly string[] | undefined,
    platform: Platform
  ) {
    this.#emotes = emotes
    this.#override = override
    this.#platform = platform
  }

  /** Add `code` as an emote if it is one; false when it isn't a known code. */
  emote(code: string): boolean {
    const known = this.#emotes.get(code)
    if (known === undefined) {
      return false
    }
    const url = this.#override?.[this.#nextOverride] ?? known
    this.#nextOverride += 1
    if (!isApprovedEmoteUrl(url)) {
      this.text(code)
      return true
    }
    this.#flush()
    this.#fragments.push({ type: 'emote', code, url, provider: this.#platform })
    return true
  }

  text(text: string): void {
    this.#pending += text
  }

  done(): Fragment[] {
    this.#flush()
    return this.#fragments
  }

  #flush(): void {
    if (this.#pending !== '') {
      this.#fragments.push({ type: 'text', text: this.#pending })
      this.#pending = ''
    }
  }
}

/**
 * Rebuild a chat message from its log line, as the user card renders it. Badges, colours and the
 * avatar weren't logged; a reply's parent text wasn't either, so the reply link is dropped.
 *
 * Args:
 *   line: The message (or its latest `replace`).
 *   stream: The stream the file belongs to.
 *   fragments: From {@link fragmentsFrom}.
 */
export function messageFromLine(
  line: LogMessage,
  stream: UserHistoryStream,
  fragments: Fragment[]
): ChatMessage {
  const message: ChatMessage = {
    id: line.id,
    platform: stream.platform,
    channelId: stream.channelId,
    timestamp: line.t,
    author: {
      id: line.uid,
      name: line.h ?? line.u,
      displayName: line.u,
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments
  }
  applyLoggedFlags(message, line)
  return message
}

function applyLoggedFlags(message: ChatMessage, line: LogMessage): void {
  if (line.sys === 1) {
    message.system = true
  }
  if (line.mod === 1) {
    message.moderationNotice = true
  }
  if (line.del === 1) {
    message.deleted = true
  }
  if (line.bl === 1) {
    message.backlog = true
  }
  if (line.self === 1) {
    message.self = true
  }
  applyLoggedExtras(message, line)
}

function applyLoggedExtras(message: ChatMessage, line: LogMessage): void {
  // A removed message is no longer awaiting review, as in the live chat.
  if (line.held === 1 && line.del !== 1) {
    message.held = { headerText: 'Held for review', actions: [] }
  }
  if (line.rw !== undefined) {
    message.reward = rewardFrom(line.rw)
  }
  if (line.d !== undefined) {
    message.highlight = highlightFrom(line.d)
  }
}

/** A Twitch channel-points reward id: a UUID. */
const REWARD_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu

/**
 * The logger writes a reward's name when it knew it, else its id. An id is a UUID; anything else is
 * the name, kept as the id too since nothing better is known.
 */
function rewardFrom(logged: string): { id: string; name?: string } {
  return REWARD_ID.test(logged) ? { id: logged } : { id: logged, name: logged }
}

function highlightFrom(logged: LogHighlight): Highlight {
  const highlight: Highlight = { kind: logged.k }
  if (logged.amt !== undefined) {
    highlight.displayAmount = logged.amt
  }
  if (logged.bits !== undefined) {
    highlight.amount = logged.bits
  }
  if (logged.n !== undefined) {
    highlight.count = logged.n
  }
  if (logged.mo !== undefined) {
    highlight.months = logged.mo
  }
  if (logged.tier !== undefined) {
    highlight.tier = logged.tier
  }
  if (logged.hdr !== undefined) {
    highlight.headerText = logged.hdr
  }
  if (logged.np === 1) {
    highlight.notAPurchase = true
  }
  return highlight
}
