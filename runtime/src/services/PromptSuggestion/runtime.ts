/**
 * Local runtime helpers for the prompt-suggestion service.
 *
 * This file carries the small source-reference helper slices that S-04 needs
 * without importing mirror PromptSuggestion modules. The live service can
 * therefore compile and
 * run as AgenC-owned code while preserving the prompt-suggestion control flow.
 */

import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import type { LLMProvider } from '../../llm/types.js'
import { isDangerousCommand } from '../../permissions/bash.js'
import {
  parseCommand,
  parseShellCommand,
} from '../../shell-command/parser.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import type { Message } from '../../types/message.js'

type ToolDecision =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      decisionReason?: { type: 'other'; reason: string }
    }
  | {
      behavior: 'deny'
      message: string
      decisionReason: { type: 'other'; reason: string }
    }

export type CanUseToolFn = (
  tool: { name: string },
  input: Record<string, unknown>,
) => Promise<ToolDecision> | ToolDecision

export type SetAppState<T = PromptSuggestionAppState> = (
  f: (prev: T) => T,
) => void

export type PromptSuggestionAppState = {
  promptSuggestionEnabled: boolean
  pendingWorkerRequest: unknown | null
  pendingSandboxRequest: unknown | null
  elicitation: { queue: readonly unknown[] }
  toolPermissionContext: {
    mode: string
    isBypassPermissionsModeAvailable?: boolean
  }
  promptSuggestion: {
    text: string | null
    promptId: 'user_intent' | 'stated_intent' | null
    shownAt: number
    acceptedAt: number
    generationRequestId: string | null
  }
  speculation: SpeculationState
  speculationSessionTimeSavedMs: number
}

export type AppState = PromptSuggestionAppState

export type CompletionBoundary =
  | { type: 'complete'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | {
      type: 'denied_tool'
      toolName: string
      detail: string
      completedAt: number
    }

export type SpeculationResult = {
  messages: Message[]
  boundary: CompletionBoundary | null
  timeSavedMs: number
}

export type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string
      abort: () => void
      startTime: number
      messagesRef: { current: Message[] }
      writtenPathsRef: { current: Set<string> }
      boundary: CompletionBoundary | null
      suggestionLength: number
      toolUseCount: number
      isPipelined: boolean
      speculationEnabled?: boolean
      cwd: string
      contextRef: { current: REPLHookContext }
      pipelinedSuggestion?: {
        text: string
        promptId: 'user_intent' | 'stated_intent'
        generationRequestId: string | null
      } | null
    }

export const IDLE_SPECULATION_STATE: SpeculationState = { status: 'idle' }

export type FileStateCache = Map<string, unknown> | Record<string, unknown>

export const READ_FILE_STATE_CACHE_SIZE = 50

export type PromptSuggestionToolUseContext = {
  abortController?: AbortController
  provider?: LLMProvider
  options?: {
    mainLoopModel?: string
    tools?: readonly unknown[]
    contextWindowTokens?: number
    maxOutputTokens?: number
  }
  getAppState: () => PromptSuggestionAppState
  setAppState?: SetAppState
  readFileState?: FileStateCache
  cwd?: string
  queryTracking?: {
    readonly chainId?: string
    readonly depth?: number
  }
}

export type REPLHookContext = {
  messages: Message[]
  systemPrompt: unknown
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: PromptSuggestionToolUseContext
  querySource?: string
}

export type CacheSafeParams = {
  systemPrompt: unknown
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: PromptSuggestionToolUseContext
  forkContextMessages: Message[]
}

type ForkedAgentParams = {
  promptMessages: Message[]
  cacheSafeParams: CacheSafeParams
  canUseTool: CanUseToolFn
  querySource: string
  forkLabel: string
  overrides?: {
    abortController?: AbortController
    requireCanUseTool?: boolean
  }
  maxTurns?: number
  onMessage?: (message: Message) => void
  skipTranscript?: boolean
  skipCacheWrite?: boolean
}

export type NonNullableUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type ForkedAgentResult = {
  messages: Message[]
  totalUsage: NonNullableUsage
}

type ForkedAgentModule = {
  readonly runForkedAgent: (params: Record<string, unknown>) => Promise<unknown>
}

const forkedAgentModulePath = '../../utils/forkedAgent.js'

