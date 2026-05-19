// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { existsSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  isAgencRefreshFailureCoolingDown as isProviderCodeRefreshFailureCoolingDown,
  readAgencCredentials as readProviderCodeCredentials,
  type AgencCredentialBlob as ProviderCodeCredentialBlob,
} from '../../utils/agencCredentials.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  asTrimmedString,
  parseChatgptAccountId,
} from './openAiCodeOAuthShared.js'
import { DEFAULT_GEMINI_BASE_URL } from 'src/utils/providerProfile.js'

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_PROVIDER_CODE_BASE_URL = 'https://chatgpt.com/backend-api/providerCode'
const DEFAULT_MISTRAL_BASE_URL = 'https://api.mistral.ai/v1'
/** Default GitHub Copilot API model when user selects copilot / github:copilot */
export const DEFAULT_GITHUB_MODELS_API_MODEL = 'gpt-4o'
const warnedUndefinedEnvNames = new Set<string>()

const PROVIDER_CODE_ALIAS_MODELS: Record<
  string,
  {
    model: string
    reasoningEffort?: ReasoningEffort
  }
> = {
  providerCodeplan: {
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  },
  'gpt-5.5': {
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  },
  'gpt-5.4': {
    model: 'gpt-5.4',
    reasoningEffort: 'high',
  },
  'gpt-5.3-providerCode': {
    model: 'gpt-5.3-providerCode',
    reasoningEffort: 'high',
  },
  'gpt-5.3-providerCode-spark': {
    model: 'gpt-5.3-providerCode-spark',
  },
  providerCodespark: {
    model: 'gpt-5.3-providerCode-spark',
  },
  'gpt-5.2-providerCode': {
    model: 'gpt-5.2-providerCode',
    reasoningEffort: 'high',
  },
  'gpt-5.1-providerCode-max': {
    model: 'gpt-5.1-providerCode-max',
    reasoningEffort: 'high',
  },
  'gpt-5.1-providerCode-mini': {
    model: 'gpt-5.1-providerCode-mini',
  },
  'gpt-5.5-mini': {
    model: 'gpt-5.5-mini',
    reasoningEffort: 'medium',
  },
  'gpt-5.4-mini': {
    model: 'gpt-5.4-mini',
    reasoningEffort: 'medium',
  },
  'gpt-5.2': {
    model: 'gpt-5.2',
    reasoningEffort: 'medium',
  },
} as const

type ProviderCodeAlias = keyof typeof PROVIDER_CODE_ALIAS_MODELS
type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

const OPENAI_PROVIDER_CODE_SHORTCUT_ALIASES = new Set(['providerCodeplan', 'providerCodespark'])

export type ProviderTransport = 'chat_completions' | 'responses' | 'providerCode_responses'
export type OpenAiCompatibleApiFormat = 'chat_completions' | 'responses'

export type ResolvedProviderRequest = {
  transport: ProviderTransport
  requestedModel: string
  resolvedModel: string
  baseUrl: string
  reasoning?: {
    effort: ReasoningEffort
  }
}

export type ResolvedProviderCodeCredentials = {
  apiKey: string
  accountId?: string
  authPath?: string
  source: 'env' | 'secure-storage' | 'auth.json' | 'none'
}

type ModelDescriptor = {
  raw: string
  baseModel: string
  reasoning?: {
    effort: ReasoningEffort
  }
}

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

function isPrivateIpv4Address(hostname: string): boolean {
  const octets = hostname.split('.').map(part => Number.parseInt(part, 10))
  if (octets.length !== 4 || octets.some(octet => Number.isNaN(octet))) {
    return false
  }

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  )
}

function isPrivateIpv6Address(hostname: string): boolean {
  const firstHextet = hostname.split(':', 1)[0]
  if (!firstHextet) return false

  const prefix = Number.parseInt(firstHextet, 16)
  if (Number.isNaN(prefix)) return false

  return (prefix & 0xfe00) === 0xfc00 || (prefix & 0xffc0) === 0xfe80
}

// Reads an env-var-style string intended as a URL or path, rejecting both
// empty strings and the literal string "undefined" that Windows shells can
// write when a variable is unset-then-referenced without quotes (issue #336).
function asEnvUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed === 'undefined') {
    return undefined
  }
  return trimmed
}

