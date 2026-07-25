import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, Platform } from '@shared/model'
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
  now?: () => number
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
  readonly #now: () => number
  readonly #writeFile: (path: string, contents: string) => void
  /** Oldest first, so ageing out is a shift and appending is a push. */
  #donations: Donation[] = []
  readonly #ids = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(deps: DonationStoreDeps) {
    this.#path = join(deps.dir, 'donations.json')
    this.#now = deps.now ?? Date.now
    this.#writeFile = deps.writeFile ?? ((path, contents) => writeFileSync(path, contents))
    this.#load()
  }

  /** Newest first — the order the panel renders. */
  list(): Donation[] {
    return [...this.#donations].reverse()
  }

  unreadCount(): number {
    return this.#donations.reduce((total, donation) => total + (donation.read ? 0 : 1), 0)
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
    this.#donations.push(donation)
    this.#ids.add(donation.id)
    if (this.#donations.length > DONATION_RETENTION) {
      // Whole records only: read state ages out with the donation it belongs to.
      for (const dropped of this.#donations.splice(
        0,
        this.#donations.length - DONATION_RETENTION
      )) {
        this.#ids.delete(dropped.id)
      }
    }
    this.#schedulePersist()
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

  /** Write any pending change immediately (shutdown). */
  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
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
      const body = JSON.stringify({ donations: this.#donations, savedAt: this.#now() })
      this.#writeFile(`${this.#path}.tmp`, body)
      renameSync(`${this.#path}.tmp`, this.#path)
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
      for (const value of raw.slice(-DONATION_RETENTION)) {
        const donation = sanitizeDonation(value)
        if (donation !== undefined && !this.#ids.has(donation.id)) {
          this.#donations.push(donation)
          this.#ids.add(donation.id)
        }
      }
    } catch {
      // A truncated or hand-edited file starts empty rather than preventing startup.
      this.#donations = []
      this.#ids.clear()
    }
  }
}

const KINDS: ReadonlySet<string> = new Set([
  'superchat',
  'supersticker',
  'membership',
  'membership_gift',
  'bits',
  'subscription'
])

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
  const donationValue = sanitizeValue(input['value'])
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
    read: input['read'] === true
  }
  if (input['removed'] === true) {
    donation.removed = true
  }
  return donation
}

function sanitizeValue(value: unknown): DonationValue | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = value as Record<string, unknown>
  const unit = input['unit']
  if (unit === 'count') {
    return { unit: 'count' }
  }
  if (unit === 'bits' && typeof input['bits'] === 'number' && Number.isFinite(input['bits'])) {
    return { unit: 'bits', bits: input['bits'] }
  }
  if (unit === 'money-unparsed' && typeof input['original'] === 'string') {
    return { unit: 'money-unparsed', original: input['original'] }
  }
  if (
    unit === 'money' &&
    typeof input['amount'] === 'number' &&
    Number.isFinite(input['amount']) &&
    typeof input['currency'] === 'string' &&
    typeof input['original'] === 'string'
  ) {
    return {
      unit: 'money',
      amount: input['amount'],
      currency: input['currency'],
      original: input['original']
    }
  }
  return undefined
}
