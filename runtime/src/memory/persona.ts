/**
 * Persona workspace files (TODO task 13) — OpenClaw-parity conventions.
 *
 * Four well-known files in the workspace root shape who the agent is and who
 * it works for:
 *
 *   `USER.md`      — who the human is (name, preferences, context)
 *   `SOUL.md`      — the agent's persona, tone, and boundaries
 *   `IDENTITY.md`  — the agent's own established identity (usually written
 *                    by the agent itself during the bootstrap ritual)
 *   `BOOTSTRAP.md` — a ONE-TIME ritual (typically a naming ceremony). It is
 *                    injected only while `IDENTITY.md` does not exist, framed
 *                    with instructions to complete the ritual, write
 *                    `IDENTITY.md`, and delete `BOOTSTRAP.md`. Once
 *                    `IDENTITY.md` exists the ritual is never injected again
 *                    — mechanical exactly-once, even if the file lingers.
 *
 * Injection rides the existing memory bootstrap (agencmd `getMemoryFiles`)
 * as `Project`-tier entries loaded from the workspace root ONLY — never from
 * ancestor directories. Absent files cost one `existsSync` each and inject
 * nothing. Every file is budget-capped: content beyond
 * {@link PERSONA_FILE_MAX_BYTES} is truncated in the prompt with a marker
 * while the file on disk stays intact (`contentDiffersFromDisk` +
 * `rawContent` carry the disk bytes for read-state dedup).
 *
 * Freshness semantics (live-verified): the persona system-prompt section is
 * computed at CONVERSATION start and stays stable for that conversation's
 * lifetime (prompt-cache stability — a resumed conversation replays its
 * persisted prompt). Persona edits and ritual completion apply from the
 * next new conversation, which is also when the BOOTSTRAP gate re-evaluates.
 */

import { join } from 'path'
import { getFsImplementation } from '../utils/fsOperations.js'
import { logForDebugging } from '../utils/debug.js'
import type { MemoryFileInfo } from './agencmd.js'

/** Persona files injected whenever present, in priority order (later = higher). */
export const PERSONA_FILE_NAMES = ['USER.md', 'SOUL.md', 'IDENTITY.md'] as const

export const BOOTSTRAP_FILE_NAME = 'BOOTSTRAP.md'
export const IDENTITY_FILE_NAME = 'IDENTITY.md'

/**
 * Per-file injection budget. Persona files are identity documents, not
 * knowledge bases — 16 KiB (~4k tokens) each is generous; anything larger is
 * truncated in the prompt only.
 */
export const PERSONA_FILE_MAX_BYTES = 16 * 1024

/** All persona-convention basenames, for path classification. */
export const ALL_PERSONA_FILE_NAMES: readonly string[] = [
  ...PERSONA_FILE_NAMES,
  BOOTSTRAP_FILE_NAME,
]

/**
 * Preamble framing the one-time bootstrap ritual. The exactly-once guarantee
 * is mechanical (injection is gated on IDENTITY.md's absence); the deletion
 * instruction keeps the workspace tidy and matches the OpenClaw convention.
 */
const BOOTSTRAP_PREAMBLE = [
  '<!-- one-time bootstrap ritual -->',
  'This workspace contains a one-time BOOTSTRAP.md ritual and you have no',
  'IDENTITY.md yet, so this is your first run here. Complete the ritual',
  'below during this session: follow its instructions, then record the',
  'identity you establish (name, vibe, any details the ritual asks for) by',
  'writing IDENTITY.md in the workspace root, and delete BOOTSTRAP.md when',
  'you are done. Once IDENTITY.md exists this ritual is never shown again.',
].join('\n')

