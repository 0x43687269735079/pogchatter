import type { ResolvedEmote } from '@main/emotes/types'
import { resolveActiveEmote, type SevenTvActiveEmote } from '@main/emotes/providers/sevenTv'

const EVENTS_URL = 'wss://events.7tv.io/v3'

// Opcodes per https://github.com/SevenTV/EventAPI#opcodes (server ⬇ / client ⬆).
const OP_DISPATCH = 0
const OP_HELLO = 1
const OP_HEARTBEAT = 2
const OP_RECONNECT = 4
const OP_END_OF_STREAM = 7
const OP_SUBSCRIBE = 35
const OP_UNSUBSCRIBE = 36

// A socket that opens but never sends HELLO is dead — without this the heartbeat
// watchdog (armed only on HELLO) never starts and the client stalls forever.
const HELLO_TIMEOUT_MS = 15_000
// Used until HELLO supplies the real interval (the server's default is 25 s).
const DEFAULT_HEARTBEAT_MS = 25_000
// Per the docs: heartbeats missed for 3 cycles → the connection is dead, reconnect.
const MISSED_HEARTBEAT_CYCLES = 3
const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 60_000

/** A live mutation of one 7TV emote set; a rename/swap arrives as remove + add. */
export interface SevenTvSetChange {
  add: ResolvedEmote[]
  removeCodes: string[]
}

/** The slice of the WebSocket API the client touches — injectable so tests can fake it. */
export interface EventsSocket {
  send(data: string): void
  close(): void
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: { data?: unknown }) => void
  ): void
}

export type SocketFactory = (url: string) => EventsSocket

// A dispatch's ChangeMap arrays hold ChangeFields; only `emotes` entries carry active emotes.
interface ChangeField {
  key?: unknown
  value?: unknown
  old_value?: unknown
}

function changeFields(value: unknown): ChangeField[] {
  if (!Array.isArray(value)) {
    return []
  }
  const fields: ChangeField[] = []
  for (const entry of value) {
    if (entry !== null && typeof entry === 'object' && (entry as ChangeField).key === 'emotes') {
      fields.push(entry as ChangeField)
    }
  }
  return fields
}

/** Map an EventAPI active emote into the engine's shape, or undefined if malformed. */
function parseActiveEmote(value: unknown): ResolvedEmote | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined
  }
  const active = value as { id?: unknown; name?: unknown }
  if (typeof active.id !== 'string' || active.id === '') {
    return undefined
  }
  if (typeof active.name !== 'string' || active.name === '') {
    return undefined
  }
  return resolveActiveEmote(active as SevenTvActiveEmote)
}

