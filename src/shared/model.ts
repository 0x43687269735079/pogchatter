/**
 * Normalized chat model shared between the main process and the renderer.
 *
 * Every platform connector (Twitch, YouTube, ...) maps its native payloads onto
 * these types so the UI never has to branch on the source platform.
 */

export type Platform = 'twitch' | 'youtube'

export type EmoteProvider = Platform | '7tv' | 'bttv' | 'ffz'

export interface Badge {
  /** Stable badge key, e.g. `moderator`, `subscriber`, `member`. */
  type: string
  /** Human-readable label for tooltips/accessibility. */
  label: string
  imageUrl?: string
}

export interface AuthorRoles {
  broadcaster: boolean
  moderator: boolean
  vip?: boolean
  /** Twitch subscriber. */
  subscriber?: boolean
  /** YouTube channel member. */
  member?: boolean
  verified?: boolean
}

export interface Author {
  id: string
  /** Login / handle. */
  name: string
  displayName: string
  /** Hex colour (e.g. `#7cf`), if the platform provides one. */
  color?: string
  /** Profile image URL, when the platform provides one. */
  avatarUrl?: string
  badges: Badge[]
  roles: AuthorRoles
}

export type Fragment =
  | {
      type: 'text'
      text: string
      /** Exempt from third-party emote tokenization (e.g. a cheer's bits amount stays a number). */
      verbatim?: boolean
    }
  | {
      type: 'emote'
      code: string
      url: string
      provider: EmoteProvider
      /** Overlay/zero-width emote stacked on the preceding emote. */
      zeroWidth?: boolean
      animated?: boolean
    }
  | { type: 'mention'; text: string; userId?: string }

export type HighlightKind =
  | 'superchat'
  | 'supersticker'
  | 'bits'
  | 'membership'
  | 'membership_gift'
  | 'subscription'
  | 'first_message'

export interface Highlight {
  kind: HighlightKind
  amount?: number
  currency?: string
  /** Pre-formatted amount, e.g. `$5.00`. */
  displayAmount?: string
  tier?: string
  /** Accent colour for the highlight card. */
  color?: string
  count?: number
  /**
   * Membership header line — YouTube's milestone ("Member for 6 months") or welcome/level text.
   * The member's own typed message (milestone chat) rides in the message's `fragments`.
   */
  headerText?: string
}

export interface ReplyContext {
  parentId: string
  parentAuthor: string
  parentText: string
  /**
   * YouTube only: a token to fetch the donation's reply thread (the Super Chat plus every reply) via
   * {@link ChatApi.getReplyThread}, so the whole chain can be opened in one view. Absent on Twitch
   * replies, which carry the parent inline.
   */
  threadToken?: string
}

export interface ChatMessage {
  id: string
  platform: Platform
  channelId: string
  /** Unix epoch milliseconds. */
  timestamp: number
  author: Author
  /** Text/emote/mention pieces, in render order (post emote tokenization). */
  fragments: Fragment[]
  highlight?: Highlight
  reply?: ReplyContext
  /** Non-chat event line (sub, member, raid, ...). */
  system?: boolean
  deleted?: boolean
  /** This message was sent by the logged-in user (local echo) — rendered with the accent style. */
  self?: boolean
  /**
   * YouTube per-message "⋮" menu token. Opens the right-click action menu (report/block, plus
   * moderation when the signed-in account is a moderator or the streamer). Absent on platforms or
   * messages without one.
   */
  menuToken?: string
  /** Set when the message matched a highlight rule; carries the resolved accent colour. */
  ping?: { color: string }
  /** Set when the message matched a moderation watchlist term — flagged for a moderator to review. */
  flagged?: boolean
}

/**
 * One right-click action available on a chat message for the signed-in account. The set reflects
 * the account's role in that chat (a viewer sees report/block; a moderator/streamer also sees
 * remove/timeout/ban), as resolved by the platform — not assumed by the client.
 */
export interface ChatAction {
  /** Stable id for invoking the action (the platform's icon type, e.g. `DELETE`, `FLAG`). */
  id: string
  /** Human label as the platform names it (e.g. "Remove", "Report", "Block"). */
  label: string
  /** Removes/bans/times-out — the UI confirms before running. */
  destructive: boolean
  /** A timeout action: the durations (seconds) YouTube offers, shown as a picker instead of a confirm. */
  timeoutDurations?: number[]
}

/**
 * `degraded` (waiting/live): chat is flowing but the parser is skipping a sustained share of
 * unrecognized YouTube actions — some messages may be missing until the parsers catch up with a
 * changed response shape.
 */
