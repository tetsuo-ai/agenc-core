/**
 * Ports source-reference `src/services/PromptSuggestion/promptSuggestion.ts` onto
 * AgenC's live prompt-suggestion service.
 *
 * Shape differences:
 *   - Uses AgenC env naming and a local rate-limit view instead of importing
 *     source-reference API limit modules.
 */

import type { Message } from '../../types/message.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import {
  type CacheSafeParams,
  type PromptSuggestionAppState,
  type PromptSuggestionRuntimeOptions,
  type PromptSuggestionSettings,
  type REPLHookContext,
  count,
  createCacheSafeParams,
  createUserMessage,
  getFeatureValue_CACHED_MAY_BE_STALE,
  getInitialPromptSuggestionSettings,
  getLastAssistantMessage,
  isAgentSwarmsEnabled,
  logForDebugging,
  logError,
  runForkedAgent,
  toError,
} from './runtime.js'
import { getPromptSuggestionLimits } from './limits.js'
import { isSpeculationEnabled, startSpeculation } from './speculation.js'

let currentAbortController: AbortController | null = null

export type PromptVariant = 'user_intent' | 'stated_intent'

export function getPromptVariant(): PromptVariant {
  return 'user_intent'
}

export function shouldEnablePromptSuggestion(
  settings?: PromptSuggestionSettings | null,
): boolean {
  // Env var overrides everything (for testing)
  const envOverride = process.env.AGENC_ENABLE_PROMPT_SUGGESTION
  if (isEnvDefinedFalsy(envOverride)) {
    return false
  }
  if (isEnvTruthy(envOverride)) {
    return true
  }

  // Keep default in sync with Config.tsx (settings toggle visibility)
  const promptSuggestionFeatureEnabled =
    settings?.promptSuggestionFeatureEnabled ??
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_chomp_inflection', false)
  if (!promptSuggestionFeatureEnabled) {
    return false
  }

  // Disable in non-interactive mode (print mode, piped input, SDK)
  if (settings?.isNonInteractiveSession) {
    return false
  }

  // Disable for swarm teammates (only leader should show suggestions)
  const agentSwarmsEnabled =
    settings?.agentSwarmsEnabled ?? isAgentSwarmsEnabled()
  if (agentSwarmsEnabled && settings?.isTeammateSession) {
    return false
  }

  return (
    getInitialPromptSuggestionSettings(settings).promptSuggestionEnabled !==
    false
  )
}

export function abortPromptSuggestion(): void {
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
}

/**
 * Returns a suppression reason if suggestions should not be generated,
 * or null if generation is allowed. Shared by main and pipelined paths.
 */
export function getSuggestionSuppressReason(
  appState: PromptSuggestionAppState,
): string | null {
  if (!appState.promptSuggestionEnabled) return 'disabled'
  if (appState.pendingWorkerRequest || appState.pendingSandboxRequest)
    return 'pending_permission'
  if (appState.elicitation.queue.length > 0) return 'elicitation_active'
  if (appState.toolPermissionContext.mode === 'plan') return 'plan_mode'
  if (
    process.env.USER_TYPE === 'external' &&
    getPromptSuggestionLimits().status !== 'allowed'
  )
    return 'rate_limit'
  return null
}

/**
 * Shared guard + generation logic used by both CLI TUI and SDK push paths.
 * Returns the suggestion with metadata, or null if suppressed/filtered.
 */
async function tryGenerateSuggestion(
  abortController: AbortController,
  messages: Message[],
  getAppState: () => PromptSuggestionAppState,
  cacheSafeParams: CacheSafeParams,
  source?: 'cli' | 'sdk',
): Promise<{
  suggestion: string
  promptId: PromptVariant
  generationRequestId: string | null
} | null> {
  if (abortController.signal.aborted) {
    logSuggestionSuppressed('aborted', undefined, undefined, source)
    return null
  }

  const assistantTurnCount = count(messages, m => m.type === 'assistant')
  if (assistantTurnCount < 2) {
    logSuggestionSuppressed('early_conversation', undefined, undefined, source)
    return null
  }

  const lastAssistantMessage = getLastAssistantMessage(messages)
  if (lastAssistantMessage?.isApiErrorMessage) {
    logSuggestionSuppressed('last_response_error', undefined, undefined, source)
    return null
  }
  const cacheReason = getParentCacheSuppressReason(lastAssistantMessage)
  if (cacheReason) {
    logSuggestionSuppressed(cacheReason, undefined, undefined, source)
    return null
  }

  const appState = getAppState()
  const suppressReason = getSuggestionSuppressReason(appState)
  if (suppressReason) {
    logSuggestionSuppressed(suppressReason, undefined, undefined, source)
    return null
  }

  const promptId = getPromptVariant()
  const { suggestion, generationRequestId } = await generateSuggestion(
    abortController,
    promptId,
    cacheSafeParams,
  )
  if (abortController.signal.aborted) {
    logSuggestionSuppressed('aborted', undefined, undefined, source)
    return null
  }
  if (!suggestion) {
    logSuggestionSuppressed('empty', undefined, promptId, source)
    return null
  }
  if (shouldFilterSuggestion(suggestion, promptId, source)) return null

  return { suggestion, promptId, generationRequestId }
}

