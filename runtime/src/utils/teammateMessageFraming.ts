import { TEAMMATE_MESSAGE_TAG } from '../constants/xml.js'
import { sanitizeSystemReminderContent } from '../prompts/attachments/system-reminder-sanitizer.js'

const TEAMMATE_MESSAGE_TAG_RE =
  /<\s*\/?\s*teammate-message\b[^>]*>/giu

function escapeTeammateMessageAttribute(value: string): string {
  return sanitizeSystemReminderContent(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function sanitizeTeammateMessageBody(value: string): string {
  return sanitizeSystemReminderContent(value).replace(
    TEAMMATE_MESSAGE_TAG_RE,
    '<neutralized-teammate-message-tag>',
  )
}

export function formatTeammateMessageForModel(input: {
  from: string
  text: string
  color?: string
  summary?: string
}): string {
  const from = escapeTeammateMessageAttribute(input.from)
  const colorAttr = input.color
    ? ` color="${escapeTeammateMessageAttribute(input.color)}"`
    : ''
  const summaryAttr = input.summary
    ? ` summary="${escapeTeammateMessageAttribute(input.summary)}"`
    : ''
  const text = sanitizeTeammateMessageBody(input.text)
  return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${from}"${colorAttr}${summaryAttr}>\n${text}\n</${TEAMMATE_MESSAGE_TAG}>`
}
