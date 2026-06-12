import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@main/net/proxy', () => ({ proxiedFetch: vi.fn() }))

import { proxiedFetch } from '@main/net/proxy'
import { getJson } from '@main/emotes/httpJson'

const mockFetch = vi.mocked(proxiedFetch)

function response(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
  } as Response
}

afterEach(() => {
  mockFetch.mockReset()
})

describe('getJson', () => {
  it('returns the parsed body on success', async () => {
    mockFetch.mockResolvedValue(response(200, { id: 'set-1' }))

    await expect(getJson<{ id: string }>('https://api.example/set')).resolves.toEqual({
      id: 'set-1'
    })
  })

  it('returns null for a 404 — the resource genuinely does not exist', async () => {
    mockFetch.mockResolvedValue(response(404))

    await expect(getJson('https://api.example/missing')).resolves.toBeNull()
  })

  it('throws on a non-404 error status so callers can retry instead of caching empty', async () => {
    mockFetch.mockResolvedValue(response(503))

    await expect(getJson('https://api.example/down')).rejects.toThrow('503')
  })

  it('propagates network errors and timeouts', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed'))

    await expect(getJson('https://api.example/offline')).rejects.toThrow('fetch failed')
  })

  it('aborts a hung request after the timeout and propagates the failure', async () => {
    vi.useFakeTimers()
    try {
      mockFetch.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'))
            })
          })
      )
      const pending = getJson('https://api.example/hung')
      const failure = expect(pending).rejects.toThrow('aborted')
      await vi.advanceTimersByTimeAsync(6000)
      await failure
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates a malformed JSON body as a failure', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('Unexpected token'))
    } as unknown as Response)

    await expect(getJson('https://api.example/bad-json')).rejects.toThrow('Unexpected token')
  })
})