export type SourceStatus =
  | { state: 'offline' }
  | { state: 'connecting' }
  /** Chat connected. Used by Twitch, whose room is joinable regardless of stream-live status. */
  | { state: 'connected' }
  | { state: 'waiting'; scheduledStart?: number; degraded?: boolean }
  | { state: 'live'; viewers?: number; degraded?: boolean }
  | { state: 'ended' }
  | { state: 'replay' }
  | { state: 'error'; message: string }

export interface ClearTarget {
  /** Clear a single message; omit to clear by user or whole chat. */
  messageId?: string
  userId?: string
}

export interface ChannelInfo {
  id: string
  platform: Platform
  label: string
  status: SourceStatus
  /**
   * Why the signed-in user currently can't send here (e.g. "Subscribers-only mode"), when the
   * platform reports a chat restriction. Undefined means no known restriction. Only meaningful
   * once logged in; the logged-out case is handled separately by the renderer.
   */
  sendRestriction?: string
}

/** A custom (7TV/BTTV/FFZ) emote usable in a channel, surfaced to the input autocomplete/picker. */
export interface ChannelEmote {
  code: string
  url: string
  provider: EmoteProvider
  animated: boolean
  /**
   * `channel` for the current channel's set, `global` for the provider's site-wide set,
   * `library` for your own emotes + the other added channels' sets (usable in every column).
   */
  scope: 'global' | 'channel' | 'library'
}

/**
 * Platform profile details for the user card, fetched on open. Fields are best-effort per
 * platform: Twitch fills account age/avatar/description via Helix; YouTube fills subscriber
 * count/joined/avatar via the channel page. Everything beyond the ids may be missing.
 */
export interface UserProfile {
  platform: Platform
  userId: string
  displayName: string
  /** Login (Twitch) or @handle (YouTube), when known. */
  handle?: string
  avatarUrl?: string
  /** The user's channel/profile page, opened in the system browser. */
  url?: string
  /** Account creation (Twitch) / channel join (YouTube) time, epoch ms, when exposed. */
  createdAt?: number
  /** Pre-formatted audience size, e.g. "1.23M subscribers" — platforms format these differently. */
  audience?: string
  description?: string
}

/**
 * A user being monitored (from the user card's Monitor toggle): all their messages are highlighted
 * across the main columns until cleared. Persisted; team-shaped for the future sync backend.
 */
export interface MonitoredUser {
  platform: Platform
  /** The author id ({@link Author.id} — Twitch user id / YouTube channel id). */
  userId: string
  /** Handle/display name at the time of adding, so the entry stays identifiable. */
  handle?: string
  note?: string
  /** Epoch ms. */
  addedAt: number
}

/** A YouTube channel the signed-in account can post as. */
export interface YouTubeChannel {
  /** `default` for the cookie's own identity, otherwise the channel's `X-Goog-PageId`. */
  id: string
  name: string
  handle?: string
  avatarUrl?: string
}

/**
 * How credentials are held at rest: OS-keychain encrypted (normal), plaintext on disk (explicit
 * opt-in for keyring-less Linux), or memory-only (no keyring, no opt-in — lost on restart).
 */
export type CredentialStorageMode = 'encrypted' | 'plaintext' | 'memory'

/**
 * Electron's Linux `safeStorage` backend (`safeStorage.getSelectedStorageBackend()`).
 * `basic_text` means the desktop environment wasn't recognized, so no keyring is in use — the
 * UI's advice differs from the genuinely-no-keyring case (a `--password-store` flag can fix it).
 */
export type LinuxKeyringBackend =
  | 'basic_text'
  | 'gnome_libsecret'
  | 'kwallet'
  | 'kwallet5'
  | 'kwallet6'
  | 'unknown'

export interface AuthState {
  twitch: { configured: boolean; loggedIn: boolean; userName?: string }
  youtube: { loggedIn: boolean; channels: YouTubeChannel[]; selectedChannelId?: string }
  /** Storage backing for saved logins, so the UI can warn when they won't persist/aren't encrypted. */
  credentialStorage: CredentialStorageMode
  /** The keyring `safeStorage` selected — present on Linux only. */
  linuxKeyringBackend?: LinuxKeyringBackend
}

