import { describe, expect, it, vi } from 'vitest'
import { YouTubeSignaler } from '@main/sources/youtube/YouTubeSignaler'

/** A length-prefixed BrowserChannel chunk, matching the captured framing. */
function chunk(entries: unknown[]): string {
  const json = JSON.stringify(entries)
  return `${json.length}\n${json}`
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    }
  })
}

describe('YouTubeSignaler', () => {
  it('negotiates a session and nudges on a signal frame', async () => {
    const onConnect = vi.fn()
    const onSignal = vi.fn()
    let signaler: YouTubeSignaler | undefined

    const fetchMock = vi.fn((input: unknown, _init?: unknown): Promise<Response> => {
      const url = String(input)
      if (url.includes('/punctual/v1/chooseServer')) {
        return Promise.resolve(new Response('["GSID-1",3,null,"1","2"]'))
      }
      if (url.includes('RID=rpc')) {
        // Back channel: one signal on topic "1", then the stream closes.
        return Promise.resolve(new Response(streamOf(chunk([[1, [[[['1', [null, [['tok']]]]]]]]]))))
      }
      // Forward bind → the open control frame carrying the SID.
      return Promise.resolve(new Response(chunk([[0, ['c', 'SID-1', '', 8, 14, 30000]]])))
    })

    signaler = new YouTubeSignaler(fetchMock as unknown as typeof fetch, 'EWrX250Zhko', {
      onConnect,
      onSignal: () => {
        onSignal()
        signaler?.stop() // end the loop after the first signal so the test terminates
      }
    })
    signaler.start()

    await vi.waitFor(() => expect(onSignal).toHaveBeenCalledTimes(1))
    expect(onConnect).toHaveBeenCalledTimes(1)

    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls[0]).toContain('/punctual/v1/chooseServer') // no bootstrap — negotiation is first
    expect(urls.some((u) => u.includes('CVER=22'))).toBe(true) // forward bind
    expect(urls.some((u) => u.includes('RID=rpc') && u.includes('SID=SID-1'))).toBe(true)

    // The signaler is anonymous — no auth/visitor cookie on its requests.
    const chooseServerCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('chooseServer'))
    const init = chooseServerCall?.[1] as { headers: Record<string, string> } | undefined
    expect(init?.headers['Cookie']).toBeUndefined()
  })

  it('does not start the network until start() is called', () => {
    const fetchMock = vi.fn()
    const signaler = new YouTubeSignaler(fetchMock as unknown as typeof fetch, 'vid', {
      onSignal: vi.fn()
    })
    expect(fetchMock).not.toHaveBeenCalled()
    signaler.stop() // safe to stop before start
  })

  it('stop() aborts an in-flight handshake request instead of leaving it hanging', async () => {
    let signal: AbortSignal | undefined
    const fetchMock = vi.fn((_input: unknown, init?: unknown): Promise<Response> => {
      signal = (init as RequestInit | undefined)?.signal ?? undefined
      // A black-holed chooseServer: never settles on its own, only via the abort signal.
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const signaler = new YouTubeSignaler(fetchMock as unknown as typeof fetch, 'vid', {
      onSignal: vi.fn()
    })
    signaler.start()
    expect(fetchMock).toHaveBeenCalledTimes(1) // the chooseServer POST is in flight
    expect(signal).toBeDefined()

    signaler.stop()
    expect(signal?.aborted).toBe(true)

    // The run loop sees the stop and exits without another connection attempt.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('resets the reconnect backoff once a session establishes, so routine drops never compound', async () => {
    vi.useFakeTimers()
    try {
      let chooseServerCalls = 0
      const fetchMock = vi.fn((input: unknown, _init?: unknown): Promise<Response> => {
        const url = String(input)
        if (url.includes('/punctual/v1/chooseServer')) {
          chooseServerCalls += 1
          return Promise.resolve(new Response('["GSID-3",3,null,"1","2"]'))
        }
        if (url.includes('RID=rpc')) {
          // Every back channel drops immediately: each session connects, then fails.
          return Promise.resolve(new Response('', { status: 400 }))
        }
        return Promise.resolve(new Response(chunk([[0, ['c', 'SID-3', '', 8, 14, 30000]]])))
      })

      const signaler = new YouTubeSignaler(fetchMock as unknown as typeof fetch, 'vid', {
        onSignal: vi.fn()
      })
      signaler.start()
      await vi.advanceTimersByTimeAsync(0) // session 1 connects then drops → first-failure backoff
      expect(chooseServerCalls).toBe(1)
      // Each session established a channel before dropping, so the counter resets every time:
      // the reconnect gap stays at the first-failure 4s instead of doubling toward the 30s cap.
      await vi.advanceTimersByTimeAsync(4000)
      expect(chooseServerCalls).toBe(2)
      await vi.advanceTimersByTimeAsync(4000)
      expect(chooseServerCalls).toBe(3)
      await vi.advanceTimersByTimeAsync(4000)
      expect(chooseServerCalls).toBe(4)
      signaler.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-issues the back channel with the advanced AID after a batch and idle gap', async () => {
    vi.useFakeTimers()
    try {
      const onSignal = vi.fn()
      const backChannelUrls: string[] = []
      // A batch with one signal (id 7), then the stream hangs — the server is waiting for the
      // re-issue (AID ack) rather than closing, which is what stalled the real session.
      const hangingAfterFrame = (): ReadableStream<Uint8Array> =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(chunk([[7, [[[['1', [null, [['t']]]]]]]]])))
          }
        })
      const fetchMock = vi.fn((input: unknown, _init?: unknown): Promise<Response> => {
        const url = String(input)
        if (url.includes('/punctual/v1/chooseServer')) {
          return Promise.resolve(new Response('["GSID-2",3,null,"1","2"]'))
        }
        if (url.includes('RID=rpc')) {
          backChannelUrls.push(url)
          // First poll streams a batch then hangs; the re-issue gets a 400 to end the test cleanly.
          return backChannelUrls.length === 1
            ? Promise.resolve(new Response(hangingAfterFrame()))
            : Promise.resolve(new Response('', { status: 400 }))
        }
        return Promise.resolve(new Response(chunk([[0, ['c', 'SID-2', '', 8, 14, 30000]]])))
      })

      const signaler = new YouTubeSignaler(fetchMock as unknown as typeof fetch, 'vid', {
        onSignal: () => onSignal()
      })
      signaler.start()
      await vi.advanceTimersByTimeAsync(0) // negotiate + read the first batch (fires the signal)
      expect(onSignal).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(600) // idle gap → re-issue with the advanced AID

      expect(backChannelUrls).toHaveLength(2)
      expect(backChannelUrls[0]).toContain('AID=0')
      expect(backChannelUrls[1]).toContain('AID=7')
      signaler.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
