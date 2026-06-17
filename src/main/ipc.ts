import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  type AddStreamsResult,
  type AppSettings,
  type AuthState,
  type BanRule,
  type ChannelEmote,
  type ChatEvent,
  type ChatLogSettings,
  DEFAULT_SETTINGS,
  type ModerationExport,
  type ModerationImport,
  type ModerationRule,
  type Platform,
  type PrebanImport,
  type SendResult,
  type TwitchLoginPrompt
} from '@shared/model'
import { type ConfigStore, sanitizeBanRule, sanitizeModerationRule } from '@main/ConfigStore'
import { debugLog, debugLogEnabled } from '@main/debugLog'
import type { SourceManager } from '@main/SourceManager'
import type { AuthStore } from '@main/auth/AuthStore'
import type { EmoteEngine } from '@main/emotes/EmoteEngine'
import { isTrustedRendererUrl } from '@main/net/origin'
import { isPlatform } from '@main/sources/channelId'
import type { TwitchAuthManager } from '@main/sources/twitch/TwitchAuthManager'
import type { YouTubeAuthManager } from '@main/sources/youtube/YouTubeAuthManager'

/** Adds/removes chat columns and persists the channel list (implemented by the composition root). */
export interface ChannelService {
  add(platform: Platform, target: string, label?: string): Promise<SendResult>
  addYouTubeStreams(target: string): Promise<AddStreamsResult>
  remove(channelId: string): Promise<void>
}

/**
 * Everything the chat IPC surface needs, threaded in explicitly so handlers never reach for
 * module globals. Most services are wired after registration (the renderer can invoke handlers
 * before bootstrap finishes), so they're read through getters that may return undefined — each
 * handler already answers "not ready yet" gracefully.
 */
export interface IpcDeps {
  manager: SourceManager
  getTwitchAuth(): TwitchAuthManager | undefined
  getYouTubeAuth(): YouTubeAuthManager | undefined
  getEmoteEngine(): EmoteEngine | undefined
  getConfigStore(): ConfigStore | undefined
  getAuthStore(): AuthStore | undefined
  getChannelService(): ChannelService | undefined
  getMainWindow(): BrowserWindow | undefined
  /** A snapshot of both platforms' login state for the renderer. */
  authState(): AuthState
  /** Push an auth snapshot to the renderer through the event batcher. */
  broadcastAuth(): void
  /** The retained chat history, replayed into a fresh renderer (startup race, crash-reload). */
  backlogSnapshot(): ChatEvent[]
  /** Start the Twitch device-code login and resolve with the code prompt (or an error). */
  startTwitchLogin(): Promise<TwitchLoginPrompt>
  /** Resolve when the pending device-code login finishes: ok on success, the failure otherwise. */
  twitchLoginResult(): Promise<SendResult>
  /** (Re)open or close the chat logger from settings. */
  applyChatLog(settings: ChatLogSettings): void
  /** Hold or release the macOS keep-awake power assertion per the setting. */
  applyKeepAwake(enabled: boolean): void
  /** The app's default chat-log directory, used when the user hasn't set one. */
  defaultLogDir(): string
  /** The directory logs are written to: the configured one, or the default. */
  effectiveLogDir(): string
  /** Trusted-sender inputs: the dev loopback renderer URL (if any) and the bundled document. */
  rendererUrl: string | undefined
  appFilePath: string
  /** POGCHATTER_SEND_DEBUG: time the send round-trip (IPC receipt → platform send resolved). */
  sendDebug: boolean
}

