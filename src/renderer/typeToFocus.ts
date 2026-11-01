/** The parts of a keydown that decide whether it is typing. */
export interface KeyInput {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/** Where keyboard focus is when the key is pressed. */
export interface FocusContext {
  /** An input, textarea, select or contenteditable already has focus — it owns the key. */
  editable: boolean
  /** Focus is inside a menu, dialog or listbox, which handles its own keys. */
  inOverlay: boolean
  /** Focus is on a button or link, where Space activates it rather than typing. */
  activatable: boolean
}

/**
 * True when a keystroke made with no text field focused is the user starting to type a chat
 * message, so it should be routed to the active column's composer instead of being lost.
 *
 * Typing means a printable character (Option/AltGr characters included) or a paste shortcut.
 * Shortcuts (Ctrl/Cmd plus a key), navigation keys and anything aimed at a focused menu, dialog or
 * field are left alone, so global shortcuts and arrow-key tab navigation keep working.
 */
export function routesToComposer(input: KeyInput, focus: FocusContext): boolean {
  if (focus.editable || focus.inOverlay) {
    return false
  }
  const paste =
    (input.ctrlKey || input.metaKey) && !input.altKey && (input.key === 'v' || input.key === 'V')
  if (paste) {
    return true
  }
  // Chromium on Windows reports AltGr as Ctrl+Alt, and AltGr types characters such as `@` on
  // many layouts, so Ctrl+Alt with a printable key is typing, not a shortcut.
  const altGraph = input.ctrlKey && input.altKey && !input.metaKey
  if ((input.ctrlKey || input.metaKey) && !altGraph) {
    return false
  }
  // Named keys (Enter, Tab, ArrowLeft, F5, Process, …) are longer than one code point.
  if ([...input.key].length !== 1) {
    return false
  }
  return !(input.key === ' ' && focus.activatable)
}

/**
 * Marks an overlay (menu, modal, picker) that handles its own keys, so a keystroke made while focus
 * is inside it is never routed to a composer.
 */
export const OWNS_KEYS = 'data-owns-keys'

/** Classify the focused element for {@link routesToComposer}. */
export function focusContext(element: Element | null): FocusContext {
  if (element === null) {
    return { editable: false, inOverlay: false, activatable: false }
  }
  return {
    editable:
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      (element instanceof HTMLElement && element.isContentEditable),
    inOverlay: element.closest(`[${OWNS_KEYS}]`) !== null,
    activatable: element.closest('button, a[href], [role="button"]') !== null
  }
}

/** The column's message composer, when it is rendered and accepting input. */
export function composerFor(columnId: string): HTMLTextAreaElement | undefined {
  const composer = document.querySelector<HTMLTextAreaElement>(
    `textarea[data-composer="${CSS.escape(columnId)}"]`
  )
  return composer === null || composer.disabled ? undefined : composer
}