function activeEmoteName(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined
  }
  const name = (value as { name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : undefined
}

function buildChange(map: {
  pushed?: unknown
  pulled?: unknown
  updated?: unknown
}): SevenTvSetChange {
  const change: SevenTvSetChange = { add: [], removeCodes: [] }
  for (const field of changeFields(map.pushed)) {
    const emote = parseActiveEmote(field.value)
    if (emote !== undefined) {
      change.add.push(emote)
    }
  }
  for (const field of changeFields(map.pulled)) {
    const code = activeEmoteName(field.old_value)
    if (code !== undefined) {
      change.removeCodes.push(code)
    }
  }
  for (const field of changeFields(map.updated)) {
    const code = activeEmoteName(field.old_value)
    if (code !== undefined) {
      change.removeCodes.push(code)
    }
    const emote = parseActiveEmote(field.value)
    if (emote !== undefined) {
      change.add.push(emote)
    }
  }
  return change
}

/** Extract a set id + change from an `emote_set.update` dispatch, or undefined to ignore it. */
function parseDispatch(d: unknown): { setId: string; change: SevenTvSetChange } | undefined {
  if (d === null || typeof d !== 'object') {
    return undefined
  }
  const { type, body } = d as { type?: unknown; body?: unknown }
  if (type !== 'emote_set.update' || body === null || typeof body !== 'object') {
    return undefined
  }
  const map = body as { id?: unknown; pushed?: unknown; pulled?: unknown; updated?: unknown }
  if (typeof map.id !== 'string' || map.id === '') {
    return undefined
  }
  const change = buildChange(map)
  if (change.add.length === 0 && change.removeCodes.length === 0) {
    return undefined
  }
  return { setId: map.id, change }
}

/**
 * Best-effort 7TV EventAPI client: one shared socket subscribed to `emote_set.update`
 * for every loaded 7TV set, translating dispatches into `SevenTvSetChange`s for the
 * engine. A dead EventAPI never affects chat — every failure path just schedules a
 * reconnect (capped exponential backoff), and all subscriptions replay on the next
 * HELLO. Logs one line per state change, never per event.
 */
export class SevenTvEvents {
  readonly #apply: (setId: string, change: SevenTvSetChange) => void
  readonly #createSocket: SocketFactory
  readonly #setIds = new Set<string>()
  #socket: EventsSocket | undefined
  #sessionReady = false
  #heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS
  #helloTimer: ReturnType<typeof setTimeout> | undefined
  #watchdog: ReturnType<typeof setTimeout> | undefined
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #attempts = 0
  #stopped = false

  constructor(
    apply: (setId: string, change: SevenTvSetChange) => void,
    createSocket: SocketFactory = (url) => new WebSocket(url)
  ) {
    this.#apply = apply
    this.#createSocket = createSocket
  }

  /** Subscribe to a set's updates — now if connected, otherwise on the next HELLO. */
  watch(setId: string): void {
    if (this.#stopped || this.#setIds.has(setId)) {
      return
    }
    this.#setIds.add(setId)
    if (this.#socket === undefined && this.#reconnectTimer === undefined) {
      this.#connect()
    } else if (this.#sessionReady) {
      this.#subscribe(setId)
    }
  }

  /** Stop watching a set: drop it from the HELLO replay list and unsubscribe if connected. */
  unwatch(setId: string): void {
    if (!this.#setIds.delete(setId)) {
      return
    }
    if (this.#sessionReady) {
      this.#sendSetOp(OP_UNSUBSCRIBE, setId)
    }
  }

  /** Tear down the socket and timers; the client is not restartable. */
  stop(): void {
    this.#stopped = true
    clearTimeout(this.#watchdog)
    clearTimeout(this.#reconnectTimer)
    this.#closeSocket()
  }

  #connect(): void {
    let socket: EventsSocket
    try {
      socket = this.#createSocket(EVENTS_URL)
    } catch {
      this.#scheduleReconnect('connect failed')
      return
    }
    this.#socket = socket
    this.#sessionReady = false
    clearTimeout(this.#helloTimer)
    this.#helloTimer = setTimeout(() => {
      this.#onLost('no HELLO')
    }, HELLO_TIMEOUT_MS)
    // Guard every handler against firing for a socket we already replaced.
    socket.addEventListener('message', (event) => {
      if (this.#socket === socket) {
        this.#onFrame(event.data)
      }
    })
    socket.addEventListener('close', () => {
      if (this.#socket === socket) {
        this.#onLost('socket closed')
      }
    })
    socket.addEventListener('error', () => {
      // The close event that follows a failure handles reconnection.
    })
  }

  #closeSocket(): void {
    clearTimeout(this.#helloTimer)
    this.#helloTimer = undefined
    const socket = this.#socket
    this.#socket = undefined
    this.#sessionReady = false
    try {
      socket?.close()
    } catch {
      // Already closed/failed — nothing to release.
    }
  }

  #onLost(reason: string): void {
    clearTimeout(this.#watchdog)
    this.#closeSocket()
    this.#scheduleReconnect(reason)
  }

  #scheduleReconnect(reason: string): void {
    if (this.#stopped || this.#reconnectTimer !== undefined) {
      return
    }
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.#attempts, 6))
    this.#attempts += 1
    console.log(`[7tv-events] ${reason} — reconnecting in ${delay}ms`)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      this.#connect()
    }, delay)
  }

  #onFrame(data: unknown): void {
    let frame: unknown
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data))
    } catch {
      return
    }
    if (frame === null || typeof frame !== 'object') {
      return
    }
    const { op, d } = frame as { op?: unknown; d?: unknown }
    if (op === OP_HELLO) {
      this.#onHello(d)
    } else if (op === OP_HEARTBEAT) {
      this.#armWatchdog()
    } else if (op === OP_DISPATCH) {
      this.#onDispatch(d)
    } else if (op === OP_RECONNECT || op === OP_END_OF_STREAM) {
      this.#onLost(op === OP_RECONNECT ? 'server requested reconnect' : 'end of stream')
    }
    // Other opcodes (ACK, ERROR, …) carry nothing we act on.
  }

  #onHello(d: unknown): void {
    clearTimeout(this.#helloTimer)
    this.#helloTimer = undefined
    const interval = (d as { heartbeat_interval?: unknown } | null)?.heartbeat_interval
    this.#heartbeatIntervalMs =
      typeof interval === 'number' && interval > 0 ? interval : DEFAULT_HEARTBEAT_MS
    this.#sessionReady = true
    this.#attempts = 0
    console.log(`[7tv-events] connected; subscribing to ${this.#setIds.size} emote set(s)`)
    for (const setId of this.#setIds) {
      this.#subscribe(setId)
    }
    this.#armWatchdog()
  }

  #subscribe(setId: string): void {
    this.#sendSetOp(OP_SUBSCRIBE, setId)
  }

  #sendSetOp(op: number, setId: string): void {
    try {
      this.#socket?.send(
        JSON.stringify({ op, d: { type: 'emote_set.update', condition: { object_id: setId } } })
      )
    } catch {
      // A failed send means the socket is going down; its close event reconnects.
    }
  }

  #armWatchdog(): void {
    clearTimeout(this.#watchdog)
    if (this.#stopped) {
      return
    }
    this.#watchdog = setTimeout(() => {
      this.#onLost('heartbeats stopped')
    }, this.#heartbeatIntervalMs * MISSED_HEARTBEAT_CYCLES)
  }

  #onDispatch(d: unknown): void {
    const parsed = parseDispatch(d)
    if (parsed === undefined) {
      return
    }
    try {
      this.#apply(parsed.setId, parsed.change)
    } catch {
      // Never let an engine error kill the socket loop.
    }
  }
}
