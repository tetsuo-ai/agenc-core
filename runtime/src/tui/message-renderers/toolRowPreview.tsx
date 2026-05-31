import React from 'react'
import type { StructuredPatchHunk } from 'diff'
import type { ReactNode } from 'react'
import { getPatchForEdit } from '../../tools/FileEditTool/utils.js'
import { expandPath } from '../../utils/path.js'
import { readFileSyncCached } from '../../utils/file.js'
import { logError } from '../../utils/log.js'
import { DiffInline, type ToolKind } from '../components/v2/primitives.js'
import ThemedText from '../components/design-system/ThemedText.js'

/** Width cap for an individual previewed result line (keeps the gutter tidy). */
const MAX_LINE_WIDTH = 120
/** Default number of result lines surfaced inline under a call row. */
const DEFAULT_MAX_LINES = 6
/** Number of changed diff rows shown inline before collapsing to "… +N more". */
const MAX_DIFF_LINES = 8

/**
 * Canonical tool names whose RESULT is owned by the inline call-row preview.
 * Keyed off the exact tool name (not a fuzzy kind) so the detached
 * UserToolSuccessMessage only suppresses itself for these specific tools and
 * never for unrelated ones that happen to fuzzy-match a kind.
 */
const INLINE_PREVIEW_TOOL_NAMES = new Set<string>([
  'Read',
  'FileRead',
  'Bash',
  'Grep',
  'Edit',
  'MultiEdit',
  'Write',
])

/** True when the call row owns the inline result preview for this tool name. */
export function toolNameOwnsInlinePreview(name: string | undefined): boolean {
  return name !== undefined && INLINE_PREVIEW_TOOL_NAMES.has(name)
}

function truncateWidth(line: string): string {
  if (line.length <= MAX_LINE_WIDTH) return line
  return `${line.slice(0, MAX_LINE_WIDTH - 1)}…`
}

/** Strip the BashTool structured wrapper ({exitCode,stdout,...}) if present. */
function unwrapBashResult(raw: string): { text: string; isError: boolean } {
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as {
        stdout?: unknown
        stderr?: unknown
        exitCode?: unknown
        code?: unknown
      }
      if (parsed && typeof parsed === 'object' && 'stdout' in parsed) {
        const stdout = typeof parsed.stdout === 'string' ? parsed.stdout : ''
        const stderr = typeof parsed.stderr === 'string' ? parsed.stderr : ''
        const exit =
          typeof parsed.exitCode === 'number'
            ? parsed.exitCode
            : typeof parsed.code === 'number'
              ? parsed.code
              : 0
        const isError = exit !== 0
        const text = isError && stderr ? `${stdout}\n${stderr}`.trim() : stdout
        return { text, isError }
      }
    } catch {
      // not JSON — fall through and treat as plain text
    }
  }
  return { text: raw, isError: false }
}

function capLines(text: string, maxLines: number): string {
  const lines = text
    .replace(/\s+$/, '')
    .split('\n')
    .map(truncateWidth)
  if (lines.length <= maxLines) return lines.join('\n')
  const shown = lines.slice(0, maxLines)
  const remaining = lines.length - maxLines
  return `${shown.join('\n')}\n… +${remaining} ${remaining === 1 ? 'line' : 'lines'}`
}

/**
 * Build a compact, capped RESULT preview shown behind the `⎿` gutter under a
 * tool call row (codex `output_lines` / `format_and_truncate_tool_result`
 * convention). Returns null when there is no meaningful preview to show.
 */
export function successToolRowPreview(
  kind: ToolKind,
  rawResult: string | null,
  maxLines: number = DEFAULT_MAX_LINES,
): string | null {
  if (rawResult === null) return null
  const result = rawResult.trim()
  if (result.length === 0) return null

  if (kind === 'read') {
    // The Read tool's model-facing result is the file body in `cat -n` form;
    // there is no "Read N lines" header, so honor one if present else count.
    const header = result.match(/Read\s+(\d+)\s+lines?/i)
    if (header) return `Read ${header[1]} lines`
    const count = result.split('\n').length
    return `Read ${count} ${count === 1 ? 'line' : 'lines'}`
  }

  if (kind === 'bash') {
    const { text, isError } = unwrapBashResult(rawResult)
    const body = text.trim()
    if (body.length === 0) {
      return isError ? '(no output, non-zero exit)' : '(no output)'
    }
    return capLines(body, maxLines)
  }

  if (kind === 'grep') {
    // Honor an explicit count line, otherwise count the match lines we got.
    const found = result.match(/Found\s+(\d+)\s+match/i)
    if (found) return `Found ${found[1]} ${found[1] === '1' ? 'match' : 'matches'}`
    const numMatches = result.match(/(\d+)\s+match(?:es)?/i)
    if (numMatches) {
      return `Found ${numMatches[1]} ${numMatches[1] === '1' ? 'match' : 'matches'}`
    }
    const lines = result.split('\n').filter(line => line.trim().length > 0)
    if (lines.length === 0) return 'No matches'
    if (lines.length <= maxLines) {
      return `Found ${lines.length} ${lines.length === 1 ? 'match' : 'matches'}`
    }
    return capLines(result, maxLines)
  }

  // Default / other read-style tools: first maxLines lines, capped.
  return capLines(result, maxLines)
}

