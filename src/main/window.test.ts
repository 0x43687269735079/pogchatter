import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@build/icon.png?asset', () => ({ default: 'icon.png' }))

// Fake just enough of Electron for createWindow: a BrowserWindow that records its event
// handlers so tests can fire renderer crashes, plus spyable dialog/app endpoints.
const electron = vi.hoisted(() => {
  class FakeWebContents {
    handlers = new Map<string, (...args: unknown[]) => void>()
    on(event: string, fn: (...args: unknown[]) => void): void {
      this.handlers.set(event, fn)
    }
    setWindowOpenHandler(): void {}
  }
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    webContents = new FakeWebContents()
    reload = vi.fn()
    show = vi.fn()
    loadURL = vi.fn().mockResolvedValue(undefined)
    loadFile = vi.fn().mockResolvedValue(undefined)
    focused = true
    #handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    constructor() {
      FakeBrowserWindow.instances.push(this)
    }
    on(event: string, fn: (...args: unknown[]) => void): void {
      this.#add(event, fn)
    }
    once(event: string, fn: (...args: unknown[]) => void): void {
      this.#add(event, fn)
    }
    removeListener(event: string, fn: (...args: unknown[]) => void): void {
      const list = this.#handlers.get(event) ?? []
      this.#handlers.set(
        event,
        list.filter((handler) => handler !== fn)
      )
    }
    emit(event: string): void {
      const handlers = this.#handlers.get(event) ?? []
      for (const handler of handlers.slice()) {
        handler()
      }
    }
    isDestroyed(): boolean {
      return false
    }
    isFocused(): boolean {
      return this.focused
    }
    #add(event: string, fn: (...args: unknown[]) => void): void {
      const list = this.#handlers.get(event) ?? []
      list.push(fn)
      this.#handlers.set(event, list)
    }
  }
  return {
    FakeBrowserWindow,
    quit: vi.fn(),
    showErrorBox: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    quit: electron.quit,
    commandLine: { hasSwitch: () => false },
    getPath: () => '/tmp'
  },
  BrowserWindow: electron.FakeBrowserWindow,
  dialog: { showErrorBox: electron.showErrorBox },
  ipcMain: { on: vi.fn() },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } }
}))

import { createWindow } from '@main/window'

type Fake = InstanceType<(typeof electron)['FakeBrowserWindow']>

function openWindow(options: { shown?: boolean } = {}): {
  win: Fake
  crash: (reason: string) => void
} {
  createWindow(undefined)
  const win = electron.FakeBrowserWindow.instances.at(-1)
  if (win === undefined) {
    throw new Error('createWindow did not construct a BrowserWindow')
  }
  const handler = win.webContents.handlers.get('render-process-gone')
  if (handler === undefined) {
    throw new Error('createWindow did not subscribe to render-process-gone')
  }
  // The common case: the renderer painted once and the window has been shown. Tests for the
  // first-launch "renderer never started" state pass shown: false.
  if (options.shown !== false) {
    win.emit('ready-to-show')
  }
  return { win, crash: (reason) => handler({}, { reason }) }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  electron.quit.mockClear()
  electron.showErrorBox.mockClear()
  electron.FakeBrowserWindow.instances.length = 0
})

describe('renderer launch-failed recovery', () => {
  it('retries a transient launch failure instead of quitting the whole app', () => {
    const { win, crash } = openWindow()

    crash('launch-failed')

    expect(win.reload).toHaveBeenCalledTimes(1)
    expect(electron.showErrorBox).not.toHaveBeenCalled()
    expect(electron.quit).not.toHaveBeenCalled()
  })

  it('fails loudly (dialog + quit) only once the reload cap is exhausted', () => {
    const { win, crash } = openWindow()

    crash('launch-failed')
    crash('launch-failed')
    crash('launch-failed')
    expect(win.reload).toHaveBeenCalledTimes(3)
    expect(electron.quit).not.toHaveBeenCalled()

    crash('launch-failed') // a genuinely permanent cause fails on every retry
    expect(win.reload).toHaveBeenCalledTimes(3)
    expect(electron.showErrorBox).toHaveBeenCalledTimes(1)
    expect(electron.quit).toHaveBeenCalledTimes(1)
  })

  it('defers a launch-failed reload until the window regains focus (App Nap wake races)', () => {
    const { win, crash } = openWindow()
    win.focused = false

    crash('launch-failed')
    expect(win.reload).not.toHaveBeenCalled()
    expect(electron.quit).not.toHaveBeenCalled()

    win.emit('focus')
    expect(win.reload).toHaveBeenCalledTimes(1)
  })

  it('ignores a clean renderer exit', () => {
    const { win, crash } = openWindow()

    crash('clean-exit')

    expect(win.reload).not.toHaveBeenCalled()
    expect(electron.quit).not.toHaveBeenCalled()
  })

  it('fails loudly right away when the very first renderer never launches (window never shown)', () => {
    // First launch from a UNC path / after antivirus quarantine: show:false, 'ready-to-show'
    // never fires (it needs a renderer to paint), so 'focus'/'show' can never arrive — deferring
    // would leave an invisible process forever.
    const { win, crash } = openWindow({ shown: false })
    win.focused = false

    crash('launch-failed')

    expect(win.reload).not.toHaveBeenCalled()
    expect(electron.showErrorBox).toHaveBeenCalledTimes(1)
    expect(electron.quit).toHaveBeenCalledTimes(1)
  })

  it('reloads a pre-show crash immediately instead of waiting for a focus that can never come', () => {
    const { win, crash } = openWindow({ shown: false })
    win.focused = false

    crash('crashed')

    expect(win.reload).toHaveBeenCalledTimes(1)
    expect(electron.quit).not.toHaveBeenCalled()
  })
})
