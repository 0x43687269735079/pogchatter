import { appendFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, crashReporter, powerSaveBlocker, safeStorage } from 'electron'
import { Innertube, Log } from 'youtubei.js'
import {
  type AuthState,
  type ChatEvent,
  type ChatLogSettings,
  DEFAULT_SETTINGS,
  type Platform,
  type SendResult,
  type TwitchLoginPrompt
} from '@shared/model'
import { AutoMod } from '@main/AutoMod'
import { EventBatcher } from '@main/Batcher'
import { ChatLogger } from '@main/ChatLogger'
import { EventBacklog } from '@main/EventBacklog'
import { ConfigStore } from '@main/ConfigStore'
import { closeDebugLog, debugLog, debugLogEnabled, initDebugLog } from '@main/debugLog'
import { migrateLegacyUserData } from '@main/migrateUserData'
import { SourceManager } from '@main/SourceManager'
import { AuthStore } from '@main/auth/AuthStore'
import { EmoteEngine } from '@main/emotes/EmoteEngine'
import { type ChannelService, registerIpc } from '@main/ipc'
import { isLoopbackRendererUrl } from '@main/net/origin'
import { proxiedFetch, proxyIgnoresCert, proxyUrl } from '@main/net/proxy'
import type { ChatSource } from '@main/sources/ChatSource'
import {
  channelId,
  channelLabel,
  isAcceptableTwitchTarget,
  isAcceptableYouTubeTarget,
  isYouTubeVideoId,
  normalizeTarget
} from '@main/sources/channelId'
import {
  type DiscoveredStream,
  discoverChannelStreams
} from '@main/sources/youtube/discoverStreams'
import { TwitchSource } from '@main/sources/twitch/TwitchSource'
import { TwitchAuthManager } from '@main/sources/twitch/TwitchAuthManager'
import { TwitchBadgeProvider } from '@main/sources/twitch/TwitchBadgeProvider'
import { TwitchCheermoteProvider } from '@main/sources/twitch/TwitchCheermoteProvider'
import { TwitchEmoteProvider } from '@main/sources/twitch/TwitchEmoteProvider'
import { createBrowserIdentity, createPageFetch } from '@main/sources/youtube/browserIdentity'
import { YouTubeAuthManager } from '@main/sources/youtube/YouTubeAuthManager'
import { YouTubeSource } from '@main/sources/youtube/YouTubeSource'
import {
  APP_FILE_PATH,
  applyContentSecurityPolicy,
  createWindow,
  getMainWindow,
  registerWindowControls,
  sendEvents
} from '@main/window'

// Development-only knobs (a local .env, a custom renderer URL, the debug proxy) must not be
// honored in a packaged build: a planted .env or launch-env var could otherwise load an
// attacker renderer or strip TLS off credentialed traffic. Scrub them when packaged; load a
// local .env only in development.
if (app.isPackaged) {
  delete process.env['ELECTRON_RENDERER_URL']
  delete process.env['PROXY_URL']
  delete process.env['PROXY_IGNORE_CERT']
} else {
  try {
    process.loadEnvFile()
  } catch {
    // No .env present — use the ambient environment.
  }
}

// A second instance would double-connect every chat, race this instance's config/auth file
// writes, and run the legacy-userData copy loop concurrently against the same destination
// files. Hand off to the running instance (and skip the migration) instead.
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.quit()
}
app.on('second-instance', () => {
  const mainWindow = getMainWindow()
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
  }
})

// See migrateLegacyUserData: must precede the debug log, ConfigStore, and AuthStore opening
// files in the new directory, and runs only under the single-instance lock.
const migrated = isPrimaryInstance
  ? migrateLegacyUserData(
      app.getPath('userData'),
      join(dirname(app.getPath('userData')), 'youtube-chat-addon')
    )
  : undefined

// `--debug-log` turns on the troubleshooting stream (stdout + <userData>/debug.log) users capture
// from a terminal. Enabled before anything below can emit a line worth keeping.
initDebugLog()

