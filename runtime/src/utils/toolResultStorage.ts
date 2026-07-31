/**
 * Utility for persisting large tool results to disk instead of truncating them.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { createHash } from 'node:crypto'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import {
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULT_BYTES,
} from '../constants/toolLimits.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import { toError } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'
import { isRecord } from './record.js'
import { getProjectDir } from './sessionStorage.js'
import { jsonStringify } from './slowOperations.js'
import { commitArtifactAtomically } from '../durability/atomic-artifact.js'
import { peekAmbientRuntimeSession } from '../session/current-session.js'
import type { Session } from '../session/session.js'
import type {
  ArtifactCommittedEvent,
  ArtifactIntentEvent,
  Event,
} from '../session/event-log.js'

// Subdirectory name for tool results within a session
export const TOOL_RESULTS_SUBDIR = 'tool-results'

// XML tag used to wrap persisted output messages
export const PERSISTED_OUTPUT_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>'

// Message used when tool result content was cleared without persisting to file
export const TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]'

/**
 * Resolve the effective persistence threshold for a tool.
 * GrowthBook override wins when present; otherwise falls back to the declared
 * per-tool cap clamped by the global default.
 *
 * Defensive: GrowthBook's cache returns `cached !== undefined ? cached : default`,
 * so a flag served as `null` leaks through. We guard with optional chaining and a
 * typeof check so any non-object flag value (null, string, number) falls through
 * to the hardcoded default instead of throwing on index or returning 0.
 */
export function getPersistenceThreshold(
  // Per-tool overrides were feature-flag-stripped to a constant; the threshold is
  // now tool-independent. Kept in the signature for call-site compatibility.
  _toolName: string,
  declaredMaxResultSizeChars: number,
): number {
  // Infinity = hard opt-out. Read self-bounds via maxTokens; persisting its
  // output to a file the model reads back with Read is circular. Checked
  // before the GB override so tengu_satin_quoll can't force it back on.
  if (!Number.isFinite(declaredMaxResultSizeChars)) {
    return declaredMaxResultSizeChars
  }
  return Math.min(declaredMaxResultSizeChars, DEFAULT_MAX_RESULT_SIZE_CHARS)
}

// Result of persisting a tool result to disk
export type PersistedToolResult = {
  filepath: string
  originalSize: number
  isJson: boolean
  preview: string
  hasMore: boolean
}

// Error result when persistence fails
export type PersistToolResultError = {
  error: string
}

/**
 * Get the session directory (projectDir/sessionId)
 */
function getSessionDir(): string {
  return join(getProjectDir(getOriginalCwd()), getSessionId())
}

/**
 * Get the tool results directory for this session (projectDir/sessionId/tool-results)
 */
export function getToolResultsDir(): string {
  return join(getSessionDir(), TOOL_RESULTS_SUBDIR)
}

// Preview size in bytes for the reference message
export const PREVIEW_SIZE_BYTES = 2000

/**
 * Get the filepath where a tool result would be persisted.
 */
export function getToolResultPath(id: string, isJson: boolean): string {
  const ext = isJson ? 'json' : 'txt'
  return join(getToolResultsDir(), `${safeToolResultPathSegment(id)}.${ext}`)
}

function safeToolResultPathSegment(value: string): string {
  const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
  if (
    value !== '.' &&
    value !== '..' &&
    !windowsDeviceName.test(value) &&
    /^[a-zA-Z0-9._-]{1,128}$/.test(value)
  ) {
    return value
  }
  const readable = value
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)
  const prefix =
    readable.length > 0 &&
    readable !== '.' &&
    readable !== '..' &&
    !windowsDeviceName.test(readable)
      ? readable
      : 'tool-result'
  return `${prefix}-${digest}`
}

/**
 * Ensure the session-specific tool results directory exists
 */
export async function ensureToolResultsDir(): Promise<void> {
  try {
    await mkdir(getToolResultsDir(), { recursive: true })
  } catch {
    // Directory may already exist
  }
}

/**
 * Persist a tool result to disk and return information about the persisted file
 *
 * @param content - The tool result content to persist (string or array of content blocks)
 * @param toolUseId - The ID of the tool use that produced the result
 * @returns Information about the persisted file including filepath and preview
 */
