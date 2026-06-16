const SYSTEM_REMINDER_TAG_RE = /<\s*\/?\s*system-reminder\b[^>]*>/giu;
const HIDDEN_TEXT_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu;

export function sanitizeSystemReminderContent(value: string): string {
  return value
    .replace(SYSTEM_REMINDER_TAG_RE, "<neutralized-system-reminder-tag>")
    .replace(HIDDEN_TEXT_RE, " ");
}
