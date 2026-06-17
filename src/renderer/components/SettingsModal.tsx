import { type ReactElement, useEffect, useState } from 'react'
import { ModalShell } from '@renderer/components/ModalShell'
import {
  type AppSettings,
  type BanRule,
  BUFFER_SIZE_OPTIONS,
  type ChatLogSettings,
  type CredentialStorageMode,
  DEFAULT_FONT_SIZE,
  type EmoteProviderSettings,
  FONT_SIZE_OPTIONS,
  type HighlightRule,
  type LinuxKeyringBackend,
  type ModerationRule
} from '@shared/model'

const BUFFER_NOTE: Record<number, string> = {
  100: 'minimal',
  500: 'default',
  1000: 'large',
  2000: 'very large',
  5000: 'maximum'
}

const EMOTE_PROVIDERS: ReadonlyArray<{ key: keyof EmoteProviderSettings; name: string }> = [
  { key: 'sevenTv', name: '7TV' },
  { key: 'bttv', name: 'BTTV' },
  { key: 'ffz', name: 'FFZ' }
]
import { HighlightSettings } from '@renderer/components/HighlightSettings'
import { ModerationSettings } from '@renderer/components/ModerationSettings'
import { PrebanSettings } from '@renderer/components/PrebanSettings'

interface SettingsModalProps {
  settings: AppSettings
  /** How saved logins are held at rest; the Credentials section appears when not encrypted. */
  credentialStorage: CredentialStorageMode
  /** Why Linux has no keyring, when it doesn't: basic_text = unrecognized desktop. */
  linuxKeyringBackend: LinuxKeyringBackend | undefined
  onChange: (patch: Partial<AppSettings>) => void
  /** Apply a highlights edit against the latest rules (kept separate so edits can't clobber). */
  onHighlightsChange: (apply: (rules: HighlightRule[]) => HighlightRule[]) => void
  /** Apply a moderation-watchlist edit against the latest rules. */
  onModerationChange: (apply: (rules: ModerationRule[]) => ModerationRule[]) => void
  onModerationAlert: (patch: { sound?: boolean; notify?: boolean }) => void
  /** Apply a pre-ban rules edit against the latest rules. */
  onPrebanChange: (apply: (rules: BanRule[]) => BanRule[]) => void
  onPrebanToggle: (patch: { enabled?: boolean; dryRun?: boolean }) => void
  onClose: () => void
}

/**
 * App settings: chat preferences, highlight rules (ping on specific users/keywords), chat logging,
 * and a Developer section gated behind a switch. Settings persist in the main process.
 */