export async function persistToolResult(
  content: NonNullable<ToolResultBlockParam['content']>,
  toolUseId: string,
): Promise<PersistedToolResult | PersistToolResultError> {
  const isJson = Array.isArray(content)

  // Check for non-text content - we can only persist text blocks
  if (isJson) {
    const hasNonTextContent = content.some(block => block.type !== 'text')
    if (hasNonTextContent) {
      return {
        error: 'Cannot persist tool results containing non-text content',
      }
    }
  }

  const filepath = getToolResultPath(toolUseId, isJson)
  const contentStr = isJson ? jsonStringify(content, null, 2) : content
  const contentBytes = Buffer.from(contentStr, 'utf8')
  const contentSha256 = createHash('sha256').update(contentBytes).digest('hex')
  const session = peekAmbientRuntimeSession()
  const runId = session?.rolloutStore?.sessionId ?? session?.conversationId
  const artifactId = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        runId: runId ?? null,
        kind: 'tool_result',
        sourceCallId: toolUseId,
      }),
      'utf8',
    )
    .digest('hex')
  let intent: Event | undefined

  // tool_use_id is unique per invocation and content is deterministic for a
  // given id. Publish via temp+fsync+exclusive-link+directory-fsync so the
  // model never receives a path to partial bytes. Same-byte replay is an
  // idempotent acknowledgement; conflicting bytes fail closed.
  try {
    if (session?.rolloutStore && runId !== undefined) {
      const payload: ArtifactIntentEvent = {
        runId,
        artifactId,
        kind: 'tool_result',
        sourceCallId: toolUseId,
        targetPath: filepath,
        contentSha256,
        byteLength: contentBytes.byteLength,
        recordedAt: new Date().toISOString(),
      }
      intent = readOrAppendArtifactIntent(session, payload)
      if (!Number.isSafeInteger(intent.seq) || (intent.seq ?? 0) <= 0) {
        throw new Error('artifact intent journal sequence is missing')
      }
    }

    await ensureToolResultsDir()
    const outcome = await commitArtifactAtomically(filepath, contentBytes, {
      trustedRoot: getToolResultsDir(),
    })

    if (session?.rolloutStore && runId !== undefined && intent !== undefined) {
      const payload: ArtifactCommittedEvent = {
        runId,
        artifactId,
        kind: 'tool_result',
        sourceCallId: toolUseId,
        targetPath: filepath,
        contentSha256,
        byteLength: contentBytes.byteLength,
        recordedAt:
          intent.msg.type === 'artifact_intent'
            ? intent.msg.payload.recordedAt
            : new Date().toISOString(),
        intentEventSeq: intent.seq!,
        outcome,
        committedAt: new Date().toISOString(),
      }
      readOrAppendArtifactCommitted(session, payload)
    }
    logForDebugging(
      `Persisted tool result to ${filepath} (${formatFileSize(contentStr.length)})`,
    )
  } catch (error) {
    logError(toError(error))
    return { error: getFileSystemErrorMessage(toError(error)) }
  }

  // Generate a preview
  const { preview, hasMore } = generatePreview(contentStr, PREVIEW_SIZE_BYTES)

  return {
    filepath,
    originalSize: contentStr.length,
    isJson,
    preview,
    hasMore,
  }
}

function readArtifactEvents(session: Session): Event[] {
  const rolloutStore = session.rolloutStore
  if (rolloutStore === null) {
    throw new Error('artifact journal is unavailable')
  }
  return rolloutStore
    .readAll()
    .flatMap(item => (item.type === 'event_msg' ? [item.payload] : []))
}

function readOrAppendArtifactIntent(
  session: Session,
  payload: ArtifactIntentEvent,
): Event {
  const eventId = `artifact-intent:${payload.artifactId}`
  const candidates = readArtifactEvents(session).filter(
    event =>
      event.eventId === eventId ||
      (event.msg.type === 'artifact_intent' &&
        event.msg.payload.artifactId === payload.artifactId),
  )
  if (candidates.length > 1) {
    throw artifactJournalConflict(payload.artifactId, 'duplicate intents')
  }
  const existing = candidates[0]
  if (existing !== undefined) {
    if (
      existing.msg.type !== 'artifact_intent' ||
      !artifactIntentMatches(existing.msg.payload, payload)
    ) {
      throw artifactJournalConflict(payload.artifactId, 'intent content differs')
    }
    // The prior append may have reached the file before its fsync failed.
    // Re-establish durability before the matching intent authorizes artifact
    // publication.
    session.rolloutStore!.syncCanonicalTail()
    return existing
  }
  return session.emit(
    { eventId, id: eventId, msg: { type: 'artifact_intent', payload } },
    { durable: true },
  )
}

