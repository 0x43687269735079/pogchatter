import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  type AppSettings,
  type BanRule,
  type ChatLogSettings,
  DEFAULT_SETTINGS,
  type HighlightRule,
  MAX_BUFFER_SIZE,
  MAX_FONT_SIZE,
  MIN_BUFFER_SIZE,
  MIN_FONT_SIZE,
  type ModerationRule,
  type ModerationSettings,
  type MonitoredUser,
  type MonitorView,
  type Platform,
  type PrebanSettings
} from '@shared/model'
import { MAX_PATTERN_LENGTH } from '@shared/patternMatch'
import { channelId, isPlatform } from '@main/sources/channelId'

export interface PersistedChannel {
  platform: Platform
  target: string
  id: string
  /** Display label override (e.g. a discovered stream title), so columns keep their name across restarts. */
  label?: string
}

interface Config {
  channels: PersistedChannel[]
  visitorData?: string
  settings: AppSettings
}

function isPersistedChannel(value: unknown): value is PersistedChannel {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const channel = value as Record<string, unknown>
  return (
    isPlatform(channel['platform']) &&
    typeof channel['target'] === 'string' &&
    typeof channel['id'] === 'string' &&
    (channel['label'] === undefined || typeof channel['label'] === 'string')
  )
}

/**
 * Recompute each persisted channel's id from its target, so entries written under an older
 * normalization scheme (e.g. /channel/ URLs before they canonicalized to the bare UC id) keep
 * matching the live source ids — otherwise removing such a column would never stick. Entries
 * whose targets now collapse to one id keep only the first.
 */
function recomputeChannelIds(channels: PersistedChannel[]): PersistedChannel[] {
  const result: PersistedChannel[] = []
  for (const channel of channels) {
    const id = channelId(channel.platform, channel.target)
    if (!result.some((existing) => existing.id === id)) {
      result.push({ ...channel, id })
    }
  }
  return result
}

/** One highlight rule from untrusted JSON, or undefined if it isn't a valid rule. */
function sanitizeHighlight(value: unknown): HighlightRule | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = value as Record<string, unknown>
  const pattern = input['pattern']
  const target = input['target']
  if (
    typeof pattern !== 'string' ||
    pattern === '' ||
    (target !== 'user' && target !== 'message')
  ) {
    return undefined
  }
  const rule: HighlightRule = { pattern, isRegex: input['isRegex'] === true, target }
  if (typeof input['color'] === 'string') {
    rule.color = input['color']
  }
  for (const key of ['flash', 'sound', 'notify'] as const) {
    if (typeof input[key] === 'boolean') {
      rule[key] = input[key] as boolean
    }
  }
  return rule
}

/** One monitor view from untrusted JSON, or undefined if it isn't a valid view. */
function sanitizeMonitor(value: unknown): MonitorView | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = value as Record<string, unknown>
  const id = input['id']
  const label = input['label']
  const members = input['members']
  if (typeof id !== 'string' || id === '' || typeof label !== 'string' || !Array.isArray(members)) {
    return undefined
  }
  return { id, label, members: members.filter((m): m is string => typeof m === 'string') }
}

/** One moderation watchlist rule from untrusted JSON, or undefined if its pattern is missing/empty. */
export function sanitizeModerationRule(value: unknown): ModerationRule | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = value as Record<string, unknown>
  const pattern = input['pattern']
  if (typeof pattern !== 'string' || pattern === '') {
    return undefined
  }
  return { pattern, isRegex: input['isRegex'] === true }
}

/**
 * One pre-ban rule from untrusted JSON (a stale config, an imported file, or the renderer), or
 * undefined if its pattern is missing/empty/oversized. Platforms keep only known values; an empty
 * platform list collapses to "both" (the key is dropped).
 */
export function sanitizeBanRule(value: unknown): BanRule | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = value as Record<string, unknown>
  const pattern = input['pattern']
  if (typeof pattern !== 'string' || pattern === '' || pattern.length > MAX_PATTERN_LENGTH) {
    return undefined
  }
  const rule: BanRule = { pattern, isRegex: input['isRegex'] === true }
  if (Array.isArray(input['platforms'])) {
    const platforms = input['platforms'].filter(isPlatform)
    if (platforms.length > 0 && platforms.length < 2) {
      rule.platforms = platforms
    }
  }
  if (typeof input['note'] === 'string' && input['note'].trim() !== '') {
    rule.note = input['note'].trim().slice(0, 500)
  }
  return rule
}

