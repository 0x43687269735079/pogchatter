import type { ChatMessage, Fragment } from '@shared/model'

/**
 * True when two fragments render identically: same kind, same text/code/target. Provider flags
 * (`zeroWidth`, `animated`, `verbatim`) are ignored — they never change without the code or text
 * changing with them, and a re-render is only worth pushing when the reader would see a difference.
 */
function sameFragment(a: Fragment, b: Fragment): boolean {
  if (a.type === 'emote') {
    return b.type === 'emote' && a.code === b.code && a.url === b.url
  }
  if (a.type === 'gif') {
    return b.type === 'gif' && a.text === b.text && a.url === b.url
  }
  if (a.type === 'mention') {
    return b.type === 'mention' && a.text === b.text
  }
  return b.type === 'text' && a.text === b.text
}

function isThirdPartyEmote(fragment: Fragment): fragment is Fragment & { type: 'emote' } {
  return (
    fragment.type === 'emote' &&
    (fragment.provider === '7tv' || fragment.provider === 'bttv' || fragment.provider === 'ffz')
  )
}

/**
 * Third-party emote fragments revert to their code, merged into the surrounding text, so that a
 * catalogue arriving later can override an earlier match (a channel's own 7TV emote outranks a
 * global one of the same name) and an emote a provider no longer serves reverts to text. A native
 * emote comes from the platform's own message tag, not from any catalogue, so it stays — as does
 * verbatim text, which was never tokenised.
 */
function withThirdPartyEmotesAsText(fragments: readonly Fragment[]): Fragment[] {
  const out: Fragment[] = []
  for (const fragment of fragments) {
    const text = isThirdPartyEmote(fragment)
      ? fragment.code
      : fragment.type === 'text' && fragment.verbatim !== true
        ? fragment.text
        : undefined
    if (text === undefined) {
      out.push(fragment)
      continue
    }
    const last = out[out.length - 1]
    if (last?.type === 'text' && last.verbatim !== true) {
      out[out.length - 1] = { type: 'text', text: last.text + text }
      continue
    }
    out.push({ type: 'text', text })
  }
  return out
}

function sameFragments(a: readonly Fragment[], b: readonly Fragment[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((fragment, index) => {
    const other = b[index]
    return other !== undefined && sameFragment(fragment, other)
  })
}

/**
 * Re-run buffered messages through `tokenize` and return only those whose fragments came back
 * different — a channel's 7TV set (or the shared library) often finishes loading after the first
 * messages were tokenized, leaving an emote's name sitting in the row as plain text.
 *
 * Each changed message is a fresh object (shallow copy carrying the new fragments); the inputs are
 * never mutated, so a caller that keeps the originals still holds what the renderer already has.
 *
 * @param messages Buffered messages to re-check, in any order.
 * @param tokenize Tokenizer bound to the message's channel; must not mutate the array it is given.
 * @returns New message objects for the changed rows only, in input order.
 */
export function retokenizeAgainst(
  messages: readonly ChatMessage[],
  tokenize: (fragments: Fragment[]) => Fragment[]
): ChatMessage[] {
  const changed: ChatMessage[] = []
  for (const message of messages) {
    const fragments = tokenize(withThirdPartyEmotesAsText(message.fragments))
    if (!sameFragments(message.fragments, fragments)) {
      changed.push({ ...message, fragments })
    }
  }
  return changed
}
