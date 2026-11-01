import type { ChatEvent, ChatMessage, ClearTarget, Highlight, Platform } from '@shared/model'
import { isCheerAmount } from '@shared/cheerFragments'

/**
 * The per-stream chat log's line format (version {@link LOG_FORMAT_VERSION}).
 *
 * One JSON object per line, short keys, nothing a reader can't use. Message content is kept in
 * full: text, emoji and emote codes inline in `m`. An emote's image URL is written once per file
 * as an `emote` definition line ahead of the first message using it, so a viewer can render it
 * without the URL repeating on every line. Badges, colours and avatars are not logged.
 *
 * Line kinds (the `k` field; absent on a chat message, the common case):
 * - `stream` — the file header: platform, column id, stream key, creator, title, start time.
 * - `emote` — `c` (the code as it appears in `m`) renders as `url` from here on. A message whose
 *   `e` array is present overrides this: its emotes, in order, render as those URLs.
 * - message — `t` send time (epoch ms), `id`, `uid` account id, `u` display name, `h` login or
 *   handle when it differs from `u`, `m` text, plus optional flags described on {@link LogMessage}.
 * - `replace` — a message's later state (held → shown or removed, a back-filled reward name),
 *   carrying the full message fields again; the latest line for an `id` wins.
 * - `del` / `clear-user` / `clear-all` — a moderation removal of one message, every message by
 *   `uid`, or the whole chat, at `t`.
 */
export const LOG_FORMAT_VERSION = 1

/** Which stream a file belongs to, and what its header says about it. */
export interface StreamTarget {
  platform: Platform
  /** The column the events came from (several columns can feed one stream's file). */
  channelId: string
  /** Directory under the platform: the YouTube creator id, or the Twitch login. */
  owner: string
  /** File name stem, unique per stream within `owner`. */
  streamKey: string
  creatorId?: string
  title?: string
  /** When the platform says the stream started (epoch ms). */
  startedAt?: number
}

/** A paid or membership event's essentials. */
export interface LogHighlight {
  k: Highlight['kind']
  /** The platform's formatted amount (Super Chat, sticker). */
  amt?: string
  bits?: number
  /** How many were given (gift subs/memberships). */
  n?: number
  /** Resub tenure in months. */
  mo?: number
  tier?: string
  hdr?: string
  /** Announces activity that is not a purchase (milestone, gift delivery). */
  np?: 1
}

export interface LogMessage {
  k?: 'replace'
  t: number
  id: string
  uid: string
  u: string
  h?: string
  m: string
  /** System notice (sub, raid, membership…). */
  sys?: 1
  /** YouTube moderation-activity notice. */
  mod?: 1
  /** Held for review by YouTube automod. */
  held?: 1
  /** Removed by a moderator (on a `replace`). */
  del?: 1
  /** From a chat-history service, not received live. */
  bl?: 1
  /** Sent by the signed-in account. */
  self?: 1
  /** Id of the message this replies to. */
  r?: string
  /** Paid/membership event. */
  d?: LogHighlight
  /** Channel-points reward name or id. */
  rw?: string
  /** GIF image URLs, in order; their placeholder text is in `m`. */
  media?: string[]
  /**
   * Every emote's image URL in the order the emotes appear in `m` — present only when one code
   * stands for two different images in this message, which a code-keyed definition can't express.
   */
  e?: string[]
}

export interface LogEmote {
  k: 'emote'
  c: string
  url: string
}

/** The header written once at the top of a new file. */
export function headerLine(target: StreamTarget): Record<string, unknown> {
  const line: Record<string, unknown> = {
    k: 'stream',
    v: LOG_FORMAT_VERSION,
    p: target.platform,
    ch: target.channelId,
    key: target.streamKey
  }
  if (target.creatorId !== undefined) {
    line['creator'] = target.creatorId
  }
  if (target.title !== undefined) {
    line['title'] = target.title
  }
  if (target.startedAt !== undefined) {
    line['started'] = target.startedAt
  }
  return line
}

/** The compact form of a message (or of its later state, for a `replace`). */
export function messageLine(message: ChatMessage, replace = false): LogMessage {
  const line: LogMessage = {
    t: message.timestamp,
    id: message.id,
    uid: message.author.id,
    u: message.author.displayName,
    m: textOf(message)
  }
  if (replace) {
    line.k = 'replace'
  }
  const handle = message.author.name
  if (handle !== '' && handle !== message.author.displayName) {
    line.h = handle
  }
  applyFlags(line, message)
  return line
}

