import type { ChannelInfo, ChatMessage } from '@shared/model'

/** Origin-tag colours, cycled by a member's position so each column gets a stable, distinct hue. */
const ORIGIN_COLORS = [
  '#88c0d0',
  '#a3be8c',
  '#b48ead',
  '#ebcb8b',
  '#d08770',
  '#81a1c1',
  '#bf616a',
  '#8fbcbb'
] as const

/** The per-message origin tag shown in a combined monitor view. */
export interface Origin {
  label: string
  color: string
}

/**
 * Build the origin tag (short label + a stable colour) for each member of a monitor view, keyed by
 * channel id. Colour is assigned by member position so it doesn't shift as messages arrive.
 */
export function buildOrigins(members: readonly ChannelInfo[]): Map<string, Origin> {
  const origins = new Map<string, Origin>()
  members.forEach((member, index) => {
    origins.set(member.id, {
      label: shortLabel(member.label),
      color: ORIGIN_COLORS[index % ORIGIN_COLORS.length] ?? '#88c0d0'
    })
  })
  return origins
}

/** Trim a column label to a compact origin-tag width (dropping the `yt:` prefix). */
function shortLabel(label: string): string {
  const trimmed = label.replace(/^yt:/, '')
  return trimmed.length > 18 ? `${trimmed.slice(0, 17)}…` : trimmed
}

/**
 * Merge several columns' message buffers into one time-ordered feed for a combined view, keeping only
 * the most recent `cap` messages. Per-channel inputs are already ordered oldest→newest; the stable
 * sort keeps same-timestamp messages in member then arrival order. With `flaggedOnly`, only messages
 * flagged by the moderation watchlist are kept — the basis for the flagged-messages view.
 */
export function mergeMonitorMessages(
  memberIds: readonly string[],
  messagesByChannel: Readonly<Record<string, ChatMessage[]>>,
  cap: number,
  flaggedOnly = false
): ChatMessage[] {
  const merged: ChatMessage[] = []
  for (const id of memberIds) {
    const list = messagesByChannel[id]
    if (list !== undefined) {
      for (const message of list) {
        if (!flaggedOnly || message.flagged === true) {
          merged.push(message)
        }
      }
    }
  }
  merged.sort((a, b) => a.timestamp - b.timestamp)
  return merged.length > cap ? merged.slice(merged.length - cap) : merged
}