/** A user/keyword highlight rule: matched messages get a colour and an alert. */
export interface HighlightRule {
  /** Substring (case-insensitive) or, when `isRegex`, a regular expression. */
  pattern: string
  isRegex: boolean
  /** Match the author's handle/name (`user`) or the message text (`message`). */
  target: 'user' | 'message'
  /** Row accent colour (hex). Falls back to a default highlight colour when unset. */
  color?: string
  /** Flash the column on match (default on). */
  flash?: boolean
  /** Play a sound on match (default on). */
  sound?: boolean
  /** Also show an OS notification on match (default off — it's the intrusive alert). */
  notify?: boolean
}

/**
 * A combined monitor view: several open columns merged into one time-ordered feed, each message
 * tagged with its origin chat. Built by manual multi-select, for watching many of one creator's
 * waiting-room + live chats in one place.
 */
export interface MonitorView {
  /** Stable id; the combined column is ordered alongside channels under `monitor:<id>`. */
  id: string
  label: string
  /** Member channel ids whose messages are merged into this view. */
  members: string[]
}

/** A moderation watchlist entry: a word/phrase, or a regex, to flag in chat for review. */
export interface ModerationRule {
  pattern: string
  isRegex: boolean
}

/**
 * A pre-ban rule: a known-bad username/handle (or regex) to ban automatically on their first
 * message. Shared between moderators by file export/import until a sync backend exists.
 */
export interface BanRule {
  /**
   * Matched against the author's handle and display name. Literal patterns must equal one exactly
   * (case-insensitive, leading `@` tolerated); regex patterns match anywhere, case-insensitively.
   */
  pattern: string
  isRegex: boolean
  /** Platforms the rule applies to; omitted/empty means both. */
  platforms?: Platform[]
  /** Where the intel came from (e.g. "rae's mod team, 2026-06"), for future review. */
  note?: string
}

/**
 * Pre-ban auto-moderation. Automatically bans a matching author on their first message in any chat
 * where the signed-in account can moderate. Safety posture (deliberate): `enabled` is the
 * master opt-in (off by default), `dryRun` (on by default) only logs what it *would* ban, every
 * action — real or dry — is surfaced in the column and the chat log, and a per-minute rate cap
 * guards a runaway regex from mass-banning on a real account.
 */
export interface PrebanSettings {
  enabled: boolean
  dryRun: boolean
  rules: BanRule[]
}

/** Moderation alerts: flag messages matching any watchlist term so a moderator can review them. */
export interface ModerationSettings {
  rules: ModerationRule[]
  /** Play a sound when a message is flagged. */
  sound: boolean
  /** Fire an OS notification when a message is flagged. */
  notify: boolean
}

/** Outcome of exporting the moderation watchlist to a local file: written, failed, or user cancel. */
export type ModerationExport = { ok: true } | { ok: false; error: string } | { canceled: true }

/** Outcome of importing a moderation watchlist from a local file: the parsed rules, failed, or cancel. */
export type ModerationImport =
  | { ok: true; rules: ModerationRule[] }
  | { ok: false; error: string }
  | { canceled: true }

/** Outcome of importing pre-ban rules from a local file: the parsed rules, failed, or cancel. */
export type PrebanImport =
  | { ok: true; rules: BanRule[] }
  | { ok: false; error: string }
  | { canceled: true }

/**
 * Append every chat message + deletion from all open chats to one local JSONL file, for long-term
 * record-keeping and moderation review. When enabled it covers every chat (including newly-opened
 * ones); there's no per-chat selection.
 */
export interface ChatLogSettings {
  enabled: boolean
  /** Directory for the JSONL log; empty means the app default (under the user-data dir). */
  directory: string
}

/** UI theme (the two built-in TUI palettes). */
export type ThemeName = 'ice' | 'midnight'

/** Third-party emote providers; disabling one hides its emotes and skips its fetches/socket. */
export interface EmoteProviderSettings {
  sevenTv: boolean
  bttv: boolean
  ffz: boolean
}

/** Bounds and presets for {@link AppSettings.fontSize} (chat text; UI chrome stays compact). */
export const MIN_FONT_SIZE = 11
export const MAX_FONT_SIZE = 16
export const DEFAULT_FONT_SIZE = 13
export const FONT_SIZE_OPTIONS = [11, 12, 13, 14, 15, 16] as const