export async function executePromptSuggestion(
  context: REPLHookContext,
  runtimeOptions?: PromptSuggestionRuntimeOptions,
): Promise<void> {
  if (context.querySource !== 'repl_main_thread') return

  currentAbortController = new AbortController()
  const abortController = currentAbortController
  const cacheSafeParams = createCacheSafeParams(context)

  try {
    const result = await tryGenerateSuggestion(
      abortController,
      context.messages,
      context.toolUseContext.getAppState,
      cacheSafeParams,
      'cli',
    )
    if (!result) return

    const setAppState = context.toolUseContext.setAppState
    if (!setAppState) return

    setAppState(prev => ({
      ...prev,
      promptSuggestion: {
        text: result.suggestion,
        promptId: result.promptId,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: result.generationRequestId,
      },
    }))

    if (isSpeculationEnabled(runtimeOptions?.speculationEnabled) && result.suggestion) {
      void startSpeculation(
        result.suggestion,
        context,
        setAppState,
        false,
        cacheSafeParams,
        runtimeOptions,
      )
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'APIUserAbortError')
    ) {
      logSuggestionSuppressed('aborted', undefined, undefined, 'cli')
      return
    }
    logError(toError(error))
  } finally {
    if (currentAbortController === abortController) {
      currentAbortController = null
    }
  }
}

const MAX_PARENT_UNCACHED_TOKENS = 10_000

function getParentCacheSuppressReason(
  lastAssistantMessage: ReturnType<typeof getLastAssistantMessage>,
): string | null {
  if (!lastAssistantMessage) return null

  const usage = lastAssistantMessage.message.usage
  const inputTokens = usage.input_tokens ?? 0
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  // The fork re-processes the parent's output (never cached) plus its own prompt.
  const outputTokens = usage.output_tokens ?? 0

  return inputTokens + cacheWriteTokens + outputTokens >
    MAX_PARENT_UNCACHED_TOKENS
    ? 'cache_cold'
    : null
}

