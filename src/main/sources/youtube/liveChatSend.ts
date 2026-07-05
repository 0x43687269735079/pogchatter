/**
 * Building blocks for sending a live-chat message: rich-text segments (YouTube's web client converts
 * a typed `:shortcut:` into an emoji segment so it renders as an image; sending the literal text
 * leaves it as plain text), the request's `params` token, and delivery classification of the raw
 * response. youtubei.js's `LiveChat.sendMessage` only sends plain text and hard-fails its strict
 * parse on any unmodeled response action, so {@link YouTubeAuthManager} builds the request and reads
 * the response itself using these helpers.
 */

/** A send_message rich-message segment: plain text, or a reference to an emoji by id. */
export interface RichSegment {
  text?: string
  emojiId?: string
}

/** Delivery outcome read from a raw (HTTP-ok, unparsed) `send_message` response. */
export type SendOutcome =
  | { kind: 'posted' }
  | { kind: 'held' }
  | { kind: 'rejected'; message?: string }

/** Tolerant of renames around the stable `ChatItem` core (YouTube drifts action names). */
const HELD_KEY = /^dim\w*chatitem/i

/** DFS for the first value under a matching key, skipping `responseContext` (tracking metadata). */
function findValueByKey(node: unknown, matches: (key: string) => boolean): unknown {
  if (node === null || typeof node !== 'object') {
    return undefined
  }
  const entries = Array.isArray(node) ? node.entries() : Object.entries(node)
  for (const [key, value] of entries) {
    if (key === 'responseContext') {
      continue
    }
    if (typeof key === 'string' && matches(key)) {
      return value
    }
    const found = findValueByKey(value, matches)
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

/**
 * Classify a raw `send_message` response. A delivered message is echoed back as an
 * `addChatItemAction`; a *held* message instead carries a `dimChatItemAction` (YouTube telling its
 * own client to grey out the optimistic copy); an explicit `error` payload is a rejection. Anything
 * else on an HTTP-ok response counts as posted — YouTube ships new sibling actions (attestation
 * commands, experiments) routinely, and reporting a delivered message as failed invites duplicate
 * resends.
 */
export function classifySendResponse(data: unknown): SendOutcome {
  if (findValueByKey(data, (key) => HELD_KEY.test(key)) !== undefined) {
    return { kind: 'held' }
  }
  const error = findValueByKey(data, (key) => key === 'error')
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' && message !== ''
      ? { kind: 'rejected', message }
      : { kind: 'rejected' }
  }
  return { kind: 'posted' }
}

const SHORTCODE = /:[-\w+]+:/g

/**
 * Split text into rich-message segments, replacing any `:shortcut:` that maps to a proprietary
 * YouTube emoji with an emoji segment. Unknown shortcuts and plain text stay as text. Returns a
 * single text segment when nothing converts (or there are no emojis), matching youtubei.js.
 */
export function buildTextSegments(
  text: string,
  emojiByShortcut: Map<string, string>
): RichSegment[] {
  if (emojiByShortcut.size === 0) {
    return [{ text }]
  }
  const segments: RichSegment[] = []
  let last = 0
  for (const match of text.matchAll(SHORTCODE)) {
    const emojiId = emojiByShortcut.get(match[0])
    if (emojiId === undefined || match.index === undefined) {
      continue
    }
    const before = text.slice(last, match.index)
    if (before !== '') {
      segments.push({ text: before })
    }
    segments.push({ emojiId })
    last = match.index + match[0].length
  }
  const tail = text.slice(last)
  if (tail !== '') {
    segments.push({ text: tail })
  }
  return segments.length > 0 ? segments : [{ text }]
}

function varint(value: number): number[] {
  const out: number[] = []
  let n = value
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return out
}

/** The wire tag for a field, varint-encoded — so field numbers above 15 (a two-byte tag) don't
 *  truncate. For field numbers ≤ 15 this is the same single byte as before. */
function tag(fieldNumber: number, wireType: number): number[] {
  return varint((fieldNumber << 3) | wireType)
}

function lenField(fieldNumber: number, payload: number[]): number[] {
  return [...tag(fieldNumber, 2), ...varint(payload.length), ...payload]
}

function strField(fieldNumber: number, value: string): number[] {
  return lenField(fieldNumber, [...Buffer.from(value, 'utf8')])
}

function varintField(fieldNumber: number, value: number): number[] {
  return [...tag(fieldNumber, 0), ...varint(value)]
}

/**
 * The `params` token send_message requires: a protobuf of
 * `{ params: { ids: { channelId, videoId } }, number0: 1, number1: 4 }`, then base64 → URL-encode →
 * base64 (replicating youtubei.js, which builds it from a generated proto it doesn't export). The
 * field numbers are fixed by YouTube's schema (Ids channelId=1/videoId=2, Params ids=5, the outer
 * params=1/number0=2/number1=3).
 */
export function encodeSendParams(videoId: string, channelId: string): string {
  const ids = [...strField(1, channelId), ...strField(2, videoId)]
  const params = lenField(5, ids)
  const message = [...lenField(1, params), ...varintField(2, 1), ...varintField(3, 4)]
  const base64 = Buffer.from(message).toString('base64')
  return Buffer.from(encodeURIComponent(base64), 'latin1').toString('base64')
}

/**
 * The `params` token the `get_panel` "channel activity" panel (`PAlc_channel_activity`) requires: a
 * protobuf of `{ 132: { 1: { 5: { channelId: broadcaster, videoId } }, 2: { channelId: target }, 5: 1 } }`,
 * then base64 → URL-encode (matching the browser request, which stores the `=` padding as `%3D`).
 * The inner `1 → 5 → { 1: channelId, 2: videoId }` mirrors {@link encodeSendParams}; the target user
 * whose activity is requested is field 2, and the outer wrapper is field 132.
 */
export function encodeChannelActivityParams(
  broadcasterChannelId: string,
  videoId: string,
  targetChannelId: string
): string {
  const ids = lenField(5, [...strField(1, broadcasterChannelId), ...strField(2, videoId)])
  const body = [
    ...lenField(1, ids),
    ...lenField(2, strField(1, targetChannelId)),
    ...varintField(5, 1)
  ]
  const base64 = Buffer.from(lenField(132, body)).toString('base64')
  return encodeURIComponent(base64)
}