function readOrAppendArtifactCommitted(
  session: Session,
  payload: ArtifactCommittedEvent,
): Event {
  const eventId = `artifact-committed:${payload.artifactId}`
  const candidates = readArtifactEvents(session).filter(
    event =>
      event.eventId === eventId ||
      (event.msg.type === 'artifact_committed' &&
        event.msg.payload.artifactId === payload.artifactId),
  )
  if (candidates.length > 1) {
    throw artifactJournalConflict(payload.artifactId, 'duplicate commits')
  }
  const existing = candidates[0]
  if (existing !== undefined) {
    if (
      existing.msg.type !== 'artifact_committed' ||
      !artifactIntentMatches(existing.msg.payload, payload) ||
      existing.msg.payload.intentEventSeq !== payload.intentEventSeq
    ) {
      throw artifactJournalConflict(payload.artifactId, 'commit content differs')
    }
    // A matching line is not itself fsync proof. The caller may be retrying
    // after publication succeeded but acknowledgement durability failed.
    session.rolloutStore!.syncCanonicalTail()
    return existing
  }
  return session.emit(
    { eventId, id: eventId, msg: { type: 'artifact_committed', payload } },
    { durable: true },
  )
}

function artifactIntentMatches(
  left: ArtifactIntentEvent,
  right: ArtifactIntentEvent,
): boolean {
  return (
    left.runId === right.runId &&
    left.artifactId === right.artifactId &&
    left.kind === right.kind &&
    left.sourceCallId === right.sourceCallId &&
    left.targetPath === right.targetPath &&
    left.contentSha256 === right.contentSha256 &&
    left.byteLength === right.byteLength
  )
}

function artifactJournalConflict(artifactId: string, reason: string): Error {
  return Object.assign(
    new Error(`artifact ${artifactId} has conflicting journal evidence: ${reason}`),
    { code: 'ARTIFACT_JOURNAL_CONFLICT' as const },
  )
}

/**
 * Build a message for large tool results with preview
 */
export function buildLargeToolResultMessage(
  result: PersistedToolResult,
): string {
  let message = `${PERSISTED_OUTPUT_TAG}\n`
  message += `Output too large (${formatFileSize(result.originalSize)}). Full output saved to: ${result.filepath}\n\n`
  message += `Preview (first ${formatFileSize(PREVIEW_SIZE_BYTES)}):\n`
  message += result.preview
  message += result.hasMore ? '\n...\n' : '\n'
  message += PERSISTED_OUTPUT_CLOSING_TAG
  return message
}

/**
 * Process a tool result for inclusion in a message.
 * Maps the result to the API format and persists large results to disk.
 */
export async function processToolResultBlock<T>(
  tool: {
    name: string
    maxResultSizeChars: number
    mapToolResultToToolResultBlockParam: (
      result: T,
      toolUseID: string,
    ) => ToolResultBlockParam
  },
  toolUseResult: T,
  toolUseID: string,
): Promise<ToolResultBlockParam> {
  const toolResultBlock = tool.mapToolResultToToolResultBlockParam(
    toolUseResult,
    toolUseID,
  )
  return maybePersistLargeToolResult(
    toolResultBlock,
    tool.name,
    getPersistenceThreshold(tool.name, tool.maxResultSizeChars),
  )
}

/**
 * Process a pre-mapped tool result block. Applies persistence for large results
 * without re-calling mapToolResultToToolResultBlockParam.
 */
export async function processPreMappedToolResultBlock(
  toolResultBlock: ToolResultBlockParam,
  toolName: string,
  maxResultSizeChars: number,
): Promise<ToolResultBlockParam> {
  return maybePersistLargeToolResult(
    toolResultBlock,
    toolName,
    getPersistenceThreshold(toolName, maxResultSizeChars),
  )
}

/**
 * True when a tool_result's content is empty or effectively empty. Covers:
 * undefined/null/'', whitespace-only strings, empty arrays, and arrays whose
 * only blocks are text blocks with empty/whitespace text. Non-text blocks
 * (images, tool_reference) are treated as non-empty.
 */