const SUGGESTION_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into AgenC.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
The assistant offers options → suggest the one the user would likely pick, based on conversation
The assistant asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Assistant-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`

const SUGGESTION_PROMPTS: Record<PromptVariant, string> = {
  user_intent: SUGGESTION_PROMPT,
  stated_intent: SUGGESTION_PROMPT,
}

export async function generateSuggestion(
  abortController: AbortController,
  promptId: PromptVariant,
  cacheSafeParams: CacheSafeParams,
): Promise<{ suggestion: string | null; generationRequestId: string | null }> {
  const prompt = SUGGESTION_PROMPTS[promptId]

  // Deny tools via callback, NOT by passing tools:[] - that busts cache (0% hit)
  const canUseTool = async () => ({
    behavior: 'deny' as const,
    message: 'No tools needed for suggestion',
    decisionReason: { type: 'other' as const, reason: 'suggestion only' },
  })

  // DO NOT override any API parameter that differs from the parent request.
  // The fork piggybacks on the main thread's prompt cache by sending identical
  // cache-key params. The billing cache key includes more than just
  // system/tools/model/messages/thinking — empirically, setting effortValue
  // or maxOutputTokens on the fork (even via output_config or getAppState)
  // busts cache. PR #18143 tried effort:'low' and caused a 45x spike in cache
  // writes (92.7% → 61% hit rate). The only safe overrides are:
  //   - abortController (not sent to API)
  //   - skipTranscript (client-side only)
  //   - skipCacheWrite (controls cache_control markers, not the cache key)
  //   - canUseTool (client-side permission check)
  const result = await runForkedAgent({
    promptMessages: [createUserMessage({ content: prompt })],
    cacheSafeParams, // Don't override tools/thinking settings - busts cache
    canUseTool,
    querySource: 'prompt_suggestion',
    forkLabel: 'prompt_suggestion',
    overrides: {
      abortController,
    },
    skipTranscript: true,
    skipCacheWrite: true,
  })

  // Check ALL messages - model may loop (try tool → denied → text in next message)
  // Also extract the requestId from the first assistant message for RL dataset joins
  const firstAssistantMsg = result.messages.find(m => m.type === 'assistant')
  const generationRequestId =
    firstAssistantMsg?.type === 'assistant'
      ? (firstAssistantMsg.requestId ?? null)
      : null

  for (const msg of result.messages) {
    if (msg.type !== 'assistant') continue
    const content = (msg as { message?: { content?: unknown } }).message
      ?.content
    if (!Array.isArray(content)) continue
    const textBlock = content.find(
      (b: unknown): b is { type: 'text'; text: string } =>
        typeof b === 'object' &&
        b !== null &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    if (textBlock?.type === 'text') {
      const suggestion = textBlock.text.trim()
      if (suggestion) {
        return { suggestion, generationRequestId }
      }
    }
  }

  return { suggestion: null, generationRequestId }
}

export function shouldFilterSuggestion(
  suggestion: string | null,
  promptId: PromptVariant,
  source?: 'cli' | 'sdk',
): boolean {
  if (!suggestion) {
    logSuggestionSuppressed('empty', undefined, promptId, source)
    return true
  }

  const lower = suggestion.toLowerCase()
  const wordCount = suggestion.trim().split(/\s+/).length

  const filters: Array<[string, () => boolean]> = [
    ['done', () => lower === 'done'],
    [
      'meta_text',
      () =>
        lower === 'nothing found' ||
        lower === 'nothing found.' ||
        lower.startsWith('nothing to suggest') ||
        lower.startsWith('no suggestion') ||
        // Model spells out the prompt's "stay silent" instruction
        /\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
        // Model outputs bare "silence" wrapped in punctuation/whitespace
        /^\W*silence\W*$/.test(lower),
    ],
    [
      'meta_wrapped',
      // Model wraps meta-reasoning in parens/brackets: (silence — ...), [no suggestion]
      () => /^\(.*\)$|^\[.*\]$/.test(suggestion),
    ],
    [
      'error_message',
      () =>
        lower.startsWith('api error:') ||
        lower.startsWith('prompt is too long') ||
        lower.startsWith('request timed out') ||
        lower.startsWith('invalid api key') ||
        lower.startsWith('image was too large'),
    ],
    ['prefixed_label', () => /^\w+:\s/.test(suggestion)],
    [
      'too_few_words',
      () => {
        if (wordCount >= 2) return false
        // Allow slash commands — these are valid user commands
        if (suggestion.startsWith('/')) return false
        // Allow common single-word inputs that are valid user commands
        const ALLOWED_SINGLE_WORDS = new Set([
          // Affirmatives
          'yes',
          'yeah',
          'yep',
          'yea',
          'yup',
          'sure',
          'ok',
          'okay',
          // Actions
          'push',
          'commit',
          'deploy',
          'stop',
          'continue',
          'check',
          'exit',
          'quit',
          // Negation
          'no',
        ])
        return !ALLOWED_SINGLE_WORDS.has(lower)
      },
    ],
    ['too_many_words', () => wordCount > 12],
    ['too_long', () => suggestion.length >= 100],
    ['multiple_sentences', () => /[.!?]\s+[A-Z]/.test(suggestion)],
    ['has_formatting', () => /[\n*]|\*\*/.test(suggestion)],
    [
      'evaluative',
      () =>
        /thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/.test(
          lower,
        ),
    ],
    [
      'agent_voice',
      () =>
        /^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(
          suggestion,
        ),
    ],
  ]

  for (const [reason, check] of filters) {
    if (check()) {
      logSuggestionSuppressed(reason, suggestion, promptId, source)
      return true
    }
  }

  return false
}
export function logSuggestionSuppressed(
  reason: string,
  suggestion?: string,
  promptId?: PromptVariant,
  source?: 'cli' | 'sdk',
): void {
  const resolvedPromptId = promptId ?? getPromptVariant()
  logForDebugging(
    `[PromptSuggestion] suppressed ${resolvedPromptId}: ${reason}` +
      `${source ? ` (${source})` : ''}` +
      `${suggestion ? `; suggestion=${JSON.stringify(suggestion)}` : ''}`,
  )
}