// Keep local minidumps for renderer/GPU native crashes (nothing is uploaded — there is no crash
// backend for these personal builds). A Crashpad dump under <userData>/Crashpad is the only way
// to diagnose a "render-process-gone: crashed" after the fact.
// Minidumps can embed decrypted credentials from process memory — the very data auth.bin's
// encryption protects at rest — so don't let them accumulate: keep a week for diagnostics.
const CRASH_DUMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
function pruneOldCrashDumps(): void {
  for (const subdir of ['completed', 'pending', 'new']) {
    const dumpDir = join(app.getPath('crashDumps'), subdir)
    let entries: string[]
    try {
      entries = readdirSync(dumpDir)
    } catch {
      continue // no dumps yet
    }
    for (const entry of entries) {
      const file = join(dumpDir, entry)
      try {
        if (Date.now() - statSync(file).mtimeMs > CRASH_DUMP_MAX_AGE_MS) {
          rmSync(file, { force: true })
        }
      } catch {
        // Best-effort cleanup — never let it affect startup.
      }
    }
  }
}
crashReporter.start({ uploadToServer: false })
pruneOldCrashDumps()
if (migrated !== undefined) {
  debugLog('app', 'migrated legacy user data', migrated)
}

// Chromium's sandbox broker cannot CreateProcess child processes (GPU, renderers) when the app
// runs from a network/UNC path (crbug.com/103902) — the window never appears. A raw UNC launch is
// the only case detectable without native drive-type calls; a mapped drive letter (Z:\) hits the
// same wall and is caught at runtime by the launch-failed handling in window.ts.
if (process.platform === 'win32' && process.execPath.startsWith('\\\\')) {
  debugLog('app', 'running from a network (UNC) path — child processes will likely fail to start', {
    execPath: process.execPath
  })
}

// youtubei.js logs parser type-mismatch and text-run warnings at WARNING level while parsing
// pages whose layout it doesn't fully model (e.g. watch-next chip clouds). They're non-actionable
// noise for this app; keep ERROR so genuine library failures still surface.
Log.setLevel(Log.Level.ERROR)

// Windows routes renderer Notifications through the shortcut's AppUserModelID; without this the
// moderation/highlight toasts silently never appear in a packaged build. Must match the
// electron-builder appId.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.pogchatter.app')
}

