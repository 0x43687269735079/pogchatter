import { type ReactElement, useEffect, useRef, useState } from 'react'
import type { ModerationRule, ModerationSettings as Settings } from '@shared/model'
import { isValidPattern } from '@renderer/match'

interface ModerationSettingsProps {
  settings: Settings
  /** Apply an edit against the latest rules (a function, so a toggle can't overwrite another edit). */
  onRulesChange: (apply: (rules: ModerationRule[]) => ModerationRule[]) => void
  onAlertChange: (patch: { sound?: boolean; notify?: boolean }) => void
}

/** A rule's identity for de-duplication: a literal and a regex of the same text are distinct rules. */
function ruleKey(rule: ModerationRule): string {
  return `${rule.isRegex ? 're' : 'lit'}:${rule.pattern}`
}

/** Append the imported rules that aren't already present, reporting how many were new. */
function mergeRules(
  current: ModerationRule[],
  incoming: ModerationRule[]
): { rules: ModerationRule[]; added: number } {
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

/** Editor for the moderation watchlist: words/phrases (or regex) that flag a message for review. */
export function ModerationSettings({
  settings,
  onRulesChange,
  onAlertChange
}: ModerationSettingsProps): ReactElement {
  const update = (index: number, patch: Partial<ModerationRule>): void => {
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

  // Export the watchlist to a JSON file the user picks, so it can be shared with other moderators.
  async function exportRules(): Promise<void> {
    const result = await window.chat.exportModerationRules(settings.rules)
    if ('canceled' in result) {
      return
    }
    setStatus(result.ok ? 'exported the watchlist' : `export failed: ${result.error}`)
  }

  // Import a shared watchlist, merging in any terms not already present.
  async function importRules(): Promise<void> {
    const result = await window.chat.importModerationRules()
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
      added === 0 ? 'no new terms to import' : `imported ${added} term${added === 1 ? '' : 's'}`
    )
  }

  return (
    <div className="pc-rule-list" ref={listRef}>
      <p className="pc-setting-note">
        Flag messages containing any of these terms with a ⚑ for review. Matched against the message
        text.
      </p>
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
            placeholder="word, phrase, or regex"
            aria-label="Moderation term"
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
          <button
            type="button"
            className="pc-x"
            aria-label="Remove term"
            onClick={() => {
              remove(index)
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="pc-hl-add" onClick={add}>
        + add term
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
        Export your watchlist to a JSON file to share with other moderators; importing merges in any
        new terms.
      </p>
      <div className="pc-mod-alerts">
        <label className="pc-hl-flag" title="Play a sound when a message is flagged">
          <input
            type="checkbox"
            checked={settings.sound}
            onChange={(event) => {
              onAlertChange({ sound: event.target.checked })
            }}
          />
          sound
        </label>
        <label
          className="pc-hl-flag"
          title="Also show a system notification when a message is flagged"
        >
          <input
            type="checkbox"
            checked={settings.notify}
            onChange={(event) => {
              onAlertChange({ notify: event.target.checked })
            }}
          />
          notify
        </label>
      </div>
    </div>
  )
}
