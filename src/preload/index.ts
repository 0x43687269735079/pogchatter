import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AddStreamsResult,
  AppSettings,
  AuthState,
  BanRule,
  ChannelEmote,
  ChannelInfo,
  ChatAction,
  ChatApi,
  ChatEvent,
  ChatMessage,
  ModerationExport,
  ModerationImport,
  ModerationRule,
  Platform,
  PrebanImport,
  SendResult,
  TwitchLoginPrompt,
  UserProfile,
  WindowControlsApi
} from '@shared/model'
import { createEventBuffer } from '@preload/eventBuffer'

// Listen from preload time, not first subscription: main starts pushing batches the moment its
// sources connect, which can beat React's mount. The buffer queues those early batches (bounded)
// and drains them into the renderer's callback in order.
const eventBuffer = createEventBuffer()
ipcRenderer.on('chat:events', (_event: IpcRendererEvent, events: ChatEvent[]): void => {
  eventBuffer.deliver(events)
})

const api: ChatApi = {
  onEvents(callback: (events: ChatEvent[]) => void): () => void {
    return eventBuffer.subscribe(callback)
  },
  getBacklog(): Promise<ChatEvent[]> {
    return ipcRenderer.invoke('chat:getBacklog') as Promise<ChatEvent[]>
  },
  listChannels(): Promise<ChannelInfo[]> {
    return ipcRenderer.invoke('chat:listChannels') as Promise<ChannelInfo[]>
  },
  send(channelId: string, text: string, replyTo?: string): Promise<SendResult> {
    // Stamp the click time (Date.now is wall-clock, comparable across processes) as a trailing
    // IPC arg so SEND_DEBUG in main can measure click→handler latency. Not part of the public API.
    return ipcRenderer.invoke(
      'chat:send',
      channelId,
      text,
      replyTo,
      Date.now()
    ) as Promise<SendResult>
  },
  getMessageActions(channelId: string, menuToken: string): Promise<ChatAction[]> {
    return ipcRenderer.invoke('chat:getMessageActions', channelId, menuToken) as Promise<
      ChatAction[]
    >
  },
  runMessageAction(
    channelId: string,
    menuToken: string,
    actionId: string,
    timeoutSeconds?: number
  ): Promise<SendResult> {
    return ipcRenderer.invoke(
      'chat:runMessageAction',
      channelId,
      menuToken,
      actionId,
      timeoutSeconds
    ) as Promise<SendResult>
  },
  getAuthState(): Promise<AuthState> {
    return ipcRenderer.invoke('chat:getAuthState') as Promise<AuthState>
  },
  loginTwitch(): Promise<TwitchLoginPrompt> {
    return ipcRenderer.invoke('chat:loginTwitch') as Promise<TwitchLoginPrompt>
  },
  twitchLoginResult(): Promise<SendResult> {
    return ipcRenderer.invoke('chat:twitchLoginResult') as Promise<SendResult>
  },
  logoutTwitch(): Promise<void> {
    return ipcRenderer.invoke('chat:logoutTwitch') as Promise<void>
  },
  loginYouTube(cookies: string): Promise<SendResult> {
    return ipcRenderer.invoke('chat:loginYouTube', cookies) as Promise<SendResult>
  },
  logoutYouTube(): Promise<void> {
    return ipcRenderer.invoke('chat:logoutYouTube') as Promise<void>
  },
  selectYouTubeChannel(channelId: string): Promise<SendResult> {
    return ipcRenderer.invoke('chat:selectYouTubeChannel', channelId) as Promise<SendResult>
  },
  getEmotes(channelId: string): Promise<ChannelEmote[]> {
    return ipcRenderer.invoke('chat:getEmotes', channelId) as Promise<ChannelEmote[]>
  },
  getReplyThread(channelId: string, threadToken: string): Promise<ChatMessage[]> {
    return ipcRenderer.invoke('chat:getReplyThread', channelId, threadToken) as Promise<
      ChatMessage[]
    >
  },
  getUserProfile(channelId: string, userId: string): Promise<UserProfile | undefined> {
    return ipcRenderer.invoke('chat:getUserProfile', channelId, userId) as Promise<
      UserProfile | undefined
    >
  },
  addChannel(platform: Platform, target: string): Promise<SendResult> {
    return ipcRenderer.invoke('chat:addChannel', platform, target) as Promise<SendResult>
  },
  addYouTubeStreams(target: string): Promise<AddStreamsResult> {
    return ipcRenderer.invoke('chat:addYouTubeStreams', target) as Promise<AddStreamsResult>
  },
  removeChannel(channelId: string): Promise<void> {
    return ipcRenderer.invoke('chat:removeChannel', channelId) as Promise<void>
  },
  defaultLogDirectory(): Promise<string> {
    return ipcRenderer.invoke('chat:defaultLogDir') as Promise<string>
  },
  pickLogDirectory(): Promise<string | undefined> {
    return ipcRenderer.invoke('chat:pickLogDir') as Promise<string | undefined>
  },
  openLogDirectory(): Promise<void> {
    return ipcRenderer.invoke('chat:openLogDir') as Promise<void>
  },
  exportModerationRules(rules: ModerationRule[]): Promise<ModerationExport> {
    return ipcRenderer.invoke('chat:exportModerationRules', rules) as Promise<ModerationExport>
  },
  importModerationRules(): Promise<ModerationImport> {
    return ipcRenderer.invoke('chat:importModerationRules') as Promise<ModerationImport>
  },
  exportPrebanRules(rules: BanRule[]): Promise<ModerationExport> {
    return ipcRenderer.invoke('chat:exportPrebanRules', rules) as Promise<ModerationExport>
  },
  importPrebanRules(): Promise<PrebanImport> {
    return ipcRenderer.invoke('chat:importPrebanRules') as Promise<PrebanImport>
  },
  getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke('chat:getSettings') as Promise<AppSettings>
  },
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return ipcRenderer.invoke('chat:setSettings', patch) as Promise<AppSettings>
  }
}

contextBridge.exposeInMainWorld('chat', api)

const win: WindowControlsApi = {
  platform: process.platform,
  minimize: () => {
    ipcRenderer.send('win:minimize')
  },
  toggleMaximize: () => {
    ipcRenderer.send('win:toggleMaximize')
  },
  close: () => {
    ipcRenderer.send('win:close')
  }
}

contextBridge.exposeInMainWorld('win', win)
