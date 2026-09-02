/**
 * Ports the upstream `src/memdir/memdir.ts` prompt flow onto AgenC memory layers.
 *
 * AgenC keeps the upstream truncation behavior and the D-13 layers (global
 * durable memory, project memory and instructions, session-only in-conversation
 * state) but trims the model-facing prompt to what a coding agent needs: when
 * to save, where, the one-fact-per-file frontmatter format, the `MEMORY.md`
 * index, and how to recall. The prompt is split in two so the system prompt
 * assembler can cache it: `instructions` carry no paths and live in the static
 * head, `directories` carry the two memory paths and live in the dynamic tail.
 */
import { feature } from 'bun:bundle'
import { join } from 'path'
import { getFsImplementation } from '../utils/fsOperations.js'
import {
  getAutoMemPath,
  getGlobalMemoryPath,
  getProjectInstructionPath,
  getProjectMemoryPath,
  isAutoMemoryEnabled,
} from './paths.js'

import { getKairosActive, getOriginalCwd } from '../bootstrap/state.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { isReplModeEnabled } from '../tools/REPLTool/constants.js'
import { logForDebugging } from '../utils/debug.js'
import { hasEmbeddedSearchTools } from '../utils/embeddedTools.js'
import { formatFileSize } from '../utils/format.js'
import { getProjectDir } from '../utils/sessionStorage.js'
import { getSessionCoworkMemoryExtraGuidelines } from '../session/runtime-options.js'
import { MEMORY_TYPES, WHAT_NOT_TO_SAVE_SECTION } from './types.js'

export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
// ~125 chars/line at 200 lines. At p97 today; catches long-line indexes that
// slip past the line cap (p100 observed: 197KB under 200 lines).
export const MAX_ENTRYPOINT_BYTES = 25_000
const AUTO_MEM_DISPLAY_NAME = 'auto memory'

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

/**
 * Truncate MEMORY.md content to the line AND byte caps, appending a warning
 * that names which cap fired. Line-truncates first (natural boundary), then
 * byte-truncates at the last newline before the cap so we don't cut mid-line.
 *
 * Shared by memory prompt loaders and agencmd getMemoryFiles (previously
 * duplicated the line-only logic).
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split('\n')
  const lineCount = contentLines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  // Check original byte count — long lines are the failure mode the byte cap
  // targets, so post-line-truncation size would understate the warning.
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    }
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatFileSize(byteCount)}`

  return {
    content:
      truncated +
      `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

/**
 * Shared guidance text appended to each memory directory prompt line.
 * Shipped because AgenC was burning turns on `ls`/`mkdir -p` before writing.
 * Harness guarantees the directory exists via ensureMemoryDirExists().
 */
export const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'
export const DIRS_EXIST_GUIDANCE =
  'These directories already exist — write to them directly with the Write tool (do not run mkdir or check for their existence).'

/** The two halves of the memory prompt; see the module comment. */
export interface MemoryPromptSections {
  /** Path-free instructions for the cacheable static head. */
  readonly instructions: string
  /** Memory directory paths (and per-session guidance) for the dynamic tail. */
  readonly directories: string
}

/**
 * Ensure a memory directory exists. Idempotent — called from loadMemoryPrompt
 * (once per session via systemPromptSection cache) so the model can always
 * write without checking existence first. FsOperations.mkdir is recursive
 * by default and already swallows EEXIST, so the full parent chain
 * (~/.agenc/projects/<slug>/memory/) is created in one call with no
 * try/catch needed for the happy path.
 */
async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  const fs = getFsImplementation()
  try {
    await fs.mkdir(memoryDir)
  } catch (e) {
    // fs.mkdir already handles EEXIST internally. Anything reaching here is
    // a real problem (EACCES/EPERM/EROFS) — log so --debug shows why. Prompt
    // building continues either way; the model's Write will surface the
    // real perm error (and FileWriteTool does its own mkdir of the parent).
    const code =
      e instanceof Error && 'code' in e && typeof e.code === 'string'
        ? e.code
        : undefined
    logForDebugging(
      `ensureMemoryDirExists failed for ${memoryDir}: ${code ?? String(e)}`,
      { level: 'debug' },
    )
  }
}

