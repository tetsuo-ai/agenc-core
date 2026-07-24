/**
 * provider-compatible API shim for AgenC.
 *
 * Translates provider SDK calls (anthropic.beta.messages.create) into
 * provider-compatible chat completion requests and streams back events
 * in the provider streaming format so the rest of the codebase is unaware.
 *
 * Supports: OpenAi, Azure OpenAi, Ollama, LM Studio, OpenRouter,
 * Together, Groq, Fireworks, DeepSeek, Mistral, and any provider-compatible API.
 *
 * Environment variables:
 *   AGENC_USE_OPENAI=1          — enable this provider
 *   OPENAI_API_KEY=sk-...             — API key (optional for local models)
 *   OPENAI_AUTH_HEADER=api-key        — optional custom auth header name
 *   OPENAI_AUTH_HEADER_VALUE=...      — optional custom auth header value
 *   OPENAI_AUTH_SCHEME=bearer|raw     — auth scheme for Authorization/custom header handling
 *   OPENAI_API_FORMAT=chat_completions|responses — request format for compatible APIs
 *   OPENAI_BASE_URL=http://...        — base URL (default: https://api.openai.com/v1)
 *   OPENAI_MODEL=gpt-4o              — default model override
 *   PROVIDER_CODE_API_KEY / ~/.providerCode/auth.json — ProviderCode auth for providerCodeplan/providerCodespark
 *
 * GitHub Copilot API (api.githubcopilot.com), provider-compatible:
 *   AGENC_USE_GITHUB=1         — enable GitHub inference (no need for USE_OPENAI)
 *   GITHUB_TOKEN or GH_TOKEN         — Copilot API token (mapped to Bearer auth)
 *   OPENAI_MODEL                     — optional; use github:copilot or openai/gpt-4.1 style IDs
 */
import { APIError } from '@anthropic-ai/sdk'
import {
  readAgencCredentialsAsync as readProviderCodeCredentialsAsync,
  refreshAgencAccessTokenIfNeeded as refreshProviderCodeAccessTokenIfNeeded,
} from '../../utils/agencCredentials.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isBareMode, isEnvTruthy } from '../../utils/envUtils.js'
import { resolveGeminiCredential } from '../../utils/geminiAuth.js'
import { hydrateGeminiAccessTokenFromSecureStorage } from '../../utils/geminiCredentials.js'
import { hydrateGithubModelsTokenFromSecureStorage } from '../../utils/githubModelsCredentials.js'
import {
  createThinkTagFilter,
  stripThinkTags,
} from './thinkTagSanitizer.js'
import {
  providerCodeStreamToprovider,
  collectProviderCodeCompletedResponse,
  convertproviderMessagesToResponsesInput,
  convertProviderCodeResponseToproviderMessage,
  convertToolsToResponsesTools,
  performProviderCodeRequest,
  type providerStreamEvent,
  type providerUsage,
  type ShimCreateParams,
} from './openAiCodeTransform.js'
import { buildproviderUsageFromRawUsage } from './cacheMetrics.js'
import { compressToolHistory } from './compressToolHistory.js'
import { fetchWithProxyRetry } from './fetchWithProxyRetry.js'
import {
  getLocalProviderRetryBaseUrls,
  getGithubEndpointType,
  isLocalProviderUrl,
  resolveRuntimeOpenAiCodeCredentials,
  resolveProviderRequest,
  shouldAttemptLocalToollessRetry,
} from './providerConfig.js'
import {
  buildOpenAiCompatibilityErrorMessage,
  classifyOpenAiHttpFailure,
  classifyOpenAiNetworkFailure,
} from './openaiErrorClassification.js'
import { sanitizeSchemaForOpenAiCompat } from '../../utils/schemaSanitizer.js'
import { normalizeToolParamSchema } from '../../utils/toolParamSchema.js'
import { redactSecretValueForDisplay } from '../../utils/providerProfile.js'
import { isZaiBaseUrl } from '../../utils/zaiProvider.js'
import {
  normalizeToolArguments,
  hasToolFieldMapping,
} from './toolArgumentNormalization.js'
import { logApiCallStart, logApiCallEnd } from '../../utils/requestLogging.js'
import {
  createStreamState,
  processStreamChunk,
  getStreamStats,
} from '../../utils/streamingOptimizer.js'
import { stableStringify } from '../../utils/stableStringify.js'

type SecretValueSource = Partial<{
  OPENAI_API_KEY: string
  OPENAI_AUTH_HEADER_VALUE: string
  PROVIDER_CODE_API_KEY: string
  GEMINI_API_KEY: string
  GOOGLE_API_KEY: string
  GEMINI_ACCESS_TOKEN: string
  MISTRAL_API_KEY: string
}>

type SelectedShimProvider =
  | 'firstParty'
  | 'openai'
  | 'gemini'
  | 'github'
  | 'agenc'
  | 'nvidia-nim'
  | 'minimax'
  | 'mistral'
  | 'xai'

const GITHUB_COPILOT_BASE = 'https://api.githubcopilot.com'
const DEFAULT_MISTRAL_MODEL = 'devstral-latest'
const DEFAULT_NVIDIA_NIM_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct'
const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.5'
const DEFAULT_GITHUB_MODEL = 'gpt-4o'
const GITHUB_429_MAX_RETRIES = 3
const GITHUB_429_BASE_DELAY_SEC = 1
const GITHUB_429_MAX_DELAY_SEC = 32
// Ceiling on how long a server-provided Retry-After can hold a 429 retry, so a
// pathological or hostile header value cannot stall the request indefinitely.
const GITHUB_429_RETRY_AFTER_CAP_MS = 60_000
const GEMINI_API_HOST = 'generativelanguage.googleapis.com'
const MOONSHOT_API_HOSTS = new Set([
  'api.moonshot.ai',
  'api.moonshot.cn',
])
const KIMI_CODE_API_HOST = 'api.kimi.com'
const DEEPSEEK_API_HOSTS = new Set([
  'api.deepseek.com',
])
const COPILOT_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHubCopilotChat/0.26.7',
  'Editor-Version': 'vscode/1.99.3',
  'Editor-Plugin-Version': 'copilot-chat/0.26.7',
  'Copilot-Integration-Id': 'vscode-chat',
}

const SENSITIVE_URL_QUERY_PARAM_NAMES = [
  'api_key',
  'key',
  'token',
  'access_token',
  'refresh_token',
  'signature',
  'sig',
  'secret',
  'password',
  'authorization',
]

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

async function readJsonObjectResponse(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return recordValue(await response.json())
  } catch {
    return null
  }
}

function malformedJsonResponseError(response: Response): APIError {
  return APIError.generate(
    response.status,
    undefined,
    `OpenAi API error ${response.status}: malformed JSON response payload`,
    response.headers as unknown as Headers,
  )
}

function isGithubModelsMode(): boolean {
  return isEnvTruthy(process.env.AGENC_USE_GITHUB)
}

function firstProviderEnvString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function hasNonMiniMaxProviderSelection(): boolean {
  return (
    isEnvTruthy(process.env.AGENC_USE_GEMINI) ||
    isEnvTruthy(process.env.AGENC_USE_MISTRAL) ||
    isEnvTruthy(process.env.AGENC_USE_GITHUB) ||
    isEnvTruthy(process.env.AGENC_USE_OPENAI) ||
    isEnvTruthy(process.env.NVIDIA_NIM) ||
    firstProviderEnvString(process.env.XAI_API_KEY) !== undefined
  )
}

function hasOpenAiCompatibleProviderSelection(): boolean {
  return (
    isEnvTruthy(process.env.AGENC_USE_GEMINI) ||
    isEnvTruthy(process.env.AGENC_USE_OPENAI) ||
    firstProviderEnvString(process.env.XAI_API_KEY) !== undefined
  )
}

function requireSelectedProviderApiKey(
  providerName: string,
  envLabel: string,
  apiKey: string | undefined,
): string {
  if (apiKey) return apiKey
  throw new Error(`${envLabel} is required for ${providerName} provider`)
}

function buildMistralProviderOverride(): {
  model: string
  baseURL: string
  apiKey: string
} {
  return {
    model:
      firstProviderEnvString(process.env.MISTRAL_MODEL) ??
      DEFAULT_MISTRAL_MODEL,
    baseURL:
      firstProviderEnvString(process.env.MISTRAL_BASE_URL) ??
      'https://api.mistral.ai/v1',
    apiKey: requireSelectedProviderApiKey(
      'Mistral',
      'MISTRAL_API_KEY',
      firstProviderEnvString(process.env.MISTRAL_API_KEY),
    ),
  }
}

function buildNvidiaNimProviderOverride(): {
  model: string
  baseURL: string
  apiKey: string
} {
  return {
    model:
      firstProviderEnvString(process.env.NVIDIA_MODEL) ??
      DEFAULT_NVIDIA_NIM_MODEL,
    baseURL:
      firstProviderEnvString(process.env.NVIDIA_BASE_URL) ??
      'https://integrate.api.nvidia.com/v1',
    apiKey: requireSelectedProviderApiKey(
      'NVIDIA NIM',
      'NVIDIA_API_KEY',
      firstProviderEnvString(process.env.NVIDIA_API_KEY),
    ),
  }
}

function buildMiniMaxProviderOverride(): {
  model: string
  baseURL: string
  apiKey: string
} {
  return {
    model:
      firstProviderEnvString(process.env.MINIMAX_MODEL) ??
      DEFAULT_MINIMAX_MODEL,
    baseURL:
      firstProviderEnvString(process.env.MINIMAX_BASE_URL) ??
      'https://api.minimax.io/v1',
    apiKey: requireSelectedProviderApiKey(
      'MiniMax',
      'MINIMAX_API_KEY',
      firstProviderEnvString(process.env.MINIMAX_API_KEY),
    ),
  }
}

