import type { Platform } from '@shared/model'

/**
 * The one streamer identity the app groups by, across platforms.
 *
 * A streamer is one person however many chats they run: the same donations, the same viewers, the
 * same name on the door. Platforms disagree about what identifies them — Twitch names a login,
 * YouTube names a video or a channel id and only sometimes a handle — so everything that has to
 * treat two chats as one streamer (donation dedup, per-streamer totals) goes through this key.
 *
 * The key is deliberately lossy: casing, spaces and punctuation vary between a Twitch login and a
 * YouTube display name for the same person, so they are stripped rather than trusted.
 */

/**
 * Reduce a name to the characters both platforms agree on: lower-case, `[a-z0-9]` only. Underscores
 * go too: a Twitch login `some_streamer` and the YouTube name "Some Streamer" are one person.
 */
function normalise(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, '')
}

/**
 * Bring a stored key up to the current normalisation. Keys were once allowed to keep underscores;
 * an opaque legacy id (`youtube:<video>`) is not a key at all and is returned untouched.
 */
export function normaliseStreamerKey(key: string): string {
  return /^[a-z0-9_]+$/u.test(key) ? key.replaceAll('_', '') : key
}

/**
 * The streamer key for a chat, from the best identity its platform gave us.
 *
 * Args:
 *   platform: Which platform the chat belongs to.
 *   target: What the user asked to watch — a Twitch login, or a YouTube `@handle`, video id, or
 *     channel id.
 *   creatorName: The YouTube creator's channel name, once the connector has resolved it. Ignored on
 *     Twitch, where the login is already the identity.
 *   creatorId: The YouTube creator's channel id, once resolved.
 *   handle: The creator's `@handle`, once resolved from the video (with or without the `@`).
 *
 * Returns:
 *   The normalised key. On Twitch, the login; on YouTube, the handle — the target's when the target
 *   is a handle, else the resolved one — then the creator name when known, else the target itself:
 *   a video id is a poor identity, but a stable one.
 */
export function streamerKeyOf(
  platform: Platform,
  target: string,
  creatorName?: string,
  creatorId?: string,
  handle?: string
): string {
  if (platform === 'twitch') {
    return normalise(target)
  }
  // A handle is the username itself — the same thing a Twitch login is — so it outranks the
  // creator's display name, which can be anything ("Tidal Fern ch. Reef Collective" for @Tidal_Fern).
  if (target.startsWith('@') && normalise(target.slice(1)) !== '') {
    return normalise(target.slice(1))
  }
  if (handle !== undefined && normalise(handle) !== '') {
    return normalise(handle)
  }
  if (creatorName !== undefined && normalise(creatorName) !== '') {
    return normalise(creatorName)
  }
  // A name outside [a-z0-9_] (most non-Latin channels) normalises to nothing; the creator's channel
  // id still identifies them across every room, where the per-video target would split them.
  if (creatorId !== undefined && normalise(creatorId) !== '') {
    return normalise(creatorId)
  }
  return normalise(target.startsWith('@') ? target.slice(1) : target)
}

/**
 * The key for a donation recorded before donations carried one, derived from its channel id.
 *
 * Args:
 *   channelId: The source id the donation was stored against (`twitch:<login>`, `youtube:<target>`).
 *
 * Returns:
 *   The normalised streamer key when the id names one, else the channel id verbatim. A `youtube:`
 *   id holding a video or channel id yields no identity, so it is kept opaque rather than mangled
 *   into a key that would collide with a real one.
 */
export function legacyStreamerKey(channelId: string): string {
  if (channelId.startsWith('twitch:')) {
    return normalise(channelId.slice('twitch:'.length))
  }
  if (channelId.startsWith('youtube:@')) {
    return normalise(channelId.slice('youtube:@'.length))
  }
  return channelId
}
