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

// Minimal protobuf reader (wire types 0 and 2 only) — decodes the encoder's output with independent
// logic, so the structure test verifies the layout rather than echoing the encoder. A length-delimited
// chunk is read as a nested message unless it is entirely printable (then a string).
function readProto(buf: Buffer): Record<number, unknown> {
  const out: Record<number, unknown> = {}
  let i = 0
  const varint = (): number => {
    let value = 0
    let shift = 0
    let byte: number
    do {
      byte = buf[i++] ?? 0
      value |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)
    return value
  }
  while (i < buf.length) {
    const tag = varint()
    const field = tag >>> 3
    if ((tag & 7) === 0) {
      out[field] = varint()
    } else {
      const length = varint()
      const chunk = buf.subarray(i, i + length)
      i += length
      const text = chunk.toString('utf8')
      out[field] = /^[\x20-\x7e]+$/.test(text) ? text : readProto(chunk)
    }
  }
  return out
}

describe('encodeChannelActivityParams', () => {
  // The byte-exact match against the real captured get_panel request was verified during development;
  // here the structure is asserted against placeholder ids (no real channel/video ids in the tree).
  it('encodes the PAlc_channel_activity params proto with the broadcaster, video, and target ids', () => {
    const token = encodeChannelActivityParams(
      'UCbroadcasterAAAAAAAAAAAA',
      'VIDEOID1234',
      'UCtargetBBBBBBBBBBBBBBBB'
    )
    const bytes = Buffer.from(decodeURIComponent(token), 'base64')
    // Field 132's two-byte tag must not truncate (the regression the varint-tag fix guards).
    expect([bytes[0], bytes[1]]).toEqual([0xa2, 0x08])
    // Decoded independently: 132 → 1 → 5 → { channel, video }, 132 → 2 → { target }, 132 → 5 = 1.
    expect(readProto(bytes)).toEqual({
      132: {
        1: { 5: { 1: 'UCbroadcasterAAAAAAAAAAAA', 2: 'VIDEOID1234' } },
        2: { 1: 'UCtargetBBBBBBBBBBBBBBBB' },
        5: 1
      }
    })
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
