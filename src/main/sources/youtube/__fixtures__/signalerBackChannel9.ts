/**
 * Real signaler back-channel bodies, captured from a logged-out browser session. The signaler is anonymous — these frames carry no cookies or auth; the only
 * identifier scrubbed is the server's connection id in the open frame.
 */
import type { SignalFrame } from '@main/sources/youtube/signalerProtocol'

/**
 * The exact back-channel body from capture `9-signaler-response` (2026-06-01), byte-for-byte:
 * a `noop` keepalive followed by a real invalidation signal for `chat~EWrX250Zhko`. The signal's
 * first timestamp (`1780318288318227`) is the publish time the browser echoes back to
 * `get_live_chat` as `invalidationPayloadLastPublishAtUsec`.
 */
export const signalerBackChannel9 =
  '16\n[[241,["noop"]]]256\n[[242,[[[["1",[null,[[[null,"EJOeprmK5pQD","1780318288318227","1780318288700575",["1780318288639758","1780318288623605","1780318288640033","1780318288651718","1780318288700575","1780318288737566","1780318288738480",null,"1780318288738818"],[],0,0]]]]]]]]]]'

/**
 * The connection-open frame from capture `5-response` (same session) — the first frame after
 * the handshake. The server connection id is replaced with a placeholder; its value is never read.
 */
export const signalerOpenFrame5: SignalFrame = { id: 1, payload: [[null, null, ['conn-id']]] }

/**
 * The subscription-ack frame from capture `5-response`, verbatim: topic index `"1"` confirmed
 * with a timestamp array. An ack is not an invalidation and must not trigger a fetch.
 */
export const signalerAckFrame5: SignalFrame = {
  id: 2,
  payload: [[[['1', [['1780277028441850']]]]]]
}