/**
 * Build the inline edit-row preview: a header summary "(+a -r)" plus a compact
 * green/red diff body, capped to a handful of changed lines. Reads the current
 * on-disk file to synthesize the before/after patch (best-effort: a missing
 * file is treated as an empty before, which is the create/Write case).
 */
export function buildEditRowPreview(
  toolName: string,
  input: unknown,
): { stats: string; node: ReactNode } | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const filePath =
    typeof record.file_path === 'string' ? record.file_path : undefined
  if (!filePath) return null

  let beforeContent = ''
  try {
    beforeContent = readFileSyncCached(expandPath(filePath))
  } catch {
    beforeContent = ''
  }

  let patch: StructuredPatchHunk[]
  try {
    if (typeof record.content === 'string') {
      // Write: synthesize a before/after diff against the new full content.
      patch = getPatchForEdit({
        filePath,
        fileContents: '',
        oldString: '',
        newString: record.content,
      }).patch
    } else if (
      typeof record.old_string === 'string' &&
      typeof record.new_string === 'string'
    ) {
      // Edit: the file has already been written by the time the result renders,
      // so reconstruct the BEFORE by reversing the edit on the current content.
      const after = beforeContent
      const beforeReconstructed =
        record.old_string === ''
          ? ''
          : after.replace(record.new_string, () => record.old_string as string)
      patch = getPatchForEdit({
        filePath,
        fileContents: beforeReconstructed,
        oldString: record.old_string,
        newString: record.new_string,
        replaceAll:
          typeof record.replace_all === 'boolean' ? record.replace_all : false,
      }).patch
    } else if (Array.isArray(record.edits)) {
      // MultiEdit: approximate with the first edit's before/after.
      const first = record.edits[0] as
        | { old_string?: unknown; new_string?: unknown }
        | undefined
      if (
        !first ||
        typeof first.old_string !== 'string' ||
        typeof first.new_string !== 'string'
      ) {
        return null
      }
      const after = beforeContent
      const beforeReconstructed =
        first.old_string === ''
          ? ''
          : after.replace(first.new_string, () => first.old_string as string)
      patch = getPatchForEdit({
        filePath,
        fileContents: beforeReconstructed,
        oldString: first.old_string,
        newString: first.new_string,
      }).patch
    } else {
      return null
    }
  } catch (error) {
    logError(
      new Error(`Failed to build edit preview for ${toolName}: ${String(error)}`),
    )
    return null
  }

  let additions = 0
  let removals = 0
  const allLines: { kind: 'add' | 'rem' | 'ctx'; code: string }[] = []
  for (const hunk of patch) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        additions++
        allLines.push({ kind: 'add', code: truncateWidth(line.slice(1)) })
      } else if (line.startsWith('-')) {
        removals++
        allLines.push({ kind: 'rem', code: truncateWidth(line.slice(1)) })
      }
    }
  }

  if (allLines.length === 0) return null

  const stats = `+${additions} -${removals}`
  // Cap aggressively — edit diffs are noisy.
  const shown = allLines.slice(0, MAX_DIFF_LINES)
  const remaining = allLines.length - shown.length
  const diffLines = shown.map(line => ({ kind: line.kind, code: line.code }))

  const node = (
    <>
      <DiffInline file={filePath} stats={stats} lines={diffLines} />
      {remaining > 0 ? (
        <ThemedText color="muted3">
          {`… +${remaining} more ${remaining === 1 ? 'line' : 'lines'}`}
        </ThemedText>
      ) : null}
    </>
  )
  return { stats, node }
}

/**
 * Per-tool human-readable arg summary for the "Tool(<args>)" row. Never dumps
 * raw JSON. Falls back to a readable key=value rendering of known fields.
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
