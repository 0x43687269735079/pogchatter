/**
 * Pure encoding/decoding for YouTube's live-chat "signaler" — Google's WebChannel/BrowserChannel
 * push that fires when a chat's invalidation topic changes (decoded from a proxy capture). These functions carry no I/O or state so they can be unit-tested against fixtures;
 * {@link YouTubeSignaler} drives the actual session with them.
 *
 * The wire shapes are reverse-engineered and undocumented — treat them as brittle.
 */

const HOST = 'https://signaler-pa.youtube.com'
// Public web key from the watch-page ytcfg (not a credential — it scopes the anonymous API call).
const KEY = 'AIzaSyDZNkyC-AtROwMBpLfevIvqYk-Gfi8ZOeo'
const CLIENT = 'youtube_live_chat_web'

/** A live chat's invalidation topic is simply `chat~<videoId>`. */
export function topicFor(videoId: string): string {
  return `chat~${videoId}`
}

export function chooseServerUrl(): string {
  return `${HOST}/punctual/v1/chooseServer?key=${KEY}`
}

export function bindUrl(gsessionid: string, rid: number, zx: string): string {
  return (
    `${HOST}/punctual/multi-watch/channel?VER=8&gsessionid=${encodeURIComponent(gsessionid)}` +
    `&key=${KEY}&RID=${rid}&CVER=22&zx=${zx}&t=1`
  )
}

export function backChannelUrl(
  gsessionid: string,
  sid: string,
  aid: number,
  ci: number,
  zx: string
): string {
  return (
    `${HOST}/punctual/multi-watch/channel?VER=8&gsessionid=${encodeURIComponent(gsessionid)}` +
    `&key=${KEY}&RID=rpc&SID=${encodeURIComponent(sid)}&AID=${aid}&CI=${ci}&TYPE=xmlhttp&zx=${zx}&t=1`
  )
}

/** Body subscribing the topic when asking the server to choose a session host (current API shape). */
export function chooseServerBody(topic: string): string {
  return JSON.stringify([
    [null, null, null, [9, 5], null, [[CLIENT], [1], [[[topic]]]]],
    null,
    null,
    0
  ])
}

/**
 * Forward-channel "bind" body that opens the WebChannel and subscribes the topic (current API
 * shape, matching yt-chat-signaler). The request id is the **string** `"1"`, and the trailing
 * `null,null,1`/`null,3` sit on `open`/the request — not inside the subscription. The old capture's
 * `[1,…,null,3]` shape put `3` on `start_time_chosen_by_punctual` (now `TYPE_BOOL`), which the
 * server rejects with a BadRequest + `["close"]`.
 */
export function bindBody(topic: string): string {
  const subscription = [[CLIENT], [1], [[[topic]]]]
  const open = [null, null, null, [9, 5], null, subscription, null, null, 1]
  const data = JSON.stringify([[['1', open, null, 3]]])
  return `count=1&ofs=0&req0___data__=${encodeURIComponent(data)}`
}

/** `chooseServer` returns `["<gsessionid>",3,null,...]`. */
export function parseGsessionId(responseText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(responseText)
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : undefined
  } catch {
    return undefined
  }
}

/** The open response carries a control frame `[0,["c","<SID>",...]]`; pull the SID out of it. */
export function parseSid(responseText: string): string | undefined {
  for (const frame of parseFrames(responseText).frames) {
    const payload = frame.payload
    if (Array.isArray(payload) && payload[0] === 'c' && typeof payload[1] === 'string') {
      return payload[1]
    }
  }
  return undefined
}

export interface SignalFrame {
  /** Monotonic array id; the max seen becomes the next request's `AID`. */
  id: number
  payload: unknown
}

/**
 * Parse length-prefixed BrowserChannel frames (`"<len>\n<json>"`, repeated). Each json is an
 * array of `[id, payload]` entries, flattened here. Returns the complete frames plus any trailing
 * partial bytes (`rest`) so a streaming caller can prepend them to the next read.
 */
export function parseFrames(buffer: string): { frames: SignalFrame[]; rest: string } {
  const frames: SignalFrame[] = []
  let pos = 0
  while (pos < buffer.length) {
    const newline = buffer.indexOf('\n', pos)
    if (newline === -1) {
      break
    }
    const lengthText = buffer.slice(pos, newline)
    if (!/^\d+$/.test(lengthText)) {
      break
    }
    const start = newline + 1
    const end = start + Number(lengthText)
    if (buffer.length < end) {
      break // incomplete chunk — leave it in `rest`
    }
    pos = end
    let parsed: unknown
    try {
      parsed = JSON.parse(buffer.slice(start, end))
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) {
      continue
    }
    for (const entry of parsed) {
      if (Array.isArray(entry) && typeof entry[0] === 'number') {
        frames.push({ id: entry[0], payload: entry[1] })
      }
    }
  }
  return { frames, rest: buffer.slice(pos) }
}

export type FrameKind = 'noop' | 'open' | 'ack' | 'signal' | 'unknown'

export interface FrameInfo {
  kind: FrameKind
  /** For a real `signal` frame: the topic's first publish timestamp (µs), to forward to get_live_chat. */
  publishUsec?: string
}

/**
 * Classify a back-channel frame. Only `signal` frames are real topic invalidations ("new chat,
 * go fetch"); `noop` is a keepalive, `open` is the connection-id frame, `ack` is the subscription
 * acknowledgement. Shapes (topic index `"1"`):
 * - noop:   `[id,["noop"]]`
 * - open:   `[id,[[null,null,["<srvId>"]]]]`
 * - ack:    `[id,[[[["1",[["<ts>"]]]]]]]`                       — topic value `[["<ts>"]]`
 * - signal: `[id,[[[["1",[null,[[[null,"<tok>","<ts1>",…]]]]]]]]]` — topic value `[null,[[[null,…]]]]`
 * The signal's `<ts1>` is the `invalidationPayloadLastPublishAtUsec` the browser echoes to get_live_chat.
 */
export function classifyFrame(frame: SignalFrame): FrameInfo {
  const payload = frame.payload
  if (Array.isArray(payload) && payload[0] === 'noop') {
    return { kind: 'noop' }
  }
  const entry = asArray(asArray(asArray(payload)?.[0])?.[0])?.[0]
  if (!Array.isArray(entry) || entry[0] !== '1') {
    return { kind: 'open' }
  }
  const value = entry[1]
  if (!Array.isArray(value) || value[0] !== null) {
    return { kind: 'ack' } // value is `[["<ts>"]]`
  }
  // signal: value = [null, [[[null, token, ts1, ts2, …]]]] — pull ts1.
  const publishUsec = asArray(asArray(asArray(value[1])?.[0])?.[0])?.[2]
  return typeof publishUsec === 'string' ? { kind: 'signal', publishUsec } : { kind: 'signal' }
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}
