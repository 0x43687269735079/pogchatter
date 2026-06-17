import type { ChannelInfo, SourceStatus } from '@shared/model'

/** A source is "online" (LED lit) once its chat is reachable. */
export function isOnline(status: SourceStatus): boolean {
  return (
    status.state === 'connected' ||
    status.state === 'live' ||
    status.state === 'waiting' ||
    status.state === 'replay'
  )
}

/** Coarse status shown as a tab's dot: a waiting room, an online chat, an error, or offline. */
export type TabStatus = 'on' | 'off' | 'err' | 'wait' | 'none'

/** The dot a channel tab shows for its lifecycle state. */
export function channelTabStatus(status: SourceStatus): TabStatus {
  if (status.state === 'error') {
    return 'err'
  }
  if (status.state === 'waiting') {
    return 'wait'
  }
  return isOnline(status) ? 'on' : 'off'
}

/** A monitor tab is "on" if any of its member chats is online. */
export function monitorTabStatus(memberIds: readonly string[], channels: ChannelInfo[]): TabStatus {
  const online = memberIds.some((id) => {
    const channel = channels.find((c) => c.id === id)
    return channel !== undefined && isOnline(channel.status)
  })
  return online ? 'on' : 'off'
}
