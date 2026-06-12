import type { ChatMessage } from '@shared/model'

// Pattern matching lives in shared/ (the main process's pre-ban auto-mod uses it too); re-exported
// here so renderer modules keep one import site.
export { isValidPattern, matchesPattern } from '@shared/patternMatch'

/** Plain, searchable text of a message (text + mention text + emote codes). */
export function messageText(message: ChatMessage): string {
  return message.fragments
    .map((fragment) => (fragment.type === 'emote' ? fragment.code : fragment.text))
    .join(' ')
}