export type PromptSuggestionSettings = {
  readonly promptSuggestionEnabled?: boolean
  readonly isNonInteractiveSession?: boolean
  readonly isTeammateSession?: boolean
  readonly promptSuggestionFeatureEnabled?: boolean
  readonly agentSwarmsEnabled?: boolean
}

export type PromptSuggestionRuntimeOptions = {
  readonly speculationEnabled?: boolean
  readonly cwd?: string
}

const INTERRUPT_MESSAGE_TEXT = '[Request interrupted by user]'
const INTERRUPT_MESSAGE_FOR_TOOL_USE_TEXT =
  '[Request interrupted by user for tool use]'

export const INTERRUPT_MESSAGE = INTERRUPT_MESSAGE_TEXT
export const INTERRUPT_MESSAGE_FOR_TOOL_USE =
  INTERRUPT_MESSAGE_FOR_TOOL_USE_TEXT

export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  feature: string,
  defaultValue: T,
): T {
  const raw = process.env.AGENC_INTERNAL_FC_OVERRIDES
  if (raw && process.env.USER_TYPE === 'ant') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (Object.hasOwn(parsed, feature)) return parsed[feature] as T
    } catch {
      return defaultValue
    }
  }
  return defaultValue
}

export function getInitialPromptSuggestionSettings(
  settings?: PromptSuggestionSettings | null,
): PromptSuggestionSettings {
  const raw = process.env.AGENC_PROMPT_SUGGESTION_ENABLED
  if (raw === undefined) return settings ?? {}
  return { promptSuggestionEnabled: !['0', 'false', 'no', 'off'].includes(raw) }
}

export function isAgentSwarmsEnabled(): boolean {
  if (process.env.USER_TYPE === 'ant') return true
  if (
    !isEnvTruthy(process.env.AGENC_EXPERIMENTAL_AGENT_TEAMS) &&
    !process.argv.includes('--agent-teams')
  ) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_flint', true)
}

export function isSpeculationConfigEnabled(speculationEnabled?: boolean): boolean {
  const envOverride = process.env.AGENC_SPECULATION_ENABLED
  if (envOverride !== undefined) {
    return !['0', 'false', 'no', 'off'].includes(envOverride.toLowerCase())
  }
  return speculationEnabled !== false
}