// Last-resort diagnostics: the unofficial YouTube surface means response-shape surprises are a
// matter of when, not if. A stray throw must leave a trace on disk (and keep the app alive)
// instead of silently killing a long-running chat session. Rate-capped against error storms.
let errorLogTimes: number[] = []
function logFatal(kind: string, error: unknown): void {
  const now = Date.now()
  errorLogTimes = errorLogTimes.filter((at) => now - at < 60_000)
  if (errorLogTimes.length >= 10) {
    return
  }
  errorLogTimes.push(now)
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`
  console.error(line.trimEnd())
  debugLog('fatal', kind, { detail })
  try {
    appendFileSync(join(app.getPath('userData'), 'error.log'), line)
  } catch {
    // The error log must never become its own crash source.
  }
}
process.on('uncaughtException', (error) => {
  logFatal('uncaughtException', error)
})
process.on('unhandledRejection', (reason) => {
  logFatal('unhandledRejection', reason)
})

// Every Chromium child-process death (GPU, utility, …) — renderer recovery lives in window.ts;
// this is the diagnostic trail for "the window never appeared" reports. reason 'launch-failed'
// with the app on a network/VM-shared drive means the sandbox broker couldn't spawn the child.
app.on('child-process-gone', (_event, details) => {
  debugLog('app', `child process gone: ${details.type}`, {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    ...(details.name !== undefined ? { name: details.name } : {})
  })
})

// The dev-server URL the window loads in development (the bundled document otherwise). Resolved
// here, after the packaged-build env scrub above, and threaded to the window/IPC trust checks.
const RENDERER_URL = ((): string | undefined => {
  const url = process.env['ELECTRON_RENDERER_URL']
  return url !== undefined && isLoopbackRendererUrl(url) ? url : undefined
})()

// The baked-in public device-code client id, so packaged builds can log in to Twitch without any
// environment setup (a public client carries no secret — the id identifies the app, like
// Chatterino's). TWITCH_CLIENT_ID overrides it for development against another app registration.
const DEFAULT_TWITCH_CLIENT_ID = 'a7zzf30go83ua7ohuhofe2e74wblqc'
const TWITCH_CLIENT_ID = process.env['TWITCH_CLIENT_ID']?.trim() || DEFAULT_TWITCH_CLIENT_ID

// Time the send round-trip (IPC receipt → platform send resolved) to stdout. The renderer logs its
// own round-trip in dev; the difference is IPC overhead. Enable with `POGCHATTER_SEND_DEBUG=1`.
const SEND_DEBUG = process.env['POGCHATTER_SEND_DEBUG'] === '1'

// Env channels seed the config only on first run; after that the in-app list wins.
const TWITCH_CHANNELS = (process.env['TWITCH_CHANNELS'] ?? '')
  .split(',')
  .map((channel) => channel.trim())
  .filter((channel) => channel.length > 0)
const YOUTUBE_CHANNELS = (process.env['YOUTUBE_CHANNELS'] ?? '')
  .split(',')
  .map((target) => target.trim())
  .filter((target) => target.length > 0)

let manager: SourceManager | undefined
let batcher: EventBatcher | undefined
let chatLogger: ChatLogger | undefined
let configStore: ConfigStore | undefined
let authStore: AuthStore | undefined
let authManager: TwitchAuthManager | undefined
let youtubeAuth: YouTubeAuthManager | undefined
let emoteEngine: EmoteEngine | undefined
let channelService: ChannelService | undefined
// Chat-to-disk logging, driven by Settings → Chat logging. When on, every open chat is logged.

/** The app's default chat-log directory, used when the user hasn't set one. */
function defaultLogDir(): string {
  return join(app.getPath('userData'), 'chat-logs')
}

/** The directory logs are written to: the configured one, or the default. */
function effectiveLogDir(): string {
  const dir = configStore?.settings().chatLog.directory.trim()
  return dir !== undefined && dir !== '' ? dir : defaultLogDir()
}

/** (Re)open or close the chat logger from settings. */
function applyChatLog(settings: ChatLogSettings): void {
  if (!settings.enabled) {
    void chatLogger?.close()
    chatLogger = undefined
    return
  }
  const dir = settings.directory.trim() === '' ? defaultLogDir() : settings.directory.trim()
  if (chatLogger === undefined || chatLogger.dir !== dir) {
    void chatLogger?.close()
    chatLogger = new ChatLogger(dir, (path) => {
      console.log(`Chat logging → ${path}`)
    })
  }
}

/** Record an event to the chat log when logging is on (every open chat is logged). */
function recordChatEvent(event: ChatEvent): void {
  if (chatLogger === undefined || (event.kind !== 'message' && event.kind !== 'clear')) {
    return
  }
  chatLogger.record(event)
}

// Message events are far too frequent to log individually (and their text must never reach the
// debug stream); accumulate per-channel counts and flush one `messages` line every 30 seconds.
const debugMessageCounts = new Map<string, number>()
if (debugLogEnabled()) {
  setInterval(() => {
    if (debugMessageCounts.size === 0) {
      return
    }
    debugLog('messages', 'count by channel (last 30s)', Object.fromEntries(debugMessageCounts))
    debugMessageCounts.clear()
  }, 30_000).unref()
}

/** Debug-log one renderer-bound event — everything except per-message details (counted above). */
function debugLogChatEvent(event: ChatEvent): void {
  if (event.kind === 'message') {
    debugMessageCounts.set(event.channelId, (debugMessageCounts.get(event.channelId) ?? 0) + 1)
    return
  }
  if (event.kind === 'replace') {
    debugLog('replace', event.channelId, { id: event.message.id })
    return
  }
  if (event.kind === 'status') {
    const { status } = event
    debugLog('status', event.channelId, {
      state: status.state,
      ...(status.state === 'error' ? { message: status.message } : {}),
      ...('viewers' in status && status.viewers !== undefined ? { viewers: status.viewers } : {}),
      ...('degraded' in status && status.degraded === true ? { degraded: true } : {})
    })
    return
  }
  if (event.kind === 'channels') {
    debugLog('channels', `${event.channels.length} open`, {
      ids: event.channels.map((channel) => channel.id)
    })
    return
  }
  if (event.kind === 'sendRestriction') {
    debugLog('sendRestriction', event.channelId, { reason: event.reason ?? 'cleared' })
    return
  }
  if (event.kind === 'clear') {
    const { messageId, userId } = event.target
    debugLog('clear', event.channelId, {
      ...(messageId !== undefined ? { messageId } : {}),
      ...(userId !== undefined ? { userId } : {}),
      ...(messageId === undefined && userId === undefined ? { wholeChat: true } : {})
    })
    return
  }
  if (event.kind === 'authorUpdate') {
    // Avatar back-fills are routine; one line per resolved author is plenty.
    debugLog('authorUpdate', event.channelId, { login: event.login })
    return
  }
  // Login state, not credentials: booleans, ids, and the storage mode only.
  debugLog('auth', 'state', {
    twitchLoggedIn: event.auth.twitch.loggedIn,
    ...(event.auth.twitch.userName !== undefined
      ? { twitchUserName: event.auth.twitch.userName }
      : {}),
    youtubeLoggedIn: event.auth.youtube.loggedIn,
    ...(event.auth.youtube.selectedChannelId !== undefined
      ? { youtubeChannelId: event.auth.youtube.selectedChannelId }
      : {}),
    // Not named credentialStorage: the defensive key redaction would blank it.
    storage: event.auth.credentialStorage
  })
}

function authState(): AuthState {
  const twitch: AuthState['twitch'] = {
    configured: authManager?.configured ?? false,
    loggedIn: authManager?.isLoggedIn ?? false
  }
  const userName = authManager?.userName
  if (userName !== undefined) {
    twitch.userName = userName
  }
  const youtube: AuthState['youtube'] = {
    loggedIn: youtubeAuth?.isLoggedIn ?? false,
    channels: youtubeAuth?.getChannels() ?? []
  }
  const selectedChannelId = youtubeAuth?.getSelectedId()
  if (selectedChannelId !== undefined) {
    youtube.selectedChannelId = selectedChannelId
  }
  // Optimistic until the store exists (a moment at startup), so the UI doesn't flash a warning.
  const state: AuthState = {
    twitch,
    youtube,
    credentialStorage: authStore?.storageMode() ?? 'encrypted'
  }
  if (process.platform === 'linux') {
    // So the keyring notices can tell an unrecognized desktop (basic_text) from no keyring at
    // all. Linux-only API; called post-ready here, so 'unknown' never reaches the renderer.
    state.linuxKeyringBackend = safeStorage.getSelectedStorageBackend()
  }
  return state
}

function broadcastAuth(): void {
  const event: ChatEvent = { kind: 'auth', auth: authState() }
  if (debugLogEnabled()) {
    debugLogChatEvent(event)
  }
  batcher?.push(event)
}

// The outcome of the most recent device-code login attempt; the renderer awaits it
// (chat:twitchLoginResult) after showing the code, so denials/expiry reach the modal.
let twitchLoginCompletion: Promise<SendResult> = Promise.resolve({ ok: true })

function startTwitchLogin(): Promise<TwitchLoginPrompt> {
  const auth = authManager
  if (auth === undefined) {
    return Promise.resolve({ error: 'Auth is not ready yet' })
  }
  return new Promise((resolve) => {
    let prompted = false
    twitchLoginCompletion = auth
      .login((device) => {
        prompted = true
        resolve({
          userCode: device.user_code,
          verificationUri: device.verification_uri,
          expiresIn: device.expires_in
        })
      })
      .then((): SendResult => ({ ok: true }))
      .catch((error: unknown): SendResult => {
        const message = error instanceof Error ? error.message : String(error)
        if (!prompted) {
          resolve({ error: message })
        }
        return { ok: false, error: message }
      })
  })
}

// Relax Chromium's own backgrounding so a chat renderer keeps rendering when the window is occluded,
// minimized, or hidden — otherwise timers, frames, and network get throttled in the background. On
// Windows and Linux (which have no App Nap) these switches are the whole fix. On macOS they're
// necessary but not sufficient: they tune Chromium's throttling, not macOS App Nap, which suspends
// the whole renderer process (see applyKeepAwake). Must be set before the app is ready.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

let keepAwakeId: number | undefined

/**
 * Hold (or release) a power-management assertion per Settings → "Keep this Mac awake".
 *
 * While held, macOS never puts the app in App Nap. App Nap suspends a backgrounded renderer
 * outright — it stops responding, gets reported as a render-process-gone "crash" the instant the
 * user returns, and a reload then spawns a fresh renderer into the suspended bootstrap context
 * where it can't reach the Mach port rendezvous server and dies too. Per Apple's App Nap
 * heuristics an app is exempt once it takes an IOKit / NSProcessInfo assertion, which is exactly
 * what prevent-app-suspension does — at the cost of also blocking idle sleep, the trade-off the
 * setting exposes (off = the Mac can sleep, and a backgrounded app may gap). macOS only; on other
 * platforms there is no App Nap and the assertion would needlessly block system sleep.
 */
function applyKeepAwake(enabled: boolean): void {
  if (process.platform !== 'darwin') {
    return
  }
  if (enabled) {
    if (keepAwakeId === undefined || !powerSaveBlocker.isStarted(keepAwakeId)) {
      keepAwakeId = powerSaveBlocker.start('prevent-app-suspension')
    }
    return
  }
  if (keepAwakeId !== undefined && powerSaveBlocker.isStarted(keepAwakeId)) {
    powerSaveBlocker.stop(keepAwakeId)
  }
  keepAwakeId = undefined
}

void app
  .whenReady()
  .then(async () => {
    debugLog('app', 'ready', {
      locale: app.getLocale(),
      ...(process.platform === 'linux'
        ? { safeStorageBackend: safeStorage.getSelectedStorageBackend() }
        : {})
    })
    batcher = new EventBatcher(sendEvents)
    // Replay ring so a fresh renderer (startup race, crash-reload) can refill its chat buffers.
    const backlog = new EventBacklog()
    // Created below (it needs the source manager for the action path); the sink guards on it.
    let autoMod: AutoMod | undefined
    const emitEvent = (event: ChatEvent): void => {
      if (debugLogEnabled()) {
        debugLogChatEvent(event)
      }
      recordChatEvent(event)
      backlog.record(event)
      batcher?.push(event)
    }
    const sourceManager = new SourceManager(
      (event) => {
        emitEvent(event)
        // Pre-ban auto-moderation watches the same normalized stream the renderer gets.
        if (event.kind === 'message') {
          void autoMod?.onMessage(event.channelId, event.message)
        }
      },
      // A following column (e.g. a @handle) rolled onto a video that's also open as a standalone
      // column; drop the standalone one (view + persisted config) so the chat isn't duplicated.
      (duplicateChannelId) => {
        void channelService?.remove(duplicateChannelId)
      },
      // The last column using this emote scope was removed; drop its third-party emotes so they
      // stop tokenizing everywhere and the engine stops re-fetching/watching the channel.
      (scope) => {
        emoteEngine?.releaseChannel(scope.platform, scope.channelId)
      }
    )
    manager = sourceManager
    autoMod = new AutoMod({
      settings: () => configStore?.settings().preban ?? DEFAULT_SETTINGS.preban,
      getMessageActions: (channelId, menuToken) =>
        sourceManager.getMessageActions(channelId, menuToken),
      runMessageAction: (channelId, menuToken, actionId) =>
        sourceManager.runMessageAction(channelId, menuToken, actionId),
      emit: emitEvent
    })
    registerIpc({
      manager: sourceManager,
      getTwitchAuth: () => authManager,
      getYouTubeAuth: () => youtubeAuth,
      getEmoteEngine: () => emoteEngine,
      getConfigStore: () => configStore,
      getAuthStore: () => authStore,
      getChannelService: () => channelService,
      getMainWindow,
      authState,
      broadcastAuth,
      backlogSnapshot: () => backlog.snapshot(),
      startTwitchLogin,
      twitchLoginResult: () => twitchLoginCompletion,
      applyChatLog,
      applyKeepAwake,
      defaultLogDir,
      effectiveLogDir,
      rendererUrl: RENDERER_URL,
      appFilePath: APP_FILE_PATH,
      sendDebug: SEND_DEBUG
    })
    registerWindowControls(RENDERER_URL)
    applyContentSecurityPolicy()
    createWindow(RENDERER_URL)

    const proxy = proxyUrl()
    if (proxy !== undefined) {
      console.log(`Routing HTTP through upstream proxy: ${proxy}`)
      // The proxy dispatcher is the *bundled* undici's ProxyAgent driven by Electron's built-in
      // (different-version) fetch — record the pairing so a post-Electron-upgrade total-proxy
      // failure is diagnosable from the log alone.
      debugLog('net', 'proxying built-in fetch through the bundled undici ProxyAgent', {
        proxyUrl: proxy,
        nodeUndici: process.versions['undici'] ?? 'unknown'
      })
      if (proxyIgnoresCert()) {
        console.warn(
          'PROXY_IGNORE_CERT is set: upstream TLS verification is DISABLED. Proxied requests ' +
            '(including YouTube cookies and Twitch tokens) are exposed to the proxy — use only ' +
            'with a trusted local debugging proxy.'
        )
      }
    }

    const config = new ConfigStore()
    configStore = config
    applyChatLog(config.settings().chatLog)
    applyKeepAwake(config.settings().keepAwake)

    const emotes = new EmoteEngine(undefined, () => config.settings().emoteProviders)
    emoteEngine = emotes
    void emotes.loadGlobals().catch(() => {
      // Non-fatal: chat still works with native emotes only.
    })
    // The plaintext fallback (keyring-less Linux) is an explicit, revocable user opt-in.
    const store = new AuthStore(() => config.settings().allowPlaintextCredentials)
    authStore = store
    const identity = createBrowserIdentity()
    const pageFetch = createPageFetch(identity)
    const twitchBadges = new TwitchBadgeProvider()
    const twitchEmotes = new TwitchEmoteProvider()
    const twitchCheermotes = new TwitchCheermoteProvider()

    // Refresh the Twitch native emote catalog (global + this account's usable emotes)
    // into the engine on login, and clear it on logout. Personal emotes need the
    // user:read:emotes scope; a pre-scope login simply yields global emotes only.
    async function loadTwitchEmotes(): Promise<void> {
      const token = await twitchAuth.accessToken()
      const clientId = twitchAuth.clientId
      if (token === undefined || clientId === undefined) {
        emotes.clearTwitch()
        return
      }
      const userId = twitchAuth.userId
      const [global, user] = await Promise.all([
        twitchEmotes.fetchGlobal(token, clientId),
        userId === undefined ? Promise.resolve([]) : twitchEmotes.fetchUser(userId, token, clientId)
      ])
      emotes.setTwitchGlobal([...global, ...user])
    }

    // Load the logged-in account's own 7TV/BTTV/FFZ emotes into the shared library so they
    // (like every added channel's emotes) work in every column, including YouTube chats.
    async function loadUserEmotes(): Promise<void> {
      const userId = twitchAuth.userId
      if (userId === undefined) {
        emotes.clearUserEmotes()
        return
      }
      await emotes.loadUserEmotes('twitch', userId)
    }
    // Persist one durable browser identity (visitor_data) across restarts instead of a
    // fresh random one each boot; capture it from whichever Innertube instance builds first.
    let visitorData = config.visitorData()
    const rememberVisitor = (value: string | undefined): void => {
      if (visitorData === undefined && typeof value === 'string' && value !== '') {
        visitorData = value
        config.setVisitorData(value)
      }
    }

    const twitchAuth = new TwitchAuthManager(TWITCH_CLIENT_ID, store, () => {
      void sourceManager.reconnectByPlatform('twitch')
      // A re-login may restore the moderation permissions whose loss paused auto-mod.
      autoMod?.resetPermanentFailures('twitch')
      broadcastAuth()
      void loadTwitchEmotes()
      void loadUserEmotes()
    })
    authManager = twitchAuth
    // Don't block startup on a token refresh — reading needs no Twitch auth, and the
    // auth provider revalidates on each (re)connect. Refresh in the background.
    void twitchAuth.ensureValid().then(() => {
      broadcastAuth()
      void loadTwitchEmotes()
      void loadUserEmotes()
    })

    // YouTube sending only; reading uses a separate unauthenticated instance so
    // login never interrupts the live-chat readers.
    const ytAuth = new YouTubeAuthManager(
      store,
      identity.userAgent,
      () => visitorData,
      () => {
        // Same as the Twitch path: fresh cookies (or a channel switch) may restore moderation
        // permissions, so auto-mod's per-channel pauses must not outlive the login.
        autoMod?.resetPermanentFailures('youtube')
        broadcastAuth()
      },
      !app.isPackaged
    )
    youtubeAuth = ytAuth
    // Restoring the authed session does network I/O; don't block startup on it
    // (sending is unavailable until it finishes, reading is unaffected).
    void ytAuth.init().then(() => {
      broadcastAuth()
    })

    // The unauthenticated YouTube reader is created lazily on the first YouTube channel.
    let youtubeReader: Promise<Innertube> | undefined
    const createYouTubeReader = async (): Promise<Innertube> => {
      // Reuse the persisted visitor identity across restarts (instead of a fresh random one each
      // boot); capture whatever this instance ends up with for next time.
      // Never enable player retrieval / session caching / OAuth here without an explicit cache
      // directory under userData: youtubei.js's default cache path resolves inside app.asar
      // (read-only), so it works in dev but crashes every packaged build on first write.
      const yt = await Innertube.create({
        user_agent: identity.userAgent,
        retrieve_player: false,
        fetch: proxiedFetch,
        ...(visitorData !== undefined ? { visitor_data: visitorData } : {})
      })
      rememberVisitor(yt.session.context.client.visitorData)
      return yt
    }
    const getYouTubeReader = (): Promise<Innertube> => {
      if (youtubeReader === undefined) {
        // Reset the cache on failure so one transient error doesn't poison every later YouTube add.
        youtubeReader = createYouTubeReader().catch((error: unknown) => {
          youtubeReader = undefined
          throw error
        })
      }
      return youtubeReader
    }

    const makeSource = (platform: Platform, target: string): ChatSource => {
      if (platform === 'youtube') {
        // Pass the reader factory, not an awaited instance: YouTubeSource acquires it
        // inside connect(), so creating a YouTube channel never blocks add()/restore.
        return new YouTubeSource(target, getYouTubeReader, pageFetch, emotes, ytAuth)
      }
      return new TwitchSource(target, emotes, twitchAuth, {
        badges: twitchBadges,
        emotes: twitchEmotes,
        cheermotes: twitchCheermotes
      })
    }

    channelService = {
      async add(platform, target, label) {
        const trimmed = target.trim()
        if (trimmed === '') {
          return { ok: false, error: 'Enter a channel name' }
        }
        if (platform === 'youtube' && !isAcceptableYouTubeTarget(trimmed)) {
          return { ok: false, error: 'Enter a YouTube @handle, channel/video URL, or video id' }
        }
        if (platform === 'twitch' && !isAcceptableTwitchTarget(trimmed)) {
          return { ok: false, error: 'Enter a Twitch channel name or twitch.tv URL' }
        }
        const id = channelId(platform, trimmed)
        if (sourceManager.has(id)) {
          return { ok: false, error: 'That channel is already open' }
        }
        // A follower column (@handle / channel URL) may already be reading this exact video;
        // adding it would only flash a column that the resolved-video dedupe removes again.
        const normalized = normalizeTarget(platform, trimmed)
        if (
          platform === 'youtube' &&
          isYouTubeVideoId(normalized) &&
          sourceManager.youtubeVideoIds().has(normalized)
        ) {
          return { ok: false, error: "That video's chat is already open in another column" }
        }
        try {
          await sourceManager.add(
            makeSource(platform, trimmed),
            label ?? channelLabel(platform, trimmed)
          )
          config.addChannel({
            platform,
            target: trimmed,
            id,
            ...(label !== undefined && { label })
          })
          return { ok: true }
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : `Failed to add ${platform} channel`
          }
        }
      },
      async addYouTubeStreams(target) {
        const trimmed = target.trim()
        if (trimmed === '' || !isAcceptableYouTubeTarget(trimmed)) {
          return { ok: false, error: 'Enter a YouTube @handle or channel URL' }
        }
        if (isYouTubeVideoId(normalizeTarget('youtube', trimmed))) {
          return { ok: false, error: 'Add all streams needs a channel @handle or URL, not a video' }
        }
        let reader: Innertube
        try {
          reader = await getYouTubeReader()
        } catch {
          return { ok: false, error: 'Could not reach YouTube' }
        }
        let streams: DiscoveredStream[]
        try {
          streams = await discoverChannelStreams(reader, trimmed)
        } catch {
          return { ok: false, error: "Couldn't load the channel's streams — try again" }
        }
        // Skip streams already open — including the one a `@handle` column has resolved to, so
        // adding a channel's streams next to its handle column doesn't duplicate the live chat.
        const open = sourceManager.youtubeVideoIds()
        let added = 0
        for (const stream of streams) {
          if (open.has(stream.videoId)) {
            continue
          }
          const result = await channelService?.add('youtube', stream.videoId, stream.title)
          if (result?.ok === true) {
            added += 1
            open.add(stream.videoId)
          }
        }
        return { ok: true, added, total: streams.length }
      },
      async remove(channelId) {
        await sourceManager.remove(channelId)
        config.removeChannel(channelId)
      }
    }

    // Restore persisted channels; seed from env only the very first run.
    const initial: Array<{ platform: Platform; target: string; label?: string }> = config.firstRun
      ? [
          ...TWITCH_CHANNELS.map((target) => ({ platform: 'twitch' as Platform, target })),
          ...YOUTUBE_CHANNELS.map((target) => ({ platform: 'youtube' as Platform, target }))
        ]
      : config.channels().map((channel) => ({
          platform: channel.platform,
          target: channel.target,
          label: channel.label
        }))
    for (const channel of initial) {
      await channelService.add(channel.platform, channel.target, channel.label)
    }

    broadcastAuth()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(RENDERER_URL)
      }
    })
  })
  .catch((error: unknown) => {
    console.error('Failed to start application:', error)
    app.quit()
  })

app.on('window-all-closed', () => {
  debugLog('app', 'window-all-closed')
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Teardown is async (source disconnects); hold the quit until it finishes — capped so a hung
// socket can never trap the user in a zombie process.
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) {
    return
  }
  quitting = true
  event.preventDefault()
  debugLog('app', 'quitting')
  batcher?.dispose()
  // close() resolves when the log's WriteStream has flushed; include it in the shutdown race
  // so tail writes reach disk before the forced app.exit below can terminate the process.
  const logFlushed = chatLogger?.close() ?? Promise.resolve()
  const disposed = (manager?.disposeAll() ?? Promise.resolve()).catch((error: unknown) => {
    console.error('Error during shutdown:', error)
  })
  void Promise.race([
    Promise.all([disposed, logFlushed]).then(
      () => 'completed',
      () => 'failed'
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('2s timeout'), 2000))
  ]).then((outcome) => {
    debugLog('app', 'shutdown teardown settled', { outcome })
    debugLog('app', 're-invoking app.quit()')
    // After the chat-log close above, so shutdown debug lines flush with everything else.
    closeDebugLog()
    app.quit()
    // A SIGTERM-initiated quit can swallow the deferred re-quit (Chromium's signal shutdown and
    // this handler race); if the graceful path didn't take, stop waiting and exit outright.
    setTimeout(() => {
      // stdout only — closeDebugLog already ended the file stream.
      debugLog('app', 'graceful quit did not exit — forcing app.exit(0)')
      app.exit(0)
    }, 1500)
  })
})

// Quit-path tracing for "the process never exits" reports: together with the lines above these
// bracket where a hang sits. Both fire after closeDebugLog, so they reach stdout only.
app.on('will-quit', () => {
  debugLog('app', 'will-quit')
})
app.on('quit', () => {
  debugLog('app', 'quit')
})
