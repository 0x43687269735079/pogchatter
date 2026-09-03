import type { MenuItemConstructorOptions, Session, WebContents } from 'electron'
import { Menu } from 'electron'
import type { AppSettings } from '@shared/model'

/**
 * Applies the user's spelling setting to a session's built-in spell-checker.
 *
 * `'off'` disables the checker outright. Otherwise the checker is enabled and, on every platform
 * except macOS, `setSpellCheckerLanguages` selects the Hunspell dictionary for the chosen dialect.
 * On macOS that call is a documented no-op — the OS spell-checker owns the language there — so it
 * is skipped rather than made and silently ignored.
 *
 * @param session - Electron session (or a minimal stand-in) whose spell-checker to configure.
 * @param value - The persisted `AppSettings.spelling` value.
 * @param platform - Defaults to `process.platform`; overridable for tests.
 */
export function applySpelling(
  session: Pick<Session, 'setSpellCheckerLanguages' | 'setSpellCheckerEnabled'>,
  value: AppSettings['spelling'],
  platform: NodeJS.Platform = process.platform
): void {
  if (value === 'off') {
    session.setSpellCheckerEnabled(false)
    return
  }
  session.setSpellCheckerEnabled(true)
  if (platform !== 'darwin') {
    session.setSpellCheckerLanguages([value])
  }
}

/**
 * Wires up the spell-checker's right-click suggestions menu on a `webContents`.
 *
 * Listens for `context-menu` and, only when the click landed on a misspelled word in an editable
 * field, builds a native menu: one item per Hunspell suggestion (click replaces the misspelling),
 * a separator, then "Add to dictionary". Any other right-click — not editable, not misspelled, no
 * suggestions available yet — is left alone so the app's own React context menus keep working.
 *
 * @param webContents - The webContents to attach the listener to.
 * @param session - Electron session (or a minimal stand-in) used to add words to the dictionary.
 */
export function installSpellingMenu(
  webContents: WebContents,
  session: Pick<Session, 'addWordToSpellCheckerDictionary'>
): void {
  webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable || params.misspelledWord === '') {
      return
    }
    const template: MenuItemConstructorOptions[] = params.dictionarySuggestions.map(
      (suggestion) => ({
        label: suggestion,
        click: () => webContents.replaceMisspelling(suggestion)
      })
    )
    if (template.length > 0) {
      template.push({ type: 'separator' })
    }
    template.push({
      label: 'Add to dictionary',
      click: () => session.addWordToSpellCheckerDictionary(params.misspelledWord)
    })
    const menu = Menu.buildFromTemplate(template)
    menu.popup()
  })
}
