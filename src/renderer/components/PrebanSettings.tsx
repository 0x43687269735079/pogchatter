import { type ReactElement, useEffect, useRef, useState } from 'react'
import type { BanRule, Platform, PrebanSettings as Settings } from '@shared/model'
import { isValidPattern } from '@renderer/match'

interface PrebanSettingsProps {
  settings: Settings
  /** Apply an edit against the latest rules (a function, so a toggle can't overwrite another edit). */
  onRulesChange: (apply: (rules: BanRule[]) => BanRule[]) => void
  onToggle: (patch: { enabled?: boolean; dryRun?: boolean }) => void
}

/** A rule's identity for import de-duplication. */
function ruleKey(rule: BanRule): string {
  const platforms = rule.platforms === undefined ? 'both' : [...rule.platforms].sort().join('+')
  return `${rule.isRegex ? 're' : 'lit'}:${platforms}:${rule.pattern}`
}

/** Append the imported rules that aren't already present, reporting how many were new. */
function mergeRules(current: BanRule[], incoming: BanRule[]): { rules: BanRule[]; added: number } {
  const seen = new Set(current.map(ruleKey))
  const rules = [...current]
  let added = 0
  for (const rule of incoming) {
    if (!seen.has(ruleKey(rule))) {
      seen.add(ruleKey(rule))
      rules.push(rule)
      added += 1
    }
  }
  return { rules, added }
}

/** Whether a rule applies to a platform (no scoping = both). */
function appliesTo(rule: BanRule, platform: Platform): boolean {
  return rule.platforms === undefined || rule.platforms.length === 0
    ? true
    : rule.platforms.includes(platform)
}

/**
 * Toggle one platform on a rule. Both-on is stored as "no scoping" (`platforms` omitted); turning
 * the last platform off is ignored — a rule that applies nowhere is a trap, delete it instead.
 */
function togglePlatform(rule: BanRule, platform: Platform): BanRule {
  const on = (['twitch', 'youtube'] as Platform[]).filter((p) =>
    p === platform ? !appliesTo(rule, p) : appliesTo(rule, p)
  )
  if (on.length === 0) {
    return rule
  }
  const { platforms: _drop, ...rest } = rule
  return on.length === 2 ? rest : { ...rest, platforms: on }
}

/**
 * Editor for the pre-ban list: known-bad usernames banned automatically on their first message.
 * Off by default; dry-run (log only) by default; every action is surfaced in the column.
 */
