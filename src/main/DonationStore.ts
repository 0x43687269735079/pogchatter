import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, ClearTarget, Platform } from '@shared/model'
import {
  type Donation,
  type DonationKind,
  type DonationValue,
  DONATION_RETENTION
} from '@shared/donations'
import { donationFrom } from '@shared/donationFrom'

/** How long to batch writes, so a gift-sub storm doesn't rewrite the file once per event. */
const WRITE_DEBOUNCE_MS = 1000

export interface DonationStoreDeps {
  /** Directory to keep `donations.json` in (Electron's userData in production). */
  dir: string
  /** Injected so tests exercise the real ring and sanitising without touching a disk. */
  writeFile?: (path: string, contents: string) => void
}

/**
 * The durable record of every paid event, owned by the main process.
 *
 * It exists because the renderer's chat buffers trim and reset: the flagged view is a filter over
 * those buffers, so anything scrolled past or any restart empties it. A donation has to outlive both,
 * because the streamer reviews it after the stream, so the list lives here and is pushed to whatever
 * renderer is attached.
 *
 * Bounded to {@link DONATION_RETENTION}, written atomically (tmp + rename) like `ConfigStore`, and
 * tolerant of a corrupt file — losing donations is bad, but refusing to start is worse.
 */
export class DonationStore {
  readonly #path: string
  readonly #writeFile: (path: string, contents: string) => void
  /** Oldest first, so ageing out is a shift and appending is a push. */
  #donations: Donation[] = []
  readonly #ids = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | undefined
  /** Unsaved changes are pending; cleared only by a write that actually succeeded. */
  #dirty = false

  constructor(deps: DonationStoreDeps) {
    this.#path = join(deps.dir, 'donations.json')
    this.#writeFile = deps.writeFile ?? ((path, contents) => writeFileSync(path, contents))
    this.#load()
  }

  /** Newest first — the order the panel renders. */
  list(): Donation[] {
    return [...this.#donations].reverse()
  }

  /**
   * Collect `message` if it is a paid event. Returns the stored donation, or `undefined` when the
   * message doesn't qualify or its id was already recorded — so a platform re-send or a reconnect
   * replay never produces a second entry.
   */
  record(message: ChatMessage, channelId: string): Donation | undefined {
    if (this.#ids.has(message.id)) {
      return undefined
    }
    const donation = donationFrom(message, channelId)
    if (donation === undefined) {
      return undefined
    }
    // Kept in timestamp order rather than arrival order, so a donation that reaches us late but
    // happened earlier sits where it belongs — otherwise the panel opens mis-ordered (it hydrates
    // straight from here) and retention could evict a *newer* donation than the one it kept.
    // Usually the newest, so scan from the end.
    let at = this.#donations.length
    while (at > 0 && (this.#donations[at - 1]?.timestamp ?? 0) > donation.timestamp) {
      at -= 1
    }
    this.#donations.splice(at, 0, donation)
    this.#ids.add(donation.id)
    if (this.#donations.length > DONATION_RETENTION) {
      // Whole records only, oldest first: read state ages out with the donation it belongs to.
      for (const dropped of this.#donations.splice(
        0,
        this.#donations.length - DONATION_RETENTION
      )) {
        this.#ids.delete(dropped.id)
      }
    }
    // Arrivals persist promptly: this store exists to outlive the session, and a crash inside the
    // debounce window would lose the paid event outright. Read-state changes stay debounced, since
    // those are frequent and cheap to lose.
    this.#dirty = true
    this.#persist()
    return donation
  }

  /** Set read state on the named donations; returns the ids that actually changed. */
  markRead(ids: readonly string[], read: boolean): string[] {
    const wanted = new Set(ids)
    const changed: string[] = []
    for (const donation of this.#donations) {
      if (wanted.has(donation.id) && donation.read !== read) {
        donation.read = read
        changed.push(donation.id)
      }
    }
    if (changed.length > 0) {
      this.#dirty = true
      this.#schedulePersist()
    }
    return changed
  }

  /**
   * Flag donations affected by a moderator clear: a single removed message, or every donation from a
   * user whose messages were cleared (a Twitch timeout/ban emits a by-user clear, not a per-message one).
   * Returns the ids that changed. A whole-chat clear (no message id and no user id) is intentionally not
   * matched — it clears the live view, not the individual paid events, which still happened.
   */
  markRemovedByTarget(channelId: string, target: ClearTarget): string[] {
    const changed: string[] = []
    for (const donation of this.#donations) {
      if (donation.removed === true) {
        continue
      }
      const byMessage = target.messageId !== undefined && donation.id === target.messageId
      const byAuthor =
        target.userId !== undefined &&
        donation.channelId === channelId &&
        donation.author.id === target.userId
      if (byMessage || byAuthor) {
        donation.removed = true
        changed.push(donation.id)
      }
    }
    if (changed.length > 0) {
      this.#dirty = true
      this.#schedulePersist()
    }
    return changed
  }

  /** Mark everything read; returns the ids that actually changed. */
  markAllRead(): string[] {
    return this.markRead(
      this.#donations.filter((donation) => !donation.read).map((donation) => donation.id),
      true
    )
  }

  /** Write any unsaved change immediately (shutdown). */
  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    // Keyed on unsaved-ness rather than on a pending timer: a write that threw (full disk, a
    // transient EPERM) has already cleared its timer, so a timer check would skip the retry that
    // shutdown is the last chance to make.
    if (this.#dirty) {
      this.#persist()
    }
  }

