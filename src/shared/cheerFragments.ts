import type { Fragment } from '@shared/model'

/**
 * True when `fragments[index]` is the bits amount Twitch renders after a cheer's artwork.
 *
 * A cheer with art is normalised to an emote whose code is the typed cheer (`Cheer100`) followed by
 * a verbatim text fragment holding the amount (`100`) — the image and the number shown beside it.
 * Flattening a message to text must drop that amount, or `Cheer100` becomes `Cheer100100`.
 */
export function isCheerAmount(fragments: readonly Fragment[], index: number): boolean {
  const fragment = fragments[index]
  const previous = fragments[index - 1]
  return (
    fragment?.type === 'text' &&
    fragment.verbatim === true &&
    previous?.type === 'emote' &&
    previous.provider === 'twitch' &&
    previous.code.toLowerCase().endsWith(fragment.text.toLowerCase())
  )
}
