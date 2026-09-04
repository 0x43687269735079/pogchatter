import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  buildFromTemplate: vi.fn()
}))

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: electron.buildFromTemplate }
}))

import { applySpelling, installSpellingMenu } from '@main/spelling'

function fakeSession(): {
  setSpellCheckerLanguages: ReturnType<typeof vi.fn<(languages: string[]) => void>>
  setSpellCheckerEnabled: ReturnType<typeof vi.fn<(enable: boolean) => void>>
  addWordToSpellCheckerDictionary: ReturnType<typeof vi.fn<(word: string) => boolean>>
} {
  return {
    setSpellCheckerLanguages: vi.fn<(languages: string[]) => void>(),
    setSpellCheckerEnabled: vi.fn<(enable: boolean) => void>(),
    addWordToSpellCheckerDictionary: vi.fn<(word: string) => boolean>().mockReturnValue(true)
  }
}

describe('applySpelling', () => {
  it('enables the checker and sets the dictionary language on non-macOS platforms', () => {
    const session = fakeSession()

    applySpelling(session, 'en-GB', 'linux')

    expect(session.setSpellCheckerLanguages).toHaveBeenCalledWith(['en-GB'])
    expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(true)
  })

  it('enables the checker but never sets languages on macOS (documented no-op there)', () => {
    const session = fakeSession()

    applySpelling(session, 'en-GB', 'darwin')

    expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(true)
    expect(session.setSpellCheckerLanguages).not.toHaveBeenCalled()
  })

  it('disables the checker for "off" and never sets languages', () => {
    const session = fakeSession()

    applySpelling(session, 'off', 'linux')

    expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
    expect(session.setSpellCheckerLanguages).not.toHaveBeenCalled()
  })
})

interface FakeParams {
  isEditable: boolean
  misspelledWord: string
  dictionarySuggestions: string[]
}

function fakeWebContents(): {
  on: ReturnType<typeof vi.fn>
  replaceMisspelling: ReturnType<typeof vi.fn>
  fire: (params: FakeParams) => void
} {
  const handlers = new Map<string, (event: unknown, params: FakeParams) => void>()
  const on = vi.fn((event: string, fn: (event: unknown, params: FakeParams) => void) => {
    handlers.set(event, fn)
  })
  return {
    on,
    replaceMisspelling: vi.fn(),
    fire: (params: FakeParams) => {
      const handler = handlers.get('context-menu')
      if (handler === undefined) {
        throw new Error('installSpellingMenu did not subscribe to context-menu')
      }
      handler({}, params)
    }
  }
}

function fakeDictionarySession(): {
  addWordToSpellCheckerDictionary: ReturnType<typeof vi.fn<(word: string) => boolean>>
} {
  return {
    addWordToSpellCheckerDictionary: vi.fn<(word: string) => boolean>().mockReturnValue(true)
  }
}

describe('installSpellingMenu', () => {
  let popup: ReturnType<typeof vi.fn>

  beforeEach(() => {
    popup = vi.fn()
    electron.buildFromTemplate.mockReset()
    electron.buildFromTemplate.mockImplementation((template: unknown) => ({
      template,
      popup
    }))
  })

  it('builds no menu when there is no misspelled word', () => {
    const webContents = fakeWebContents()
    const session = fakeDictionarySession()
    installSpellingMenu(webContents as never, session)

    webContents.fire({ isEditable: true, misspelledWord: '', dictionarySuggestions: [] })

    expect(electron.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('builds no menu when the field is not editable', () => {
    const webContents = fakeWebContents()
    const session = fakeDictionarySession()
    installSpellingMenu(webContents as never, session)

    webContents.fire({
      isEditable: false,
      misspelledWord: 'colour',
      dictionarySuggestions: ['color']
    })

    expect(electron.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('builds a suggestions menu with a replace item and an add-to-dictionary item', () => {
    const webContents = fakeWebContents()
    const session = fakeDictionarySession()
    installSpellingMenu(webContents as never, session)

    webContents.fire({
      isEditable: true,
      misspelledWord: 'colour',
      dictionarySuggestions: ['color']
    })

    expect(electron.buildFromTemplate).toHaveBeenCalledTimes(1)
    const template = electron.buildFromTemplate.mock.calls[0]?.[0] as Array<{
      label?: string
      click?: () => void
    }>
    const suggestionItem = template.find((item) => item.label === 'color')
    expect(suggestionItem).toBeDefined()
    suggestionItem?.click?.()
    expect(webContents.replaceMisspelling).toHaveBeenCalledWith('color')

    const addItem = template.find((item) => item.label === 'Add to dictionary')
    expect(addItem).toBeDefined()
    addItem?.click?.()
    expect(session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('colour')

    expect(popup).toHaveBeenCalledTimes(1)
  })
})