  #schedulePersist(): void {
    if (this.#timer !== undefined) {
      return
    }
    const timer = setTimeout(() => {
      this.#timer = undefined
      this.#persist()
    }, WRITE_DEBOUNCE_MS)
    timer.unref()
    this.#timer = timer
  }

  #persist(): void {
    try {
      const body = JSON.stringify({ donations: this.#donations })
      this.#writeFile(`${this.#path}.tmp`, body)
      renameSync(`${this.#path}.tmp`, this.#path)
      this.#dirty = false
    } catch (error) {
      // Best-effort, like the chat log: a donation lost to a full disk must not take the app down.
      console.error('Donation store write failed:', error)
    }
  }

  #load(): void {
    try {
      if (!existsSync(this.#path)) {
        return
      }
      const parsed: unknown = JSON.parse(readFileSync(this.#path, 'utf8'))
      const raw = (parsed as { donations?: unknown }).donations
      if (!Array.isArray(raw)) {
        return
      }
      const loaded: Donation[] = []
      for (const value of raw) {
        const donation = sanitizeDonation(value)
        if (donation !== undefined && !this.#ids.has(donation.id)) {
          this.#ids.add(donation.id)
          loaded.push(donation)
        }
      }
      // `record` maintains #donations in ascending timestamp order and evicts the oldest at capacity.
      // A file need not be sorted — an older arrival-ordered file, or a valid hand-edited one, can be in
      // any order — so restore the invariant here: sort ascending, then keep the newest, rather than
      // trusting file order (which would mis-place later inserts and could evict a newer record).
      loaded.sort((a, b) => a.timestamp - b.timestamp)
      if (loaded.length > DONATION_RETENTION) {
        for (const dropped of loaded.splice(0, loaded.length - DONATION_RETENTION)) {
          this.#ids.delete(dropped.id)
        }
      }
      this.#donations = loaded
    } catch {
      // A truncated or hand-edited file starts empty rather than preventing startup.
      this.#donations = []
      this.#ids.clear()
    }
  }
}

const KINDS: ReadonlySet<string> = new Set([
  'superchat',
  'tip',
  'supersticker',
  'membership',
  'membership_gift',
  'bits',
  'subscription'
])

/**
 * Which kinds each platform can actually produce — a superchat is never a Twitch event, bits never a
 * YouTube one. Checked on load so a hand-edited (or otherwise malformed) file can't smuggle in a
 * platform/kind pairing the panel's per-platform labels don't model. Tips ride in Twitch chat only
 * (see parseTipAnnouncement); gifted subs/memberships normalise to the same kind on both.
 */
const KINDS_FOR_PLATFORM: Record<Platform, ReadonlySet<string>> = {
  youtube: new Set(['superchat', 'supersticker', 'membership', 'membership_gift']),
  twitch: new Set(['bits', 'subscription', 'membership_gift', 'tip'])
}

/** One donation from untrusted JSON, or undefined when it isn't a well-formed record. */
function sanitizeDonation(value: unknown): Donation | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = value as Record<string, unknown>
  const id = input['id']
  const channelId = input['channelId']
  const platform = input['platform']
  const kind = input['kind']
  const timestamp = input['timestamp']
  const author = input['author'] as Record<string, unknown> | undefined
  if (
    typeof id !== 'string' ||
    id === '' ||
    typeof channelId !== 'string' ||
    (platform !== 'twitch' && platform !== 'youtube') ||
    typeof kind !== 'string' ||
    !KINDS.has(kind) ||
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp) ||
    typeof author !== 'object' ||
    author === null
  ) {
    return undefined
  }
  // A well-typed record can still be an impossible one (youtube + bits, twitch + superchat); reject it
  // so it can't create a feed row or total the per-platform labels don't model.
  if (!KINDS_FOR_PLATFORM[platform].has(kind)) {
    return undefined
  }
  const donationValue = sanitizeValue(kind as DonationKind, input['value'])
  if (donationValue === undefined) {
    return undefined
  }
  const donation: Donation = {
    id,
    channelId,
    platform: platform as Platform,
    kind: kind as DonationKind,
    author: {
      id: typeof author['id'] === 'string' ? author['id'] : '',
      displayName: typeof author['displayName'] === 'string' ? author['displayName'] : ''
    },
    timestamp,
    value: donationValue,
    text: typeof input['text'] === 'string' ? input['text'] : '',
    read: input['read'] === true,
    streamerKey: typeof input['streamerKey'] === 'string' ? input['streamerKey'] : channelId
  }
  if (input['removed'] === true) {
    donation.removed = true
  }
  if (typeof input['headerText'] === 'string') {
    donation.headerText = input['headerText']
  }
  return donation
}

/** Which units each kind may legitimately carry — a superchat cannot be a bits count. */
const UNITS_FOR_KIND: Record<DonationKind, ReadonlySet<string>> = {
  superchat: new Set(['money', 'money-unparsed']),
  supersticker: new Set(['money', 'money-unparsed']),
  bits: new Set(['bits']),
  membership: new Set(['count']),
  membership_gift: new Set(['count']),
  subscription: new Set(['count']),
  tip: new Set(['money', 'money-unparsed'])
}

/**
 * One donation value from untrusted JSON, checked against its kind and for coherent numbers.
 *
 * The file is user-writable and survives restarts, so type-checking each field alone is not enough:
 * a hand-edited record could pair a superchat with a bits count, or carry a negative amount, and the
 * totals would do arithmetic on it without complaint.
 */
function sanitizeValue(kind: DonationKind, value: unknown): DonationValue | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = value as Record<string, unknown>
  const unit = input['unit']
  if (typeof unit !== 'string' || !UNITS_FOR_KIND[kind].has(unit)) {
    return undefined
  }
  if (unit === 'count') {
    const count = input['count']
    return {
      unit: 'count',
      count: typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 1
    }
  }
  if (unit === 'bits') {
    const bits = input['bits']
    return typeof bits === 'number' && Number.isInteger(bits) && bits > 0
      ? { unit: 'bits', bits }
      : undefined
  }
  if (unit === 'money-unparsed' && typeof input['original'] === 'string') {
    return { unit: 'money-unparsed', original: input['original'] }
  }
  if (
    unit === 'money' &&
    typeof input['amount'] === 'number' &&
    Number.isFinite(input['amount']) &&
    input['amount'] > 0 &&
    typeof input['currency'] === 'string' &&
    /^[A-Za-z]{3}$/u.test(input['currency']) &&
    typeof input['original'] === 'string'
  ) {
    return {
      unit: 'money',
      amount: input['amount'],
      currency: input['currency'].toUpperCase(),
      original: input['original']
    }
  }
  return undefined
}
