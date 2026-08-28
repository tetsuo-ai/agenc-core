// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { isIP } from 'node:net'

import {
  parseOpenAiCompatibleApiFormat,
  type OpenAiCompatibleApiFormat,
} from '../../llm/provider-request.js'
export {
  parseOpenAiCompatibleApiFormat,
  type OpenAiCompatibleApiFormat,
} from '../../llm/provider-request.js'
import {
  CHATGPT_BACKEND_BASE_URL,
} from '../../llm/providers/openai/chatgpt-backend.js'
import { BUILT_IN_PROVIDER_BASE_URLS } from '../../llm/registry/provider-info.js'
import {
  getGithubEndpointType,
  normalizeGithubModelForEndpoint,
  shouldUseGithubCopilotResponsesApi,
} from '../../llm/providers/github/model-routing.js'

export const DEFAULT_OPENAI_BASE_URL = BUILT_IN_PROVIDER_BASE_URLS.openai

const PROVIDER_CODE_ALIAS_MODELS: Record<
  string,
  {
    model: string
    reasoningEffort?: ReasoningEffort
  }
> = {
  providercodeplan: {
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
  'gpt-5.3-providercode': {
    model: 'gpt-5.3-providerCode',
    reasoningEffort: 'high',
  },
  'gpt-5.3-providercode-spark': {
    model: 'gpt-5.3-providerCode-spark',
  },
  providercodespark: {
    model: 'gpt-5.3-providerCode-spark',
  },
  'gpt-5.2-providercode': {
    model: 'gpt-5.2-providerCode',
    reasoningEffort: 'high',
  },
  'gpt-5.1-providercode-max': {
    model: 'gpt-5.1-providerCode-max',
    reasoningEffort: 'high',
  },
  'gpt-5.1-providercode-mini': {
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

export type ProviderTransport = 'chat_completions' | 'responses' | 'providerCode_responses'
export type ResolvedProviderRequest = {
  transport: ProviderTransport
  requestedModel: string
  resolvedModel: string
  baseUrl: string
  reasoning?: {
    effort: ReasoningEffort
  }
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

function parseReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized
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

export function shouldUseProviderCodeTransport(
  model: string,
  baseUrl: string | undefined,
): boolean {
  const explicitBaseUrl = asEnvUrl(baseUrl)
  return isChatGptSubscriptionBaseUrl(explicitBaseUrl) || (!explicitBaseUrl && isProviderCodeAlias(model))
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

export function isChatGptSubscriptionBaseUrl(
  baseUrl: string | undefined,
): boolean {
  if (!baseUrl) return false
  try {
    const parsed = new URL(baseUrl)
    const canonical = new URL(CHATGPT_BACKEND_BASE_URL)
    return (
      parsed.origin === canonical.origin &&
      parsed.pathname.replace(/\/+$/, '') === canonical.pathname.replace(/\/+$/, '')
    )
  } catch {
    return false
  }
}

export function resolveProviderRequest(options: {
  provider: string
  model: string
  baseUrl: string
  reasoningEffortOverride?: ReasoningEffort
  apiFormat?: OpenAiCompatibleApiFormat | string
}): ResolvedProviderRequest {
  const selectedProvider = options.provider.trim().toLowerCase()
  if (!selectedProvider) {
    throw new Error('provider request requires a prepared provider identity')
  }
  const isGithubMode = selectedProvider === 'github'
  if (selectedProvider === 'gemini') {
    throw new Error(
      'Gemini request configuration is owned by the canonical native Gemini provider',
    )
  }
  const requestedModel = options.model.trim()
  if (!requestedModel) {
    throw new Error('provider request requires a prepared model')
  }
  const descriptor = parseModelDescriptor(requestedModel)
  const rawBaseUrl = asEnvUrl(options.baseUrl)
  if (rawBaseUrl === undefined) {
    throw new Error('provider request requires a prepared base URL')
  }

  const githubEndpointType = isGithubMode
    ? getGithubEndpointType(rawBaseUrl)
    : 'custom'
  const requestedApiFormat =
    parseOpenAiCompatibleApiFormat(options.apiFormat)
  const transport: ProviderTransport =
    isGithubMode
      ? shouldUseGithubCopilotResponsesApi(requestedModel, rawBaseUrl)
        ? 'providerCode_responses'
        : 'chat_completions'
      : shouldUseProviderCodeTransport(requestedModel, rawBaseUrl)
        ? 'providerCode_responses'
        : requestedApiFormat === 'responses'
          ? 'responses'
          : 'chat_completions'

  // For GitHub Copilot API, normalize to the current LTS model ID.
  // For GitHub Models/custom endpoints:
  //   - Normalize the default alias to the current LTS model
  //   - Preserve provider-qualified models (openai/gpt-4.1 stays as-is)
  const resolvedModel = isGithubMode
    ? normalizeGithubModelForEndpoint(descriptor.baseModel, githubEndpointType)
    : descriptor.baseModel

  const reasoning = options?.reasoningEffortOverride
    ? { effort: options.reasoningEffortOverride }
    : descriptor.reasoning

  return {
    transport,
    requestedModel,
    resolvedModel,
    baseUrl:
      rawBaseUrl.replace(/\/+$/, ''),
    reasoning,
  }
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

  if (base === 'gpt-5.3-providercode-spark' || base === 'providercodespark') {
    return false
  }

  if (getReasoningEffortForModel(base) !== undefined) {
    return true
  }

  return /^gpt-5(?:[.-]|$)/.test(base)
}
