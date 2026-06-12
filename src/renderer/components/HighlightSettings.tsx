import { type ReactElement, useEffect, useRef } from 'react'
import type { HighlightRule } from '@shared/model'
import { isValidPattern } from '@renderer/match'

// The ice theme's --warn — the one default that must be a literal hex (it feeds <input type="color">).
const DEFAULT_COLOR = '#ebcb8b'

interface HighlightSettingsProps {
  rules: HighlightRule[]
  /** Apply an edit against the latest rules (a function, so a toggle can't overwrite another edit). */
  onChange: (apply: (rules: HighlightRule[]) => HighlightRule[]) => void
}

/** Editor for the highlight rules: a list of user/keyword patterns with colour and alert toggles. */
export function HighlightSettings({ rules, onChange }: HighlightSettingsProps): ReactElement {
  const update = (index: number, patch: Partial<HighlightRule>): void => {
    onChange((current) => current.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
  }
  const remove = (index: number): void => {
    onChange((current) => current.filter((_, i) => i !== index))
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
    onChange((current) => [...current, { pattern: '', isRegex: false, target: 'user' }])
  }

  return (
    <div className="pc-rule-list" ref={listRef}>
      {rules.length === 0 ? (
        <p className="pc-setting-note">
          Add a user handle/name or a message keyword to be alerted when it appears in chat.
        </p>
      ) : null}
      {rules.map((rule, index) => (
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
            placeholder={rule.target === 'user' ? 'handle or name' : 'keyword'}
            aria-label="Highlight pattern"
            title={
              rule.pattern !== '' && !isValidPattern(rule.pattern, rule.isRegex)
                ? 'Invalid or too-long pattern — it will never match'
                : undefined
            }
            onChange={(event) => {
              update(index, { pattern: event.target.value })
            }}
          />
          <select
            className="pc-hl-target"
            value={rule.target}
            aria-label="Match against"
            onChange={(event) => {
              update(index, { target: event.target.value as HighlightRule['target'] })
            }}
          >
            <option value="user">user</option>
            <option value="message">message</option>
          </select>
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
          <input
            type="color"
            className="pc-hl-color"
            value={rule.color ?? DEFAULT_COLOR}
            aria-label="Highlight colour"
            onChange={(event) => {
              update(index, { color: event.target.value })
            }}
          />
          <label className="pc-hl-flag" title="Flash the column on match">
            <input
              type="checkbox"
              checked={rule.flash ?? true}
              onChange={(event) => {
                update(index, { flash: event.target.checked })
              }}
            />
            flash
          </label>
          <label className="pc-hl-flag" title="Play a sound on match">
            <input
              type="checkbox"
              checked={rule.sound ?? true}
              onChange={(event) => {
                update(index, { sound: event.target.checked })
              }}
            />
            sound
          </label>
          <label className="pc-hl-flag" title="Also show a system notification on match">
            <input
              type="checkbox"
              checked={rule.notify ?? false}
              onChange={(event) => {
                update(index, { notify: event.target.checked })
              }}
            />
            notify
          </label>
          <button
            type="button"
            className="pc-x"
            aria-label="Remove highlight"
            onClick={() => {
              remove(index)
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="pc-hl-add" onClick={add}>
        + add highlight
      </button>
    </div>
  )
}
