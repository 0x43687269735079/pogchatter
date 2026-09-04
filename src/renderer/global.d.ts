import type { ChatApi, WindowControlsApi } from '@shared/model'

declare global {
  interface Window {
    chat: ChatApi
    win: WindowControlsApi
  }
  /** package.json's version, defined by electron.vite.config.ts at build time. */
  const __APP_VERSION__: string
}

export {}