function buildGithubProviderOverride(): {
  model: string
  baseURL: string
  apiKey: string
} {
  return {
    model:
      firstProviderEnvString(process.env.GITHUB_MODEL) ??
      DEFAULT_GITHUB_MODEL,
    baseURL:
      firstProviderEnvString(process.env.GITHUB_BASE_URL) ??
      GITHUB_COPILOT_BASE,
    apiKey:
      requireSelectedProviderApiKey(
        'GitHub',
        'GITHUB_TOKEN or GH_TOKEN',
        firstProviderEnvString(process.env.GITHUB_TOKEN) ??
          firstProviderEnvString(process.env.GH_TOKEN),
      ),
  }
}

function resolveSelectedProviderOverride(
  selectedProvider?: SelectedShimProvider,
): { model: string; baseURL: string; apiKey: string } | undefined {
  if (selectedProvider) {
    switch (selectedProvider) {
      case 'mistral':
        return buildMistralProviderOverride()
      case 'nvidia-nim':
        return buildNvidiaNimProviderOverride()
      case 'minimax':
        return buildMiniMaxProviderOverride()
      case 'github':
        return buildGithubProviderOverride()
      default:
        return undefined
    }
  }

  if (isEnvTruthy(process.env.AGENC_USE_MISTRAL)) {
    return buildMistralProviderOverride()
  }

  if (isEnvTruthy(process.env.AGENC_USE_GITHUB)) {
    return buildGithubProviderOverride()
  }

  if (isEnvTruthy(process.env.AGENC_USE_MINIMAX)) {
    return buildMiniMaxProviderOverride()
  }

  if (
    isEnvTruthy(process.env.NVIDIA_NIM) &&
    !hasOpenAiCompatibleProviderSelection()
  ) {
    return buildNvidiaNimProviderOverride()
  }

  if (
    firstProviderEnvString(process.env.MINIMAX_API_KEY) &&
    !hasNonMiniMaxProviderSelection()
  ) {
    return buildMiniMaxProviderOverride()
  }

  return undefined
}

function isMistralMode(): boolean {
  return isEnvTruthy(process.env.AGENC_USE_MISTRAL)
}

function filterproviderHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {}

  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (
      lower.startsWith('x-anthropic') ||
      lower.startsWith('anthropic-') ||
      lower.startsWith('x-agenc') ||
      lower === 'x-app' ||
      lower === 'x-client-app' ||
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'api-key'
    ) {
      continue
    }
    filtered[key] = value
  }

  return filtered
}

function hasGeminiApiHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false

  try {
    return new URL(baseUrl).hostname.toLowerCase() === GEMINI_API_HOST
  } catch {
    return false
  }
}

function isMoonshotCompatibleBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const parsed = new URL(baseUrl)
    const hostname = parsed.hostname.toLowerCase()
    return (
      MOONSHOT_API_HOSTS.has(hostname) ||
      (hostname === KIMI_CODE_API_HOST &&
        parsed.pathname.toLowerCase().startsWith('/coding'))
    )
  } catch {
    return false
  }
}

function isDeepSeekBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    return DEEPSEEK_API_HOSTS.has(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

function normalizeDeepSeekReasoningEffort(
  effort: 'low' | 'medium' | 'high' | 'xhigh',
): 'high' | 'max' {
  return effort === 'xhigh' ? 'max' : 'high'
}

function formatRetryAfterHint(response: Response): string {
  const ra = response.headers.get('retry-after')
  return ra ? ` (Retry-After: ${ra})` : ''
}

/**
 * Parse an HTTP `Retry-After` header into milliseconds. Supports both RFC 7231
 * forms: delta-seconds (a non-negative integer) and an HTTP-date. Returns
 * `undefined` for a missing or unparseable value, and never a negative delay
 * (a date already in the past yields 0).
 */
function parseRetryAfterMs(
  headerValue: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  const raw = headerValue?.trim()
  if (!raw) return undefined
  if (/^\d+$/.test(raw)) {
    return Number.parseInt(raw, 10) * 1000
  }
  const absoluteMs = Date.parse(raw)
  return Number.isFinite(absoluteMs) ? Math.max(0, absoluteMs - nowMs) : undefined
}

/**
 * How long to wait before the next GitHub/Copilot 429 retry. Uses the larger of
 * the exponential backoff and the server's `Retry-After` hint (so we never
 * hammer the endpoint before it says it is ready), capped at
 * `GITHUB_429_RETRY_AFTER_CAP_MS` so a hostile header cannot stall us. Exported
 * for testing.
 */
export function computeGithub429WaitMs(
  attempt: number,
  retryAfterHeader: string | null,
  nowMs: number = Date.now(),
): number {
  const backoffMs =
    Math.min(GITHUB_429_BASE_DELAY_SEC * 2 ** attempt, GITHUB_429_MAX_DELAY_SEC) *
    1000
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader, nowMs)
  const waitMs =
    retryAfterMs !== undefined ? Math.max(retryAfterMs, backoffMs) : backoffMs
  return Math.min(waitMs, GITHUB_429_RETRY_AFTER_CAP_MS)
}

function shouldRedactUrlQueryParam(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_URL_QUERY_PARAM_NAMES.some(token => lower.includes(token))
}

function redactUrlForDiagnostics(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username) {
      parsed.username = 'redacted'
    }
    if (parsed.password) {
      parsed.password = 'redacted'
    }

    for (const key of parsed.searchParams.keys()) {
      if (shouldRedactUrlQueryParam(key)) {
        parsed.searchParams.set(key, 'redacted')
      }
    }

    const serialized = parsed.toString()
    return redactSecretValueForDisplay(serialized, process.env as SecretValueSource) ?? serialized
  } catch {
    return redactSecretValueForDisplay(url, process.env as SecretValueSource) ?? url
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Types — minimal subset of provider SDK types we need to produce
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Message format conversion: provider → OpenAi
// ---------------------------------------------------------------------------

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
    extra_content?: Record<string, unknown>
  }>
  tool_call_id?: string
  name?: string
  /**
   * Per-assistant-message chain-of-thought, attached when echoing an
   * assistant message back to providers that require it (notably Moonshot:
   * "thinking is enabled but reasoning_content is missing in assistant
   * tool call message at index N" 400). Derived from the provider thinking
   * block captured when the original response was translated.
   */
  reasoning_content?: string
}

interface OpenAiTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

function convertSystemPrompt(
  system: unknown,
): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .map((block: { type?: string; text?: string }) =>
        block.type === 'text' ? block.text ?? '' : '',
      )
      .join('\n\n')
  }
  return String(system)
}

function convertToolResultContent(
  content: unknown,
  isError?: boolean,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === 'string') {
    return isError ? `Error: ${content}` : content
  }
  if (!Array.isArray(content)) {
    const text = JSON.stringify(content ?? '')
    return isError ? `Error: ${text}` : text
  }

  const parts: Array<{
    type: string
    text?: string
    image_url?: { url: string }
  }> = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
      continue
    }

    if (block?.type === 'image') {
      const source = block.source
      if (source?.type === 'url' && source.url) {
        parts.push({ type: 'image_url', image_url: { url: source.url } })
      } else if (source?.type === 'base64' && source.media_type && source.data) {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${source.media_type};base64,${source.data}`,
          },
        })
      }
      continue
    }

    if (typeof block?.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    }
  }

  if (parts.length === 0) return ''
  if (parts.length === 1 && parts[0].type === 'text') {
    const text = parts[0].text ?? ''
    return isError ? `Error: ${text}` : text
  }

  // Collapse arrays of only text blocks into a single string for DeepSeek
  // compatibility (issue #774). DeepSeek rejects arrays in role: "tool" messages.
  const allText = parts.every(p => p.type === 'text')
  if (allText) {
    const text = parts.map(p => p.text ?? '').join('\n\n')
    return isError ? `Error: ${text}` : text
  }

  if (isError && parts[0]?.type === 'text') {
    parts[0] = { ...parts[0], text: `Error: ${parts[0].text ?? ''}` }
  } else if (isError) {
    parts.unshift({ type: 'text', text: 'Error:' })
  }

  return parts
}

function convertContentBlocks(
  content: unknown,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')

  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text ?? '' })
        break
      case 'image': {
        const src = block.source
        if (src?.type === 'base64') {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${src.media_type};base64,${src.data}`,
            },
          })
        } else if (src?.type === 'url') {
          parts.push({ type: 'image_url', image_url: { url: src.url } })
        }
        break
      }
      case 'tool_use':
        // handled separately
        break
      case 'tool_result':
        // handled separately
        break
      case 'thinking':
      case 'redacted_thinking':
        // Strip thinking blocks for provider-compatible providers.
        // These are provider-specific content types that 3P providers
        // don't understand. Serializing them as <thinking> text corrupts
        // multi-turn context: the model sees the tags as part of its
        // previous reply and may mimic or misattribute them.
        break
      default:
        if (block.text) {
          parts.push({ type: 'text', text: block.text })
        }
    }
  }

  if (parts.length === 0) return ''
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text ?? ''

  // Collapse arrays of only text blocks into a single string for DeepSeek
  // compatibility (issue #774).
  const allText = parts.every(p => p.type === 'text')
  if (allText) {
    return parts.map(p => p.text ?? '').join('\n\n')
  }

  return parts
}