/** Persisted app preferences, surfaced in the Settings panel. */
export interface AppSettings {
  /** Reveals the Developer section — the home for experimental features and debug toggles. */
  devMode: boolean
  /** Keep deleted messages readable (dimmed + struck) instead of hiding their text. */
  revealDeleted: boolean
  /**
   * Messages kept per chat (scrollback, and the pool the monitor/flagged/search views draw from).
   * A bigger buffer holds more history at the cost of memory — clamped to
   * [{@link MIN_BUFFER_SIZE}, {@link MAX_BUFFER_SIZE}]. Off-screen rows skip layout/paint
   * (content-visibility), so the render cost stays bounded to what's on screen.
   */
  bufferSize: number
  /** User/keyword highlight rules (ping when matched). */
  highlights: HighlightRule[]
  /** Combined monitor views (merged read-only feeds across columns). */
  monitors: MonitorView[]
  /** Moderation watchlist alerts. */
  moderation: ModerationSettings
  /** Pre-ban auto-moderation (ban known-bad users on their first message). */
  preban: PrebanSettings
  /** Users whose messages are highlighted across all columns (user-card Monitor toggle). */
  monitoredUsers: MonitoredUser[]
  /** UI theme palette. */
  theme: ThemeName
  /** Chat text size in px, clamped to [{@link MIN_FONT_SIZE}, {@link MAX_FONT_SIZE}]. */
  fontSize: number
  /** Third-party emote provider toggles. */
  emoteProviders: EmoteProviderSettings
  /**
   * Persisted column order (column ids, left to right), written on an explicit move. Columns not
   * listed slot in by the default rule: flagged view, then monitor views, then chats.
   */
  columnOrder: string[]
  /** Chat-to-disk logging. */
  chatLog: ChatLogSettings
  /**
   * Allow saved logins to persist as plaintext on disk when no OS keyring is available (Linux
   * without a Secret Service). Off by default: without it, credentials are memory-only there.
   */
  allowPlaintextCredentials: boolean
  /**
   * Hold a power assertion so this computer never idle-sleeps (suspending chat and chat-logging)
   * while the app runs. On by default. Only meaningful on macOS, where App Nap would otherwise
   * also suspend a backgrounded renderer outright.
   */
  keepAwake: boolean
}

/**
 * Bounds for {@link AppSettings.bufferSize}. The ceiling is generous because off-screen rows render
 * lazily (content-visibility); memory and React reconciliation still scale with the buffer, so it
 * isn't unbounded.
 */
export const MIN_BUFFER_SIZE = 100
export const MAX_BUFFER_SIZE = 5000
export const DEFAULT_BUFFER_SIZE = 500
/**
 * Messages retained per channel in main's replay ring ({@link ../main/EventBacklog | EventBacklog})
 * and replayed into a fresh renderer. Shared so the renderer can size its seen-id dedup window to
 * absorb a full replay (see `seenIdCapacity`).
 */
export const BACKLOG_MESSAGES_PER_CHANNEL = 300
/** The buffer sizes offered in Settings (each a clear step in the memory/history trade-off). */
export const BUFFER_SIZE_OPTIONS = [100, 500, 1000, 2000, 5000] as const

export const DEFAULT_SETTINGS: AppSettings = {
  devMode: false,
  revealDeleted: true,
  bufferSize: DEFAULT_BUFFER_SIZE,
  highlights: [],
  monitors: [],
  moderation: { rules: [], sound: true, notify: false },
  preban: { enabled: false, dryRun: true, rules: [] },
  monitoredUsers: [],
  theme: 'ice',
  fontSize: DEFAULT_FONT_SIZE,
  emoteProviders: { sevenTv: true, bttv: true, ffz: true },
  columnOrder: [],
  chatLog: { enabled: false, directory: '' },
  allowPlaintextCredentials: false,
  keepAwake: true
}

/** Result of a send attempt — never rejects across IPC, so failures are handled gracefully. */
export type SendResult = { ok: true } | { ok: false; error: string }

/** Result of bulk-adding a YouTube channel's live + waiting-room streams as columns. */
export type AddStreamsResult =
  | { ok: true; added: number; total: number }
  | { ok: false; error: string }

/** Result of starting a Twitch device-code login: a code to enter, or an error. */
export type TwitchLoginPrompt =
  | { userCode: string; verificationUri: string; expiresIn: number }
  | { error: string }

/** Events pushed from the main process to the renderer. */
export type ChatEvent =
  | { kind: 'message'; channelId: string; message: ChatMessage }
  | { kind: 'status'; channelId: string; status: SourceStatus }
  /** The signed-in user's ability to send here changed (reason set = blocked, undefined = allowed). */
  | { kind: 'sendRestriction'; channelId: string; reason: string | undefined }
  | { kind: 'clear'; channelId: string; target: ClearTarget }
  /**
   * An author's avatar resolved after their messages already rendered (Twitch avatars arrive via
   * a lazy batched Helix lookup), so buffered messages can be back-filled for a consistent view.
   */
  | { kind: 'authorUpdate'; channelId: string; login: string; avatarUrl: string }
  /** Full channel list, re-sent whenever a source is added/removed (handles late-added sources). */
  | { kind: 'channels'; channels: ChannelInfo[] }
  | { kind: 'auth'; auth: AuthState }