export function count<T>(arr: readonly T[], pred: (x: T) => unknown): number {
  let n = 0
  for (const item of arr) n += pred(item) ? 1 : 0
  return n
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${Math.round(ms / 1000)}s`
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function logError(error: unknown): void {
  if (!isEnvTruthy(process.env.AGENC_DEBUG_PROMPT_SUGGESTION)) return
  // eslint-disable-next-line no-console
  console.error(error)
}

export function logForDebugging(message: string): void {
  if (!isEnvTruthy(process.env.AGENC_DEBUG_PROMPT_SUGGESTION)) return
  // eslint-disable-next-line no-console
  console.error(message)
}

export function createChildAbortController(
  parent?: AbortController,
): AbortController {
  const child = new AbortController()
  if (!parent) return child
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
    return child
  }
  const onAbort = () => child.abort(parent.signal.reason)
  parent.signal.addEventListener('abort', onAbort, { once: true })
  child.signal.addEventListener(
    'abort',
    () => parent.signal.removeEventListener('abort', onAbort),
    { once: true },
  )
  return child
}

export function createCacheSafeParams(
  context: REPLHookContext,
): CacheSafeParams {
  return {
    systemPrompt: context.systemPrompt,
    userContext: context.userContext,
    systemContext: context.systemContext,
    toolUseContext: context.toolUseContext,
    forkContextMessages: context.messages,
  }
}

export function createUserMessage({ content }: { content: unknown }): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content },
  } as Message
}

export function createSystemMessage(
  content: string,
  level: string,
): Message {
  return {
    type: 'system',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    message: { role: 'system', content },
  } as Message
}

export function getLastAssistantMessage(messages: Message[]): Message | null {
  return (
    messages.findLast(
      (message: Message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: string }).type === 'assistant',
    ) ?? null
  )
}

export function mergeFileStateCaches(
  first: FileStateCache,
  second: FileStateCache,
): FileStateCache {
  if (first instanceof Map || second instanceof Map) {
    return new Map([
      ...(first instanceof Map ? first.entries() : Object.entries(first)),
      ...(second instanceof Map ? second.entries() : Object.entries(second)),
    ])
  }
  return { ...first, ...second }
}

export function extractReadFilesFromMessages(
  messages: Message[],
  cwd: string,
  maxEntries: number,
): FileStateCache {
  const readToolPaths = new Map<string, string>()
  const extracted = new Map<string, unknown>()

  for (const message of messages) {
    const content = (message as { message?: { content?: unknown } }).message
      ?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const candidate = block as Record<string, unknown>
      if (
        candidate.type === 'tool_use' &&
        candidate.name === 'Read' &&
        typeof candidate.id === 'string'
      ) {
        const input = candidate.input
        if (input && typeof input === 'object' && !Array.isArray(input)) {
          const filePath = readPathInput(input as Record<string, unknown>)
          if (filePath) {
            readToolPaths.set(candidate.id, resolve(cwd, filePath))
          }
        }
      }

      if (
        candidate.type === 'tool_result' &&
        typeof candidate.tool_use_id === 'string' &&
        candidate.is_error !== true &&
        readToolPaths.has(candidate.tool_use_id)
      ) {
        extracted.set(
          readToolPaths.get(candidate.tool_use_id)!,
          contentToText(candidate.content),
        )
        if (extracted.size >= maxEntries) return extracted
      }
    }
  }

  return extracted
}

export function getPromptSuggestionTempDir(): string {
  return join(tmpdir(), 'agenc')
}

export function getTranscriptPath(): string {
  return join(getPromptSuggestionTempDir(), 'transcript.jsonl')
}

export function jsonStringify(value: unknown): string {
  return JSON.stringify(value)
}

export function getCurrentCwd(fallback?: string): string {
  return fallback ?? process.env.AGENC_CWD ?? process.cwd()
}

export async function checkBashReadOnlyConstraints(command: string): Promise<{
  behavior: 'allow' | 'deny'
}> {
  if (!command.trim()) return { behavior: 'deny' }
  if (isDangerousCommand(command)) return { behavior: 'deny' }
  const argv = parseShellCommand(command)
  if (argv === null) return { behavior: 'deny' }
  if (argv[0] === 'git') {
    return isKnownReadOnlyGit(argv) ? { behavior: 'allow' } : { behavior: 'deny' }
  }
  const parsed = parseCommand(argv)
  if (parsed.length === 0) return { behavior: 'deny' }
  if (
    parsed.every(item =>
      item.type === 'read' ||
      item.type === 'search' ||
      item.type === 'list_files',
    )
  ) {
    return { behavior: 'allow' }
  }
  return isKnownReadOnlyGit(argv) ? { behavior: 'allow' } : { behavior: 'deny' }
}

function isKnownReadOnlyGit(argv: readonly string[]): boolean {
  if (argv[0] !== 'git') return false
  const command = argv[1]
  if (command === undefined) return false
  const readOnlyCommands = new Set([
    'status',
    'diff',
    'log',
    'show',
    'rev-parse',
    'ls-files',
    'grep',
    'cat-file',
    'blame',
    'for-each-ref',
  ])
  if (!readOnlyCommands.has(command)) return false
  return !argv.some(arg => arg === '--output' || arg.startsWith('--output='))
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (typeof block === 'string') return block
      if (
        block &&
        typeof block === 'object' &&
        'text' in block &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function readPathInput(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

export async function runForkedAgent(
  params: ForkedAgentParams,
): Promise<ForkedAgentResult> {
  logForDebugging(`[PromptSuggestion] running forked ${params.forkLabel}`)
  const { runForkedAgent: runAgenCForkedAgent } = (await import(
    forkedAgentModulePath
  )) as ForkedAgentModule
  const result = await runAgenCForkedAgent({
    promptMessages: params.promptMessages,
    cacheSafeParams: params.cacheSafeParams,
    canUseTool: params.canUseTool,
    querySource: params.querySource,
    forkLabel: params.forkLabel,
    overrides: params.overrides,
    maxTurns: params.maxTurns,
    onMessage: params.onMessage,
    skipTranscript: params.skipTranscript,
    skipCacheWrite: params.skipCacheWrite,
  })
  return result as unknown as ForkedAgentResult
}
