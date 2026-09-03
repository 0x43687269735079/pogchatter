import { proxiedFetch } from '@main/net/proxy'

/**
 * Emote sets run large — a 600-emote 7TV channel set is ordinary — and the providers' CDNs are
 * slow under load, so the budget is generous: a scope that times out shows no emotes at all
 * until its retry lands.
 */
export const TIMEOUT_MS = 15_000
// Descriptive UA: emote providers prefer clients to identify themselves.
// (Browser-spoofing is reserved for YouTube InnerTube only.)
const USER_AGENT = 'pogchatter/0.1'

/**
 * Fetch JSON with a timeout. Returns `null` only for a 404 — the resource genuinely
 * doesn't exist (e.g. a channel with no account on that provider), which callers treat
 * as an empty contribution. Every other failure (timeout, network error, non-2xx,
 * bad JSON) throws, so the emote engine can tell "provider down" from "no emotes"
 * and retry the former instead of caching it.
 */
export async function getJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, TIMEOUT_MS)
  try {
    const response = await proxiedFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal
    })
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw new Error(`GET ${url} failed: ${response.status}`)
    }
    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}