export function buildSessionMemoryLayerLines(): string[] {
  return [
    '### Session memory',
    '',
    'Session memory is the in-conversation state for the current thread: user messages, assistant replies, tool results, plans, and tasks. It is already visible in the active conversation and should not be copied into durable memory unless it will still matter in future conversations.',
    '',
  ]
}

export function buildMemoryLayerLines(projectMemoryDir = getProjectMemoryPath()): string[] {
  return [
    '## Memory layers',
    '',
    `- Global memory: durable user-level memory shared across projects at \`${getGlobalMemoryPath()}\`.`,
    `- Project memory: durable project-level memory at \`${projectMemoryDir}\` plus project instructions from \`${getProjectInstructionPath()}\`.`,
    '- Session memory: in-conversation state for this current thread. Use plans, tasks, and normal conversation context for information that only matters during this session.',
    '',
  ]
}

/**
 * Shell or tool form of a memory search, without a concrete directory so the
 * text stays byte-stable across sessions (the directories are listed in the
 * dynamic tail).
 */
function memorySearchExample(): string {
  return hasEmbeddedSearchTools() || isReplModeEnabled()
    ? '`grep -rn "<term>" <memory directory> --include="*.md"`'
    : `${GREP_TOOL_NAME} with pattern="<term>" path="<memory directory>" glob="*.md"`
}

/**
 * Path-free memory instructions for the cacheable static head of the system
 * prompt: when to save, where, the one-fact-per-file frontmatter format, the
 * `MEMORY.md` index, and how to recall. Roughly 650 tokens.
 */
export function buildMemoryInstructionLines(): string[] {
  return [
    `# ${AUTO_MEM_DISPLAY_NAME}`,
    '',
    `You have persistent, file-based memory directories: a global memory directory for user-level facts that apply across projects, and a project memory directory for facts about this repository. Their paths are listed under "Memory directories" in this prompt. Each directory already exists and holds one markdown file per memory plus a \`${ENTRYPOINT_NAME}\` index.`,
    '',
    '## When to save',
    '- When the user asks you to remember something, save it immediately. When they ask you to forget something, delete the memory file and its index line.',
    '- Save facts about the user (role, expertise, how they want to work), feedback (corrections and approaches the user confirmed, with the reason), project context that is not in the code (decisions and why, deadlines, incidents, who owns what), and references (where things live in external systems).',
    '- Do not save code patterns, architecture, file paths, git history, fix recipes, anything already in AGENC.md, or in-progress task state; these are derivable from the repository. If the user asks you to save an activity log or PR list, ask what was surprising or non-obvious about it and save that.',
    '',
    '## How to save',
    'One fact per file. Write `<topic>.md` in the matching directory with this frontmatter, then the fact:',
    '```markdown',
    '---',
    'name: {{short name}}',
    'description: {{one line used to judge relevance in later sessions, be specific}}',
    `type: {{${MEMORY_TYPES.join(', ')}}}`,
    '---',
    '',
    '{{the fact; for feedback and project memories add a **Why:** line and a **How to apply:** line}}',
    '```',
    `Then add one line to that directory's \`${ENTRYPOINT_NAME}\` index: \`- [Title](topic.md): one-line hook\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory: one line per file, no frontmatter, under 150 characters per line, and only its first ${MAX_ENTRYPOINT_LINES} lines are loaded. Before writing, check for an existing file on the topic and update or delete it instead of adding a duplicate.`,
    '',
    '## How to recall',
    `- Both \`${ENTRYPOINT_NAME}\` indexes are loaded into your context, and memories that match the current request may be attached to a turn. When an index line looks relevant, read that file. You must check memory when the user asks you to check, recall, or remember something.`,
    `- To search memory: ${memorySearchExample()}.`,
    '- A memory is a claim about the past. Before recommending a file, function, or flag it names, verify it still exists; trust what you observe now and fix or delete the stale memory.',
    '- If the user says to ignore memory, proceed as if the indexes were empty and do not mention memory content.',
  ]
}

