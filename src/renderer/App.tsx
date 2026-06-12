import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  type AppSettings,
  type Author,
  type AuthState,
  type ChannelInfo,
  type ChatEvent,
  type ChatMessage,
  DEFAULT_SETTINGS,
  type BanRule,
  type HighlightRule,
  type ModerationRule,
  type MonitorView,
  type Platform,
  type SourceStatus
} from '@shared/model'
import { AddColumn } from '@renderer/components/AddColumn'
import { ChannelColumn } from '@renderer/components/ChannelColumn'
import { CombinedColumn } from '@renderer/components/CombinedColumn'
import { DonationThreadModal } from '@renderer/components/DonationThreadModal'
import { SearchModal } from '@renderer/components/SearchModal'
import { ModalShell } from '@renderer/components/ModalShell'
import { MonitorComposer } from '@renderer/components/MonitorComposer'
import { UserActivityModal } from '@renderer/components/UserActivityModal'
import { SettingsModal } from '@renderer/components/SettingsModal'
import { StatusBar } from '@renderer/components/StatusBar'
import { Titlebar } from '@renderer/components/Titlebar'
import { TwitchLoginModal } from '@renderer/components/TwitchLoginModal'
import { YouTubeChannelModal } from '@renderer/components/YouTubeChannelModal'
import { YouTubeLoginModal } from '@renderer/components/YouTubeLoginModal'
import { processEvents, seenIdCapacity, SeenMessageIds } from '@renderer/chatEvents'
import { BacklogGate } from '@renderer/backlogGate'
import { applyEventsToChannels, applyEventsToMessages, type MessageMap } from '@renderer/chatState'
import { FLAGGED_COLUMN_ID, reconcileColumnOrder } from '@renderer/columnOrder'
import { playPing, showPing } from '@renderer/ping'
import { THEME_PALETTES } from '@renderer/theme'

const DEFAULT_COL_WIDTH = 340
const INITIAL_AUTH: AuthState = {
  twitch: { configured: false, loggedIn: false },
  youtube: { loggedIn: false, channels: [] },
  // Optimistic until main reports the real mode, so the UI doesn't flash a warning at startup.
  credentialStorage: 'encrypted'
}

/** Sending is enabled once logged in to that channel's platform and not blocked by a chat restriction. */
function canSendTo(channel: ChannelInfo, auth: AuthState): boolean {
  if (channel.platform === 'twitch') {
    return auth.twitch.loggedIn
  }
  return auth.youtube.loggedIn && channel.sendRestriction === undefined
}

/** A source is "online" (LED lit) once its chat is reachable. */
function isOnline(status: SourceStatus): boolean {
  return (
    status.state === 'connected' ||
    status.state === 'live' ||
    status.state === 'waiting' ||
    status.state === 'replay'
  )
}

/** A rendered column: a chat channel, a combined monitor view, or the built-in flagged view. */
type Column =
  | { kind: 'channel'; id: string; channel: ChannelInfo }
  | { kind: 'monitor'; id: string; monitor: MonitorView }
  | { kind: 'flagged'; id: string }