export function registerIpc(deps: IpcDeps): void {
  const { manager: activeManager, rendererUrl, appFilePath, sendDebug } = deps
  // Only the trusted app renderer may invoke IPC. With the navigation lockdown this is
  // belt-and-suspenders, but it ensures any unexpected page can never drive chat or auth.
  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedRendererUrl(event.senderFrame?.url, rendererUrl, appFilePath)) {
        return undefined
      }
      return listener(event, ...args)
    })
  }

  handle('chat:listChannels', () => activeManager.list())
  handle('chat:getBacklog', () => deps.backlogSnapshot())
  handle('chat:send', async (_event, channelId, text, replyTo, clientTime): Promise<SendResult> => {
    if (
      typeof channelId !== 'string' ||
      typeof text !== 'string' ||
      (replyTo !== undefined && typeof replyTo !== 'string')
    ) {
      return { ok: false, error: 'Invalid send request' }
    }
    if (sendDebug && typeof clientTime === 'number') {
      // Click (preload stamp) → this handler: IPC transit + renderer event handling.
      console.log(`[send] ${channelId}: click→main ${Date.now() - clientTime}ms`)
    }
    const startedAt = sendDebug || debugLogEnabled() ? performance.now() : 0
    try {
      await activeManager.send(channelId, text, replyTo)
      if (sendDebug) {
        console.log(`[send] ${channelId}: ok in ${Math.round(performance.now() - startedAt)}ms`)
      }
      if (debugLogEnabled()) {
        // The length, never the text: enough to correlate with platform-side rejections.
        debugLog('send', 'ok', {
          channelId,
          textLength: text.length,
          ms: Math.round(performance.now() - startedAt)
        })
      }
      return { ok: true }
    } catch (error) {
      if (sendDebug) {
        console.log(`[send] ${channelId}: failed in ${Math.round(performance.now() - startedAt)}ms`)
      }
      const message = error instanceof Error ? error.message : 'Failed to send message'
      if (debugLogEnabled()) {
        debugLog('send', 'failed', {
          channelId,
          textLength: text.length,
          ms: Math.round(performance.now() - startedAt),
          error: message
        })
      }
      return { ok: false, error: message }
    }
  })
  handle('chat:getMessageActions', (_event, channelId, menuToken) => {
    if (typeof channelId !== 'string' || typeof menuToken !== 'string') {
      return Promise.resolve([])
    }
    return activeManager.getMessageActions(channelId, menuToken)
  })
  handle(
    'chat:runMessageAction',
    async (_event, channelId, menuToken, actionId, timeoutSeconds): Promise<SendResult> => {
      if (
        typeof channelId !== 'string' ||
        typeof menuToken !== 'string' ||
        typeof actionId !== 'string'
      ) {
        return { ok: false, error: 'Invalid action request' }
      }
      const seconds = typeof timeoutSeconds === 'number' ? timeoutSeconds : undefined
      try {
        await activeManager.runMessageAction(channelId, menuToken, actionId, seconds)
        debugLog('action', 'ok', {
          channelId,
          actionId,
          ...(seconds !== undefined ? { timeoutSeconds: seconds } : {})
        })
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Action failed'
        debugLog('action', 'failed', {
          channelId,
          actionId,
          ...(seconds !== undefined ? { timeoutSeconds: seconds } : {}),
          error: message
        })
        return { ok: false, error: message }
      }
    }
  )
  handle('chat:runHeldAction', async (_event, channelId, token): Promise<SendResult> => {
    if (typeof channelId !== 'string' || typeof token !== 'string') {
      return { ok: false, error: 'Invalid action request' }
    }
    try {
      await activeManager.runHeldAction(channelId, token)
      debugLog('action', 'held ok', { channelId })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Action failed'
      debugLog('action', 'held failed', { channelId, error: message })
      return { ok: false, error: message }
    }
  })
  handle('chat:getAuthState', () => deps.authState())
  handle('chat:loginTwitch', async (): Promise<TwitchLoginPrompt> => {
    debugLog('login', 'twitch start')
    const prompt = await deps.startTwitchLogin()
    if ('error' in prompt) {
      debugLog('login', 'twitch prompt failed', { error: prompt.error })
    } else {
      debugLog('login', 'twitch device code prompted')
    }
    return prompt
  })
  handle('chat:twitchLoginResult', async (): Promise<SendResult> => {
    const result = await deps.twitchLoginResult()
    if (result.ok) {
      debugLog('login', 'twitch ok')
    } else {
      debugLog('login', 'twitch failed', { error: result.error })
    }
    return result
  })
  handle('chat:logoutTwitch', () => {
    debugLog('login', 'twitch logout')
    deps.getTwitchAuth()?.logout()
  })
  handle('chat:loginYouTube', async (_event, cookies): Promise<SendResult> => {
    // The cookies argument is the credential itself — only the outcome may be logged.
    debugLog('login', 'youtube start')
    const youtubeAuth = deps.getYouTubeAuth()
    if (youtubeAuth === undefined) {
      debugLog('login', 'youtube failed', { error: 'auth not ready yet' })
      return { ok: false, error: 'YouTube auth is not ready yet' }
    }
    if (typeof cookies !== 'string') {
      debugLog('login', 'youtube failed', { error: 'invalid cookies argument' })
      return { ok: false, error: 'Invalid cookies' }
    }
    try {
      await youtubeAuth.setCookies(cookies)
      activeManager.refreshSendability('youtube')
      debugLog('login', 'youtube ok')
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'YouTube login failed'
      debugLog('login', 'youtube failed', { error: message })
      return { ok: false, error: message }
    }
  })
  handle('chat:logoutYouTube', () => {
    debugLog('login', 'youtube logout')
    deps.getYouTubeAuth()?.logout()
    activeManager.refreshSendability('youtube')
  })
  handle('chat:selectYouTubeChannel', async (_event, channelId): Promise<SendResult> => {
    const youtubeAuth = deps.getYouTubeAuth()
    if (youtubeAuth === undefined) {
      return { ok: false, error: 'YouTube auth is not ready yet' }
    }
    if (typeof channelId !== 'string') {
      return { ok: false, error: 'Invalid channel' }
    }
    try {
      await youtubeAuth.selectChannel(channelId)
      // The new identity may have different chat access (e.g. a brand channel that is a member).
      activeManager.refreshSendability('youtube')
      debugLog('login', 'youtube channel selected', { channelId })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to switch channel'
      debugLog('login', 'youtube channel select failed', { channelId, error: message })
      return { ok: false, error: message }
    }
  })
  handle('chat:getEmotes', (_event, channelId): ChannelEmote[] => {
    const emoteEngine = deps.getEmoteEngine()
    if (typeof channelId !== 'string' || emoteEngine === undefined) {
      return []
    }
    const scope = activeManager.emoteScope(channelId)
    return emoteEngine.list(scope).map((emote) => ({
      code: emote.code,
      url: emote.url,
      provider: emote.provider,
      animated: emote.animated,
      scope: emote.scope
    }))
  })
  handle('chat:getReplyThread', (_event, channelId, threadToken) => {
    if (typeof channelId !== 'string' || typeof threadToken !== 'string') {
      return Promise.resolve([])
    }
    return activeManager.getReplyThread(channelId, threadToken)
  })
  handle('chat:getUserProfile', async (_event, channelId, userId) => {
    if (typeof channelId !== 'string' || typeof userId !== 'string') {
      return undefined
    }
    try {
      return await activeManager.getUserProfile(channelId, userId)
    } catch {
      // Best-effort: the card renders without the platform extras.
      return undefined
    }
  })
  handle('chat:addChannel', (_event, platform, target): Promise<SendResult> => {
    if (!isPlatform(platform) || typeof target !== 'string') {
      return Promise.resolve({ ok: false, error: 'Invalid channel request' })
    }
    return (
      deps.getChannelService()?.add(platform, target) ??
      Promise.resolve({ ok: false, error: 'Not ready yet' })
    )
  })
  handle('chat:addYouTubeStreams', (_event, target): Promise<AddStreamsResult> => {
    if (typeof target !== 'string') {
      return Promise.resolve({ ok: false, error: 'Invalid channel request' })
    }
    return (
      deps.getChannelService()?.addYouTubeStreams(target) ??
      Promise.resolve({ ok: false, error: 'Not ready yet' })
    )
  })
  handle('chat:removeChannel', async (_event, channelId) => {
    if (typeof channelId === 'string') {
      await deps.getChannelService()?.remove(channelId)
    }
  })
  handle(
    'chat:getSettings',
    (): AppSettings => deps.getConfigStore()?.settings() ?? DEFAULT_SETTINGS
  )
  handle('chat:setSettings', (_event, patch): AppSettings => {
    const configStore = deps.getConfigStore()
    if (configStore === undefined || typeof patch !== 'object' || patch === null) {
      return configStore?.settings() ?? DEFAULT_SETTINGS
    }
    const merged = configStore.setSettings(patch as Partial<AppSettings>)
    deps.applyChatLog(merged.chatLog)
    deps.applyKeepAwake(merged.keepAwake)
    if ('emoteProviders' in patch) {
      // Drop/re-fetch third-party emotes and stop/restart the 7TV socket to match the toggles.
      void deps.getEmoteEngine()?.applyProviderSettings()
    }
    if ('allowPlaintextCredentials' in patch) {
      // Apply the new policy now (write or scrub the plaintext store) and tell the UI.
      deps.getAuthStore()?.refreshPersistence()
      deps.broadcastAuth()
    }
    return merged
  })
  handle('chat:defaultLogDir', (): string => deps.defaultLogDir())
  handle('chat:pickLogDir', async (): Promise<string | undefined> => {
    const mainWindow = deps.getMainWindow()
    if (mainWindow === undefined) {
      return undefined
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose chat-log folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? undefined : result.filePaths[0]
  })
  handle('chat:openLogDir', async (): Promise<void> => {
    const dir = deps.effectiveLogDir()
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // openPath surfaces the failure to the user; nothing else to do here.
    }
    await shell.openPath(dir)
  })
  handle('chat:exportModerationRules', async (_event, rules): Promise<ModerationExport> => {
    const mainWindow = deps.getMainWindow()
    if (mainWindow === undefined) {
      return { canceled: true }
    }
    const clean = sanitizeRules(rules)
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export moderation rules',
      defaultPath: 'moderation-rules.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || result.filePath === undefined) {
      return { canceled: true }
    }
    try {
      writeFileSync(result.filePath, JSON.stringify({ version: 1, rules: clean }, null, 2))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Failed to write file' }
    }
  })
  handle('chat:importModerationRules', async (): Promise<ModerationImport> => {
    const mainWindow = deps.getMainWindow()
    if (mainWindow === undefined) {
      return { canceled: true }
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import moderation rules',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    const path = result.filePaths[0]
    if (result.canceled || path === undefined) {
      return { canceled: true }
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      const list = Array.isArray(parsed) ? parsed : (parsed as { rules?: unknown })?.rules
      if (!Array.isArray(list)) {
        return { ok: false, error: 'That file is not a moderation rules export.' }
      }
      return { ok: true, rules: sanitizeRules(list) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Failed to read file' }
    }
  })
  handle('chat:exportPrebanRules', async (_event, rules): Promise<ModerationExport> => {
    const mainWindow = deps.getMainWindow()
    if (mainWindow === undefined) {
      return { canceled: true }
    }
    const clean = sanitizeBanRules(rules)
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export pre-ban rules',
      defaultPath: 'preban-rules.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || result.filePath === undefined) {
      return { canceled: true }
    }
    try {
      writeFileSync(
        result.filePath,
        // The `kind` marker distinguishes this file from the watchlist export, so a watchlist
        // can never be imported as ban rules by mistake (bans are destructive; flags aren't).
        JSON.stringify({ version: 1, kind: PREBAN_FILE_KIND, rules: clean }, null, 2)
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Failed to write file' }
    }
  })
  handle('chat:importPrebanRules', async (): Promise<PrebanImport> => {
    const mainWindow = deps.getMainWindow()
    if (mainWindow === undefined) {
      return { canceled: true }
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import pre-ban rules',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    const path = result.filePaths[0]
    if (result.canceled || path === undefined) {
      return { canceled: true }
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        kind?: unknown
        rules?: unknown
      }
      // Require the marker: importing some other rules file (e.g. the flag watchlist) as a list
      // of users to BAN must fail loudly, not half-work.
      if (parsed?.kind !== PREBAN_FILE_KIND || !Array.isArray(parsed.rules)) {
        return { ok: false, error: 'That file is not a pre-ban rules export.' }
      }
      return { ok: true, rules: sanitizeBanRules(parsed.rules) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Failed to read file' }
    }
  })
}

/** File marker for pre-ban exports (see the export handler). */
const PREBAN_FILE_KIND = 'pogchatter-preban'

/** Keep only well-formed pre-ban rules from untrusted input (a file or the renderer). */
function sanitizeBanRules(value: unknown): BanRule[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map(sanitizeBanRule).filter((rule): rule is BanRule => rule !== undefined)
}

/** Keep only well-formed moderation rules from untrusted input (a file or the renderer). */
function sanitizeRules(value: unknown): ModerationRule[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map(sanitizeModerationRule)
    .filter((rule): rule is ModerationRule => rule !== undefined)
}
