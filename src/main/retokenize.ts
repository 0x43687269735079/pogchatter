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
  if (a.type === 'link') {
    return b.type === 'link' && a.text === b.text && a.url === b.url
  }
  if (a.type === 'mention') {
    return b.type === 'mention' && a.text === b.text
  }
  return b.type === 'text' && a.text === b.text
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
    const fragments = tokenize([...message.fragments])
    if (!sameFragments(message.fragments, fragments)) {
      changed.push({ ...message, fragments })
    }
  }
  return changed
}
