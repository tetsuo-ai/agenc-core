// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import ProviderSdk, { type ClientOptions } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getproviderApiKey,
  getApiKeyFromApiKeyHelper,
  getAgenCAIOAuthTokens,
  isAgenCAISubscriber,
} from 'src/utils/auth.js'
import { getUserAgent } from 'src/utils/http.js'
import {
  getAPIProvider,
  isFirstPartyproviderBaseUrl,
  isGithubNativeproviderMode,
} from 'src/utils/model/providers.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from '../../bootstrap/state.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { isDebugToStdErr, logForDebugging } from 'src/utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

/**
 * Environment variables for different client types:
 *
 * Direct API:
 * - ANTHROPIC_API_KEY: Required for direct API access
 *
 * Provider-compatible routing:
 * - OPENAI_API_KEY / OPENAI_BASE_URL for generic compatible endpoints
 * - Provider-specific keys and base URLs for hosted compatible providers
 */

function createStderrLogger(): ClientOptions['logger'] {
  return {
    error: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[provider SDK ERROR]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    warn: (msg, ...args) => console.error('[provider SDK WARN]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    info: (msg, ...args) => console.error('[provider SDK INFO]', msg, ...args),
    debug: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[provider SDK DEBUG]', msg, ...args),
  }
}

function stripForwardedAuthHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const safeHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'api-key'
    ) {
      continue
    }
    safeHeaders[key] = value
  }
  return safeHeaders
}

function hasProviderEnvValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function resolveShimSelectedProvider(
  apiProvider: ReturnType<typeof getAPIProvider>,
): ReturnType<typeof getAPIProvider> {
  if (isEnvTruthy(process.env.AGENC_USE_GEMINI)) return 'gemini'
  if (isEnvTruthy(process.env.AGENC_USE_MISTRAL)) return 'mistral'
  if (isEnvTruthy(process.env.AGENC_USE_GITHUB)) return 'github'
  if (isEnvTruthy(process.env.AGENC_USE_MINIMAX)) return 'minimax'
  if (hasProviderEnvValue(process.env.XAI_API_KEY)) return 'xai'
  if (isEnvTruthy(process.env.AGENC_USE_OPENAI)) {
    return apiProvider === 'agenc' ? 'agenc' : 'openai'
  }
  if (isEnvTruthy(process.env.NVIDIA_NIM)) return 'nvidia-nim'
  if (hasProviderEnvValue(process.env.MINIMAX_API_KEY)) return 'minimax'
  return apiProvider
}

