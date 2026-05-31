import type { ToolKind } from '../components/v2/primitives.js'

/**
 * Per-tool human-readable arg summary for the "Tool(<args>)" call row. Never
 * dumps raw JSON. Falls back to a readable key=value rendering of known scalar
 * fields.
 *
 * In the live daemon path the thin-client tool's renderToolUseMessage
 * (tool-rendering.tsx) already produces the readable args, so this is only the
 * fallback when that returns an empty string (e.g. a tool with no registered
 * renderer). The capped RESULT preview is produced separately by the
 * thin-client renderToolResultMessage, rendered once by the adjacent
 * UserToolSuccessMessage — there is no inline-on-call-row preview here.
 */
export function summarizeToolInput(input: unknown, kind?: ToolKind): string {
  if (!input || typeof input !== 'object') {
    return typeof input === 'string' ? input : ''
  }
  const record = input as Record<string, unknown>

  // Grep / search: "<pattern>" in <path>, ignoring -A/-B/flags.
  if (kind === 'grep' || typeof record.pattern === 'string') {
    const pattern =
      typeof record.pattern === 'string'
        ? record.pattern
        : typeof record.query === 'string'
          ? record.query
          : undefined
    if (pattern) {
      const path =
        typeof record.path === 'string'
          ? record.path
          : typeof record.glob === 'string'
            ? record.glob
            : undefined
      return `"${pattern}"${path ? ` in ${path}` : ''}`
    }
  }

  // Read / Edit / Write: the file path.
  if (typeof record.file_path === 'string' && record.file_path.trim()) {
    return record.file_path
  }
  if (typeof record.path === 'string' && record.path.trim()) {
    return record.path
  }

  // Bash / Run: the command.
  if (typeof record.command === 'string' && record.command.trim()) {
    return record.command
  }

  // Known single-value fields.
  for (const key of ['query', 'url', 'prompt', 'description']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }

  // Generic: readable key=value of known scalar keys — NEVER a raw JSON dump.
  const parts: string[] = []
  for (const [key, value] of Object.entries(record)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      const str = String(value)
      if (str.trim().length === 0) continue
      parts.push(`${key}=${str.length > 40 ? `${str.slice(0, 39)}…` : str}`)
    }
    if (parts.length >= 3) break
  }
  return parts.join(' ')
}
