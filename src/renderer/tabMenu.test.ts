import { describe, expect, it } from 'vitest'
import type { ChannelInfo } from '@shared/model'
import { streamsTargetFor } from '@renderer/tabMenu'

function channel(overrides: Partial<ChannelInfo>): ChannelInfo {
  return {
    id: 'twitch:some_login',
    platform: 'twitch',
    label: 'some_login',
    status: { state: 'connected' },
    streamerKey: 'some_login',
    ...overrides
  }
}

describe('streamsTargetFor', () => {
  it('resolves a Twitch column to its login', () => {
    const result = streamsTargetFor(channel({ id: 'twitch:some_login', platform: 'twitch' }))
    expect(result).toEqual({ label: "Add @some_login's YouTube streams", target: 'some_login' })
  })

  it('resolves a YouTube handle column to its handle', () => {
    const result = streamsTargetFor(
      channel({ id: 'youtube:@somehandle', platform: 'youtube', label: 'somehandle' })
    )
    expect(result).toEqual({
      label: "Add this creator's other streams",
      target: '@somehandle'
    })
  })

  it('resolves a YouTube video-id column with a resolved creatorId', () => {
    const result = streamsTargetFor(
      channel({
        id: 'youtube:aaaaaaaaaaa',
        platform: 'youtube',
        label: 'a video',
        creatorId: 'UCmadeup'
      })
    )
    expect(result).toEqual({
      label: "Add this creator's other streams",
      target: 'UCmadeup'
    })
  })

  it('offers a disabled reason for a YouTube video-id column with no creatorId yet', () => {
    const result = streamsTargetFor(
      channel({ id: 'youtube:aaaaaaaaaaa', platform: 'youtube', label: 'a video' })
    )
    expect(result).toEqual({
      label: "Add this creator's other streams",
      target: undefined,
      reason: 'resolving…'
    })
  })
})