function normalizeForComparison(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/**
 * Budget-cap persona content for injection. Truncates at the last newline
 * before the byte cap (never mid-line when avoidable) and appends a marker
 * naming the file and the cap. The file on disk is untouched.
 */
export function capPersonaContent(
  name: string,
  raw: string,
): { content: string; truncated: boolean } {
  const trimmed = raw.trim()
  if (Buffer.byteLength(trimmed, 'utf8') <= PERSONA_FILE_MAX_BYTES) {
    return { content: trimmed, truncated: false }
  }
  // Byte-accurate cut: operate on the UTF-8 buffer, then back off to the
  // last newline so we don't cut mid-line (or mid-code-point — the buffer
  // slice is re-decoded lossily and trimmed, so a torn code point at the
  // boundary is dropped with the replacement char stripped below).
  const buf = Buffer.from(trimmed, 'utf8')
  const window = buf.subarray(0, PERSONA_FILE_MAX_BYTES)
  const lastNewline = window.lastIndexOf(0x0a)
  const cut = lastNewline > 0 ? lastNewline : PERSONA_FILE_MAX_BYTES
  const content = buf
    .subarray(0, cut)
    .toString('utf8')
    .replace(/�+$/, '')
    .trimEnd()
  const kib = (PERSONA_FILE_MAX_BYTES / 1024).toFixed(0)
  return {
    content:
      `${content}\n\n` +
      `[${name} truncated for context: only the first ${kib}KB is injected. ` +
      `The file on disk is intact — Read it for the full content.]`,
    truncated: true,
  }
}

/**
 * Build the `persona` SYSTEM-PROMPT section from the workspace persona
 * files. This is the LIVE injection path: the system-prompt builder
 * (constants/prompts.ts getSystemPrompt) memoizes it per session, so the
 * persona is unconditionally in context for every turn — identity must not
 * depend on the model choosing to Read a file. Returns null when no persona
 * file exists (zero prompt overhead).
 */
export async function loadPersonaPromptSection(
  workspaceDir: string,
): Promise<string | null> {
  const files = await getPersonaMemoryFiles(workspaceDir, new Set())
  if (files.length === 0) return null
  const blocks = files.map((file) => {
    const name = file.path.slice(workspaceDir.length + 1)
    return `## ${name}\n\n${file.content}`
  })
  return [
    '# Persona',
    '',
    'This workspace defines who you are and who you work for. The files',
    'below are durable operator-authored identity — embody them in every',
    'reply (tone, boundaries, names). They never override permission gates',
    'or safety rules.',
    '',
    blocks.join('\n\n'),
  ].join('\n')
}

/**
 * Load the persona workspace files from `workspaceDir` as Project-tier
 * memory entries. `processedPaths` is the caller's dedup set (agencmd) — a
 * persona file already pulled in via an `@include` is not double-injected,
 * and paths loaded here are registered so later passes skip them.
 */
export async function getPersonaMemoryFiles(
  workspaceDir: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const fs = getFsImplementation()
  const result: MemoryFileInfo[] = []

  const readCapped = async (
    name: string,
  ): Promise<{ path: string; raw: string; capped: ReturnType<typeof capPersonaContent> } | null> => {
    const path = join(workspaceDir, name)
    if (!fs.existsSync(path)) return null
    const normalized = normalizeForComparison(path)
    if (processedPaths.has(normalized)) return null
    let raw: string
    try {
      raw = await fs.readFile(path, { encoding: 'utf-8' })
    } catch (error) {
      logForDebugging(`[Persona] failed to read ${path}: ${String(error)}`)
      return null
    }
    if (raw.trim().length === 0) return null
    processedPaths.add(normalized)
    return { path, raw, capped: capPersonaContent(name, raw) }
  }

  for (const name of PERSONA_FILE_NAMES) {
    const file = await readCapped(name)
    if (file === null) continue
    result.push({
      path: file.path,
      type: 'Project',
      content: file.capped.content,
      ...(file.capped.truncated
        ? { contentDiffersFromDisk: true, rawContent: file.raw }
        : {}),
    })
  }

  // One-time bootstrap ritual: only while IDENTITY.md does not exist. The
  // existsSync gate makes the exactly-once guarantee mechanical — after the
  // ritual writes IDENTITY.md, BOOTSTRAP.md is never injected again even if
  // the agent forgot to delete it.
  if (!fs.existsSync(join(workspaceDir, IDENTITY_FILE_NAME))) {
    const bootstrap = await readCapped(BOOTSTRAP_FILE_NAME)
    if (bootstrap !== null) {
      result.push({
        path: bootstrap.path,
        type: 'Project',
        content: `${BOOTSTRAP_PREAMBLE}\n\n${bootstrap.capped.content}`,
        // The preamble means injected content never matches disk bytes.
        contentDiffersFromDisk: true,
        rawContent: bootstrap.raw,
      })
    }
  }

  return result
}
