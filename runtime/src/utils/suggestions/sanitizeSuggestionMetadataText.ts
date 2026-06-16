import stripAnsi from 'strip-ansi'
import { sanitizeSystemReminderContent } from '../../prompts/attachments/system-reminder-sanitizer.js'

export function sanitizeSuggestionMetadataText(value: string): string {
  return sanitizeSystemReminderContent(stripAnsi(value))
    .replace(/\s+/gu, ' ')
    .trim()
}
