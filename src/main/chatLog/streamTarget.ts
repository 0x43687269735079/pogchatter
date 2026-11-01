import type { CurrentStream } from '@main/sources/ChatSource'
import type { StreamTarget } from '@main/chatLog/logLines'
import type { Platform } from '@shared/model'

/** What is known about a column when one of its events is logged. */
export interface ColumnState {
  channelId: string
  platform: Platform
  /** The YouTube creator channel id, once resolved. */
  creatorId?: string
  /** The broadcast the column is reading, when its platform identifies one. */
  stream?: CurrentStream
}

/**
 * Which file an event belongs to.
 *
 * A YouTube stream is filed under its creator's channel id (the stable identity — a handle can
 * change) and named by video id, so a handle column and a video column reading one stream share a
 * file. A Twitch stream is filed under the login and named by Helix's start time and stream id.
 * When the platform hasn't identified a broadcast (Twitch offline or logged out, a YouTube column
 * still resolving), events go to a per-day file for the column so nothing is dropped.
 *
 * Args:
 *   column: The column's state at the time of the event.
 *   at: The event time (epoch ms), which dates the fallback file.
 */
export function streamTargetFor(column: ColumnState, at: number): StreamTarget {
  const bare = column.channelId.replace(/^[a-z]+:/u, '')
  const owner =
    column.platform === 'youtube' && column.creatorId !== undefined ? column.creatorId : bare
  // An event from before the broadcast started (recent-messages history fetched on connect) is
  // not part of it, even though the column now reads it.
  const started = column.stream?.startedAt
  const stream = started !== undefined && at < started ? undefined : column.stream
  const target: StreamTarget = {
    platform: column.platform,
    channelId: column.channelId,
    owner,
    streamKey: stream?.key ?? `${new Date(at).toISOString().slice(0, 10)}_no-stream`
  }
  if (column.creatorId !== undefined) {
    target.creatorId = column.creatorId
  }
  if (stream?.title !== undefined) {
    target.title = stream.title
  }
  if (stream?.startedAt !== undefined) {
    target.startedAt = stream.startedAt
  }
  return target
}