/**
 * The memory directory block for the dynamic tail: the two durable paths,
 * the session layer, and any per-session guidance a host injected.
 */
export function buildMemoryDirectoryLines(
  projectMemoryDir = getProjectMemoryPath(),
  extraGuidelines?: readonly string[],
): string[] {
  return [
    '# Memory directories',
    '',
    `- Global memory (user-level, shared across projects): \`${getGlobalMemoryPath()}\``,
    `- Project memory (this repository, shared by its git worktrees): \`${projectMemoryDir}\``,
    '- Session memory is the current conversation: use plans and tasks for state that only matters in this session.',
    '',
    'These directories already exist. Write to them directly with the Write tool; do not run mkdir or check for their existence.',
    ...(extraGuidelines !== undefined && extraGuidelines.length > 0
      ? ['', ...extraGuidelines]
      : []),
  ]
}

/**
 * Assistant-mode daily-log prompt. Gated behind feature('KAIROS').
 *
 * Assistant sessions are effectively perpetual, so the agent writes memories
 * append-only to a date-named log file rather than maintaining MEMORY.md as
 * a live index. A separate nightly /dream skill distills logs into topic
 * files + MEMORY.md. MEMORY.md is still loaded into context (via agencmd.ts)
 * as the distilled index — this prompt only changes where NEW memories go.
 */
function buildAssistantDailyLogPrompt(skipIndex = false): string {
  const projectMemoryDir = getAutoMemPath()
  const globalMemoryDir = getGlobalMemoryPath()
  // Describe the path as a pattern rather than inlining today's literal path:
  // this prompt is cached by systemPromptSection('memory', ...) and NOT
  // invalidated on date change. The model derives the current date from the
  // date_change attachment (appended at the tail on midnight rollover) rather
  // than the user-context message — the latter is intentionally left stale to
  // preserve the prompt cache prefix across midnight.
  const logPathPattern = join(
    projectMemoryDir,
    'logs',
    'YYYY',
    'MM',
    'YYYY-MM-DD.md',
  )

  const lines: string[] = [
    '# auto memory',
    '',
    `You have persistent, file-based memory directories: global memory at \`${globalMemoryDir}\` and project memory at \`${projectMemoryDir}\`. ${DIRS_EXIST_GUIDANCE}`,
    '',
    ...buildMemoryLayerLines(projectMemoryDir),
    '## Where to save memories',
    '',
    `- Save user-level memories (preferences, corrections, cross-project facts) in global memory at \`${globalMemoryDir}\`. Update that directory's \`${ENTRYPOINT_NAME}\` index when you add, rename, or remove a global memory topic file.`,
    `- Save project-level memories (repo-specific decisions, workflow context, project references not derivable from code) by appending to today's project daily log at \`${logPathPattern}\`. A nightly process distills project logs into project \`${ENTRYPOINT_NAME}\` and topic files; do not edit the project \`${ENTRYPOINT_NAME}\` directly in daily-log mode.`,
    '- Do not save session-only information to durable memory unless it will matter in future conversations.',
    '',
    "This session is long-lived. As you work, record project-level information worth remembering by **appending** to today's daily log file:",
    '',
    `\`${logPathPattern}\``,
    '',
    "Substitute today's date (from `currentDate` in your context) for `YYYY-MM-DD`. When the date rolls over mid-session, start appending to the new day's file.",
    '',
    'Write each entry as a short timestamped bullet. Create the file (and parent directories) on first write if it does not exist. Do not rewrite or reorganize the log — it is append-only. A separate nightly process distills these logs into `MEMORY.md` and topic files.',
    '',
    '## What to append to the project daily log',
    '- Corrections and preferences that apply to this working directory ("use bun for this repo"; "integration tests here must hit the real database")',
    '- Project context that is not derivable from the code (deadlines, incidents, decisions and their rationale)',
    '- Pointers to external systems (dashboards, Linear projects, Slack channels)',
    '- Anything the user explicitly asks you to remember about this project',
    '- If the user explicitly asks you to remember a user-level preference or cross-project fact, save it to global memory instead of the project daily log.',
    '',
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...(skipIndex
      ? []
      : [
          `## ${ENTRYPOINT_NAME}`,
          `The project \`${ENTRYPOINT_NAME}\` is the distilled index maintained nightly from project logs and is loaded into your context automatically. Read it for orientation, but do not edit the project index directly — record new project information in today's log instead. Global memory has its own \`${ENTRYPOINT_NAME}\`; update the global index when you save global user-level topic files.`,
          '',
        ]),
    ...buildSearchingPastContextSection([globalMemoryDir, projectMemoryDir]),
  ]

  return lines.join('\n')
}

