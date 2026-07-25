import type { ReactElement } from 'react'
import type { Platform } from '@shared/model'
import { charCount } from '@renderer/charCount'

interface CharCountProps {
  /** The current draft, counted as-is — trailing spaces still cost their place in the message. */
  draft: string
  /** Whose limit applies; also decides what going over means (Twitch splits, YouTube rejects). */
  platform: Platform
}

/** How much of the platform's message limit the draft has left (see {@link charCount}). */
export function CharCount({ draft, platform }: CharCountProps): ReactElement | null {
  const count = charCount(draft, platform)
  if (count === undefined) {
    return null
  }
  // Deliberately not a live region: the label changes on every keystroke, so announcing it would
  // read a running count over the user's own typing. It stays available to read on demand.
  return (
    <span className={count.tone === 'plain' ? 'pc-chars' : `pc-chars ${count.tone}`}>
      {count.label}
    </span>
  )
}
