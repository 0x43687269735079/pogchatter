/**
 * Splits an over-long chat message on grapheme-cluster boundaries.
 *
 * Twitch caps a message at 500 characters, and twurple splits anything longer itself before sending
 * (`splitOnSpaces` in @twurple/chat). When the text has no space near the cut, that splitter falls
 * back to a raw UTF-16 slice — `text.slice(start, start + 500)` — which tears an emoji in half
 * whenever the boundary lands mid-surrogate-pair, so both halves arrive as `�`. Because it depends
 * purely on where the emoji sits relative to the cut, it corrupts roughly half of all alignments,
 * which is why it looked intermittent. Multi-code-point emoji (family/profession ZWJ sequences,
 * skin tones, flags) are torn into their parts even when the surrogates survive.
 *
 * Splitting here first keeps every chunk at or under the limit, so twurple's splitter is a no-op
 * (it returns the text unchanged when it already fits) and no emoji is ever cut apart.
 */

import { MESSAGE_LIMIT } from '@shared/model'

/** Twitch's per-message limit, measured the way twurple measures it (UTF-16 code units). */
export const TWITCH_MESSAGE_LIMIT = MESSAGE_LIMIT.twitch

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * `text` as chunks that each fit within `limit`, breaking at a space where possible and never inside
 * a grapheme cluster. A message that already fits is returned as-is, so the common path is untouched.
 */
export function splitChatMessage(text: string, limit: number = TWITCH_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) {
    return [text]
  }
  const chunks: string[] = []
  let chunk = ''
  // Offset just past the last whitespace in `chunk`, or 0 while it holds no break point.
  let wordBreak = 0

  const flush = (upTo: number): void => {
    const head = chunk.slice(0, upTo).trim()
    if (head !== '') {
      chunks.push(head)
    }
    chunk = chunk.slice(upTo)
    wordBreak = 0
  }

  for (const { segment } of graphemes.segment(text)) {
    if (segment.length > limit) {
      // One cluster longer than the entire allowance — "Zalgo" text is a single base character with
      // hundreds of combining marks. It cannot be kept whole, and passing it through would hand an
      // over-limit chunk to twurple's raw-index splitter, reintroducing the tearing this module
      // exists to prevent. Break it on code-point boundaries so surrogate pairs at least survive.
      flush(chunk.length)
      for (const piece of splitCodePoints(segment, limit)) {
        chunks.push(piece)
      }
      continue
    }
    if (chunk.length + segment.length > limit) {
      // Prefer the last word boundary; fall back to the cluster boundary for one unbroken run.
      flush(wordBreak > 0 ? wordBreak : chunk.length)
    }
    chunk += segment
    if (/\s/u.test(segment)) {
      wordBreak = chunk.length
    }
  }
  const tail = chunk.trim()
  if (tail !== '') {
    chunks.push(tail)
  }
  return chunks
}

/** `text` in `limit`-sized pieces that never split a surrogate pair (a last resort — see above). */
function splitCodePoints(text: string, limit: number): string[] {
  const pieces: string[] = []
  let piece = ''
  for (const codePoint of text) {
    if (piece.length + codePoint.length > limit) {
      pieces.push(piece)
      piece = ''
    }
    piece += codePoint
  }
  if (piece !== '') {
    pieces.push(piece)
  }
  return pieces
}