export function isToolResultContentEmpty(
  content: ToolResultBlockParam['content'],
): boolean {
  if (!content) return true
  if (typeof content === 'string') return content.trim() === ''
  if (!Array.isArray(content)) return false
  if (content.length === 0) return true
  return content.every(
    block =>
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      (typeof block.text !== 'string' || block.text.trim() === ''),
  )
}

/**
 * Handle large tool results by persisting to disk instead of truncating.
 * Returns the original block if no persistence needed, or a modified block
 * with the content replaced by a reference to the persisted file.
 */
async function maybePersistLargeToolResult(
  toolResultBlock: ToolResultBlockParam,
  toolName: string,
  persistenceThreshold?: number,
): Promise<ToolResultBlockParam> {
  // Check size first before doing any async work - most tool results are small
  const content = toolResultBlock.content

  // inc-4586: Empty tool_result content at the prompt tail causes some models
  // (notably capybara) to emit the \n\nHuman: stop sequence and end their turn
  // with zero output. The server renderer inserts no \n\nAssistant: marker after
  // tool results, so a bare </function_results>\n\n pattern-matches to a turn
  // boundary. Several tools can legitimately produce empty output (silent-success
  // shell commands, MCP servers returning content:[], REPL statements, etc.).
  // Inject a short marker so the model always has something to react to.
  if (isToolResultContentEmpty(content)) {
    return {
      ...toolResultBlock,
      content: `(${toolName} completed with no output)`,
    }
  }
  // Narrow after the emptiness guard — content is non-nullish past this point.
  if (!content) {
    return toolResultBlock
  }

  // Skip persistence for image content blocks - they need to be sent as-is to AgenC
  if (hasImageBlock(content)) {
    return toolResultBlock
  }

  const size = contentSize(content)

  // Use tool-specific threshold if provided, otherwise fall back to global limit
  const threshold = persistenceThreshold ?? MAX_TOOL_RESULT_BYTES
  if (size <= threshold) {
    return toolResultBlock
  }

  // Persist the entire content as a unit
  const result = await persistToolResult(content, toolResultBlock.tool_use_id)
  if (isPersistError(result)) {
    // If persistence failed, return the original block unchanged
    return toolResultBlock
  }

  const message = buildLargeToolResultMessage(result)

  return { ...toolResultBlock, content: message }
}

/**
 * Generate a preview of content, truncating at a newline boundary when possible.
 */
export function generatePreview(
  content: string,
  maxBytes: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) {
    return { preview: content, hasMore: false }
  }

  // Find the last newline within the limit to avoid cutting mid-line
  const truncated = content.slice(0, maxBytes)
  const lastNewline = truncated.lastIndexOf('\n')

  // If we found a newline reasonably close to the limit, use it
  // Otherwise fall back to the exact limit
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes

  return { preview: content.slice(0, cutPoint), hasMore: true }
}

/**
 * Type guard to check if persist result is an error
 */
export function isPersistError(
  result: PersistedToolResult | PersistToolResultError,
): result is PersistToolResultError {
  return 'error' in result
}

// --- Persisted tool-result replacement state ---

/**
 * Per-conversation-thread state for the aggregate tool result budget.
 * State must be stable to preserve prompt cache:
 *   - seenIds: results that have passed through the budget check (replaced
 *     or not). Once seen, a result's fate is frozen for the conversation.
 *   - replacements: subset of seenIds that were persisted to disk and
 *     replaced with previews, mapped to the exact preview string shown to
 *     the model. Re-application is a Map lookup — no file I/O, guaranteed
 *     byte-identical, cannot fail.
 *
 * Lifecycle: one instance per conversation thread, carried on ToolUseContext.
 * Main thread: REPL provisions once, never resets — stale entries after
 * /clear, rewind, resume, or compact are never looked up (tool_use_ids are
 * UUIDs) so they're harmless. Subagents: createSubagentContext clones the
 * parent's state by default (cache-sharing forks like agentSummary need
 * identical decisions), or resumeAgentBackground threads one reconstructed
 * from sidechain records.
 */
export type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() }
}

/**
 * Clone replacement state for a cache-sharing fork. The fork needs state
 * identical to the source at fork time so its wire prefix remains stable.
 * Mutating the clone does not affect the source.
 */
export function cloneContentReplacementState(
  source: ContentReplacementState,
): ContentReplacementState {
  return {
    seenIds: new Set(source.seenIds),
    replacements: new Map(source.replacements),
  }
}