function asNamedEnvUrl(
  value: string | undefined,
  envName: string,
): string | undefined {
  if (!value) return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined

  if (trimmed === 'undefined') {
    if (!warnedUndefinedEnvNames.has(envName)) {
      warnedUndefinedEnvNames.add(envName)
      logForDebugging(
        `[provider-config] Environment variable ${envName} is the literal string "undefined"; ignoring it.`,
        { level: 'warn' },
      )
    }
    return undefined
  }

  return trimmed
}

function readNestedString(
  value: unknown,
  paths: string[][],
): string | undefined {
  for (const path of paths) {
    let current = value
    let valid = true
    for (const key of path) {
      if (!current || typeof current !== 'object' || !(key in current)) {
        valid = false
        break
      }
      current = (current as Record<string, unknown>)[key]
    }
    if (!valid) continue
    const stringValue = asTrimmedString(current)
    if (stringValue) return stringValue
  }
  return undefined
}

function parseReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized
  }
  return undefined
}

export function parseOpenAiCompatibleApiFormat(
  value: string | undefined,
): OpenAiCompatibleApiFormat | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase().replace(/[- ]+/g, '_')
  if (
    normalized === 'responses' ||
    normalized === 'response' ||
    normalized === 'responses_api'
  ) {
    return 'responses'
  }
  if (
    normalized === 'chat_completions' ||
    normalized === 'chat_completion' ||
    normalized === 'completions' ||
    normalized === 'completion' ||
    normalized === 'chat'
  ) {
    return 'chat_completions'
  }
  return undefined
}

function parseModelDescriptor(model: string): ModelDescriptor {
  const trimmed = model.trim()
  const queryIndex = trimmed.indexOf('?')
  if (queryIndex === -1) {
    const alias = trimmed.toLowerCase() as ProviderCodeAlias
    const aliasConfig = PROVIDER_CODE_ALIAS_MODELS[alias]
    if (aliasConfig) {
      return {
        raw: trimmed,
        baseModel: aliasConfig.model,
        reasoning: aliasConfig.reasoningEffort
          ? { effort: aliasConfig.reasoningEffort }
          : undefined,
      }
    }
    return {
      raw: trimmed,
      baseModel: trimmed,
    }
  }

  const baseModel = trimmed.slice(0, queryIndex).trim()
  const params = new URLSearchParams(trimmed.slice(queryIndex + 1))
  const alias = baseModel.toLowerCase() as ProviderCodeAlias
  const aliasConfig = PROVIDER_CODE_ALIAS_MODELS[alias]
  const resolvedBaseModel = aliasConfig?.model ?? baseModel
  const reasoning =
    parseReasoningEffort(params.get('reasoning') ?? undefined) ??
    (aliasConfig?.reasoningEffort
      ? { effort: aliasConfig.reasoningEffort }
      : undefined)

  return {
    raw: trimmed,
    baseModel: resolvedBaseModel,
    reasoning: typeof reasoning === 'string' ? { effort: reasoning } : reasoning,
  }
}

function isProviderCodeAlias(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  const base = normalized.split('?', 1)[0] ?? normalized
  return base in PROVIDER_CODE_ALIAS_MODELS
}

function isOpenAiProviderCodeShortcutAlias(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  const base = normalized.split('?', 1)[0] ?? normalized
  return OPENAI_PROVIDER_CODE_SHORTCUT_ALIASES.has(base)
}

export function shouldUseProviderCodeTransport(
  model: string,
  baseUrl: string | undefined,
): boolean {
  const explicitBaseUrl = asEnvUrl(baseUrl)
  return isProviderCodeBaseUrl(explicitBaseUrl) || (!explicitBaseUrl && isProviderCodeAlias(model))
}

function shouldUseGithubResponsesApi(model: string): boolean {
  const normalized = model.trim().toLowerCase()

  // ProviderCode-branded models require /responses.
  if (normalized.includes('providerCode')) return true

  // GPT-5+ models use /responses, except gpt-5-mini.
  const match = /^gpt-(\d+)/.exec(normalized)
  if (!match) return false
  const major = Number(match[1])
  if (major < 5) return false
  if (normalized.startsWith('gpt-5-mini')) return false
  return true
}

