import { describe, expect, it } from 'vitest'
import {
  bindBody,
  chooseServerBody,
  classifyFrame,
  parseFrames,
  parseGsessionId,
  parseSid,
  topicFor
} from '@main/sources/youtube/signalerProtocol'

/** Build a length-prefixed BrowserChannel chunk from its entries (matches the captured framing). */
function chunk(entries: unknown[]): string {
  const json = JSON.stringify(entries)
  return `${json.length}\n${json}`
}

describe('signaler request encoding', () => {
  it('builds the topic from a video id', () => {
    expect(topicFor('EWrX250Zhko')).toBe('chat~EWrX250Zhko')
  })

  it('encodes the chooseServer body (current API shape)', () => {
    expect(chooseServerBody('chat~EWrX250Zhko')).toBe(
      '[[null,null,null,[9,5],null,[["youtube_live_chat_web"],[1],[[["chat~EWrX250Zhko"]]]]],null,null,0]'
    )
  })

  it('encodes the bind body with the string request id and TYPE_BOOL-safe nesting', () => {
    const data =
      '[[["1",[null,null,null,[9,5],null,[["youtube_live_chat_web"],[1],[[["chat~EWrX250Zhko"]]]],null,null,1],null,3]]]'
    expect(bindBody('chat~EWrX250Zhko')).toBe(
      `count=1&ofs=0&req0___data__=${encodeURIComponent(data)}`
    )
  })
})

describe('signaler response decoding', () => {
  it('reads the gsessionid from chooseServer', () => {
    expect(parseGsessionId('["abc123",3,null,"1","2"]')).toBe('abc123')
    expect(parseGsessionId('not json')).toBeUndefined()
  })

  it('reads the SID from the open control frame', () => {
    expect(parseSid(chunk([[0, ['c', 'SID-XYZ', '', 8, 14, 30000]]]))).toBe('SID-XYZ')
    expect(parseSid(chunk([[0, ['noop']]]))).toBeUndefined()
  })
})

describe('parseFrames', () => {
  it('parses multiple length-prefixed frames and flattens their entries', () => {
    const buffer =
      chunk([
        [1, [[null, null, ['srv']]]],
        [2, [[[['1', [['ts']]]]]]]
      ]) + chunk([[5, ['noop']]])
    const { frames, rest } = parseFrames(buffer)
    expect(frames.map((f) => f.id)).toEqual([1, 2, 5])
    expect(rest).toBe('')
  })

  it('leaves an incomplete trailing chunk in rest', () => {
    const whole = chunk([[3, ['noop']]])
    const partial = whole.slice(0, whole.length - 2)
    const { frames, rest } = parseFrames(partial)
    expect(frames).toEqual([])
    expect(rest).toBe(partial)
  })

  it('resumes once the remainder of a split chunk arrives', () => {
    const whole = chunk([[4, ['noop']]])
    const first = parseFrames(whole.slice(0, 3))
    expect(first.frames).toEqual([])
    const second = parseFrames(first.rest + whole.slice(3))
    expect(second.frames.map((f) => f.id)).toEqual([4])
  })
})

describe('classifyFrame', () => {
  it('classifies a noop keepalive', () => {
    expect(classifyFrame({ id: 5, payload: ['noop'] })).toEqual({ kind: 'noop' })
  })

  it('classifies the connection-open frame', () => {
    expect(classifyFrame({ id: 1, payload: [[null, null, ['OGeP4KFA']]] })).toEqual({
      kind: 'open'
    })
  })

  it('classifies the subscription ack (topic value is a timestamp array)', () => {
    const ack = { id: 2, payload: [[[['1', [['1780277028441850']]]]]] }
    expect(classifyFrame(ack)).toEqual({ kind: 'ack' })
  })

  it('classifies a real signal and extracts the publish timestamp (captured frame 242)', () => {
    const signal = {
      id: 242,
      payload: [
        [
          [
            [
              '1',
              [
                null,
                [[[null, 'EJOeprmK5pQD', '1780318288318227', '1780318288700575', [], [], 0, 0]]]
              ]
            ]
          ]
        ]
      ]
    }
    expect(classifyFrame(signal)).toEqual({ kind: 'signal', publishUsec: '1780318288318227' })
  })
})
