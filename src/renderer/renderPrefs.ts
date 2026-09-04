import { createContext } from 'react'

/**
 * Settings that change how a chat row renders, provided once at the root so a row deep in a column
 * (or a modal) reads them without every parent threading a prop through. Rows are memoized on their
 * own props; a context change re-renders the consumers regardless.
 */
export interface RenderPrefs {
  /** Show Twitch chat GIFs as images; off shows each GIF's name as text. */
  embedGifs: boolean
}

export const RenderPrefsContext = createContext<RenderPrefs>({ embedGifs: true })