export function isLocalProviderUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    let hostname = new URL(baseUrl).hostname.toLowerCase()

    // Strip IPv6 brackets added by the URL parser (e.g. "[::1]" -> "::1")
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1)
    }

    // Strip RFC6874 IPv6 zone identifiers (e.g. "fe80::1%25en0" -> "fe80::1")
    const zoneIdIndex = hostname.indexOf('%25')
    if (zoneIdIndex !== -1) {
      hostname = hostname.slice(0, zoneIdIndex)
    }

    if (LOCALHOST_HOSTNAMES.has(hostname) || hostname === '0.0.0.0') {
      return true
    }
    if (hostname.endsWith('.local')) {
      return true
    }

    const ipVersion = isIP(hostname)
    if (ipVersion === 4) {
      // Treat the full 127.0.0.0/8 loopback range as local
      const firstOctet = Number.parseInt(hostname.split('.', 1)[0] ?? '', 10)
      return firstOctet === 127 || isPrivateIpv4Address(hostname)
    }
    if (ipVersion === 6) {
      return isPrivateIpv6Address(hostname)
    }

    return false
  } catch {
    return false
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizePathWithV1(pathname: string): string {
  const trimmed = trimTrailingSlash(pathname)
  if (!trimmed || trimmed === '/') {
    return '/v1'
  }

  if (trimmed.toLowerCase().endsWith('/v1')) {
    return trimmed
  }

  return `${trimmed}/v1`
}

function isLikelyOllamaEndpoint(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl)
    const hostname = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.toLowerCase()

    if (parsed.port === '11434') {
      return true
    }

    return (
      hostname.includes('ollama') ||
      pathname.includes('ollama')
    )
  } catch {
    return false
  }
}

export function getLocalProviderRetryBaseUrls(baseUrl: string): string[] {
  if (!isLocalProviderUrl(baseUrl)) {
    return []
  }

  try {
    const parsed = new URL(baseUrl)
    const original = trimTrailingSlash(parsed.toString())
    const seen = new Set<string>([original])
    const candidates: string[] = []

    const addCandidate = (hostname: string, pathname: string): void => {
      const next = new URL(parsed.toString())
      next.hostname = hostname
      next.pathname = pathname
      next.search = ''
      next.hash = ''

      const normalized = trimTrailingSlash(next.toString())
      if (seen.has(normalized)) {
        return
      }

      seen.add(normalized)
      candidates.push(normalized)
    }

    const v1Pathname = normalizePathWithV1(parsed.pathname)
    if (v1Pathname !== trimTrailingSlash(parsed.pathname)) {
      addCandidate(parsed.hostname, v1Pathname)
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (hostname === 'localhost' || hostname === '::1') {
      addCandidate('127.0.0.1', parsed.pathname || '/')
      addCandidate('127.0.0.1', v1Pathname)
    }

    return candidates
  } catch {
    return []
  }
}

export function shouldAttemptLocalToollessRetry(options: {
  baseUrl: string
  hasTools: boolean
}): boolean {
  if (!options.hasTools) {
    return false
  }

  if (!isLocalProviderUrl(options.baseUrl)) {
    return false
  }

  return isLikelyOllamaEndpoint(options.baseUrl)
}

export function isProviderCodeBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const parsed = new URL(baseUrl)
    return (
      parsed.hostname === 'chatgpt.com' &&
      parsed.pathname.replace(/\/+$/, '') === '/backend-api/providerCode'
    )
  } catch {
    return false
  }
}

/**
 * Normalize user model string for GitHub Copilot API inference.
 * Mirrors how Copilot resolves model IDs internally.
 */
function normalizeGithubCopilotModel(requestedModel: string): string {
  const noQuery = requestedModel.split('?', 1)[0] ?? requestedModel
  const segment =
    noQuery.includes(':') ? noQuery.split(':', 2)[1]!.trim() : noQuery.trim()
  if (!segment || segment.toLowerCase() === 'copilot') {
    return DEFAULT_GITHUB_MODELS_API_MODEL
  }
  // Strip provider prefix if present (e.g., "openai/gpt-4o" -> "gpt-4o")
  const slashIndex = segment.indexOf('/')
  if (slashIndex !== -1) {
    return segment.slice(slashIndex + 1)
  }
  return segment
}

/**
 * Normalize user model string for GitHub Models API inference.
 * Only normalizes the default alias, preserves provider-qualified models.
 */