export function SettingsModal({
  settings,
  credentialStorage,
  linuxKeyringBackend,
  onChange,
  onHighlightsChange,
  onModerationChange,
  onModerationAlert,
  onPrebanChange,
  onPrebanToggle,
  onClose
}: SettingsModalProps): ReactElement {
  const log = settings.chatLog
  const [defaultDir, setDefaultDir] = useState('')
  useEffect(() => {
    void window.chat.defaultLogDirectory().then(setDefaultDir)
  }, [])

  function updateLog(patch: Partial<ChatLogSettings>): void {
    onChange({ chatLog: { ...log, ...patch } })
  }

  async function browseLogDir(): Promise<void> {
    const dir = await window.chat.pickLogDirectory()
    if (dir !== undefined) {
      updateLog({ directory: dir })
    }
  }

  return (
    <ModalShell className="pc-modal-wide" onClose={onClose}>
      <div className="mh">
        <span className="tag acc">CFG</span>
        settings
      </div>
      <div className="mb">
        <label className="pc-setting">
          <span className="pc-setting-meta">
            <span className="pc-setting-name">message history per chat</span>
            <span className="pc-setting-desc">
              How many messages each chat keeps for scrollback, and for the monitor, flagged, and
              search views. More history uses more memory; off-screen rows render lazily, so a large
              buffer stays smooth to scroll.
            </span>
          </span>
          <select
            className="pc-hl-target"
            value={settings.bufferSize}
            aria-label="Message history per chat"
            onChange={(event) => {
              onChange({ bufferSize: Number(event.target.value) })
            }}
          >
            {BUFFER_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size} messages{BUFFER_NOTE[size] !== undefined ? ` (${BUFFER_NOTE[size]})` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="pc-setting">
          <span className="pc-setting-meta">
            <span className="pc-setting-name">theme</span>
            <span className="pc-setting-desc">
              Pick between the two built-in palettes for the whole window.
            </span>
          </span>
          <select
            className="pc-hl-target"
            value={settings.theme}
            aria-label="Theme"
            onChange={(event) => {
              onChange({ theme: event.target.value === 'midnight' ? 'midnight' : 'ice' })
            }}
          >
            <option value="ice">ice</option>
            <option value="midnight">midnight</option>
          </select>
        </label>

        <label className="pc-setting">
          <span className="pc-setting-meta">
            <span className="pc-setting-name">chat layout</span>
            <span className="pc-setting-desc">
              Side-by-side columns, or a tab bar showing one chat at a time.
            </span>
          </span>
          <select
            className="pc-hl-target"
            value={settings.layout}
            aria-label="Chat layout"
            onChange={(event) => {
              onChange({ layout: event.target.value === 'tabs' ? 'tabs' : 'scroll' })
            }}
          >
            <option value="scroll">side-by-side columns</option>
            <option value="tabs">tabs</option>
          </select>
        </label>

        <label className="pc-setting">
          <span className="pc-setting-meta">
            <span className="pc-setting-name">chat text size</span>
            <span className="pc-setting-desc">
              Scales the chat text; window chrome stays compact.
            </span>
          </span>
          <select
            className="pc-hl-target"
            value={settings.fontSize}
            aria-label="Chat text size"
            onChange={(event) => {
              onChange({ fontSize: Number(event.target.value) })
            }}
          >
            {FONT_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}px{size === DEFAULT_FONT_SIZE ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>

        {window.win.platform === 'darwin' ? (
          <label className="pc-setting">
            <span className="pc-setting-meta">
              <span className="pc-setting-name">keep this Mac awake</span>
              <span className="pc-setting-desc">
                Stop this Mac from idle-sleeping while the app runs, so chat (and chat logging)
                never gaps. Off lets the Mac sleep — and macOS may suspend the app in the
                background, gapping chat until you return.
              </span>
            </span>
            <input
              type="checkbox"
              className="pc-switch"
              checked={settings.keepAwake}
              onChange={(event) => {
                onChange({ keepAwake: event.target.checked })
              }}
            />
          </label>
        ) : null}

        <label className="pc-setting">
          <span className="pc-setting-meta">
            <span className="pc-setting-name">developer options</span>
            <span className="pc-setting-desc">Show experimental features and debug modes.</span>
          </span>
          <input
            type="checkbox"
            className="pc-switch"
            checked={settings.devMode}
            onChange={(event) => {
              onChange({ devMode: event.target.checked })
            }}
          />
        </label>

        <div className="pc-setting-group">
          <div className="pc-setting-group-title">Emotes</div>
          <p className="pc-setting-note">
            Disabling a provider hides its emotes in new messages and skips its network fetches;
            already-rendered messages keep theirs.
          </p>
          {EMOTE_PROVIDERS.map(({ key, name }) => (
            <label key={key} className="pc-setting">
              <span className="pc-setting-meta">
                <span className="pc-setting-name">{name}</span>
              </span>
              <input
                type="checkbox"
                className="pc-switch"
                checked={settings.emoteProviders[key]}
                onChange={() => {
                  onChange({
                    emoteProviders: {
                      ...settings.emoteProviders,
                      [key]: !settings.emoteProviders[key]
                    }
                  })
                }}
              />
            </label>
          ))}
        </div>

        <div className="pc-setting-group">
          <div className="pc-setting-group-title">Highlights</div>
          <HighlightSettings rules={settings.highlights} onChange={onHighlightsChange} />
        </div>

        <div className="pc-setting-group">
          <div className="pc-setting-group-title">Moderation alerts</div>
          <ModerationSettings
            settings={settings.moderation}
            onRulesChange={onModerationChange}
            onAlertChange={onModerationAlert}
          />
        </div>

        <div className="pc-setting-group">
          <div className="pc-setting-group-title">Pre-ban list</div>
          <PrebanSettings
            settings={settings.preban}
            onRulesChange={onPrebanChange}
            onToggle={onPrebanToggle}
          />
        </div>

        <div className="pc-setting-group">
          <div className="pc-setting-group-title">Chat logging</div>
          <label className="pc-setting">
            <span className="pc-setting-meta">
              <span className="pc-setting-name">log chat to disk</span>
              <span className="pc-setting-desc">
                Append every message and deletion from all open chats to one JSONL file, kept across
                sessions — a long-term record that survives moderation removals and is easy to
                search.
              </span>
            </span>
            <input
              type="checkbox"
              className="pc-switch"
              checked={log.enabled}
              onChange={(event) => {
                updateLog({ enabled: event.target.checked })
              }}
            />
          </label>
          {log.enabled ? (
            <div className="pc-log-dir">
              <span
                className="pc-log-path"
                title={log.directory === '' ? defaultDir : log.directory}
              >
                {log.directory === '' ? defaultDir : log.directory}
              </span>
              <button type="button" className="pc-mbtn" onClick={() => void browseLogDir()}>
                browse…
              </button>
              <button
                type="button"
                className="pc-mbtn"
                onClick={() => void window.chat.openLogDirectory()}
              >
                open
              </button>
            </div>
          ) : null}
        </div>

        {credentialStorage !== 'encrypted' ? (
          <div className="pc-setting-group">
            <div className="pc-setting-group-title">Credentials</div>
            <p className="pc-setting-note">
              {linuxKeyringBackend === 'basic_text' ? (
                <>
                  This desktop environment isn't one Electron recognizes, so no keyring was picked
                  and saved logins can't be encrypted at rest. Without one they last one session. If
                  you do run GNOME Keyring or KWallet, relaunch with{' '}
                  <code>--password-store=gnome-libsecret</code> (or <code>kwallet5</code>/
                  <code>kwallet6</code>) to use it.
                </>
              ) : (
                <>
                  No OS keyring is available, so saved logins can't be encrypted at rest. Without a
                  keyring they last one session; installing/unlocking GNOME Keyring or KWallet fixes
                  this properly.
                </>
              )}
            </p>
            <label className="pc-setting">
              <span className="pc-setting-meta">
                <span className="pc-setting-name">keep logins in plaintext</span>
                <span className="pc-setting-desc">
                  Persist the Twitch token and YouTube cookies unencrypted in the app's data folder
                  (readable only by your user account). Anyone with access to your files can read
                  them — enable only if you accept that risk.
                </span>
              </span>
              <input
                type="checkbox"
                className="pc-switch"
                checked={settings.allowPlaintextCredentials}
                onChange={(event) => {
                  onChange({ allowPlaintextCredentials: event.target.checked })
                }}
              />
            </label>
          </div>
        ) : null}

        {settings.devMode ? (
          <div className="pc-setting-group">
            <div className="pc-setting-group-title">Developer</div>
            <p className="pc-setting-note">
              Experimental features and debug modes will appear here. Some verbose tracing is still
              set with environment variables at launch:
            </p>
            <ul className="pc-setting-flags">
              <li>
                <code>POGCHATTER_YT_SIGNALER_DEBUG=1</code> — trace the YouTube push signaler
              </li>
              <li>
                <code>POGCHATTER_SEND_DEBUG=1</code> — time the send round-trip
              </li>
            </ul>
          </div>
        ) : null}
      </div>
      <div className="mf">
        <button type="button" className="pc-mbtn" onClick={onClose}>
          close
        </button>
      </div>
    </ModalShell>
  )
}
