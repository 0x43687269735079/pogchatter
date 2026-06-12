import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainEvent } from 'electron'
import type { ChatEvent } from '@shared/model'
import { debugLog, debugLogPath } from '@main/debugLog'
import { isTrustedRendererUrl } from '@main/net/origin'
import linuxIcon from '@build/icon.png?asset'

const moduleDir = dirname(fileURLToPath(import.meta.url))

// The bundled renderer document. Used to load the renderer and to lock navigation/IPC to the
// app's own page (alongside the dev loopback URL the composition root resolves).
export const APP_FILE_PATH = join(moduleDir, '../renderer/index.html')

// Content-Security-Policy for the renderer. The renderer makes no network requests of its
// own (data arrives over IPC; only images load remotely), so the production policy is tight.
// Dev relaxes script/connect to accommodate Vite HMR (inline + eval scripts, websocket).
const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  // data: because electron-vite inlines small bundled fonts (JetBrains Mono woffs) as data:
  // URIs; without it the packaged app silently falls back off its monospace font. A data: font
  // is inert, locally-bundled content — it can't exfiltrate anything.
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'"
].join('; ')

const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  // Same data: font allowance as PROD_CSP (the bundler inlines small fonts as data: URIs).
  "font-src 'self' data:",
  "connect-src 'self' ws: http: https:",
  "object-src 'none'"
].join('; ')

let mainWindow: BrowserWindow | undefined

/** The app window, if one is open and not destroyed yet. */
export function getMainWindow(): BrowserWindow | undefined {
  return mainWindow
}

export function applyContentSecurityPolicy(): void {
  const csp = app.isPackaged ? PROD_CSP : DEV_CSP
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders ?? {}
    if (details.resourceType === 'mainFrame') {
      responseHeaders['Content-Security-Policy'] = [csp]
    }
    callback({ responseHeaders })
  })
}