export function normalizeGithubModelsApiModel(requestedModel: string): string {
  const noQuery = requestedModel.split('?', 1)[0] ?? requestedModel
  const segment =
    noQuery.includes(':') ? noQuery.split(':', 2)[1]!.trim() : noQuery.trim()
  // Only normalize the default alias for GitHub Models
  if (!segment || segment.toLowerCase() === 'copilot') {
    return DEFAULT_GITHUB_MODELS_API_MODEL
  }
  // Preserve provider prefix for GitHub Models (e.g., "openai/gpt-4.1" stays as-is)
  return segment
}

const GITHUB_COPILOT_BASE_URL = 'https://api.githubcopilot.com'
const GITHUB_MODELS_BASE_URL = 'https://models.github.ai/inference'

export function getGithubEndpointType(
  baseUrl: string | undefined,
): 'copilot' | 'models' | 'custom' {
  if (!baseUrl) return 'copilot'
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    if (hostname === 'api.githubcopilot.com') {
      return 'copilot'
    }
    if (hostname === 'models.github.ai' || hostname.endsWith('.github.ai')) {
      return 'models'
    }
    return 'custom'
  } catch {
    return 'copilot'
  }
}

export function resolveProviderRequest(options?: {
  model?: string
  baseUrl?: string
  fallbackModel?: string
  reasoningEffortOverride?: ReasoningEffort
  apiFormat?: OpenAiCompatibleApiFormat | string
}): ResolvedProviderRequest {
  const isGithubMode = isEnvTruthy(process.env.AGENC_USE_GITHUB)
  const isMistralMode = isEnvTruthy(process.env.AGENC_USE_MISTRAL)
  const isGeminiMode = isEnvTruthy(process.env.AGENC_USE_GEMINI)
  const requestedModel =
    options?.model?.trim() ||
    (isMistralMode
      ? process.env.MISTRAL_MODEL?.trim()
      : process.env.OPENAI_MODEL?.trim()) ||
    (isGeminiMode
      ? process.env.GEMINI_MODEL?.trim()
      : process.env.OPENAI_MODEL?.trim()) ||
    options?.fallbackModel?.trim() ||
    (isGithubMode ? 'github:copilot' : 'gpt-4o')
  const descriptor = parseModelDescriptor(requestedModel)
  const explicitBaseUrl = asEnvUrl(options?.baseUrl)

  const normalizedMistralEnvBaseUrl = asNamedEnvUrl(
    process.env.MISTRAL_BASE_URL,
    'MISTRAL_BASE_URL',
  )

  const normalizedGeminiEnvBaseUrl = asNamedEnvUrl(
    process.env.GEMINI_BASE_URL,
    'GEMINI_BASE_URL',
  )

  const primaryEnvBaseUrl = isMistralMode
    ? normalizedMistralEnvBaseUrl
    : isGeminiMode
    ? normalizedGeminiEnvBaseUrl
    : asNamedEnvUrl(process.env.OPENAI_BASE_URL, 'OPENAI_BASE_URL')

  // In Mistral mode, a literal "undefined" MISTRAL_BASE_URL is treated as
  // misconfiguration and falls back to OPENAI_API_BASE, then
  // DEFAULT_MISTRAL_BASE_URL for a safe default endpoint.
  const fallbackEnvBaseUrl = isMistralMode
    ? (primaryEnvBaseUrl === undefined
      ? asNamedEnvUrl(process.env.OPENAI_API_BASE, 'OPENAI_API_BASE') ?? DEFAULT_MISTRAL_BASE_URL
      : undefined)
    : isGeminiMode
    ? (primaryEnvBaseUrl === undefined
      ? asNamedEnvUrl(process.env.OPENAI_API_BASE, 'OPENAI_API_BASE') ?? DEFAULT_GEMINI_BASE_URL
      : undefined)
    : (primaryEnvBaseUrl === undefined
      ? asNamedEnvUrl(process.env.OPENAI_API_BASE, 'OPENAI_API_BASE')
      : undefined)

  const envBaseUrlRaw =
    explicitBaseUrl ??
    primaryEnvBaseUrl ??
    fallbackEnvBaseUrl

  const isProviderCodeModelForGithub = isGithubMode && isProviderCodeAlias(requestedModel)
  const envBaseUrl =
    isProviderCodeModelForGithub && envBaseUrlRaw && getGithubEndpointType(envBaseUrlRaw) === 'custom'
      ? undefined
      : envBaseUrlRaw

  const rawBaseUrl = explicitBaseUrl ?? envBaseUrl

  const shellModel = process.env.OPENAI_MODEL?.trim() ?? ''
  const envIsProviderCodeShortcut = isOpenAiProviderCodeShortcutAlias(shellModel)
  const envResolvedProviderCodeModel = envIsProviderCodeShortcut
    ? parseModelDescriptor(shellModel).baseModel
    : null
  const requestedMatchesEnvProviderCodeShortcut =
    Boolean(options?.model) &&
    Boolean(envResolvedProviderCodeModel) &&
    descriptor.baseModel === envResolvedProviderCodeModel
  const isProviderCodeAliasModel =
    isOpenAiProviderCodeShortcutAlias(requestedModel) || requestedMatchesEnvProviderCodeShortcut
  const hasUserSetBaseUrl = rawBaseUrl && rawBaseUrl !== DEFAULT_OPENAI_BASE_URL
  const finalBaseUrl =
    !isGithubMode && isProviderCodeAliasModel && !hasUserSetBaseUrl
      ? DEFAULT_PROVIDER_CODE_BASE_URL
      : rawBaseUrl

  const githubEndpointType = isGithubMode
    ? getGithubEndpointType(rawBaseUrl)
    : 'custom'
  const isGithubCopilot = isGithubMode && githubEndpointType === 'copilot'
  const isGithubModels = isGithubMode && githubEndpointType === 'models'
  const isGithubCustom = isGithubMode && githubEndpointType === 'custom'

  const githubResolvedModel = isGithubMode
    ? normalizeGithubModelsApiModel(requestedModel)
    : requestedModel

  const requestedApiFormat =
    parseOpenAiCompatibleApiFormat(options?.apiFormat) ??
    parseOpenAiCompatibleApiFormat(process.env.OPENAI_API_FORMAT)
  const transport: ProviderTransport =
    shouldUseProviderCodeTransport(requestedModel, finalBaseUrl) ||
      (isGithubCopilot && shouldUseGithubResponsesApi(githubResolvedModel))
      ? 'providerCode_responses'
      : requestedApiFormat === 'responses'
        ? 'responses'
        : 'chat_completions'

  // For GitHub Copilot API, normalize to real model ID (e.g., "github:copilot" -> "gpt-4o")
  // For GitHub Models/custom endpoints:
  //   - Normalize default alias (github:copilot -> gpt-4o)
  //   - Preserve provider-qualified models (openai/gpt-4.1 stays as-is)
  const resolvedModel = isGithubCopilot
    ? normalizeGithubCopilotModel(descriptor.baseModel)
    : (isGithubModels || isGithubCustom
      ? normalizeGithubModelsApiModel(descriptor.baseModel)
      : descriptor.baseModel)

  const reasoning = options?.reasoningEffortOverride
    ? { effort: options.reasoningEffortOverride }
    : descriptor.reasoning

  return {
    transport,
    requestedModel,
    resolvedModel,
    baseUrl:
      (finalBaseUrl ??
        (isGithubCopilot && transport === 'providerCode_responses'
          ? GITHUB_COPILOT_BASE_URL
          : (isGithubMode
            ? GITHUB_COPILOT_BASE_URL
            : DEFAULT_OPENAI_BASE_URL))
      ).replace(/\/+$/, ''),
    reasoning,
  }
}

