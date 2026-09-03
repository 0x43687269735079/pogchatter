import type { ChannelInfo } from '@shared/model'

/** The tab/header context menu's single "add this streamer's other streams" item. */
export type StreamsTarget =
  | { label: string; target: string }
  | { label: string; target: undefined; reason: string }

const OTHER_STREAMS_LABEL = "Add this creator's other streams"

/**
 * What the tab/header context menu's "add this streamer's other streams" item resolves to for a
 * given column's channel.
 *
 * A Twitch chat always resolves — the login in its id is enough to fetch that channel's YouTube
 * rooms. A YouTube chat resolves once a stable creator identity is known: either the id already
 * names a handle, or main has since filled in `creatorId` for a column opened by video/channel id.
 * Until then there's nothing to add streams *for*, so the item is offered disabled with a reason.
 */
export function streamsTargetFor(channel: ChannelInfo): StreamsTarget {
  if (channel.platform === 'twitch') {
    const login = channel.id.slice('twitch:'.length)
    return { label: `Add @${login}'s YouTube streams`, target: login }
  }
  if (channel.id.startsWith('youtube:@')) {
    return { label: OTHER_STREAMS_LABEL, target: channel.id.slice('youtube:'.length) }
  }
  if (channel.creatorId !== undefined) {
    return { label: OTHER_STREAMS_LABEL, target: channel.creatorId }
  }
  return { label: OTHER_STREAMS_LABEL, target: undefined, reason: 'resolving…' }
}