/** One monitored user from untrusted JSON, or undefined if it isn't a valid entry. */
function sanitizeMonitoredUser(value: unknown): MonitoredUser | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = value as Record<string, unknown>
  const userId = input['userId']
  if (!isPlatform(input['platform']) || typeof userId !== 'string' || userId === '') {
    return undefined
  }
  const entry: MonitoredUser = {
    platform: input['platform'],
    userId,
    addedAt:
      typeof input['addedAt'] === 'number' && Number.isFinite(input['addedAt'])
        ? input['addedAt']
        : 0
  }
  if (typeof input['handle'] === 'string' && input['handle'] !== '') {
    entry.handle = input['handle']
  }
  if (typeof input['note'] === 'string' && input['note'].trim() !== '') {
    entry.note = input['note'].trim().slice(0, 500)
  }
  return entry
}

/** Pre-ban settings from untrusted JSON, or undefined if not a valid object. */
function sanitizePreban(value: unknown): PrebanSettings | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = value as Record<string, unknown>
  const rules = Array.isArray(input['rules'])
    ? input['rules'].map(sanitizeBanRule).filter((rule): rule is BanRule => rule !== undefined)
    : []
  // The safety defaults are the conservative ones: auto-ban stays opted out and dry-run stays on
  // unless the stored value explicitly says otherwise.
  return { enabled: input['enabled'] === true, dryRun: input['dryRun'] !== false, rules }
}

/** Moderation settings from untrusted JSON, or undefined if not a valid object. */
function sanitizeModeration(value: unknown): ModerationSettings | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = value as Record<string, unknown>
  const rules = Array.isArray(input['rules'])
    ? input['rules']
        .map(sanitizeModerationRule)
        .filter((rule): rule is ModerationRule => rule !== undefined)
    : []
  return { rules, sound: input['sound'] !== false, notify: input['notify'] === true }
}

/** Chat-log settings from untrusted JSON, or undefined if not a valid object. */
function sanitizeChatLog(value: unknown): ChatLogSettings | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = value as Record<string, unknown>
  return {
    enabled: input['enabled'] === true,
    directory: typeof input['directory'] === 'string' ? input['directory'] : ''
  }
}

/** Keep only known setting keys with the right types, so a stale file or the renderer can't inject arbitrary config. */
function sanitizeSettings(value: unknown): Partial<AppSettings> {
  if (typeof value !== 'object' || value === null) {
    return {}
  }
  const input = value as Record<string, unknown>
  const settings: Partial<AppSettings> = {}
  if (typeof input['devMode'] === 'boolean') {
    settings.devMode = input['devMode']
  }
  if (typeof input['revealDeleted'] === 'boolean') {
    settings.revealDeleted = input['revealDeleted']
  }
  if (typeof input['bufferSize'] === 'number' && Number.isFinite(input['bufferSize'])) {
    // Clamp to the supported range, so a hand-edited file can't ask for an unrenderable buffer.
    settings.bufferSize = Math.max(
      MIN_BUFFER_SIZE,
      Math.min(MAX_BUFFER_SIZE, Math.round(input['bufferSize']))
    )
  }
  if (Array.isArray(input['highlights'])) {
    settings.highlights = input['highlights']
      .map(sanitizeHighlight)
      .filter((rule): rule is HighlightRule => rule !== undefined)
  }
  if (Array.isArray(input['monitors'])) {
    settings.monitors = input['monitors']
      .map(sanitizeMonitor)
      .filter((monitor): monitor is MonitorView => monitor !== undefined)
  }
  const moderation = sanitizeModeration(input['moderation'])
  if (moderation !== undefined) {
    settings.moderation = moderation
  }
  const preban = sanitizePreban(input['preban'])
  if (preban !== undefined) {
    settings.preban = preban
  }
  if (Array.isArray(input['monitoredUsers'])) {
    settings.monitoredUsers = input['monitoredUsers']
      .map(sanitizeMonitoredUser)
      .filter((user): user is MonitoredUser => user !== undefined)
  }
  if (input['theme'] === 'ice' || input['theme'] === 'midnight') {
    settings.theme = input['theme']
  }
  if (typeof input['fontSize'] === 'number' && Number.isFinite(input['fontSize'])) {
    settings.fontSize = Math.max(
      MIN_FONT_SIZE,
      Math.min(MAX_FONT_SIZE, Math.round(input['fontSize']))
    )
  }
  if (typeof input['emoteProviders'] === 'object' && input['emoteProviders'] !== null) {
    const providers = input['emoteProviders'] as Record<string, unknown>
    settings.emoteProviders = {
      sevenTv: providers['sevenTv'] !== false,
      bttv: providers['bttv'] !== false,
      ffz: providers['ffz'] !== false
    }
  }
  if (Array.isArray(input['columnOrder'])) {
    settings.columnOrder = input['columnOrder']
      .filter((id): id is string => typeof id === 'string' && id !== '')
      .slice(0, 200)
  }
  const chatLog = sanitizeChatLog(input['chatLog'])
  if (chatLog !== undefined) {
    settings.chatLog = chatLog
  }
  if (typeof input['allowPlaintextCredentials'] === 'boolean') {
    settings.allowPlaintextCredentials = input['allowPlaintextCredentials']
  }
  if (typeof input['keepAwake'] === 'boolean') {
    settings.keepAwake = input['keepAwake']
  }
  return settings
}