export function getAdditionalModelOptionsCacheScope(): string | null {
  if (!isEnvTruthy(process.env.AGENC_USE_OPENAI)) {
    if (!isEnvTruthy(process.env.AGENC_USE_GEMINI) &&
        !isEnvTruthy(process.env.AGENC_USE_MISTRAL) &&
        !isEnvTruthy(process.env.AGENC_USE_GITHUB) &&
        !isEnvTruthy(process.env.AGENC_USE_BEDROCK) &&
        !isEnvTruthy(process.env.AGENC_USE_VERTEX) &&
        !isEnvTruthy(process.env.AGENC_USE_FOUNDRY)) {
      return 'firstParty'
    }
    return null
  }

  const request = resolveProviderRequest()
  if (request.transport !== 'chat_completions') {
    return null
  }

  if (!isLocalProviderUrl(request.baseUrl)) {
    return null
  }

  return `openai:${request.baseUrl.toLowerCase()}`
}

function resolveProviderCodeAuthPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = asTrimmedString(env.PROVIDER_CODE_AUTH_JSON_PATH)
  if (explicit) return explicit

  const providerCodeHome = asTrimmedString(env.PROVIDER_CODE_HOME)
  if (providerCodeHome) return join(providerCodeHome, 'auth.json')

  return join(homedir(), '.providerCode', 'auth.json')
}