export async function getproviderClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
  providerOverride,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
  providerOverride?: { model: string; baseURL: string; apiKey: string }
}): Promise<ProviderSdk> {
  const containerId = process.env.AGENC_CONTAINER_ID
  const remoteSessionId = process.env.AGENC_REMOTE_SESSION_ID
  const clientApp = process.env.AGENC_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const defaultHeaders: { [key: string]: string } = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-AgenC-Code-Session-Id': getSessionId(),
    ...customHeaders,
    ...(containerId ? { 'x-agenc-remote-container-id': containerId } : {}),
    ...(remoteSessionId
      ? { 'x-agenc-remote-session-id': remoteSessionId }
      : {}),
    // SDK consumers can identify their app/library in provider-side request metadata.
    ...(clientApp ? { 'x-client-app': clientApp } : {}),
  }

  // Log API client configuration for HFI debugging
  logForDebugging(
    `[API:request] Creating client, ANTHROPIC_CUSTOM_HEADERS present: ${!!process.env.ANTHROPIC_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`,
  )

  // Add additional protection header if enabled via env var
  const additionalProtectionEnabled = isEnvTruthy(
    process.env.AGENC_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  logForDebugging('[API:auth] OAuth token check starting')
  await checkAndRefreshOAuthTokenIfNeeded()
  logForDebugging('[API:auth] OAuth token check complete')

  if (!isAgenCAISubscriber()) {
    await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession())
  }

  const resolvedFetch = buildFetch(fetchOverride, source)

  const ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({
      forAnthropicAPI: true,
    }) as ClientOptions['fetchOptions'],
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  }
  // Agent routing override: use per-agent provider when configured.
  // Strip auth-related headers to prevent leaking provider credentials
  // to third-party endpoints (SSRF / credential forwarding mitigation).
  if (providerOverride) {
    const { createOpenAiShimClient } = await import('./openaiShim.js')
    return createOpenAiShimClient({
      defaultHeaders: stripForwardedAuthHeaders(defaultHeaders),
      maxRetries,
      timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
      providerOverride,
    }) as unknown as ProviderSdk
  }
  // GitHub provider in native provider API mode: send requests in provider
  // format so cache_control blocks are honoured and prompt caching works.
  // Requires the GitHub endpoint (GITHUB_BASE_URL) to support provider's
  // messages API — set AGENC_GITHUB_ANTHROPIC_API=1 to opt in.
  if (isGithubNativeproviderMode(model)) {
    const githubBaseUrl =
      process.env.GITHUB_BASE_URL?.replace(/\/$/, '') ??
      process.env.OPENAI_BASE_URL?.replace(/\/$/, '') ??
      'https://api.githubcopilot.com'
    const githubToken =
      process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
    const nativeArgs: ConstructorParameters<typeof ProviderSdk>[0] = {
      ...ARGS,
      baseURL: githubBaseUrl,
      authToken: githubToken,
      // No apiKey — we authenticate via Bearer token (authToken)
      apiKey: null,
    }
    return new ProviderSdk(nativeArgs)
  }
  const apiProvider = getAPIProvider()
  if (
    apiProvider !== 'firstParty' ||
    isEnvTruthy(process.env.AGENC_USE_OPENAI) ||
    isEnvTruthy(process.env.AGENC_USE_GITHUB) ||
    isEnvTruthy(process.env.AGENC_USE_GEMINI) ||
    isEnvTruthy(process.env.AGENC_USE_MISTRAL) ||
    isEnvTruthy(process.env.NVIDIA_NIM) ||
    isEnvTruthy(process.env.AGENC_USE_MINIMAX) ||
    (typeof process.env.MINIMAX_API_KEY === 'string' &&
      process.env.MINIMAX_API_KEY.trim() !== '')
  ) {
    const { createOpenAiShimClient } = await import('./openaiShim.js')
    return createOpenAiShimClient({
      defaultHeaders: stripForwardedAuthHeaders(defaultHeaders),
      maxRetries,
      timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
      selectedProvider: resolveShimSelectedProvider(apiProvider),
    }) as unknown as ProviderSdk
  }
  // Determine authentication method based on available tokens
  const clientConfig: ConstructorParameters<typeof ProviderSdk>[0] = {
    apiKey: isAgenCAISubscriber() ? null : apiKey || getproviderApiKey(),
    authToken: isAgenCAISubscriber()
      ? getAgenCAIOAuthTokens()?.accessToken
      : undefined,
    // Set baseURL from OAuth config when using staging OAuth
    ...(process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.USE_STAGING_OAUTH)
      ? { baseURL: getOauthConfig().BASE_API_URL }
      : {}),
    ...ARGS,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }

  return new ProviderSdk(clientConfig)
}

async function configureApiKeyHeaders(
  headers: Record<string, string>,
  isNonInteractiveSession: boolean,
): Promise<void> {
  const token =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    (await getApiKeyFromApiKeyHelper(isNonInteractiveSession))
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
}

function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  // Split by newlines to support multiple headers
  const headerStrings = customHeadersEnv.split(/\n|\r\n/)

  for (const headerString of headerStrings) {
    if (!headerString.trim()) continue

    // Parse header in format "Name: Value" (curl style). Split on first `:`
    // then trim — avoids regex backtracking on malformed long header lines.
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}
export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'
function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch
  // Only send to the first-party API; unknown headers risk rejection by strict proxies.
  const injectClientRequestId =
    getAPIProvider() === 'firstParty' && isFirstPartyproviderBaseUrl()
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    // Generate a client-side request ID so timeouts (which return no server
    // request ID) can still be correlated with server logs by the API team.
    // Callers that want to track the ID themselves can pre-set the header.
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input)
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
      )
    } catch {
      // never let logging crash the fetch
    }
    return inner(input, { ...init, headers })
  }
}
