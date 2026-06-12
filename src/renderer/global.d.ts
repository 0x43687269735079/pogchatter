import type { ChatApi, WindowControlsApi } from '@shared/model'

declare global {
  interface Window {
    chat: ChatApi
    win: WindowControlsApi
  }
}

export {}