/**
 * Serializable record of one content-replacement decision. Written to the
 * transcript as a ContentReplacementEntry so decisions survive resume.
 * Discriminated by `kind` so future replacement mechanisms (user text,
 * offloaded images) can share the same transcript entry type.
 *
 * `replacement` is the exact string the model saw — stored rather than
 * derived on resume so code changes to the preview template, size formatting,
 * or path layout can't silently break prompt cache.
 */
export type ContentReplacementRecord = {
  kind: 'tool-result'
  toolUseId: string
  replacement: string
}

type UnknownRecord = Record<string, unknown>

type ToolResultBlockRecord = UnknownRecord & {
  type: 'tool_result'
  tool_use_id: string
  content: NonNullable<ToolResultBlockParam['content']>
}

function userContentBlocks(message: Message): readonly unknown[] | undefined {
  if (!isRecord(message) || message.type !== 'user') return undefined
  const envelope = message.message
  if (!isRecord(envelope) || !Array.isArray(envelope.content)) {
    return undefined
  }
  return envelope.content
}

function isToolResultContentBlock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  return value.type !== 'text' || typeof value.text === 'string'
}

function isToolResultContent(
  value: unknown,
): value is NonNullable<ToolResultBlockParam['content']> {
  if (typeof value === 'string') return true
  return Array.isArray(value) && value.every(isToolResultContentBlock)
}

function asToolResultBlock(block: unknown): ToolResultBlockRecord | undefined {
  if (
    !isRecord(block) ||
    block.type !== 'tool_result' ||
    typeof block.tool_use_id !== 'string' ||
    block.content === undefined ||
    block.content === null ||
    block.content === '' ||
    !isToolResultContent(block.content)
  ) {
    return undefined
  }
  return block as ToolResultBlockRecord
}

function isContentAlreadyCompacted(
  content: ToolResultBlockParam['content'],
): boolean {
  // All budget-produced content starts with the tag (buildLargeToolResultMessage).
  // `.startsWith()` avoids false-positives when the tag appears anywhere else
  // in the content (e.g., reading this source file).
  return typeof content === 'string' && content.startsWith(PERSISTED_OUTPUT_TAG)
}

function hasImageBlock(
  content: NonNullable<ToolResultBlockParam['content']>,
): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      b => typeof b === 'object' && 'type' in b && b.type === 'image',
    )
  )
}

function contentSize(
  content: NonNullable<ToolResultBlockParam['content']>,
): number {
  if (typeof content === 'string') return content.length
  return content.reduce(
    (sum, block) => sum + (block.type === 'text' ? block.text.length : 0),
    0,
  )
}

function collectCandidateToolResultIds(messages: Message[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    const content = userContentBlocks(message)
    if (!content) continue
    for (const block of content) {
      const toolResult = asToolResultBlock(block)
      if (!toolResult) continue
      if (isContentAlreadyCompacted(toolResult.content)) continue
      if (hasImageBlock(toolResult.content)) continue
      ids.add(toolResult.tool_use_id)
    }
  }
  return ids
}

/**
 * Return a new Message[] where each tool_result block whose id appears in
 * replacementMap has its content replaced. Messages and blocks with no
 * replacements are passed through by reference.
 */
function replaceToolResultContents(
  messages: Message[],
  replacementMap: ReadonlyMap<string, string>,
): Message[] {
  let changed = false
  const nextMessages = messages.map(message => {
    const content = userContentBlocks(message)
    if (!content) return message
    const needsReplace = content.some(block => {
      const toolResult = asToolResultBlock(block)
      return (
        toolResult !== undefined &&
        replacementMap.has(toolResult.tool_use_id) &&
        toolResult.content !== replacementMap.get(toolResult.tool_use_id)
      )
    })
    if (!needsReplace) return message
    changed = true
    return {
      ...message,
      message: {
        ...message.message,
        content: content.map(block => {
          const toolResult = asToolResultBlock(block)
          if (!toolResult) return block
          const replacement = replacementMap.get(toolResult.tool_use_id)
          return replacement === undefined || toolResult.content === replacement
            ? block
            : { ...toolResult, content: replacement }
        }),
      },
      // Drop the original tool payload once the model-facing content has been
      // replaced with a persisted preview. Keeping both defeats the memory
      // savings for long sessions because the live transcript still retains
      // the oversized structured result.
      toolUseResult: undefined,
    }
  })
  return changed ? nextMessages : messages
}

