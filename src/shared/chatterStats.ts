/** One chatter across every tracked stream of a creator. */
export interface ChatterSummary {
  /** YouTube channel id (`UC…`) — the identity. */
  id: string
  /** The name they used most recently. */
  name: string
  /** Streams they chatted in at least once. */
  streams: number
  messages: number
  /** Their first and latest counted message (epoch ms). */
  firstSeen: number
  lastSeen: number
}

/** A creator's chatter statistics, over the streams tracked while the setting was on. */
export interface ChatterStatsSummary {
  creatorId: string
  /** Streams with at least one counted message. */
  streams: number
  /** Earliest counted message in any stream (epoch ms); undefined when nothing is tracked yet. */
  trackedSince?: number
  /** Every chatter, most streams first, then most messages. */
  chatters: ChatterSummary[]
}

export type ChatterStatsResult =
  | { ok: true; summary: ChatterStatsSummary }
  | { ok: false; error: string }