/** Surface exposed to the renderer through the preload context bridge. */
export interface ChatApi {
  /** Subscribe to batched chat events. Returns an unsubscribe function. */
  onEvents(callback: (events: ChatEvent[]) => void): () => void
  /**
   * Main's retained chat history as message events, replayed so a fresh renderer (startup race,
   * crash-reload) can refill its buffers instead of opening empty.
   */
  getBacklog(): Promise<ChatEvent[]>
  listChannels(): Promise<ChannelInfo[]>
  /** Send a message. `replyTo` is a Twitch parent message id (native reply); YouTube tags inline instead. */
  send(channelId: string, text: string, replyTo?: string): Promise<SendResult>
  getAuthState(): Promise<AuthState>
  /** Start Twitch device-code login. Returns the code to enter; completion arrives via an `auth` event. */
  loginTwitch(): Promise<TwitchLoginPrompt>
  /** Resolves when the pending device-code login finishes: ok on success, the failure otherwise. */
  twitchLoginResult(): Promise<SendResult>
  logoutTwitch(): Promise<void>
  /** Authenticate YouTube from pasted browser cookies; on success an `auth` event follows. */
  loginYouTube(cookies: string): Promise<SendResult>
  logoutYouTube(): Promise<void>
  /** Choose which of the account's channels to post as (`YouTubeChannel.id`). */
  selectYouTubeChannel(channelId: string): Promise<SendResult>
  /** The right-click actions available on a message for the signed-in account (empty if none). */
  getMessageActions(channelId: string, menuToken: string): Promise<ChatAction[]>
  /** Run one of {@link getMessageActions}'s actions on a message. `timeoutSeconds` sets a timeout's duration. */
  runMessageAction(
    channelId: string,
    menuToken: string,
    actionId: string,
    timeoutSeconds?: number
  ): Promise<SendResult>
  /** Custom emotes (7TV/BTTV/FFZ global + this channel's) for input autocomplete and the picker. */
  getEmotes(channelId: string): Promise<ChannelEmote[]>
  /** A Super Chat's reply thread (the donation first, then its replies) for the reply-thread view. */
  getReplyThread(channelId: string, threadToken: string): Promise<ChatMessage[]>
  /** Platform profile details for the user card (best-effort; undefined when unavailable). */
  getUserProfile(channelId: string, userId: string): Promise<UserProfile | undefined>
  /** Export the moderation watchlist to a JSON file the user picks (to share with other moderators). */
  exportModerationRules(rules: ModerationRule[]): Promise<ModerationExport>
  /** Import a moderation watchlist from a JSON file the user picks; returns the parsed rules. */
  importModerationRules(): Promise<ModerationImport>
  /** Export the pre-ban rules to a JSON file the user picks (to share with other moderators). */
  exportPrebanRules(rules: BanRule[]): Promise<ModerationExport>
  /** Import pre-ban rules from a JSON file the user picks; returns the parsed rules. */
  importPrebanRules(): Promise<PrebanImport>
  /** Open a channel (persisted across restarts). The new column arrives via a `channels` event. */
  addChannel(platform: Platform, target: string): Promise<SendResult>
  /** Discover a YouTube channel's live + waiting-room streams and open each as its own column. */
  addYouTubeStreams(target: string): Promise<AddStreamsResult>
  removeChannel(channelId: string): Promise<void>
  /** The default chat-log directory, shown when none is set. */
  defaultLogDirectory(): Promise<string>
  /** Open a native folder picker for the chat-log directory; resolves to the chosen path or undefined. */
  pickLogDirectory(): Promise<string | undefined>
  /** Reveal the effective chat-log directory in the OS file manager. */
  openLogDirectory(): Promise<void>
  /** The persisted app settings. */
  getSettings(): Promise<AppSettings>
  /** Update one or more settings; returns the merged, persisted result. */
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
}

/** Native window controls + platform, exposed to the renderer for the frameless window chrome. */
export interface WindowControlsApi {
  /** `process.platform`: `'darwin' | 'win32' | 'linux' | …` */
  platform: string
  minimize(): void
  toggleMaximize(): void
  close(): void
}