export function PrebanSettings({
  settings,
  onRulesChange,
  onToggle
}: PrebanSettingsProps): ReactElement {
  const update = (index: number, patch: Partial<BanRule>): void => {
    onRulesChange((current) =>
      current.map((rule, i) => (i === index ? { ...rule, ...patch } : rule))
    )
  }
  const remove = (index: number): void => {
    onRulesChange((current) => current.filter((_, i) => i !== index))
  }

  // After "+ add", put the caret straight into the new row's pattern input (the row is inserted
  // before the add button in DOM order, so Tab alone can't reach it without backtracking).
  const listRef = useRef<HTMLDivElement>(null)
  const focusNewRowRef = useRef(false)
  useEffect(() => {
    if (focusNewRowRef.current === false) {
      return
    }
    focusNewRowRef.current = false
    const rows = listRef.current?.querySelectorAll<HTMLElement>('.pc-hl-row')
    rows?.[rows.length - 1]?.querySelector<HTMLInputElement>('input.pc-hl-pattern')?.focus()
  })

  const add = (): void => {
    focusNewRowRef.current = true
    onRulesChange((current) => [...current, { pattern: '', isRegex: false }])
  }

  const [status, setStatus] = useState<string | undefined>(undefined)

  async function exportRules(): Promise<void> {
    const result = await window.chat.exportPrebanRules(settings.rules)
    if ('canceled' in result) {
      return
    }
    setStatus(result.ok ? 'exported the pre-ban list' : `export failed: ${result.error}`)
  }

  async function importRules(): Promise<void> {
    const result = await window.chat.importPrebanRules()
    if ('canceled' in result) {
      return
    }
    if (!result.ok) {
      setStatus(`import failed: ${result.error}`)
      return
    }
    const { rules, added } = mergeRules(settings.rules, result.rules)
    onRulesChange(() => rules)
    setStatus(
      added === 0 ? 'no new rules to import' : `imported ${added} rule${added === 1 ? '' : 's'}`
    )
  }

  return (
    <div className="pc-rule-list" ref={listRef}>
      <p className="pc-setting-note">
        Ban known-bad users automatically on their first message, in any chat where your account is
        a moderator (or the streamer). A plain pattern must equal the username or display name
        exactly (case-insensitive; a leading @ is ignored) — only regex rules can match partially.
        Rules can come from another channel's mod team via Import.
      </p>
      <label className="pc-setting">
        <span className="pc-setting-meta">
          <span className="pc-setting-name">enable auto-ban</span>
          <span className="pc-setting-desc">
            Acts on your real account. Off = the list is kept but nothing is ever actioned.
          </span>
        </span>
        <input
          type="checkbox"
          className="pc-switch"
          checked={settings.enabled}
          onChange={(event) => {
            onToggle({ enabled: event.target.checked })
          }}
        />
      </label>
      {settings.enabled ? (
        <label className="pc-setting">
          <span className="pc-setting-meta">
            <span className="pc-setting-name">dry run</span>
            <span className="pc-setting-desc">
              Log what <i>would</i> be banned (as a column notice) without banning anyone. Leave on
              until the list has proven itself; auto-bans are rate-capped either way.
            </span>
          </span>
          <input
            type="checkbox"
            className="pc-switch"
            checked={settings.dryRun}
            onChange={(event) => {
              onToggle({ dryRun: event.target.checked })
            }}
          />
        </label>
      ) : null}
      {settings.enabled && !settings.dryRun ? (
        <div className="pc-warnbox">
          ⚠ Live mode: matching users are banned for real, with your account, on their first
          message. A careless pattern bans innocent people — prefer exact names over regex here.
        </div>
      ) : null}
      {settings.rules.map((rule, index) => (
        // Rows aren't reordered, so the index is a stable enough key for this small editor.
        // eslint-disable-next-line react/no-array-index-key
        <div className="pc-hl-row" key={index}>
          <input
            className={
              rule.pattern !== '' && !isValidPattern(rule.pattern, rule.isRegex)
                ? 'pc-hl-pattern bad'
                : 'pc-hl-pattern'
            }
            value={rule.pattern}
            placeholder="username or @handle"
            aria-label="Pre-ban username pattern"
            title={
              rule.pattern !== '' && !isValidPattern(rule.pattern, rule.isRegex)
                ? 'Invalid or too-long pattern — it will never match'
                : undefined
            }
            onChange={(event) => {
              update(index, { pattern: event.target.value })
            }}
          />
          <label className="pc-hl-flag" title="Treat the pattern as a regular expression">
            <input
              type="checkbox"
              checked={rule.isRegex}
              onChange={(event) => {
                update(index, { isRegex: event.target.checked })
              }}
            />
            regex
          </label>
          <label className="pc-hl-flag" title="Apply on Twitch">
            <input
              type="checkbox"
              checked={appliesTo(rule, 'twitch')}
              onChange={() => {
                onRulesChange((current) =>
                  current.map((r, i) => (i === index ? togglePlatform(r, 'twitch') : r))
                )
              }}
            />
            tw
          </label>
          <label className="pc-hl-flag" title="Apply on YouTube">
            <input
              type="checkbox"
              checked={appliesTo(rule, 'youtube')}
              onChange={() => {
                onRulesChange((current) =>
                  current.map((r, i) => (i === index ? togglePlatform(r, 'youtube') : r))
                )
              }}
            />
            yt
          </label>
          <input
            className="pc-hl-pattern"
            value={rule.note ?? ''}
            placeholder="note (who/why)"
            aria-label="Pre-ban rule note"
            onChange={(event) => {
              const note = event.target.value
              onRulesChange((current) =>
                current.map((rule, i) => {
                  if (i !== index) {
                    return rule
                  }
                  if (note === '') {
                    const { note: _drop, ...rest } = rule
                    return rest
                  }
                  return { ...rule, note }
                })
              )
            }}
          />
          <button
            type="button"
            className="pc-x"
            aria-label="Remove pre-ban rule"
            onClick={() => {
              remove(index)
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="pc-hl-add" onClick={add}>
        + add user
      </button>
      <div className="pc-mod-share">
        <button
          type="button"
          className="pc-mbtn"
          onClick={() => void exportRules()}
          disabled={settings.rules.length === 0}
        >
          export…
        </button>
        <button type="button" className="pc-mbtn" onClick={() => void importRules()}>
          import…
        </button>
        {status !== undefined ? <span className="pc-mod-share-status">{status}</span> : null}
      </div>
      <p className="pc-setting-note">
        Export shares your list as a file for another moderator to import; importing merges in any
        new rules. (A pre-ban file is marked as such — watchlist exports can't be imported here.)
      </p>
    </div>
  )
}