export function App(): ReactElement {
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [messages, setMessages] = useState<MessageMap>({})
  const [auth, setAuth] = useState<AuthState>(INITIAL_AUTH)
  const [prompt, setPrompt] = useState<
    { userCode: string; verificationUri: string; error?: string } | undefined
  >(undefined)
  const [authError, setAuthError] = useState<string | undefined>(undefined)
  const [youtubeModalOpen, setYouTubeModalOpen] = useState(false)
  const [channelModalOpen, setChannelModalOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  // The author + chat whose user card ("User activity" view) is open, if any.
  const [userActivity, setUserActivity] = useState<
    { channelId: string; platform: Platform; author: Author } | undefined
  >(undefined)
  // The Super Chat reply thread that's open, if any.
  const [donationThread, setDonationThread] = useState<
    { channelId: string; threadToken: string; parentAuthor: string } | undefined
  >(undefined)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Latest settings for the stable onEvents handler (set up once on mount); kept current below.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // Settings keys the user edited before the persisted settings finished loading, so hydration
  // can adopt the stored values without clobbering those early edits (and an early edit can't
  // pin the whole session to defaults).
  const hydratedRef = useRef(false)
  const preHydrationEditsRef = useRef(new Set<string>())
  // Per-channel timestamp of the last highlight, so a column can flash when one of its users pings.
  const [pingedAt, setPingedAt] = useState<Record<string, number>>({})
  const autoPromptedRef = useRef(false)
  const ytLoggedInRef = useRef(false)
  const ytUserLogoutRef = useRef(false)
  const [order, setOrder] = useState<string[]>([])
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [activeIdState, setActiveId] = useState<string | undefined>(undefined)

  // Total messages received; StatusBar samples it at 1 Hz for the msg/s rate, so the per-second
  // re-render stays scoped there instead of cascading through the whole column tree.
  const messageCountRef = useRef(0)

  // Message ids already delivered, so a YouTube re-send/replay can't re-ring sounds, re-flash
  // columns, re-notify, or inflate the msg/s rate (chatState's in-buffer dedup stays as backstop).
  const seenIdsRef = useRef(new SeenMessageIds())

  // Live batches held until main's backlog is folded; a ref so a StrictMode remount (dev)
  // inherits batches the first mount already drained from the preload queue (see BacklogGate).
  const backlogGateRef = useRef(new BacklogGate())

  // Channels whose buffer trimming is paused because a column showing them is scrolled up,
  // keyed by the reporting column — a channel stays paused while any column holds it.
  const pausedByColumnRef = useRef(new Map<string, readonly string[]>())
  const reportScrollPause = useCallback((columnId: string, channelIds: readonly string[]): void => {
    if (channelIds.length === 0) {
      pausedByColumnRef.current.delete(columnId)
    } else {
      pausedByColumnRef.current.set(columnId, channelIds)
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.chat.listChannels().then((list) => {
      if (active) {
        // Seed only if no channels event has populated state yet, so we don't clobber a fresher list.
        setChannels((prev) => (prev.length > 0 ? prev : list))
      }
    })
    void window.chat.getAuthState().then((state) => {
      if (active) {
        setAuth(state)
      }
    })
    void window.chat.getSettings().then((loaded) => {
      // Adopt the persisted settings, but keep any key the user already edited while the load
      // was in flight — a slow load must never clobber an early edit (e.g. unticking a
      // highlight's sound right after launch).
      if (active) {
        hydratedRef.current = true
        setSettings((prev) => {
          const merged = { ...loaded } as unknown as Record<string, unknown>
          const edited = prev as unknown as Record<string, unknown>
          for (const key of preHydrationEditsRef.current) {
            merged[key] = edited[key]
          }
          return merged as unknown as AppSettings
        })
      }
    })

    const applyLive = (events: ChatEvent[]): void => {
      // Drop already-delivered messages first, then tag highlights/flags and collect alerts (the
      // policy lives in chatEvents.ts), fold the batch into state, and fire the side effects.
      const fresh = seenIdsRef.current.filter(
        events,
        seenIdCapacity(settingsRef.current.bufferSize)
      )
      const batch = processEvents(fresh, settingsRef.current)
      if (batch.auth !== undefined) {
        setAuth(batch.auth)
      }
      messageCountRef.current += batch.added
      const paused = new Set<string>()
      for (const ids of pausedByColumnRef.current.values()) {
        for (const id of ids) {
          paused.add(id)
        }
      }
      setMessages((prev) =>
        applyEventsToMessages(prev, fresh, settingsRef.current.bufferSize, paused)
      )
      setChannels((prev) => applyEventsToChannels(prev, fresh))
      if (batch.flashed.size > 0) {
        const now = Date.now()
        setPingedAt((prev) => {
          const next = { ...prev }
          for (const id of batch.flashed) {
            next[id] = now
          }
          return next
        })
      }
      if (batch.sound) {
        playPing()
      }
      if (batch.notify !== undefined) {
        showPing(batch.notify.title, batch.notify.body)
      }
    }

    // Hold live batches until main's backlog has been folded, so replayed history fills the
    // buffers first and live messages append after it; the seen-id filter absorbs any overlap.
    const gate = backlogGateRef.current
    const unsubscribe = window.chat.onEvents((events) => {
      gate.deliver(events, applyLive)
    })

    // Refill the buffers from main's replay ring (startup backlog, crash-reload history) without
    // firing alert side effects — these lines were alerted on first delivery, or predate this
    // renderer. Tagging still runs so highlights and the flagged review view survive a reload.
    void window.chat
      .getBacklog()
      .then((events) => {
        if (!active) {
          return
        }
        const fresh = seenIdsRef.current.filter(
          events,
          seenIdCapacity(settingsRef.current.bufferSize)
        )
        processEvents(fresh, settingsRef.current)
        setMessages((prev) => applyEventsToMessages(prev, fresh, settingsRef.current.bufferSize))
      })
      .catch(() => {
        // No replay available; live events still flow once released below.
      })
      .finally(() => {
        // After cleanup the gate stays armed, so a StrictMode remount releases the held batches.
        if (active) {
          gate.release(applyLive)
        }
      })

    return () => {
      active = false
      unsubscribe()
      gate.rearm()
    }
  }, [])

  useEffect(() => {
    if (auth.twitch.loggedIn) {
      setPrompt(undefined)
      setAuthError(undefined)
    }
  }, [auth.twitch.loggedIn])

  // Prompt for a channel once per login when the account can post as more than one and is
  // still on the default identity — a restored brand-channel choice is left untouched.
  useEffect(() => {
    if (!auth.youtube.loggedIn) {
      autoPromptedRef.current = false
      // A session drop closes the picker outright: leaving the flag set would keep the global
      // shortcuts disabled behind an invisible "modal" and pop the stale picker back up after
      // the next login.
      setChannelModalOpen(false)
      return
    }
    const onDefault = auth.youtube.selectedChannelId === 'default'
    if (!autoPromptedRef.current && onDefault && auth.youtube.channels.length > 1) {
      autoPromptedRef.current = true
      setChannelModalOpen(true)
    }
  }, [auth.youtube.loggedIn, auth.youtube.selectedChannelId, auth.youtube.channels.length])

  // If the YouTube session drops without the user logging out (expired/lost after a restart),
  // open the login modal so they can re-authenticate.
  useEffect(() => {
    const loggedIn = auth.youtube.loggedIn
    if (ytLoggedInRef.current && !loggedIn && !ytUserLogoutRef.current) {
      setYouTubeModalOpen(true)
    }
    ytLoggedInRef.current = loggedIn
    ytUserLogoutRef.current = false
  }, [auth.youtube.loggedIn])

  // The built-in flagged-messages view exists whenever the moderation watchlist has a configured term.
  const hasModerationRules = settings.moderation.rules.some((rule) => rule.pattern.trim() !== '')
  // Every open chat feeds the flagged view; memoized so its merge isn't recomputed on every render.
  const allChannelIds = useMemo(() => channels.map((channel) => channel.id), [channels])

  const monitorIds = useMemo(
    () => new Set(settings.monitors.map((monitor) => monitor.id)),
    [settings.monitors]
  )
  // The persisted order is applied exactly once (after settings hydrate); later changes come only
  // from explicit moves, which write straight back to settings.
  const storedOrderAppliedRef = useRef(false)

  // Keep a local column order that survives status/channel updates within a session; reconcile
  // against the authoritative membership (chat channels from main + monitor views from settings +
  // the flagged view when moderation rules exist). Columns the user has placed (this session, or
  // persisted in settings.columnOrder) stay put; everything else slots in by the default rule —
  // flagged leftmost, monitors second, chats after (see columnOrder.ts).
  useEffect(() => {
    // Decide (and consume) the one-shot stored-order application here, not inside the updater:
    // StrictMode double-invokes updaters, and a ref mutation in the first pass would make the
    // second pass return the default order, dropping the persisted arrangement in development.
    const applyStored = !storedOrderAppliedRef.current && hydratedRef.current
    if (applyStored) {
      storedOrderAppliedRef.current = true
    }
    const stored = applyStored ? settingsRef.current.columnOrder : undefined
    setOrder((prev) =>
      reconcileColumnOrder(prev, {
        flaggedVisible: hasModerationRules,
        monitorIds,
        channelIds: channels.map((channel) => channel.id),
        stored
      })
    )
  }, [channels, monitorIds, hasModerationRules, settings.columnOrder])

  // Chat columns and monitor views in one ordered list, so both move and reorder the same way.
  const orderedColumns = order
    .map((id): Column | undefined => {
      if (id === FLAGGED_COLUMN_ID) {
        return hasModerationRules ? { kind: 'flagged', id } : undefined
      }
      const channel = channels.find((c) => c.id === id)
      if (channel !== undefined) {
        return { kind: 'channel', id, channel }
      }
      const monitor = settings.monitors.find((m) => m.id === id)
      if (monitor !== undefined) {
        return { kind: 'monitor', id, monitor }
      }
      return undefined
    })
    .filter((column): column is Column => column !== undefined)
  // Chat channels only, for the pickers (monitor composer, chat-log scope).
  const orderedChannels = orderedColumns.flatMap((column) =>
    column.kind === 'channel' ? [column.channel] : []
  )
  const activeId =
    activeIdState !== undefined && orderedColumns.some((column) => column.id === activeIdState)
      ? activeIdState
      : orderedColumns[0]?.id

  function moveColumn(id: string, direction: -1 | 1): void {
    const i = order.indexOf(id)
    const j = i + direction
    if (i < 0 || j < 0 || j >= order.length) {
      return
    }
    const a = order[i]
    const b = order[j]
    if (a === undefined || b === undefined) {
      return
    }
    const next = [...order]
    next[i] = b
    next[j] = a
    setOrder(next)
    // An explicit move persists the whole arrangement, so it survives restarts; unmoved columns
    // keep slotting in by the default rule.
    updateSettings({ columnOrder: next })
  }

  // Whether any overlay is open — the global shortcuts below stand down so keystrokes can't
  // reach (or move) the columns behind a dimmed backdrop.
  const modalOpen =
    prompt !== undefined ||
    authError !== undefined ||
    youtubeModalOpen ||
    // Mirrors the render condition below: the picker only exists while logged in, and a gate
    // term with no visible overlay would silently disable every global shortcut.
    (channelModalOpen && auth.youtube.loggedIn) ||
    composerOpen ||
    searchOpen ||
    settingsOpen ||
    userActivity !== undefined ||
    donationThread !== undefined

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      // Open search on ⌘F / Ctrl+F — handled before the input-focus bail, so it works while typing
      // in a composer too (but never underneath an already-open modal).
      if ((event.metaKey || event.ctrlKey) && (event.key === 'f' || event.key === 'F')) {
        if (modalOpen) {
          return
        }
        event.preventDefault()
        setSearchOpen(true)
        return
      }
      const el = document.activeElement
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        return
      }
      if (modalOpen) {
        return
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      const ids = orderedColumns.map((column) => column.id)
      if (event.altKey) {
        if (activeId !== undefined) {
          moveColumn(activeId, direction)
        }
        return
      }
      const current = activeId !== undefined ? ids.indexOf(activeId) : -1
      const target = ids[Math.max(0, Math.min(ids.length - 1, current + direction))]
      if (target !== undefined) {
        setActiveId(target)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
    // moveColumn is recreated per render (it reads the current order to persist explicit moves);
    // this listener already re-subscribes whenever the column set changes, so that's free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedColumns, activeId, moveColumn, modalOpen])

  async function handleTwitchLogin(): Promise<void> {
    setAuthError(undefined)
    const result = await window.chat.loginTwitch()
    if ('error' in result) {
      setPrompt(undefined)
      setAuthError(result.error)
      return
    }
    setPrompt({ userCode: result.userCode, verificationUri: result.verificationUri })
    // Success closes the modal via the auth event; a denial/expiry/network death lands here.
    const completion = await window.chat.twitchLoginResult()
    if (!completion.ok) {
      setPrompt((prev) => (prev === undefined ? prev : { ...prev, error: completion.error }))
    }
  }

  // Apply the change immediately for a responsive toggle, then persist; main returns the merged truth.
  function updateSettings(patch: Partial<AppSettings>): void {
    // Optimistic, then persist fire-and-forget. We deliberately do NOT reconcile from the persisted
    // result: the highlights editor makes rapid edits (a freshly-added rule starts with an empty
    // pattern, and patterns are typed character by character), and overwriting state from the async
    // round-trip would drop the in-progress empty rule and could revert in-flight keystrokes. The
    // store sanitizes on its side; local state is the session's source of truth.
    if (!hydratedRef.current) {
      for (const key of Object.keys(patch)) {
        preHydrationEditsRef.current.add(key)
      }
    }
    setSettings((prev) => ({ ...prev, ...patch }))
    void window.chat.setSettings(patch).catch(() => {
      // A failed persist shouldn't disrupt editing; settings retry on the next change.
    })
  }

  // Apply a highlights edit against the latest rules (settingsRef is current as of the last render),
  // so toggling one rule's alert never overwrites another in-flight edit.
  function updateHighlights(apply: (rules: HighlightRule[]) => HighlightRule[]): void {
    updateSettings({ highlights: apply(settingsRef.current.highlights) })
  }

  // Edit the moderation watchlist against the latest rules (same anti-clobber pattern as highlights).
  function updateModerationRules(apply: (rules: ModerationRule[]) => ModerationRule[]): void {
    const moderation = settingsRef.current.moderation
    updateSettings({ moderation: { ...moderation, rules: apply(moderation.rules) } })
  }

  function setModerationAlert(patch: { sound?: boolean; notify?: boolean }): void {
    updateSettings({ moderation: { ...settingsRef.current.moderation, ...patch } })
  }

  // Edit the pre-ban rules against the latest list (same anti-clobber pattern as highlights).
  function updatePrebanRules(apply: (rules: BanRule[]) => BanRule[]): void {
    const preban = settingsRef.current.preban
    updateSettings({ preban: { ...preban, rules: apply(preban.rules) } })
  }

  function setPrebanToggles(patch: { enabled?: boolean; dryRun?: boolean }): void {
    updateSettings({ preban: { ...settingsRef.current.preban, ...patch } })
  }

  // Add/remove a user-card Monitor entry against the latest list (same anti-clobber pattern).
  function toggleMonitoredUser(platform: Platform, userId: string, handle: string): void {
    const monitored = settingsRef.current.monitoredUsers
    const exists = monitored.some((user) => user.platform === platform && user.userId === userId)
    updateSettings({
      monitoredUsers: exists
        ? monitored.filter((user) => !(user.platform === platform && user.userId === userId))
        : [...monitored, { platform, userId, handle, addedAt: Date.now() }]
    })
  }

  // Monitored authors as '<platform>:<userId>' keys for the rows. Memoized on the list itself, so
  // the Set's identity changes only on toggle — the memoized rows re-render then, not per message.
  const monitoredKeys = useMemo(
    () => new Set(settings.monitoredUsers.map((user) => `${user.platform}:${user.userId}`)),
    [settings.monitoredUsers]
  )

  // From a combined monitor view, open and focus a message's own column so the mod acts there.
  // Stable so the memoized rows aren't invalidated as messages arrive.
  const jumpToChannel = useCallback((channelId: string): void => {
    setActiveId(channelId)
    const el = document.querySelector(`[data-colid="${channelId.replace(/"/g, '\\"')}"]`)
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [])

  // Open the user card for a message's author in its chat. Stable for the memoized rows.
  const openUserActivity = useCallback((message: ChatMessage): void => {
    setUserActivity({
      channelId: message.channelId,
      platform: message.platform,
      author: message.author
    })
  }, [])

  // Open the reply thread of the Super Chat a message replies to. Stable for the memoized rows.
  const openDonationThread = useCallback((message: ChatMessage): void => {
    const token = message.reply?.threadToken
    if (token === undefined) {
      return
    }
    setDonationThread({
      channelId: message.channelId,
      threadToken: token,
      parentAuthor: message.reply?.parentAuthor ?? ''
    })
  }, [])

  function createMonitor(label: string, members: string[]): void {
    const monitor = { id: `mon-${Date.now()}`, label, members }
    updateSettings({ monitors: [...settingsRef.current.monitors, monitor] })
    // The reconcile effect slots it by the default rule: after the flagged view, before the chats.
    setActiveId(monitor.id)
    setComposerOpen(false)
  }

  function removeMonitor(id: string): void {
    updateSettings({ monitors: settingsRef.current.monitors.filter((m) => m.id !== id) })
  }

  const twitchOnline = channels.some(
    (channel) => channel.platform === 'twitch' && isOnline(channel.status)
  )
  const youtubeOnline = channels.some(
    (channel) => channel.platform === 'youtube' && isOnline(channel.status)
  )

  // Theme + chat text size come from settings; the username palette follows the theme.
  const theme = settings.theme
  const palette = THEME_PALETTES[theme]

  return (
    <div
      className={`pc-app theme-${theme}`}
      style={{ '--chat-fs': `${settings.fontSize}px` } as CSSProperties}
    >
      <Titlebar
        auth={auth}
        onAdd={() => {
          setAddOpen((open) => !open)
        }}
        onSearch={() => {
          setSearchOpen(true)
        }}
        onSettings={() => {
          setSettingsOpen(true)
        }}
        onTwitchLogin={() => {
          void handleTwitchLogin()
        }}
        onTwitchLogout={() => {
          void window.chat.logoutTwitch()
        }}
        onYouTubeLogin={() => {
          setYouTubeModalOpen(true)
        }}
        onYouTubeLogout={() => {
          ytUserLogoutRef.current = true
          void window.chat.logoutYouTube()
        }}
        onYouTubePickChannel={() => {
          setChannelModalOpen(true)
        }}
      />
      <div className="pc-screen">
        <div className="pc-body">
          {orderedColumns.map((column, index) =>
            column.kind === 'channel' ? (
              <ChannelColumn
                key={column.id}
                channel={column.channel}
                messages={messages[column.id] ?? []}
                canSend={canSendTo(column.channel, auth)}
                revealDeleted={settings.revealDeleted}
                pingedAt={pingedAt[column.id]}
                active={column.id === activeId}
                palette={palette}
                width={widths[column.id] ?? DEFAULT_COL_WIDTH}
                canMoveLeft={index > 0}
                canMoveRight={index < orderedColumns.length - 1}
                onActivate={setActiveId}
                onRemove={(channelId) => {
                  void window.chat.removeChannel(channelId)
                }}
                onMove={moveColumn}
                onResize={(channelId, value) => {
                  setWidths((prev) => ({ ...prev, [channelId]: value }))
                }}
                onUserActivity={openUserActivity}
                onDonationReplies={openDonationThread}
                onScrollPause={reportScrollPause}
                monitoredKeys={monitoredKeys}
              />
            ) : column.kind === 'monitor' ? (
              <CombinedColumn
                key={column.id}
                id={column.monitor.id}
                label={column.monitor.label}
                memberIds={column.monitor.members}
                members={column.monitor.members
                  .map((id) => channels.find((channel) => channel.id === id))
                  .filter((channel): channel is ChannelInfo => channel !== undefined)}
                messagesByChannel={messages}
                cap={settings.bufferSize}
                revealDeleted={settings.revealDeleted}
                active={column.id === activeId}
                palette={palette}
                width={widths[column.id] ?? DEFAULT_COL_WIDTH}
                canMoveLeft={index > 0}
                canMoveRight={index < orderedColumns.length - 1}
                onActivate={setActiveId}
                onJump={jumpToChannel}
                onUserActivity={openUserActivity}
                onDonationReplies={openDonationThread}
                onMove={moveColumn}
                onRemove={removeMonitor}
                onResize={(monitorId, value) => {
                  setWidths((prev) => ({ ...prev, [monitorId]: value }))
                }}
                onScrollPause={reportScrollPause}
                monitoredKeys={monitoredKeys}
              />
            ) : (
              <CombinedColumn
                key={column.id}
                id={column.id}
                label="messages flagged for moderation"
                memberIds={allChannelIds}
                members={channels}
                messagesByChannel={messages}
                cap={settings.bufferSize}
                flaggedOnly
                revealDeleted={settings.revealDeleted}
                active={column.id === activeId}
                palette={palette}
                width={widths[column.id] ?? DEFAULT_COL_WIDTH}
                canMoveLeft={index > 0}
                canMoveRight={index < orderedColumns.length - 1}
                onActivate={setActiveId}
                onJump={jumpToChannel}
                onUserActivity={openUserActivity}
                onDonationReplies={openDonationThread}
                onMove={moveColumn}
                onResize={(viewId, value) => {
                  setWidths((prev) => ({ ...prev, [viewId]: value }))
                }}
                onScrollPause={reportScrollPause}
                monitoredKeys={monitoredKeys}
              />
            )
          )}
          <AddColumn
            open={addOpen}
            onOpen={() => {
              setAddOpen(true)
            }}
            onClose={() => {
              setAddOpen(false)
            }}
            onAdd={(platform, target) => window.chat.addChannel(platform, target)}
            onAddStreams={(target) => window.chat.addYouTubeStreams(target)}
            onCompose={() => {
              setComposerOpen(true)
            }}
          />
        </div>
      </div>
      <StatusBar
        channelCount={channels.length}
        twitchOnline={twitchOnline}
        youtubeOnline={youtubeOnline}
        messageCountRef={messageCountRef}
        user={auth.twitch.userName ?? 'guest'}
      />
      {prompt !== undefined ? (
        <TwitchLoginModal
          userCode={prompt.userCode}
          verificationUri={prompt.verificationUri}
          credentialStorage={auth.credentialStorage}
          linuxKeyringBackend={auth.linuxKeyringBackend}
          error={prompt.error}
          onRetry={() => {
            void handleTwitchLogin()
          }}
          onClose={() => {
            setPrompt(undefined)
          }}
        />
      ) : null}
      {authError !== undefined ? (
        <ModalShell
          onClose={() => {
            setAuthError(undefined)
          }}
        >
          <div className="mh">
            <span className="tag tw">TW</span>
            twitch login failed
          </div>
          <div className="mb">
            <div className="pc-modal-err">{authError}</div>
          </div>
          <div className="mf">
            <button
              type="button"
              className="pc-mbtn"
              onClick={() => {
                setAuthError(undefined)
              }}
            >
              close
            </button>
          </div>
        </ModalShell>
      ) : null}
      {composerOpen ? (
        <MonitorComposer
          channels={orderedChannels}
          onCreate={createMonitor}
          onClose={() => {
            setComposerOpen(false)
          }}
        />
      ) : null}
      {userActivity !== undefined ? (
        <UserActivityModal
          author={userActivity.author}
          channelId={userActivity.channelId}
          channelLabel={
            channels.find((channel) => channel.id === userActivity.channelId)?.label ??
            userActivity.channelId
          }
          messages={(messages[userActivity.channelId] ?? []).filter(
            (message) => message.author.id === userActivity.author.id
          )}
          palette={palette}
          revealDeleted={settings.revealDeleted}
          monitoredKeys={monitoredKeys}
          monitored={monitoredKeys.has(`${userActivity.platform}:${userActivity.author.id}`)}
          onToggleMonitor={() => {
            toggleMonitoredUser(
              userActivity.platform,
              userActivity.author.id,
              userActivity.author.name
            )
          }}
          onJump={(channelId) => {
            jumpToChannel(channelId)
            setUserActivity(undefined)
          }}
          onClose={() => {
            setUserActivity(undefined)
          }}
        />
      ) : null}
      {donationThread !== undefined ? (
        <DonationThreadModal
          channelId={donationThread.channelId}
          threadToken={donationThread.threadToken}
          parentAuthor={donationThread.parentAuthor}
          palette={palette}
          revealDeleted={settings.revealDeleted}
          monitoredKeys={monitoredKeys}
          onJump={(channelId) => {
            jumpToChannel(channelId)
            setDonationThread(undefined)
          }}
          onClose={() => {
            setDonationThread(undefined)
          }}
        />
      ) : null}
      {searchOpen ? (
        <SearchModal
          channels={channels}
          messagesByChannel={messages}
          cap={settings.bufferSize}
          palette={palette}
          revealDeleted={settings.revealDeleted}
          monitoredKeys={monitoredKeys}
          onJump={jumpToChannel}
          onUserActivity={openUserActivity}
          onDonationReplies={openDonationThread}
          onClose={() => {
            setSearchOpen(false)
          }}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsModal
          settings={settings}
          credentialStorage={auth.credentialStorage}
          linuxKeyringBackend={auth.linuxKeyringBackend}
          onChange={updateSettings}
          onHighlightsChange={updateHighlights}
          onModerationChange={updateModerationRules}
          onModerationAlert={setModerationAlert}
          onPrebanChange={updatePrebanRules}
          onPrebanToggle={setPrebanToggles}
          onClose={() => {
            setSettingsOpen(false)
          }}
        />
      ) : null}
      {youtubeModalOpen ? (
        <YouTubeLoginModal
          credentialStorage={auth.credentialStorage}
          linuxKeyringBackend={auth.linuxKeyringBackend}
          onSubmit={(cookies) => window.chat.loginYouTube(cookies)}
          onClose={() => {
            setYouTubeModalOpen(false)
          }}
        />
      ) : null}
      {channelModalOpen && auth.youtube.loggedIn ? (
        <YouTubeChannelModal
          channels={auth.youtube.channels}
          selectedChannelId={auth.youtube.selectedChannelId}
          onSelect={(channelId) => window.chat.selectYouTubeChannel(channelId)}
          onClose={() => {
            setChannelModalOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}