function isGeminiMode(): boolean {
  return (
    isEnvTruthy(process.env.AGENC_USE_GEMINI) ||
    hasGeminiApiHost(process.env.OPENAI_BASE_URL)
  )
}

function convertMessages(
  messages: Array<{
    role: string
    message?: { role?: string; content?: unknown }
    content?: unknown
  }>,
  system: unknown,
  options?: { preserveReasoningContent?: boolean },
): OpenAiMessage[] {
  const preserveReasoningContent = options?.preserveReasoningContent === true
  const result: OpenAiMessage[] = []
  const knownToolCallIds = new Set<string>()

  // Pre-scan for all tool results in the history to identify valid tool calls
  const toolResultIds = new Set<string>()
  for (const msg of messages) {
    const inner = msg.message ?? msg
    const content = (inner as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          (block as { type?: string }).type === 'tool_result' &&
          (block as { tool_use_id?: string }).tool_use_id
        ) {
          toolResultIds.add((block as { tool_use_id: string }).tool_use_id)
        }
      }
    }
  }

  // System message first
  const sysText = convertSystemPrompt(system)
  if (sysText) {
    result.push({ role: 'system', content: sysText })
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const isLastInHistory = i === messages.length - 1

    // AgenC wraps messages in { role, message: { role, content } }
    const inner = msg.message ?? msg
    const role = (inner as { role?: string }).role ?? msg.role
    const content = (inner as { content?: unknown }).content

    if (role === 'user') {
      // Check for tool_result blocks in user messages
      if (Array.isArray(content)) {
        const toolResults = content.filter(
          (b: { type?: string }) => b.type === 'tool_result',
        )
        const otherContent = content.filter(
          (b: { type?: string }) => b.type !== 'tool_result',
        )

        // Emit tool results as tool messages, but ONLY if we have a matching tool_use ID.
        // Mistral/OpenAi strictly require tool messages to follow an assistant message with tool_calls.
        // If the user interrupted (ESC) and a synthetic tool_result was generated without a recorded tool_use,
        // emitting it here would cause a "role must alternate" or "unexpected role" error.
        for (const tr of toolResults) {
          const id = tr.tool_use_id ?? 'unknown'
          if (knownToolCallIds.has(id)) {
            result.push({
              role: 'tool',
              tool_call_id: id,
              content: convertToolResultContent(tr.content, tr.is_error),
            })
          } else {
            logForDebugging(
              `Dropping orphan tool_result for ID: ${id} to prevent API error`,
            )
          }
        }

        // Emit remaining user content
        if (otherContent.length > 0) {
          result.push({
            role: 'user',
            content: convertContentBlocks(otherContent),
          })
        }
      } else {
        result.push({
          role: 'user',
          content: convertContentBlocks(content),
        })
      }
    } else if (role === 'assistant') {
      // Check for tool_use blocks
      if (Array.isArray(content)) {
        const toolUses = content.filter(
          (b: { type?: string }) => b.type === 'tool_use',
        )
        const thinkingBlock = content.find(
          (b: { type?: string }) => b.type === 'thinking',
        )
        const textContent = content.filter(
          (b: { type?: string }) => b.type !== 'tool_use' && b.type !== 'thinking',
        )

        const assistantMsg: OpenAiMessage = {
          role: 'assistant',
          content: (() => {
            const c = convertContentBlocks(textContent)
            return typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? c.map((p: { text?: string }) => p.text ?? '').join('')
                : ''
          })(),
        }

        // Providers that validate reasoning continuity (Moonshot/Kimi Code: "thinking
        // is enabled but reasoning_content is missing in assistant tool call
        // message at index N" 400) need the original chain-of-thought echoed
        // back on each assistant message that carries a tool_call. We kept
        // the thinking block on the provider side; re-attach it here as the
        // `reasoning_content` field on the outgoing OpenAi-shaped message.
        // Gated per-provider because other endpoints either ignore the field
        // (harmless) or strict-reject unknown fields (harmful).
        if (preserveReasoningContent) {
          const thinkingText = (thinkingBlock as { thinking?: string } | undefined)?.thinking
          if (typeof thinkingText === 'string' && thinkingText.trim().length > 0) {
            assistantMsg.reasoning_content = thinkingText
          }
        }

        if (toolUses.length > 0) {
          const mappedToolCalls = toolUses
            .map(
              (tu: {
                id?: string
                name?: string
                input?: unknown
                extra_content?: Record<string, unknown>
                signature?: string
              }) => {
                const id = tu.id ?? `call_${crypto.randomUUID().replace(/-/g, '')}`

                // Only keep tool calls that have a corresponding result in the history,
                // or if it's the last message (prefill scenario).
                // Orphaned tool calls (e.g. from user interruption) cause 400 errors.
                if (!toolResultIds.has(id) && !isLastInHistory) {
                  return null
                }

                knownToolCallIds.add(id)
                const toolCall: NonNullable<
                  OpenAiMessage['tool_calls']
                >[number] = {
                  id,
                  type: 'function' as const,
                  function: {
                    name: tu.name ?? 'unknown',
                    arguments:
                      typeof tu.input === 'string'
                        ? tu.input
                        : JSON.stringify(tu.input ?? {}),
                  },
                }

                // Preserve existing extra_content if present
                if (tu.extra_content) {
                  toolCall.extra_content = { ...tu.extra_content }
                }

                // Handle Gemini thought_signature
                if (isGeminiMode()) {
                  // If the model provided a signature in the tool_use block itself (e.g. from a previous Turn/Step)
                  // Use thinkingBlock.signature for ALL tool calls in the same assistant turn if available.
                  // The API requires the same signature on every replayed function call part in a parallel set.
                  const signature =
                    tu.signature ?? (thinkingBlock as any)?.signature

                  // Merge into existing google-specific metadata if present
                  const existingGoogle =
                    (toolCall.extra_content?.google as Record<
                      string,
                      unknown
                    >) ?? {}
                  toolCall.extra_content = {
                    ...toolCall.extra_content,
                    google: {
                      ...existingGoogle,
                      thought_signature:
                        signature ?? 'skip_thought_signature_validator',
                    },
                  }
                }

                return toolCall
              },
            )
            .filter((tc): tc is NonNullable<typeof tc> => tc !== null)

          if (mappedToolCalls.length > 0) {
            assistantMsg.tool_calls = mappedToolCalls
          }
        }

        // Only push assistant message if it has content or tool calls.
        // Stripped thinking-only blocks from user interruptions are empty and cause 400s.
        if (assistantMsg.content || assistantMsg.tool_calls?.length) {
          result.push(assistantMsg)
        }
      } else {
        const assistantMsg: OpenAiMessage = {
          role: 'assistant',
          content: (() => {
            const c = convertContentBlocks(content)
            return typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? c.map((p: { text?: string }) => p.text ?? '').join('')
                : ''
          })(),
        }

        if (assistantMsg.content) {
          result.push(assistantMsg)
        }
      }
    }
  }

  // Coalescing pass: merge consecutive messages of the same role.
  // OpenAi/vLLM/Ollama require strict user↔assistant alternation.
  // Multiple consecutive tool messages are allowed (assistant → tool* → user).
  // Consecutive user or assistant messages must be merged to avoid Jinja
  // template errors like "roles must alternate" (Devstral, Mistral models).
  const coalesced: OpenAiMessage[] = []
  for (const msg of result) {
    const prev = coalesced[coalesced.length - 1]

    // Mistral/Devstral: 'tool' message must be followed by an 'assistant' message.
    // If a 'tool' result is followed by a 'user' message, we must inject a semantic
    // assistant response to satisfy the strict role sequence:
    // ... -> assistant (calls) -> tool (results) -> assistant (semantic) -> user (next)
    if (prev && prev.role === 'tool' && msg.role === 'user') {
      coalesced.push({
        role: 'assistant',
        content: '[Tool execution interrupted by user]',
      })
    }

    const lastAfterPossibleInjection = coalesced[coalesced.length - 1]
    if (
      lastAfterPossibleInjection &&
      lastAfterPossibleInjection.role === msg.role &&
      msg.role !== 'tool' &&
      msg.role !== 'system'
    ) {
      const prevContent = lastAfterPossibleInjection.content
      const curContent = msg.content

      if (typeof prevContent === 'string' && typeof curContent === 'string') {
        lastAfterPossibleInjection.content =
          prevContent + (prevContent && curContent ? '\n' : '') + curContent
      } else {
        const toArray = (
          c:
            | string
            | Array<{ type: string; text?: string; image_url?: { url: string } }>
            | undefined,
        ): Array<{
          type: string
          text?: string
          image_url?: { url: string }
        }> => {
          if (!c) return []
          if (typeof c === 'string') return c ? [{ type: 'text', text: c }] : []
          return c
        }
        lastAfterPossibleInjection.content = [
          ...toArray(prevContent),
          ...toArray(curContent),
        ]
      }

      if (msg.tool_calls?.length) {
        lastAfterPossibleInjection.tool_calls = [
          ...(lastAfterPossibleInjection.tool_calls ?? []),
          ...msg.tool_calls,
        ]
      }
    } else {
      coalesced.push(msg)
    }
  }

  return coalesced
}

/**
 * OpenAi requires every key in `properties` to also appear in `required`.
 * provider schemas often mark fields as optional (omitted from `required`),
 * which causes 400 errors on OpenAi/ProviderCode endpoints. This normalizes the
 * schema by ensuring `required` is a superset of `properties` keys.
 */