/** Plain-JSON persistence for non-sensitive settings (the channel list). */
export class ConfigStore {
  readonly #path: string
  readonly #firstRun: boolean
  #config: Config

  constructor() {
    this.#path = join(app.getPath('userData'), 'config.json')
    this.#firstRun = !existsSync(this.#path)
    this.#config = this.#load()
  }

  /** True when no config file existed at startup (so env channels can seed it once). */
  get firstRun(): boolean {
    return this.#firstRun
  }

  channels(): PersistedChannel[] {
    return this.#config.channels
  }

  addChannel(channel: PersistedChannel): void {
    if (!this.#config.channels.some((existing) => existing.id === channel.id)) {
      this.#config.channels.push(channel)
      this.#save()
    }
  }

  removeChannel(id: string): void {
    const next = this.#config.channels.filter((channel) => channel.id !== id)
    if (next.length !== this.#config.channels.length) {
      this.#config.channels = next
      this.#save()
    }
  }

  /** The persisted YouTube visitor_data, for a durable browser identity across restarts. */
  visitorData(): string | undefined {
    return this.#config.visitorData
  }

  setVisitorData(value: string): void {
    if (this.#config.visitorData !== value) {
      this.#config.visitorData = value
      this.#save()
    }
  }

  /** The persisted app settings (defaults filled in for any missing key). */
  settings(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...this.#config.settings }
  }

  /** Merge a settings patch (known keys only), persist, and return the new settings. */
  setSettings(patch: Partial<AppSettings>): AppSettings {
    this.#config.settings = { ...this.#config.settings, ...sanitizeSettings(patch) }
    this.#save()
    return this.settings()
  }

  #load(): Config {
    if (!existsSync(this.#path)) {
      return { channels: [], settings: { ...DEFAULT_SETTINGS } }
    }
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<Config>
      const config: Config = {
        channels: Array.isArray(parsed.channels)
          ? recomputeChannelIds(parsed.channels.filter(isPersistedChannel))
          : [],
        settings: { ...DEFAULT_SETTINGS, ...sanitizeSettings(parsed.settings) }
      }
      if (typeof parsed.visitorData === 'string' && parsed.visitorData !== '') {
        config.visitorData = parsed.visitorData
      }
      return config
    } catch {
      // Corrupt config: keep a backup for inspection rather than silently overwriting it.
      try {
        copyFileSync(this.#path, `${this.#path}.bad`)
      } catch {
        // ignore backup failure
      }
      return { channels: [], settings: { ...DEFAULT_SETTINGS } }
    }
  }

  #save(): void {
    // Temp-file + rename: a crash mid-write must not truncate the only copy of the
    // channel list and settings.
    try {
      writeFileSync(`${this.#path}.tmp`, JSON.stringify(this.#config, null, 2))
      renameSync(`${this.#path}.tmp`, this.#path)
    } catch (error) {
      console.error('Failed to save config:', error)
    }
  }
}