export function createWindow(rendererUrl: string | undefined): void {
  // Frameless with custom-drawn controls for the TUI aesthetic. macOS keeps the native
  // traffic lights (inset) via 'hiddenInset'; Windows/Linux are fully frameless and draw
  // their own min/max/close buttons in the renderer.
  const platformChrome: Electron.BrowserWindowConstructorOptions =
    process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 13 } }
      : { frame: false }
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 480,
    minHeight: 360,
    backgroundColor: '#242933',
    show: false,
    // Linux windows carry no binary-embedded icon (unlike the exe/.app), so taskbar/alt-tab
    // would show the stock Electron icon whenever the AppImage isn't desktop-integrated.
    // Windows/macOS take theirs from the packaged binary.
    ...(process.platform === 'linux' ? { icon: linuxIcon } : {}),
    ...platformChrome,
    webPreferences: {
      preload: join(moduleDir, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // A chat client must keep rendering while backgrounded; don't let Chromium throttle the
      // renderer's timers when the window is occluded or hidden.
      backgroundThrottling: false
    }
  })

  // 'ready-to-show' needs a renderer to paint, so a window whose renderer never launched stays
  // hidden forever — the crash handling below must know whether 'focus'/'show' can ever fire.
  let shownOnce = false
  window.on('ready-to-show', () => {
    shownOnce = true
    window.show()
  })

  // The renderer's own warnings/errors are invisible in a packaged build (no DevTools open);
  // surface them in the debug stream so a user's terminal capture includes them.
  window.webContents.on('console-message', (event) => {
    if (event.level !== 'warning' && event.level !== 'error') {
      return
    }
    debugLog('renderer', `console ${event.level}: ${event.message}`, {
      source: `${event.sourceId}:${event.lineNumber}`
    })
  })
  window.webContents.on('did-finish-load', () => {
    debugLog('renderer', 'loaded')
  })

  // Drop the reference once the window is gone so late events (e.g. source
  // teardown on quit) don't post to a destroyed webContents.
  window.on('closed', () => {
    mainWindow = undefined
  })

  // Recover from a renderer crash instead of leaving a dead window: reload the page so it
  // re-subscribes and refetches state. Capped so a renderer that crashes on load can't hot-loop.
  let crashReloads = 0
  let lastCrashAt = 0
  let reloadQueued = false

  // The unrecoverable end state: explain and quit instead of lingering as an invisible process
  // (the window may never have shown — showErrorBox is the one dialog that works without one).
  // The known unrecoverable causes are environmental, so the message names them for the user.
  const failLoudly = (reason: string): void => {
    console.error(`Renderer gone (${reason}) — unrecoverable, quitting`)
    debugLog('renderer', 'unrecoverable — showing error and quitting', { reason })
    const logPath = debugLogPath()
    const knownCauses =
      process.platform === 'win32'
        ? 'Two known causes on Windows:\n\n' +
          '• The app is running from a network or VM-shared drive. Copy the app folder to a ' +
          'local drive (for example C:\\) and run it from there.\n\n' +
          '• Antivirus removed or blocked parts of the app. Check Windows Security → ' +
          'Protection history, restore anything quarantined, then reinstall.'
        : 'Try restarting the app; if it keeps failing, reinstall it.'
    dialog.showErrorBox(
      'Pogchatter cannot display its window',
      'The chat window’s process failed to start, and reloading did not fix it.\n\n' +
        knownCauses +
        (logPath === undefined ? '' : `\n\nDetails were logged to:\n${logPath}`)
    )
    app.quit()
  }

  const reloadAfterCrash = (reason: string): void => {
    if (window.isDestroyed()) {
      return
    }
    const now = Date.now()
    if (now - lastCrashAt > 30_000) {
      crashReloads = 0 // a long-stable session that crashed once starts fresh
    }
    lastCrashAt = now
    if (crashReloads >= 3) {
      failLoudly(reason)
      return
    }
    crashReloads += 1
    console.error(`Renderer gone (${reason}) — reloading (attempt ${crashReloads})`)
    debugLog('renderer', 'reloading after crash', { reason, attempt: crashReloads })
    window.reload()
  }

  window.webContents.on('render-process-gone', (_event, details) => {
    // The exit code tells a native segfault from an abort/kill — the only clue when there's no
    // dump, so carry it through every downstream log line.
    const goneLabel = `${details.reason}, exit code ${details.exitCode}`
    debugLog('renderer', `gone: ${goneLabel}`)
    if (details.reason === 'clean-exit' || window.isDestroyed()) {
      return
    }
    // A window that has never been shown can never be focused and never emits 'focus'/'show',
    // so the App Nap deferral below would hang as an invisible process forever. 'launch-failed'
    // here is first launch with no renderer ever — the permanent environmental causes (UNC
    // path — crbug.com/103902 — or antivirus-deleted binaries): explain and quit immediately,
    // before Chromium's own launch fallbacks exhaust and FATAL the main process. Any other
    // pre-show loss takes its reload now, since deferring could never resume.
    if (!shownOnce) {
      if (details.reason === 'launch-failed') {
        failLoudly(goneLabel)
      } else {
        reloadAfterCrash(goneLabel)
      }
      return
    }
    // After first show, 'launch-failed' means a reload's process never ran an instruction. That
    // can still be transient: spawn EAGAIN under resource exhaustion, an AV scan briefly locking
    // files, or a wake-from-sleep race. Route it through the same capped reload as a crash —
    // permanent causes fail identically on every retry, exhaust the 3-per-30s cap, and reach
    // failLoudly within seconds anyway.
    //
    // macOS App Nap can suspend the renderer while the app sits in the background; reloading then
    // spawns a new renderer into that same suspended state, where it can't reach the Mach port
    // rendezvous server and dies too. Defer the reload until the window is foreground again.
    if (window.isFocused()) {
      reloadAfterCrash(goneLabel)
      return
    }
    if (reloadQueued) {
      return
    }
    reloadQueued = true
    const reloadWhenBack = (): void => {
      reloadQueued = false
      window.removeListener('focus', reloadWhenBack)
      window.removeListener('show', reloadWhenBack)
      reloadAfterCrash(goneLabel)
    }
    window.once('focus', reloadWhenBack)
    window.once('show', reloadWhenBack)
  })

  if (rendererUrl !== undefined) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(APP_FILE_PATH)
  }

  // Lock down navigation: this is a single-page local app that never navigates away,
  // opens child windows, or embeds webviews. Allow only the app's own document.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererUrl, APP_FILE_PATH)) {
      event.preventDefault()
    }
  })

  mainWindow = window
}

export function sendEvents(events: ChatEvent[]): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    return
  }
  const contents = mainWindow.webContents
  if (contents.isDestroyed() || contents.isCrashed()) {
    return
  }
  try {
    contents.send('chat:events', events)
  } catch {
    // The render frame can be disposed mid-flight (a reload or renderer crash) even when the checks
    // above pass, which makes webContents.send throw. A dropped batch is harmless — the renderer
    // re-subscribes and refetches state when it reloads — and must never crash the main process.
    debugLog('renderer', 'event batch dropped mid-reload')
  }
}

export function registerWindowControls(rendererUrl: string | undefined): void {
  // Custom title-bar buttons (Windows/Linux) drive the real window through IPC. Gated by the
  // same trusted-sender check as the chat IPC so only the app renderer can move the window.
  const onWindow =
    (action: (win: BrowserWindow) => void) =>
    (event: IpcMainEvent): void => {
      if (!isTrustedRendererUrl(event.senderFrame?.url, rendererUrl, APP_FILE_PATH)) {
        return
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win !== null) {
        action(win)
      }
    }
  ipcMain.on(
    'win:minimize',
    onWindow((win) => {
      win.minimize()
    })
  )
  ipcMain.on(
    'win:toggleMaximize',
    onWindow((win) => {
      if (win.isMaximized()) {
        win.unmaximize()
      } else {
        win.maximize()
      }
    })
  )
  ipcMain.on(
    'win:close',
    onWindow((win) => {
      win.close()
    })
  )
}