function normalizeSchemaForOpenAi(
  schema: Record<string, unknown>,
  strict = true,
): Record<string, unknown> {
  const record = sanitizeSchemaForOpenAiCompat(schema)

  if (record.type === 'object' && record.properties) {
    const properties = record.properties as Record<string, Record<string, unknown>>
    const existingRequired = Array.isArray(record.required) ? record.required as string[] : []

    // Recurse into each property
    const normalizedProps: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(properties)) {
      normalizedProps[key] = normalizeSchemaForOpenAi(
        value as Record<string, unknown>,
        strict,
      )
    }
    record.properties = normalizedProps

    if (strict) {
      // Keep only the properties that were originally marked required in the schema.
      // Adding every property to required[] (the previous behaviour) caused strict
      // provider-compatible providers (Groq, Azure, etc.) to reject tool calls because
      // the model correctly omits optional arguments — but the provider treats them
      // as missing required fields and returns a 400 / tool_use_failed error.
      record.required = existingRequired.filter(k => k in normalizedProps)
      // additionalProperties: false is still required by strict-mode providers.
      record.additionalProperties = false
    } else {
      // For Gemini: keep only existing required keys that are present in properties
      record.required = existingRequired.filter(k => k in normalizedProps)
    }
  }

  // Recurse into array items
  if ('items' in record) {
    if (Array.isArray(record.items)) {
      record.items = (record.items as unknown[]).map(
        item => normalizeSchemaForOpenAi(item as Record<string, unknown>, strict),
      )
    } else {
      record.items = normalizeSchemaForOpenAi(record.items as Record<string, unknown>, strict)
    }
  }

  // Recurse into combinators
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (key in record && Array.isArray(record[key])) {
      record[key] = (record[key] as unknown[]).map(
        item => normalizeSchemaForOpenAi(item as Record<string, unknown>, strict),
      )
    }
  }

  return record
}

function convertTools(
  tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
): OpenAiTool[] {
  const isGemini = isGeminiMode()

  return tools
    .filter(t => t.name !== 'ToolSearchTool') // Not relevant for OpenAi
    .map(t => {
      // Guarantee an object root. Strict OpenAI-compatible providers (x.ai
      // grok, deepseek) reject a root-level anyOf/oneOf union with "tool
      // parameter root must be an object type". A union/non-object root is
      // rewritten into a permissive object; its fields are conditional, so
      // strict required-superset enforcement is skipped for that tool.
      const { schema: objectRootSchema, strictEligible } =
        normalizeToolParamSchema(t.input_schema ?? { type: 'object', properties: {} })
      const schema = { ...objectRootSchema } as Record<string, unknown>

      // For ProviderCode/OpenAi: promote known Agent sub-fields into required[] only if
      // they actually exist in properties (Gemini rejects required keys absent from properties).
      if (t.name === 'Agent' && schema.properties) {
        const props = schema.properties as Record<string, unknown>
        if (!Array.isArray(schema.required)) schema.required = []
        const req = schema.required as string[]
        for (const key of ['message', 'subagent_type']) {
          if (key in props && !req.includes(key)) req.push(key)
        }
      }

      const strict =
        strictEligible &&
        !isGemini &&
        !isEnvTruthy(process.env.AGENC_DISABLE_STRICT_TOOLS)

      return {
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: normalizeSchemaForOpenAi(schema, strict),
        },
      }
    })
}

// ---------------------------------------------------------------------------
// Streaming: OpenAi SSE → provider stream events
// ---------------------------------------------------------------------------

interface OpenAiStreamChunk {
  id: string
  object: string
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
        extra_content?: Record<string, unknown>
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
  }
}

function makeMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, '')}`
}

function convertChunkUsage(
  usage: OpenAiStreamChunk['usage'] | undefined,
): Partial<providerUsage> | undefined {
  if (!usage) return undefined
  // Delegates to the shared helper so this path, openAiCodeTransform.makeUsage,
  // the non-streaming response below, and the integration tests all
  // produce byte-identical output for the same raw input.
  return buildproviderUsageFromRawUsage(
    usage as unknown as Record<string, unknown>,
  )
}

const JSON_REPAIR_SUFFIXES = [
  '}', '"}', ']}', '"]}', '}}', '"}}', ']}}', '"]}}', '"]}]}', '}]}'
]

function repairPossiblyTruncatedObjectJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? raw
      : null
  } catch {
    for (const combo of JSON_REPAIR_SUFFIXES) {
      try {
        const repaired = raw + combo
        const parsed = JSON.parse(repaired)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return repaired
        }
      } catch {
        continue
      }
    }
    return null
  }
}

/**
 * Async generator that transforms an OpenAi SSE stream into
 * provider-format BetaRawMessageStreamEvent objects.
 */
async function* openaiStreamToprovider(
  response: Response,
  model: string,
  _signal?: AbortSignal,
): AsyncGenerator<providerStreamEvent> {
  const messageId = makeMessageId()
  let contentBlockIndex = 0
  const activeToolCalls = new Map<
    number,
    {
      // id / name may arrive in separate delta chunks; the block is only
      // started (content_block_start emitted) once both are known.
      id?: string
      name?: string
      index?: number
      jsonBuffer: string
      // chars of jsonBuffer already emitted as input_json_delta.
      emittedLength: number
      normalizeAtStop: boolean
      started: boolean
      extraContent?: Record<string, unknown>
    }
  >()
  let hasEmittedContentStart = false
  let hasEmittedThinkingStart = false
  let hasClosedThinking = false
  const thinkFilter = createThinkTagFilter()
  let lastStopReason: 'tool_use' | 'max_tokens' | 'end_turn' | null = null
  let hasEmittedFinalUsage = false
  let hasProcessedFinishReason = false
  const streamState = createStreamState()

  // Emit message_start
  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }

  const maybeReader = response.body?.getReader()
  if (!maybeReader) return
  // Bind to a non-optional const so the narrowed type remains explicit in the
  // stream loop below.
  const reader: ReadableStreamDefaultReader<Uint8Array> = maybeReader

  const decoder = new TextDecoder()
  let buffer = ''

  const closeActiveContentBlock = async function* () {
    if (!hasEmittedContentStart) return

    const tail = thinkFilter.flush()
    if (tail) {
      yield {
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: { type: 'text_delta', text: tail },
      }
    }

    yield {
      type: 'content_block_stop',
      index: contentBlockIndex,
    }
    contentBlockIndex++
    hasEmittedContentStart = false
  }

  try {
  while (true) {
      // No implicit idle deadline: reasoning providers can legitimately leave
      // an SSE body silent for hours. The caller's signal remains the sole
      // cancellation authority unless an operator configures a deadline above
      // this transport.
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'data: [DONE]') continue
      if (!trimmed.startsWith('data: ')) continue

      let chunk: OpenAiStreamChunk
      try {
        chunk = JSON.parse(trimmed.slice(6))
      } catch {
        continue
      }

      const chunkUsage = convertChunkUsage(chunk.usage)

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta

        // Reasoning models (e.g. GLM-5, DeepSeek) may stream chain-of-thought
        // in `reasoning_content` before the actual reply appears in `content`.
        // Emit reasoning as a thinking block and content as a text block.
        if (delta.reasoning_content != null && delta.reasoning_content !== '') {
          // Reasoning can resume after its block was already closed (providers
          // like Kimi/Moonshot, MiniMax, Z.AI interleave reasoning around content
          // and tool calls). Reusing the old index would emit a thinking_delta
          // against the open text block / an unstarted index and crash the
          // consumer. Open a FRESH thinking block: if a text block is currently
          // open, close it first, then start a new thinking block at the new index.
          const needNewThinkingBlock = !hasEmittedThinkingStart || hasClosedThinking
          if (needNewThinkingBlock) {
            if (hasEmittedContentStart) {
              yield* closeActiveContentBlock()
            }
            yield {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'thinking', thinking: '' },
            }
            hasEmittedThinkingStart = true
            hasClosedThinking = false
          }
          yield {
            type: 'content_block_delta',
            index: contentBlockIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
          }
        }

        // Text content — use != null to distinguish absent field from empty string,
        // some providers send "" as first delta to signal streaming start
        if (delta.content != null && delta.content !== '') {
          // Close thinking block if transitioning from reasoning to content
          if (hasEmittedThinkingStart && !hasClosedThinking) {
            yield { type: 'content_block_stop', index: contentBlockIndex }
            contentBlockIndex++
            hasClosedThinking = true
          }
          if (!hasEmittedContentStart) {
            yield {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'text', text: '' },
            }
            hasEmittedContentStart = true
          }

          const visible = thinkFilter.feed(delta.content)
          if (visible) {
            yield {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: visible },
            }
          }
          processStreamChunk(streamState, delta.content)
        }

        // Tool calls — assemble id / name / arguments that a provider may split
        // across separate delta chunks (vLLM / LM Studio / OpenRouter passthroughs
        // do not always co-locate id and name the way the OpenAI API does). Track
        // per-index state and start the tool_use block once BOTH id and name are
        // known; arguments that arrive before then are buffered and flushed at start.
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            let active = activeToolCalls.get(tc.index)
            if (!active) {
              active = {
                jsonBuffer: '',
                emittedLength: 0,
                normalizeAtStop: false,
                started: false,
              }
              activeToolCalls.set(tc.index, active)
            }

            if (tc.id) active.id = tc.id
            if (tc.function?.name) active.name = tc.function.name
            if (tc.extra_content) active.extraContent = tc.extra_content
            if (tc.function?.arguments) active.jsonBuffer += tc.function.arguments

            if (!active.started && active.id && active.name) {
              // New tool call starting — close any open thinking / text block first.
              if (hasEmittedThinkingStart && !hasClosedThinking) {
                yield { type: 'content_block_stop', index: contentBlockIndex }
                contentBlockIndex++
                hasClosedThinking = true
              }
              if (hasEmittedContentStart) {
                yield* closeActiveContentBlock()
              }

              active.index = contentBlockIndex
              active.started = true
              active.normalizeAtStop = hasToolFieldMapping(active.name)
              // Feed whatever arguments were buffered before the start (mirrors the
              // original single-chunk call, which fed the initial fragment once).
              processStreamChunk(streamState, active.jsonBuffer)

              const extra = active.extraContent
              const thoughtSignature = (extra?.google as any)?.thought_signature
              yield {
                type: 'content_block_start',
                index: active.index,
                content_block: {
                  type: 'tool_use',
                  id: active.id,
                  name: active.name,
                  input: {},
                  ...(extra ? { extra_content: extra } : {}),
                  // Extract Gemini signature from extra_content
                  ...(thoughtSignature ? { signature: thoughtSignature } : {}),
                },
              }
              contentBlockIndex++
            }

            // Emit any not-yet-emitted buffered arguments as input_json_delta.
            // normalize-at-stop tools emit their whole buffer once, at finish.
            if (
              active.started &&
              active.index !== undefined &&
              !active.normalizeAtStop &&
              active.jsonBuffer.length > active.emittedLength
            ) {
              const fragment = active.jsonBuffer.slice(active.emittedLength)
              active.emittedLength = active.jsonBuffer.length
              yield {
                type: 'content_block_delta',
                index: active.index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: fragment,
                },
              }
            }
          }
        }

        // Finish — guard ensures we only process finish_reason once even if
        // multiple chunks arrive with finish_reason set (some providers do this)
        if (choice.finish_reason && !hasProcessedFinishReason) {
          hasProcessedFinishReason = true

          // Close any open thinking block that wasn't closed by content transition
          if (hasEmittedThinkingStart && !hasClosedThinking) {
            yield { type: 'content_block_stop', index: contentBlockIndex }
            contentBlockIndex++
            hasClosedThinking = true
          }
          // Close any open content blocks
          if (hasEmittedContentStart) {
            yield* closeActiveContentBlock()
          }
          // Close active tool calls
          for (const [, tc] of activeToolCalls) {
            // A call whose id or name never arrived was never started (no
            // content_block_start), so there is no block to close — drop it
            // rather than emit a stop for a non-existent index.
            if (!tc.started || tc.index === undefined || tc.name === undefined) {
              logForDebugging(
                `Dropping incomplete streamed tool call (id=${tc.id ?? '?'}, name=${tc.name ?? '?'}): never received both id and name`,
              )
              continue
            }
            if (tc.normalizeAtStop) {
              let partialJson: string
              if (choice.finish_reason === 'length') {
                // Truncated by max tokens — preserve raw buffer to avoid
                // turning an incomplete tool call into an executable command
                partialJson = tc.jsonBuffer
              } else {
                const repairedStructuredJson = repairPossiblyTruncatedObjectJson(
                  tc.jsonBuffer,
                )
                if (repairedStructuredJson) {
                  partialJson = repairedStructuredJson
                } else {
                  partialJson = JSON.stringify(
                    normalizeToolArguments(tc.name, tc.jsonBuffer),
                  )
                }
              }

              yield {
                type: 'content_block_delta',
                index: tc.index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: partialJson,
                },
              }
              yield { type: 'content_block_stop', index: tc.index }
              continue
            }

            let suffixToAdd = ''
            if (tc.jsonBuffer) {
              try {
                JSON.parse(tc.jsonBuffer)
              } catch {
                const str = tc.jsonBuffer.trimEnd()
                for (const combo of JSON_REPAIR_SUFFIXES) {
                  try {
                    JSON.parse(str + combo)
                    suffixToAdd = combo
                    break
                  } catch {
                    continue
                  }
                }
              }
            }

            if (suffixToAdd) {
              yield {
                type: 'content_block_delta',
                index: tc.index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: suffixToAdd,
                },
              }
            }

            yield { type: 'content_block_stop', index: tc.index }
          }

          const stopReason =
            choice.finish_reason === 'tool_calls'
              ? 'tool_use'
              : choice.finish_reason === 'length'
                ? 'max_tokens'
                : 'end_turn'
          if (choice.finish_reason === 'content_filter' || choice.finish_reason === 'safety') {
            // Gemini/Azure content safety filter blocked the response.
            // Emit a visible text block so the user knows why output was truncated.
            if (!hasEmittedContentStart) {
              yield {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'text', text: '' },
              }
              hasEmittedContentStart = true
            }
            yield {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: '\n\n[Content blocked by provider safety filter]' },
            }
          }
          lastStopReason = stopReason

          yield {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            ...(chunkUsage ? { usage: chunkUsage } : {}),
          }
          if (chunkUsage) {
            hasEmittedFinalUsage = true
          }
        }
      }

      if (
        !hasEmittedFinalUsage &&
        chunkUsage &&
        (chunk.choices?.length ?? 0) === 0 &&
        lastStopReason !== null
      ) {
        yield {
          type: 'message_delta',
          delta: { stop_reason: lastStopReason, stop_sequence: null },
          usage: chunkUsage,
        }
        hasEmittedFinalUsage = true
      }
    }
    }
  } finally {
    reader.releaseLock()
  }

  const stats = getStreamStats(streamState)
  if (stats.totalChunks > 0) {
    logForDebugging(
      JSON.stringify({
        type: 'stream_stats',
        model,
        total_chunks: stats.totalChunks,
        first_token_ms: stats.firstTokenMs,
        duration_ms: stats.durationMs,
      }),
      { level: 'debug' },
    )
  }

  yield { type: 'message_stop' }
}

// ---------------------------------------------------------------------------
// The shim client — duck-types as provider SDK
// ---------------------------------------------------------------------------

class OpenAiShimStream {
  private generator: AsyncGenerator<providerStreamEvent>
  // The controller property is checked by anthropic.ts to distinguish streams from error messages
  controller = new AbortController()

  constructor(generator: AsyncGenerator<providerStreamEvent>) {
    this.generator = generator
  }

  async *[Symbol.asyncIterator]() {
    yield* this.generator
  }
}

class OpenAiShimMessages {
  private defaultHeaders: Record<string, string>
  private reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  private providerOverride?: { model: string; baseURL: string; apiKey: string }

  constructor(defaultHeaders: Record<string, string>, reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh', providerOverride?: { model: string; baseURL: string; apiKey: string }) {
    this.defaultHeaders = filterproviderHeaders(defaultHeaders)
    this.reasoningEffort = reasoningEffort
    this.providerOverride = providerOverride
  }

  create(
    params: ShimCreateParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ) {
    const self = this

    let httpResponse: Response | undefined

    const promise = (async () => {
      const request = resolveProviderRequest({ model: self.providerOverride?.model ?? params.model, baseUrl: self.providerOverride?.baseURL, reasoningEffortOverride: self.reasoningEffort })
      const response = await self._doRequest(request, params, options)
      httpResponse = response

      if (params.stream) {
        const isResponsesStream = response.url?.includes('/responses')
        return new OpenAiShimStream(
          (
            request.transport === 'providerCode_responses' ||
            request.transport === 'responses' ||
            isResponsesStream
          )
            ? providerCodeStreamToprovider(response, request.resolvedModel, options?.signal)
            : openaiStreamToprovider(response, request.resolvedModel, options?.signal),
        )
      }

      if (request.transport === 'providerCode_responses') {
        const data = await collectProviderCodeCompletedResponse(response, options?.signal)
        return convertProviderCodeResponseToproviderMessage(
          data,
          request.resolvedModel,
        )
      }

      const isResponsesNonStream = response.url?.includes('/responses')
      if (
        request.transport === 'responses' ||
        isResponsesNonStream ||
        (request.transport === 'chat_completions' && isGithubModelsMode())
      ) {
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          const parsed = await readJsonObjectResponse(response)
          if (parsed === null) {
            throw malformedJsonResponseError(response)
          }
          if (
            ('output' in parsed || 'incomplete_details' in parsed)
          ) {
            return convertProviderCodeResponseToproviderMessage(
              parsed,
              request.resolvedModel,
            )
          }
          return self._convertNonStreamingResponse(parsed, request.resolvedModel)
        }
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        const data = await readJsonObjectResponse(response)
        if (data === null) {
          throw malformedJsonResponseError(response)
        }
        return self._convertNonStreamingResponse(data, request.resolvedModel)
      }

      const textBody = await response.text().catch(() => '')
      throw APIError.generate(
        response.status,
        undefined,
        `OpenAi API error ${response.status}: unexpected response: ${textBody.slice(0, 500)}`,
        response.headers as unknown as Headers,
      )
    })()

      ; (promise as unknown as Record<string, unknown>).withResponse =
        async () => {
          const data = await promise
          return {
            data,
            response: httpResponse ?? new Response(),
            request_id:
              httpResponse?.headers.get('x-request-id') ?? makeMessageId(),
          }
        }

    return promise
  }

  private async _doRequest(
    request: ReturnType<typeof resolveProviderRequest>,
    params: ShimCreateParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<Response> {
    const isGithubMode = isGithubModelsMode()
    const isGithubWithProviderCodeTransport = isGithubMode && request.transport === 'providerCode_responses'

    if (isGithubWithProviderCodeTransport) {
      const apiKey = this.providerOverride?.apiKey ?? process.env.OPENAI_API_KEY ?? ''
      if (!apiKey) {
        throw new Error(
          'GitHub Copilot auth is required. Set GITHUB_TOKEN/GH_TOKEN or configure the github provider from /provider.',
        )
      }

      return performProviderCodeRequest({
        request,
        credentials: {
          apiKey,
          source: 'env',
        },
        params,
        defaultHeaders: {
          ...this.defaultHeaders,
          ...filterproviderHeaders(options?.headers),
          ...COPILOT_HEADERS,
        },
        signal: options?.signal,
      })
    }

    if (request.transport === 'providerCode_responses' && !isGithubMode) {
      const refreshResult = await refreshProviderCodeAccessTokenIfNeeded().catch(
        async error => {
          logForDebugging(
            `[providerCode] access token refresh failed before request: ${error instanceof Error ? error.message : String(error)}`,
            { level: 'warn' },
          )
          return {
            refreshed: false,
            credentials: await readProviderCodeCredentialsAsync(),
          }
        },
      )
      const credentials = resolveRuntimeOpenAiCodeCredentials({
        storedCredentials: refreshResult.credentials,
      })
      if (!credentials.apiKey) {
        const oauthHint = isBareMode() ? '' : ', choose ProviderCode OAuth in /provider'
        const authHint = credentials.authPath
          ? `${oauthHint} or place a ProviderCode auth.json at ${credentials.authPath}`
          : oauthHint
        const safeModel =
          redactSecretValueForDisplay(request.requestedModel, process.env as SecretValueSource) ??
          'the requested model'
        throw new Error(
          `ProviderCode auth is required for ${safeModel}. Set PROVIDER_CODE_API_KEY${authHint}.`,
        )
      }
      if (!credentials.accountId) {
        throw new Error(
          'ProviderCode auth is missing chatgpt_account_id. Re-login with ProviderCode OAuth, the ProviderCode CLI, or set CHATGPT_ACCOUNT_ID/PROVIDER_CODE_ACCOUNT_ID.',
        )
      }

      return performProviderCodeRequest({
        request,
        credentials,
        params,
        defaultHeaders: {
          ...this.defaultHeaders,
          ...filterproviderHeaders(options?.headers),
        },
        signal: options?.signal,
      })
    }

    return this._doOpenAiRequest(request, params, options)
  }

  private async _doOpenAiRequest(
    request: ReturnType<typeof resolveProviderRequest>,
    params: ShimCreateParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<Response> {
    const compressedMessages = compressToolHistory(
      params.messages as Array<{
        role: string
        message?: { role?: string; content?: unknown }
        content?: unknown
      }>,
      request.resolvedModel,
    )
    const openaiMessages = convertMessages(compressedMessages, params.system, {
      // Moonshot/Kimi Code requires every assistant tool-call message to carry
      // reasoning_content when its thinking feature is active. DeepSeek does
      // the same for tool-call turns in thinking mode. Echo it back from the
      // thinking block we captured on the inbound response.
      preserveReasoningContent:
        isMoonshotCompatibleBaseUrl(request.baseUrl) ||
        isDeepSeekBaseUrl(request.baseUrl) ||
        isZaiBaseUrl(request.baseUrl),
    })

    const body: Record<string, unknown> = {
      model: request.resolvedModel,
      messages: openaiMessages,
      stream: params.stream ?? false,
      store: false,
    }
    // Convert max_tokens to max_completion_tokens for OpenAi API compatibility.
    // Azure OpenAi requires max_completion_tokens and does not accept max_tokens.
    // Ensure max_tokens is a valid positive number before using it.
    const maxTokensValue = typeof params.max_tokens === 'number' && params.max_tokens > 0
      ? params.max_tokens
      : undefined
    const maxCompletionTokensValue = typeof (params as Record<string, unknown>).max_completion_tokens === 'number'
      ? (params as Record<string, unknown>).max_completion_tokens as number
      : undefined

    if (maxTokensValue !== undefined) {
      body.max_completion_tokens = maxTokensValue
    } else if (maxCompletionTokensValue !== undefined) {
      body.max_completion_tokens = maxCompletionTokensValue
    }

    if (params.stream && !isLocalProviderUrl(request.baseUrl)) {
      body.stream_options = { include_usage: true }
    }

    const isGithub = isGithubModelsMode()
    const isMistral = isMistralMode()
    const isLocal = isLocalProviderUrl(request.baseUrl)

    const githubEndpointType = getGithubEndpointType(request.baseUrl)
    const isGithubCopilot = isGithub && githubEndpointType === 'copilot'
    const isGithubModels = isGithub && (githubEndpointType === 'models' || githubEndpointType === 'custom')

    const isMoonshot = isMoonshotCompatibleBaseUrl(request.baseUrl)
    const isDeepSeek = isDeepSeekBaseUrl(request.baseUrl)
    const isZai = isZaiBaseUrl(request.baseUrl)

    if (
      (
        isGithub ||
        isMistral ||
        isLocal ||
        isMoonshot ||
        isDeepSeek ||
        isZai
      ) &&
      body.max_completion_tokens !== undefined
    ) {
      body.max_tokens = body.max_completion_tokens
      delete body.max_completion_tokens
    }

    // mistral and gemini don't recognize body.store — Gemini returns 400
    // "Invalid JSON payload received. Unknown name 'store': Cannot find field."
    // Moonshot direct API, Kimi Code's provider-compatible coding endpoint,
    // DeepSeek, and Z.AI have not published support for the parameter either;
    // strip it preemptively to avoid the same class of error on strict-parse
    // providers.
    if (isMistral || isGeminiMode() || isMoonshot || isDeepSeek || isZai) {
      delete body.store
    }

    if (params.temperature !== undefined) body.temperature = params.temperature
    if (params.top_p !== undefined) body.top_p = params.top_p

    if (isDeepSeek) {
      const requestedThinkingType = (params.thinking as { type?: string } | undefined)?.type
      const deepSeekThinkingType =
        requestedThinkingType === 'disabled'
          ? 'disabled'
          : requestedThinkingType === 'enabled' || requestedThinkingType === 'adaptive'
            ? 'enabled'
            : undefined

      if (deepSeekThinkingType) {
        body.thinking = { type: deepSeekThinkingType }
      }

      if (deepSeekThinkingType === 'enabled') {
        const effort = request.reasoning?.effort
        if (effort) {
          body.reasoning_effort = normalizeDeepSeekReasoningEffort(effort)
        }
      }
    }

    // Z.AI uses the same thinking format as DeepSeek: { type: "enabled" | "disabled" }
    // with reasoning_content in responses.
    if (isZai) {
      const requestedThinkingType = (params.thinking as { type?: string } | undefined)?.type
      if (requestedThinkingType && requestedThinkingType !== 'disabled') {
        body.thinking = { type: 'enabled' }
      } else if (requestedThinkingType === 'disabled') {
        body.thinking = { type: 'disabled' }
      }
    }

    if (params.tools && params.tools.length > 0) {
      const converted = convertTools(
        params.tools as Array<{
          name: string
          description?: string
          input_schema?: Record<string, unknown>
        }>,
      )
      if (converted.length > 0) {
        body.tools = converted
        if (params.tool_choice) {
          const tc = params.tool_choice as { type?: string; name?: string }
          if (tc.type === 'auto') {
            body.tool_choice = 'auto'
          } else if (tc.type === 'tool' && tc.name) {
            body.tool_choice = {
              type: 'function',
              function: { name: tc.name },
            }
          } else if (tc.type === 'any') {
            body.tool_choice = 'required'
          } else if (tc.type === 'none') {
            body.tool_choice = 'none'
          }
        }
      }
    }

    let omitResponsesTools = false
    const buildResponsesBody = (): Record<string, unknown> => {
      const responsesBody: Record<string, unknown> = {
        model: request.resolvedModel,
        input: convertproviderMessagesToResponsesInput(
          params.messages as Array<{
            role?: string
            message?: { role?: string; content?: unknown }
            content?: unknown
          }>,
        ),
        stream: params.stream ?? false,
        store: false,
      }

      if (isMistral || isGeminiMode() || isMoonshot || isDeepSeek || isZai) {
        delete responsesBody.store
      }

      if (!Array.isArray(responsesBody.input) || responsesBody.input.length === 0) {
        responsesBody.input = [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '' }],
          },
        ]
      }

      const systemText = convertSystemPrompt(params.system)
      if (systemText) {
        responsesBody.instructions = systemText
      }

      if (body.max_tokens !== undefined) {
        responsesBody.max_output_tokens = body.max_tokens
      } else if (body.max_completion_tokens !== undefined) {
        responsesBody.max_output_tokens = body.max_completion_tokens
      }

      if (params.temperature !== undefined) responsesBody.temperature = params.temperature
      if (params.top_p !== undefined) responsesBody.top_p = params.top_p

      if (!omitResponsesTools && params.tools && params.tools.length > 0) {
        const convertedTools = convertToolsToResponsesTools(
          params.tools as Array<{
            name?: string
            description?: string
            input_schema?: Record<string, unknown>
          }>,
        )
        if (convertedTools.length > 0) {
          responsesBody.tools = convertedTools
        }
      }

      return responsesBody
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...filterproviderHeaders(options?.headers),
    }

    const isGemini = isGeminiMode()
    const apiKey =
      this.providerOverride?.apiKey ??
      process.env.OPENAI_API_KEY ??
      ''
    const configuredAuthHeaderValue = process.env.OPENAI_AUTH_HEADER_VALUE?.trim()
    const customAuthHeader = process.env.OPENAI_AUTH_HEADER?.trim()
    const hasCustomAuthHeader = Boolean(
      customAuthHeader &&
      /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(customAuthHeader),
    )
    const authValue = hasCustomAuthHeader
      ? configuredAuthHeaderValue || apiKey
      : apiKey
    // Detect Azure endpoints by hostname (not raw URL) to prevent bypass via
    // path segments like https://evil.com/cognitiveservices.azure.com/
    let isAzure = false
    try {
      const { hostname } = new URL(request.baseUrl)
      isAzure = hostname.endsWith('.azure.com') &&
        (hostname.includes('cognitiveservices') || hostname.includes('openai') || hostname.includes('services.ai'))
    } catch { /* malformed URL — not Azure */ }

    let isBankr = false
    try {
      isBankr = request.baseUrl.toLowerCase().includes('bankr')
    } catch { /* malformed URL — not Bankr */ }

    if (authValue) {
      if (hasCustomAuthHeader && customAuthHeader) {
        const defaultCustomAuthScheme =
          customAuthHeader.toLowerCase() === 'authorization' ? 'bearer' : 'raw'
        const customAuthScheme =
          process.env.OPENAI_AUTH_SCHEME === 'raw' ||
          process.env.OPENAI_AUTH_SCHEME === 'bearer'
            ? process.env.OPENAI_AUTH_SCHEME
            : defaultCustomAuthScheme
        headers[customAuthHeader] =
          customAuthScheme === 'bearer'
            ? `Bearer ${authValue}`
            : authValue
      } else if (isAzure) {
        // Azure uses api-key header instead of Bearer token
        headers['api-key'] = authValue
      } else if (isBankr) {
        // Bankr uses X-API-Key header instead of Bearer token
        headers['X-API-Key'] = authValue
      } else {
        headers.Authorization = `Bearer ${authValue}`
      }
    } else if (isGemini) {
      const geminiCredential = await resolveGeminiCredential(process.env)
      if (geminiCredential.kind !== 'none') {
        headers.Authorization = `Bearer ${geminiCredential.credential}`
        if (geminiCredential.kind !== 'api-key' && 'projectId' in geminiCredential && geminiCredential.projectId) {
          headers['x-goog-user-project'] = geminiCredential.projectId
        }
      }
    }

    if (isGithubCopilot) {
      Object.assign(headers, COPILOT_HEADERS)
    } else if (isGithubModels) {
      headers['Accept'] = 'application/vnd.github+json'
      headers['X-GitHub-Api-Version'] = '2022-11-28'
    }

    const buildChatCompletionsUrl = (baseUrl: string): string => {
      // Azure Cognitive Services / Azure OpenAi require a deployment-specific
      // path and an api-version query parameter.
      if (isAzure) {
        const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? '2024-12-01-preview'
        const deployment = request.resolvedModel ?? process.env.OPENAI_MODEL ?? 'gpt-4o'

        // If base URL already contains /deployments/, use it as-is with api-version.
        if (/\/deployments\//i.test(baseUrl)) {
          const normalizedBase = baseUrl.replace(/\/+$/, '')
          return `${normalizedBase}/chat/completions?api-version=${apiVersion}`
        }

        // Strip trailing /v1 or /openai/v1 if present, then build Azure path.
        const normalizedBase = baseUrl
          .replace(/\/(openai\/)?v1\/?$/, '')
          .replace(/\/+$/, '')

        return `${normalizedBase}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
      }

      return `${baseUrl}/chat/completions`
    }

    const localRetryBaseUrls = isLocal
      ? getLocalProviderRetryBaseUrls(request.baseUrl)
      : []

    const buildRequestUrl = (baseUrl: string): string =>
      request.transport === 'responses'
        ? `${baseUrl}/responses`
        : buildChatCompletionsUrl(baseUrl)

    let activeBaseUrl = request.baseUrl
    let requestUrl = buildRequestUrl(activeBaseUrl)
    const attemptedLocalBaseUrls = new Set<string>([activeBaseUrl])
    let didRetryWithoutTools = false

    const promoteNextLocalBaseUrl = (
      reason: 'endpoint_not_found' | 'localhost_resolution_failed',
    ): boolean => {
      for (const candidateBaseUrl of localRetryBaseUrls) {
        if (attemptedLocalBaseUrls.has(candidateBaseUrl)) {
          continue
        }

        const previousUrl = requestUrl
        attemptedLocalBaseUrls.add(candidateBaseUrl)
        activeBaseUrl = candidateBaseUrl
        requestUrl = buildRequestUrl(activeBaseUrl)

        logForDebugging(
          `[OpenAiShim] self-heal retry reason=${reason} method=POST from=${redactUrlForDiagnostics(previousUrl)} to=${redactUrlForDiagnostics(requestUrl)} model=${request.resolvedModel}`,
          { level: 'warn' },
        )

        return true
      }

      return false
    }

    // WHY: byte-identity required for implicit prefix caching in
    // OpenAi/Kimi/DeepSeek. stableStringify sorts object keys at every
    // depth so spurious insertion-order differences across rebuilds of
    // `body` (spread-merge, conditional assignments above) don't bust
    // the provider's prefix hash.
    let serializedBody = stableStringify(
      request.transport === 'responses' ? buildResponsesBody() : body,
    )

    const refreshSerializedBody = (): void => {
      serializedBody = stableStringify(
        request.transport === 'responses' ? buildResponsesBody() : body,
      )
    }

    const buildFetchInit = () => ({
      method: 'POST' as const,
      headers,
      body: serializedBody,
      signal: options?.signal,
    })

    const maxSelfHealAttempts = isLocal
      ? localRetryBaseUrls.length + 1
      : 0
    const maxAttempts = (isGithub ? GITHUB_429_MAX_RETRIES : 1) + maxSelfHealAttempts

    const throwClassifiedTransportError = (
      error: unknown,
      requestUrl: string,
      preclassifiedFailure?: ReturnType<typeof classifyOpenAiNetworkFailure>,
    ): never => {
      if (options?.signal?.aborted) {
        throw error
      }

      const failure =
        preclassifiedFailure ??
        classifyOpenAiNetworkFailure(error, {
          url: requestUrl,
        })
      const redactedUrl = redactUrlForDiagnostics(requestUrl)
      const safeMessage =
        redactSecretValueForDisplay(
          failure.message,
          process.env as SecretValueSource,
        ) || 'Request failed'

      logForDebugging(
        `[OpenAiShim] transport failure category=${failure.category} retryable=${failure.retryable} code=${failure.code ?? 'unknown'} method=POST url=${redactedUrl} model=${request.resolvedModel} message=${safeMessage}`,
        { level: 'warn' },
      )

      throw APIError.generate(
        503,
        undefined,
        buildOpenAiCompatibilityErrorMessage(
          `OpenAi API transport error: ${safeMessage}${failure.code ? ` (code=${failure.code})` : ''}`,
          failure,
        ),
        new Headers(),
      )
    }

    const throwClassifiedHttpError = (
      status: number,
      errorBody: string,
      parsedBody: object | undefined,
      responseHeaders: Headers,
      requestUrl: string,
      rateHint = '',
      preclassifiedFailure?: ReturnType<typeof classifyOpenAiHttpFailure>,
    ): never => {
      const failure =
        preclassifiedFailure ??
        classifyOpenAiHttpFailure({
          status,
          body: errorBody,
        })
      const redactedUrl = redactUrlForDiagnostics(requestUrl)

      logForDebugging(
        `[OpenAiShim] request failed category=${failure.category} retryable=${failure.retryable} status=${status} method=POST url=${redactedUrl} model=${request.resolvedModel}`,
        { level: 'warn' },
      )

      throw APIError.generate(
        status,
        parsedBody,
        buildOpenAiCompatibilityErrorMessage(
          `OpenAi API error ${status}: ${errorBody}${rateHint}`,
          failure,
        ),
        responseHeaders,
      )
    }

    let response: Response | undefined
    const provider = request.baseUrl.includes('nvidia') ? 'nvidia-nim'
      : request.baseUrl.includes('minimax') ? 'minimax'
      : request.baseUrl.includes('localhost:11434') || request.baseUrl.includes('localhost:11435') ? 'ollama'
      : request.baseUrl.includes('anthropic') ? 'anthropic'
      : 'openai'
    const { correlationId, startTime } = logApiCallStart(provider, request.resolvedModel)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        response = await fetchWithProxyRetry(
          requestUrl,
          buildFetchInit(),
        )
      } catch (error) {
        const isAbortError =
          options?.signal?.aborted === true ||
          (typeof DOMException !== 'undefined' &&
            error instanceof DOMException &&
            error.name === 'AbortError') ||
          (typeof error === 'object' &&
            error !== null &&
            'name' in error &&
            error.name === 'AbortError')

        if (isAbortError) {
          throw error
        }

        const failure = classifyOpenAiNetworkFailure(error, {
          url: requestUrl,
        })

        if (
          isLocal &&
          failure.category === 'localhost_resolution_failed' &&
          promoteNextLocalBaseUrl('localhost_resolution_failed')
        ) {
          continue
        }

        // throwClassifiedTransportError returns `never`; the `throw` is for
        // control-flow narrowing only (the helper always throws first, so this
        // outer throw is never reached). Without it, the `continue` branch above
        // leaves `response` typed as possibly-undefined after the try/catch.
        throw throwClassifiedTransportError(error, requestUrl, failure)
      }

      if (response.ok) {
        let tokensIn = 0
        let tokensOut = 0
        // Skip clone() for streaming responses - it blocks until full body is received,
        // defeating the purpose of streaming. Usage data is already sent via
        // stream_options: { include_usage: true } and can be extracted from the stream.
        if (!params.stream) {
          try {
            const clone = response.clone()
            const data = await clone.json()
            tokensIn = data.usage?.prompt_tokens ?? 0
            tokensOut = data.usage?.completion_tokens ?? 0
          } catch { /* ignore */ }
        }
        logApiCallEnd(correlationId, startTime, request.resolvedModel, 'success', tokensIn, tokensOut, false)
        return response
      }

      if (
        isGithub &&
        response.status === 429 &&
        attempt < maxAttempts - 1
      ) {
        await response.text().catch(() => {})
        await sleepMs(
          computeGithub429WaitMs(attempt, response.headers.get('retry-after')),
        )
        continue
      }
      // Read body exactly once here — Response body is a stream that can only
      // be consumed a single time.
      const errorBody = await response.text().catch(() => 'unknown error')
      const rateHint =
        isGithub && response.status === 429 ? formatRetryAfterHint(response) : ''

      // If GitHub Copilot returns error about /chat/completions,
      // try the /responses endpoint (needed for GPT-5+ models)
      if (isGithub && response.status === 400) {
        if (errorBody.includes('/chat/completions') || errorBody.includes('not accessible')) {
          const responsesUrl = `${request.baseUrl}/responses`
          const responsesBody = buildResponsesBody()

          let responsesResponse: Response
          try {
            responsesResponse = await fetchWithProxyRetry(responsesUrl, {
              method: 'POST',
              headers,
              body: stableStringify(responsesBody),
              signal: options?.signal,
            })
          } catch (error) {
            // `throw` is for CFA narrowing only — throwClassifiedTransportError
            // returns `never` and always throws first, so responsesResponse is
            // definitely assigned past this catch.
            throw throwClassifiedTransportError(error, responsesUrl)
          }

          if (responsesResponse.ok) {
            return responsesResponse
          }
          const responsesErrorBody = await responsesResponse.text().catch(() => 'unknown error')
          const responsesFailure = classifyOpenAiHttpFailure({
            status: responsesResponse.status,
            body: responsesErrorBody,
          })
          let responsesErrorResponse: object | undefined
          try { responsesErrorResponse = JSON.parse(responsesErrorBody) } catch { /* raw text */ }
          throwClassifiedHttpError(
            responsesResponse.status,
            responsesErrorBody,
            responsesErrorResponse,
            responsesResponse.headers,
            responsesUrl,
            '',
            responsesFailure,
          )
        }
      }

      const failure = classifyOpenAiHttpFailure({
        status: response.status,
        body: errorBody,
      })

      if (
        isLocal &&
        failure.category === 'endpoint_not_found' &&
        promoteNextLocalBaseUrl('endpoint_not_found')
      ) {
        continue
      }

      const hasToolsPayload =
        request.transport === 'responses'
          ? Array.isArray(params.tools) && params.tools.length > 0
          : Array.isArray(body.tools) && body.tools.length > 0

      if (
        !didRetryWithoutTools &&
        failure.category === 'tool_call_incompatible' &&
        shouldAttemptLocalToollessRetry({
          baseUrl: activeBaseUrl,
          hasTools: hasToolsPayload,
        })
      ) {
        didRetryWithoutTools = true
        delete body.tools
        delete body.tool_choice
        omitResponsesTools = true
        refreshSerializedBody()

        logForDebugging(
          `[OpenAiShim] self-heal retry reason=tool_call_incompatible mode=toolless method=POST url=${redactUrlForDiagnostics(requestUrl)} model=${request.resolvedModel}`,
          { level: 'warn' },
        )
        continue
      }

      let errorResponse: object | undefined
      try { errorResponse = JSON.parse(errorBody) } catch { /* raw text */ }
      throwClassifiedHttpError(
        response.status,
        errorBody,
        errorResponse,
        response.headers as unknown as Headers,
        requestUrl,
        rateHint,
        failure,
      )
    }

    throw APIError.generate(
      500, undefined, 'OpenAi shim: request loop exited unexpectedly',
      new Headers(),
    )
  }

  private _convertNonStreamingResponse(
    data: {
      id?: string
      model?: string
      choices?: Array<{
        message?: {
          role?: string
          content?:
            | string
            | null
            | Array<{ type?: string; text?: string }>
          reasoning_content?: string | null
          tool_calls?: Array<{
            id: string
            // Optional: external / provider-compatible responses may omit or
            // malform `function`; the loop below validates before dereferencing.
            function?: { name?: string; arguments?: string }
            extra_content?: Record<string, unknown>
          }>
        }
        finish_reason?: string
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: {
          cached_tokens?: number
        }
      }
    },
    model: string,
  ) {
    const choice = data.choices?.[0]
    const content: Array<Record<string, unknown>> = []

    // Some reasoning models (e.g. GLM-5) put their chain-of-thought in
    // reasoning_content while content stays null. Preserve it as a thinking
    // block, but do not surface it as visible assistant text.
    const reasoningText = choice?.message?.reasoning_content
    if (typeof reasoningText === 'string' && reasoningText) {
      content.push({ type: 'thinking', thinking: reasoningText })
    }
    const rawContent =
      choice?.message?.content !== '' && choice?.message?.content != null
        ? choice?.message?.content
        : null
    if (typeof rawContent === 'string' && rawContent) {
      content.push({
        type: 'text',
        text: stripThinkTags(rawContent),
      })
    } else if (Array.isArray(rawContent) && rawContent.length > 0) {
      const parts: string[] = []
      for (const part of rawContent) {
        if (
          part &&
          typeof part === 'object' &&
          part.type === 'text' &&
          typeof part.text === 'string'
        ) {
          parts.push(part.text)
        }
      }
      const joined = parts.join('\n')
      if (joined) {
        content.push({
          type: 'text',
          text: stripThinkTags(joined),
        })
      }
    }

    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        // A malformed provider response (tool_calls: [{ id }] or a non-function
        // entry) would throw a bare TypeError here, bypassing the shim's error
        // classification. Skip such entries with a debug log instead.
        if (typeof tc.function?.name !== 'string') {
          logForDebugging(
            `Skipping malformed non-streaming tool_call (id=${tc.id ?? '?'}): missing function.name`,
          )
          continue
        }
        const input = normalizeToolArguments(
          tc.function.name,
          tc.function.arguments ?? '',
        )
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
          ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
          // Extract Gemini signature from extra_content
          ...((tc.extra_content?.google as any)?.thought_signature
            ? { signature: (tc.extra_content?.google as any).thought_signature }
            : {}),
        })
      }
    }

    const stopReason =
      choice?.finish_reason === 'tool_calls'
        ? 'tool_use'
        : choice?.finish_reason === 'length'
          ? 'max_tokens'
          : 'end_turn'

    if (choice?.finish_reason === 'content_filter' || choice?.finish_reason === 'safety') {
      content.push({
        type: 'text',
        text: '\n\n[Content blocked by provider safety filter]',
      })
    }

    return {
      id: data.id ?? makeMessageId(),
      type: 'message',
      role: 'assistant',
      content,
      model: data.model ?? model,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: buildproviderUsageFromRawUsage(
        data.usage as unknown as Record<string, unknown> | undefined,
      ),
    }
  }
}