/**
 * Build the "Searching past context" section if the feature gate is enabled.
 */
export function buildSearchingPastContextSection(
  durableMemoryDirs: string | readonly string[],
): string[] {
  const projectDir = getProjectDir(getOriginalCwd())
  const memoryDirs = Array.from(
    new Set(
      (Array.isArray(durableMemoryDirs)
        ? durableMemoryDirs
        : [durableMemoryDirs]
      ).filter(Boolean),
    ),
  )
  // Ant-native builds alias grep to embedded ugrep and remove the dedicated
  // Grep tool, so give the model a real shell invocation there.
  // In REPL mode, both Grep and Bash are hidden from direct use — the model
  // calls them from inside REPL scripts, so the grep shell form is what it
  // will write in the script anyway.
  const embedded = hasEmbeddedSearchTools() || isReplModeEnabled()
  const memSearches = embedded
    ? [
        `grep -rn "<search term>" ${memoryDirs
          .map(quoteShellPath)
          .join(' ')} --include="*.md"`,
      ]
    : memoryDirs.map(
        dir =>
          `${GREP_TOOL_NAME} with pattern="<search term>" path="${dir}" glob="*.md"`,
      )
  const transcriptSearch = embedded
    ? `grep -rn "<search term>" ${projectDir}/ --include="*.jsonl"`
    : `${GREP_TOOL_NAME} with pattern="<search term>" path="${projectDir}/" glob="*.jsonl"`
  return [
    '## Searching past context',
    '',
    'When looking for past context:',
    '1. Search topic files in your durable memory directories:',
    '```',
    ...memSearches,
    '```',
    '2. Session transcript logs (last resort — large files, slow):',
    '```',
    transcriptSearch,
    '```',
    'Use narrow search terms (error messages, file paths, function names) rather than broad keywords.',
    '',
  ]
}

function quoteShellPath(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`
}

/**
 * Load the memory prompt for the system prompt and make sure both memory
 * directories exist so the model can write without checking first.
 *
 * Returns the trimmed auto-memory prompt split into cacheable instructions and
 * the per-session directory block. Team memory has no sync transport in this
 * runtime, so the combined team prompt is not built: the team subdirectory
 * stays readable and writable as ordinary project memory. Returns null when
 * auto memory is disabled.
 */
export async function loadMemoryPrompt(): Promise<MemoryPromptSections | null> {
  const autoEnabled = isAutoMemoryEnabled()
  if (!autoEnabled) return null

  const skipIndex = false

  // KAIROS daily-log mode replaces the save instructions with an append-only
  // log, so its self-contained prompt travels whole in the dynamic tail.
  if (feature('KAIROS') && getKairosActive()) {
    return {
      instructions: '',
      directories: buildAssistantDailyLogPrompt(skipIndex),
    }
  }

  // Cowork injects memory-policy text via env var; it is per-session, so it
  // rides with the directory block.
  const coworkExtraGuidelines = getSessionCoworkMemoryExtraGuidelines()
  const extraGuidelines =
    coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
      ? [coworkExtraGuidelines]
      : undefined

  const autoDir = getAutoMemPath()
  const globalDir = getGlobalMemoryPath()
  // Harness guarantees the directories exist so the model can write without
  // checking. The prompt text reflects this ("already exist").
  await ensureMemoryDirExists(globalDir)
  await ensureMemoryDirExists(autoDir)
  return {
    instructions: buildMemoryInstructionLines().join('\n'),
    directories: buildMemoryDirectoryLines(autoDir, extraGuidelines).join('\n'),
  }
}