function loadProviderCodeAuthJson(
  authPath: string,
): Record<string, unknown> | undefined {
  if (!existsSync(authPath)) return undefined
  try {
    const raw = readFileSync(authPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function resolveProviderCodeAuthJsonCredentials(options: {
  authJson: Record<string, unknown> | undefined
  authPath: string
  envAccountId?: string
  missingSource?: ResolvedProviderCodeCredentials['source']
}): ResolvedProviderCodeCredentials {
  const { authJson, authPath, envAccountId } = options

  if (!authJson) {
    return {
      apiKey: '',
      authPath,
      source: options.missingSource ?? 'none',
    }
  }

  const apiKey = readNestedString(authJson, [
    ['openai_api_key'],
    ['openaiApiKey'],
    ['access_token'],
    ['accessToken'],
    ['tokens', 'access_token'],
    ['tokens', 'accessToken'],
    ['auth', 'access_token'],
    ['auth', 'accessToken'],
    ['token', 'access_token'],
    ['token', 'accessToken'],
  ])
  // OIDC identity tokens can carry the ChatGPT account id, but they are not
  // valid bearer credentials for ProviderCode API requests.
  const idToken = readNestedString(authJson, [
    ['id_token'],
    ['idToken'],
    ['tokens', 'id_token'],
    ['tokens', 'idToken'],
  ])
  const accountId =
    envAccountId ??
    readNestedString(authJson, [
      ['account_id'],
      ['accountId'],
      ['tokens', 'account_id'],
      ['tokens', 'accountId'],
      ['auth', 'account_id'],
      ['auth', 'accountId'],
    ]) ??
    parseChatgptAccountId(apiKey) ??
    parseChatgptAccountId(idToken)

  if (!apiKey) {
    return {
      apiKey: '',
      accountId,
      authPath,
      source: options.missingSource ?? 'none',
    }
  }

  return {
    apiKey,
    accountId,
    authPath,
    source: 'auth.json',
  }
}

function resolveStoredProviderCodeCredentials(options: {
  storedCredentials: Pick<
    ProviderCodeCredentialBlob,
    'apiKey' | 'accessToken' | 'idToken' | 'accountId'
  >
  envAccountId?: string
}): ResolvedProviderCodeCredentials {
  const { storedCredentials, envAccountId } = options

  return {
    apiKey: storedCredentials.apiKey ?? storedCredentials.accessToken,
    accountId:
      envAccountId ??
      storedCredentials.accountId ??
      parseChatgptAccountId(storedCredentials.idToken) ??
      parseChatgptAccountId(storedCredentials.accessToken),
    source: 'secure-storage',
  }
}

function resolveEnvOrAuthJsonProviderCodeCredentials(
  env: NodeJS.ProcessEnv,
  options?: {
    explicitAuthPathOnly?: boolean
  },
): ResolvedProviderCodeCredentials {
  const envApiKey = asTrimmedString(env.PROVIDER_CODE_API_KEY)
  const envAccountId =
    asTrimmedString(env.PROVIDER_CODE_ACCOUNT_ID) ??
    asTrimmedString(env.CHATGPT_ACCOUNT_ID)

  if (envApiKey) {
    return {
      apiKey: envApiKey,
      accountId: envAccountId ?? parseChatgptAccountId(envApiKey),
      source: 'env',
    }
  }

  const explicitAuthPathConfigured = Boolean(
    asTrimmedString(env.PROVIDER_CODE_AUTH_JSON_PATH) ?? asTrimmedString(env.PROVIDER_CODE_HOME),
  )

  if (!explicitAuthPathConfigured && options?.explicitAuthPathOnly) {
    return {
      apiKey: '',
      accountId: envAccountId,
      source: 'none',
    }
  }

  const authPath = resolveProviderCodeAuthPath(env)
  const authJson = loadProviderCodeAuthJson(authPath)
  return resolveProviderCodeAuthJsonCredentials({
    authJson,
    authPath,
    envAccountId,
  })
}

export function resolveRuntimeOpenAiCodeCredentials(options?: {
  env?: NodeJS.ProcessEnv
  storedCredentials?: Pick<
    ProviderCodeCredentialBlob,
    'apiKey' | 'accessToken' | 'idToken' | 'accountId'
  >
}): ResolvedProviderCodeCredentials {
  const env = options?.env ?? process.env
  const explicitCredentials = resolveEnvOrAuthJsonProviderCodeCredentials(env, {
    explicitAuthPathOnly: true,
  })
  const explicitAuthPathConfigured = Boolean(
    asTrimmedString(env.PROVIDER_CODE_AUTH_JSON_PATH) ?? asTrimmedString(env.PROVIDER_CODE_HOME),
  )
  const hasStoredCredentialsOption = Boolean(
    options &&
      Object.prototype.hasOwnProperty.call(options, 'storedCredentials'),
  )

  if (
    explicitAuthPathConfigured ||
    explicitCredentials.source === 'env' ||
    explicitCredentials.source === 'auth.json'
  ) {
    return explicitCredentials
  }

  if (options?.storedCredentials?.accessToken) {
    return resolveStoredProviderCodeCredentials({
      storedCredentials: options.storedCredentials,
      envAccountId:
        asTrimmedString(env.PROVIDER_CODE_ACCOUNT_ID) ??
        asTrimmedString(env.CHATGPT_ACCOUNT_ID),
    })
  }

  if (hasStoredCredentialsOption) {
    return resolveEnvOrAuthJsonProviderCodeCredentials(env)
  }

  return resolveProviderCodeApiCredentials(env)
}

export function resolveProviderCodeApiCredentials(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProviderCodeCredentials {
  const envAccountId =
    asTrimmedString(env.PROVIDER_CODE_ACCOUNT_ID) ??
    asTrimmedString(env.CHATGPT_ACCOUNT_ID)
  const envOrExplicitAuthJsonCredentials = resolveEnvOrAuthJsonProviderCodeCredentials(
    env,
    {
      explicitAuthPathOnly: true,
    },
  )

  if (
    envOrExplicitAuthJsonCredentials.source === 'env' ||
    envOrExplicitAuthJsonCredentials.source === 'auth.json' ||
    envOrExplicitAuthJsonCredentials.authPath
  ) {
    return envOrExplicitAuthJsonCredentials
  }

  const storedCredentials = readProviderCodeCredentials()
  if (storedCredentials?.accessToken) {
    const resolvedStoredCredentials = resolveStoredProviderCodeCredentials({
      storedCredentials,
      envAccountId,
    })

    const shouldCheckDefaultAuthJson =
      !resolvedStoredCredentials.accountId ||
      isProviderCodeRefreshFailureCoolingDown(storedCredentials)

    if (!shouldCheckDefaultAuthJson) {
      return resolvedStoredCredentials
    }

    const authPath = resolveProviderCodeAuthPath(env)
    const authJson = loadProviderCodeAuthJson(authPath)
    const resolvedAuthJsonCredentials = resolveProviderCodeAuthJsonCredentials({
      authJson,
      authPath,
      envAccountId,
    })

    if (resolvedAuthJsonCredentials.apiKey) {
      return {
        ...resolvedAuthJsonCredentials,
        accountId:
          resolvedAuthJsonCredentials.accountId ??
          resolvedStoredCredentials.accountId,
      }
    }

    return resolvedStoredCredentials
  }

  return resolveEnvOrAuthJsonProviderCodeCredentials(env)
}

function getReasoningEffortForModel(model: string): ReasoningEffort | undefined {
  const normalized = model.trim().toLowerCase()
  const base = normalized.split('?', 1)[0] ?? normalized
  const alias = base as ProviderCodeAlias
  const aliasConfig = PROVIDER_CODE_ALIAS_MODELS[alias]
  return aliasConfig?.reasoningEffort
}

export function supportsProviderCodeReasoningEffort(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  const base = normalized.split('?', 1)[0] ?? normalized

  if (base === 'gpt-5.3-providerCode-spark' || base === 'providerCodespark') {
    return false
  }

  if (getReasoningEffortForModel(base) !== undefined) {
    return true
  }

  return /^gpt-5(?:[.-]|$)/.test(base)
}
