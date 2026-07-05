import { describe, expect, it } from 'vitest'
import {
  buildTextSegments,
  classifySendResponse,
  encodeChannelActivityParams,
  encodeSendParams
} from '@main/sources/youtube/liveChatSend'

const emojiMap = new Map([
  [':face-blue-smiling:', 'UCx/aaa'],
  [':yt:', 'UCy/bbb']
])

describe('buildTextSegments', () => {
  it('returns a single text segment when there are no emojis to convert', () => {
    expect(buildTextSegments('hello world', new Map())).toEqual([{ text: 'hello world' }])
  })

  it('leaves an unknown shortcut as text', () => {
    expect(buildTextSegments('hi :unknown: there', emojiMap)).toEqual([
      { text: 'hi :unknown: there' }
    ])
  })

  it('replaces a known shortcut with an emoji segment and splits the surrounding text', () => {
    expect(buildTextSegments('hi :face-blue-smiling: there', emojiMap)).toEqual([
      { text: 'hi ' },
      { emojiId: 'UCx/aaa' },
      { text: ' there' }
    ])
  })

  it('handles a leading emoji and back-to-back emojis', () => {
    expect(buildTextSegments(':face-blue-smiling::yt:!', emojiMap)).toEqual([
      { emojiId: 'UCx/aaa' },
      { emojiId: 'UCy/bbb' },
      { text: '!' }
    ])
  })
})

describe('encodeSendParams', () => {
  // Reverse the btoa(encodeURIComponent(base64(bytes))) wrapping back to the raw protobuf bytes.
  function decode(params: string): Buffer {
    const unBtoa = Buffer.from(params, 'base64').toString('latin1')
    return Buffer.from(decodeURIComponent(unBtoa), 'base64')
  }

  it('is deterministic', () => {
    const a = encodeSendParams('VIDID123456', 'UCchannel0000000000000000')
    const b = encodeSendParams('VIDID123456', 'UCchannel0000000000000000')
    expect(a).toBe(b)
  })

  it('encodes the channel and video ids into the proto', () => {
    const bytes = decode(encodeSendParams('VIDID123456', 'UCchannel0000000000000000'))
    expect(bytes.toString('latin1')).toContain('UCchannel0000000000000000')
    expect(bytes.toString('latin1')).toContain('VIDID123456')
    // Outer field 1 (params) is length-delimited, so the first tag byte is (1<<3)|2 = 0x0a.
    expect(bytes[0]).toBe(0x0a)
  })
})

describe('encodeChannelActivityParams', () => {
  it('reproduces the captured get_panel channel-activity token byte-for-byte', () => {
    // Ground truth: the params from capture-other-moderation-actions/4-mod-get-channel-history-req
    // (broadcaster UCs0AmDz3c3UWENSP6XuOajg, video r6kuUsc0QTQ, target UCcWGuT8u6jqBznNeoJfaS-g).
    const token = encodeChannelActivityParams(
      'UCs0AmDz3c3UWENSP6XuOajg',
      'r6kuUsc0QTQ',
      'UCcWGuT8u6jqBznNeoJfaS-g'
    )
    expect(token).toBe(
      'oghJCikqJwoYVUNzMEFtRHozYzNVV0VOU1A2WHVPYWpnEgtyNmt1VXNjMFFUURIaChhVQ2NXR3VUOHU2anFCem5OZW9KZmFTLWcoAQ%3D%3D'
    )
  })

  it('varint-tags field 132 (0xA2 0x08) instead of truncating it', () => {
    const bytes = Buffer.from(
      decodeURIComponent(encodeChannelActivityParams('UCb', 'v', 'UCt')),
      'base64'
    )
    expect([bytes[0], bytes[1]]).toEqual([0xa2, 0x08])
  })
})

describe('classifySendResponse', () => {
  it('reports a delivered message (the captured echo: add action + attestation siblings) as posted', () => {
    // Mirrors capture donation-replies/3-reply-to-donation-response.
    const data = {
      responseContext: { serviceTrackingParams: [] },
      actions: [
        { addChatItemAction: { item: {}, clientId: 'c' }, clickTrackingParams: 't' },
        { hideEngagementPanelEndpoint: {}, clickTrackingParams: 't' },
        { runAttestationCommand: {}, clickTrackingParams: 't' }
      ]
    }
    expect(classifySendResponse(data)).toEqual({ kind: 'posted' })
  })

  it('reports a dimChatItemAction echo as held', () => {
    const data = { actions: [{ dimChatItemAction: { itemId: 'x' } }] }
    expect(classifySendResponse(data)).toEqual({ kind: 'held' })
  })

  it('reports an explicit error payload as rejected, keeping its message', () => {
    const data = {
      error: { code: 403, message: 'Slow mode is enabled', status: 'PERMISSION_DENIED' }
    }
    expect(classifySendResponse(data)).toEqual({
      kind: 'rejected',
      message: 'Slow mode is enabled'
    })
  })

  it('reports an error payload without a usable message as rejected without one', () => {
    expect(classifySendResponse({ error: {} })).toEqual({ kind: 'rejected' })
    expect(classifySendResponse({ error: { message: '' } })).toEqual({ kind: 'rejected' })
  })

  it('treats unrecognized response shapes as posted, so drift never reports a sent message as failed', () => {
    expect(classifySendResponse({ actions: [{ someNewExperimentCommand: {} }] })).toEqual({
      kind: 'posted'
    })
    expect(classifySendResponse({})).toEqual({ kind: 'posted' })
    expect(classifySendResponse(undefined)).toEqual({ kind: 'posted' })
  })

  it('ignores responseContext when looking for outcome keys', () => {
    const data = { responseContext: { error: { message: 'tracking noise' } }, actions: [] }
    expect(classifySendResponse(data)).toEqual({ kind: 'posted' })
  })
})