function applyFlags(line: LogMessage, message: ChatMessage): void {
  if (message.system === true) {
    line.sys = 1
  }
  if (message.moderationNotice === true) {
    line.mod = 1
  }
  if (message.held !== undefined) {
    line.held = 1
  }
  if (message.deleted === true) {
    line.del = 1
  }
  if (message.backlog === true) {
    line.bl = 1
  }
  if (message.self === true) {
    line.self = 1
  }
  if (message.reply !== undefined) {
    line.r = message.reply.parentId
  }
  if (message.highlight !== undefined) {
    line.d = highlightOf(message.highlight)
  }
  if (message.reward !== undefined) {
    line.rw = message.reward.name ?? message.reward.id
  }
  const media = message.fragments.flatMap((fragment) =>
    fragment.type === 'gif' ? [fragment.url] : []
  )
  if (media.length > 0) {
    line.media = media
  }
  const emoteUrls = ambiguousEmoteUrls(message)
  if (emoteUrls !== undefined) {
    line.e = emoteUrls
  }
}

/** Every emote URL in order, when one code maps to two images in the message; else undefined. */
function ambiguousEmoteUrls(message: ChatMessage): string[] | undefined {
  const urlByCode = new Map<string, string>()
  const urls: string[] = []
  let ambiguous = false
  for (const fragment of message.fragments) {
    if (fragment.type !== 'emote') {
      continue
    }
    const seen = urlByCode.get(fragment.code)
    if (seen !== undefined && seen !== fragment.url) {
      ambiguous = true
    }
    urlByCode.set(fragment.code, fragment.url)
    urls.push(fragment.url)
  }
  return ambiguous ? urls : undefined
}

function highlightOf(highlight: Highlight): LogHighlight {
  const out: LogHighlight = { k: highlight.kind }
  if (highlight.displayAmount !== undefined) {
    out.amt = highlight.displayAmount
  }
  if (highlight.kind === 'bits' && highlight.amount !== undefined) {
    out.bits = highlight.amount
  }
  if (highlight.count !== undefined) {
    out.n = highlight.count
  }
  if (highlight.months !== undefined) {
    out.mo = highlight.months
  }
  if (highlight.tier !== undefined) {
    out.tier = highlight.tier
  }
  if (highlight.headerText !== undefined) {
    out.hdr = highlight.headerText
  }
  if (highlight.notAPurchase === true) {
    out.np = 1
  }
  return out
}

/** Text with emotes as their codes and mentions and links as shown; nothing is dropped. */
function textOf(message: ChatMessage): string {
  return message.fragments
    .map((fragment, index) => {
      if (isCheerAmount(message.fragments, index)) {
        return ''
      }
      return fragment.type === 'emote' ? fragment.code : fragment.text
    })
    .join('')
}

/**
 * Definition lines for the emotes in `message` this file hasn't defined yet — or has defined with
 * a different URL (a provider updated the image, or two providers share a code). `known` is the
 * file's code → URL map and is updated in place.
 */
export function emoteLines(message: ChatMessage, known: Map<string, string>): LogEmote[] {
  const out: LogEmote[] = []
  for (const fragment of message.fragments) {
    if (fragment.type !== 'emote' || fragment.url === '') {
      continue
    }
    if (known.get(fragment.code) === fragment.url) {
      continue
    }
    known.set(fragment.code, fragment.url)
    out.push({ k: 'emote', c: fragment.code, url: fragment.url })
  }
  return out
}

/** A moderation removal, at the time it was observed. */
export function clearLine(target: ClearTarget, at: number): Record<string, unknown> {
  if (target.messageId !== undefined) {
    return { t: at, k: 'del', id: target.messageId }
  }
  if (target.userId !== undefined) {
    return { t: at, k: 'clear-user', uid: target.userId }
  }
  return { t: at, k: 'clear-all' }
}

/**
 * Dedup key for a loggable event: the message id, the cleared message's id, or a replace keyed by
 * the message's resolved state so a held→shown/hidden transition logs once while YouTube's poll
 * re-sends of the same transition don't. User- and whole-chat clears have no stable identity and
 * always log.
 */
export function eventKey(event: ChatEvent): string | undefined {
  if (event.kind === 'message') {
    return `m:${event.message.id}`
  }
  if (event.kind === 'replace') {
    return replaceKey(event.message.id, event.message.deleted === true, event.message.held)
  }
  if (event.kind === 'clear' && event.target.messageId !== undefined) {
    return `c:${event.target.messageId}`
  }
  return undefined
}

function replaceKey(id: string, deleted: boolean, held: unknown): string {
  const state = deleted ? 'del' : held !== undefined ? 'held' : 'shown'
  return `r:${id}:${state}`
}

/**
 * The dedup key of a line already in a file, so reopening a file after a restart doesn't re-log
 * what YouTube replays. Returns undefined for lines that carry no identity.
 */
export function lineKey(line: Record<string, unknown>): string | undefined {
  const id = line['id']
  if (typeof id !== 'string') {
    return undefined
  }
  const kind = line['k']
  if (kind === undefined) {
    return `m:${id}`
  }
  if (kind === 'replace') {
    return replaceKey(id, line['del'] === 1, line['held'] === 1 ? true : undefined)
  }
  if (kind === 'del') {
    return `c:${id}`
  }
  return undefined
}
