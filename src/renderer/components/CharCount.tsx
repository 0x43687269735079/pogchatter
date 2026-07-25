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
  return (
    <span
      className={count.tone === 'plain' ? 'pc-chars' : `pc-chars ${count.tone}`}
      aria-live="polite"
    >
      {count.label}
    </span>
  )
}
