import type { ReactElement } from 'react'
import type { Badge } from '@shared/model'

const BADGE_GLYPH: Record<string, string> = {
  broadcaster: '✦',
  moderator: '⚔',
  vip: '◆',
  subscriber: '★',
  member: '✦',
  verified: '✓'
}

/** Author role badges: real badge images when available, glyph chips as the fallback. */
export function Badges({ badges }: { badges: Badge[] }): ReactElement | null {
  if (badges.length === 0) {
    return null
  }
  return (
    <span className="pc-bdgs">
      {badges.map((badge) =>
        badge.imageUrl !== undefined ? (
          <img
            key={badge.type}
            className="pc-badge-img"
            src={badge.imageUrl}
            alt={badge.label}
            title={badge.label}
            loading="lazy"
          />
        ) : (
          <span key={badge.type} className={`pc-badge b-${badge.type}`} title={badge.label}>
            {BADGE_GLYPH[badge.type] ?? badge.type.charAt(0).toUpperCase()}
          </span>
        )
      )}
    </span>
  )
}