/**
 * Mirror already-known tool-result replacements back into an in-memory
 * transcript. Used by the interactive REPL so once a large result has been
 * persisted/replaced for model use, the original oversized string can be
 * dropped from live session state as well.
 */
export function applyToolResultReplacementsToMessages(
  messages: Message[],
  replacements: ReadonlyMap<string, string>,
): Message[] {
  if (replacements.size === 0) return messages
  return replaceToolResultContents(messages, replacements)
}

/**
 * Reconstruct replacement state from content-replacement records loaded from
 * the transcript. Used on resume so the budget makes the same choices it
 * made in the original session (prompt cache stability).
 *
 * Accepts the full ContentReplacementRecord[] from LogOption (may include
 * future non-tool-result kinds); only tool-result records are applied here.
 *
 *   - replacements: populated directly from the stored replacement strings.
 *     Records for IDs not in messages (e.g. after compact) are skipped —
 *     they're inert anyway.
 *   - seenIds: every candidate tool_use_id in the loaded messages. A result
 *     being in the transcript means it was sent to the model, so it was seen.
 *     This freezes unreplaced results against future replacement.
 *   - inheritedReplacements: gap-fill for fork-subagent resume. A fork's
 *     original run applies parent-inherited replacements via mustReapply
 *     (never persisted — not newlyReplaced). On resume the sidechain has
 *     the original content but no record, so records alone would classify
 *     it as frozen. The parent's live state still has the mapping; copy
 *     it for IDs in messages that records don't cover. No-op for non-fork
 *     resumes (parent IDs aren't in the subagent's messages).
 */
export function reconstructContentReplacementState(
  messages: Message[],
  records: ContentReplacementRecord[],
  inheritedReplacements?: ReadonlyMap<string, string>,
): ContentReplacementState {
  const state = createContentReplacementState()
  const candidateIds = collectCandidateToolResultIds(messages)

  for (const id of candidateIds) {
    state.seenIds.add(id)
  }
  for (const r of records) {
    if (r.kind === 'tool-result' && candidateIds.has(r.toolUseId)) {
      state.replacements.set(r.toolUseId, r.replacement)
    }
  }
  if (inheritedReplacements) {
    for (const [id, replacement] of inheritedReplacements) {
      if (candidateIds.has(id) && !state.replacements.has(id)) {
        state.replacements.set(id, replacement)
      }
    }
  }
  return state
}

/**
 * AgentTool-resume variant: encapsulates the feature-flag gate + parent
 * gap-fill so both AgentTool.call and resumeAgentBackground share one
 * implementation. Returns undefined when parentState is undefined (feature
 * off); otherwise reconstructs from sidechain records with parent's live
 * replacements filling gaps for fork-inherited mustReapply entries.
 *
 * Kept out of AgentTool.tsx — that file is at the feature() DCE complexity
 * cliff and cannot tolerate even +1 net source line without silently
 * breaking feature('TRANSCRIPT_CLASSIFIER') eval in tests.
 */
export function reconstructForSubagentResume(
  parentState: ContentReplacementState | undefined,
  resumedMessages: Message[],
  sidechainRecords: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  if (!parentState) return undefined
  return reconstructContentReplacementState(
    resumedMessages,
    sidechainRecords,
    parentState.replacements,
  )
}

/**
 * Get a human-readable error message from a filesystem error
 */
function getFileSystemErrorMessage(error: Error): string {
  // Node.js filesystem errors have a 'code' property
  // eslint-disable-next-line no-restricted-syntax -- uses .path, not just .code
  const nodeError = error as NodeJS.ErrnoException
  if (nodeError.code) {
    switch (nodeError.code) {
      case 'ENOENT':
        return `Directory not found: ${nodeError.path ?? 'unknown path'}`
      case 'EACCES':
        return `Permission denied: ${nodeError.path ?? 'unknown path'}`
      case 'ENOSPC':
        return 'No space left on device'
      case 'EROFS':
        return 'Read-only file system'
      case 'EMFILE':
        return 'Too many open files'
      case 'EEXIST':
        return `File already exists: ${nodeError.path ?? 'unknown path'}`
      default:
        return `${nodeError.code}: ${nodeError.message}`
    }
  }
  return error.message
}