class OpenAiShimBeta {
  messages: OpenAiShimMessages
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'

  constructor(defaultHeaders: Record<string, string>, reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh', providerOverride?: { model: string; baseURL: string; apiKey: string }) {
    this.messages = new OpenAiShimMessages(defaultHeaders, reasoningEffort, providerOverride)
    this.reasoningEffort = reasoningEffort
  }
}

export function createOpenAiShimClient(options: {
  defaultHeaders?: Record<string, string>
  maxRetries?: number
  timeout?: number
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  providerOverride?: { model: string; baseURL: string; apiKey: string }
  selectedProvider?: SelectedShimProvider
}): unknown {
  hydrateGeminiAccessTokenFromSecureStorage()
  hydrateGithubModelsTokenFromSecureStorage()
  const providerOverride =
    options.providerOverride ??
    resolveSelectedProviderOverride(options.selectedProvider)

  // When Gemini provider is active, map Gemini env vars to provider-compatible ones
  // so the existing providerConfig.ts infrastructure picks them up correctly.
  if (!providerOverride && isEnvTruthy(process.env.AGENC_USE_GEMINI)) {
    process.env.OPENAI_BASE_URL ??=
      process.env.GEMINI_BASE_URL ??
      'https://generativelanguage.googleapis.com/v1beta/openai'
    const geminiApiKey =
      process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
    if (geminiApiKey && !process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = geminiApiKey
    }
    if (process.env.GEMINI_MODEL && !process.env.OPENAI_MODEL) {
      process.env.OPENAI_MODEL = process.env.GEMINI_MODEL
    }
  }

  // Map Bankr env vars to provider-compatible ones when present
  if (!providerOverride) {
    if (process.env.BNKR_API_KEY && !process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = process.env.BNKR_API_KEY
    }
    if (process.env.BANKR_BASE_URL && !process.env.OPENAI_BASE_URL) {
      process.env.OPENAI_BASE_URL = process.env.BANKR_BASE_URL
    }
    if (process.env.BANKR_MODEL && !process.env.OPENAI_MODEL) {
      process.env.OPENAI_MODEL = process.env.BANKR_MODEL
    }
  }

  const beta = new OpenAiShimBeta({
    ...(options.defaultHeaders ?? {}),
  }, options.reasoningEffort, providerOverride)
  return {
    beta,
    messages: beta.messages,
  }
}
