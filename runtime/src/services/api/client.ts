// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import ProviderSdk, { type ClientOptions } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getproviderApiKey,
  getAgenCAIOAuthTokens,
  isAgenCAISubscriber,
} from 'src/utils/auth.js'
import { getUserAgent } from 'src/utils/http.js'
import {
  getAPIProvider,
  getSelectedProviderEnvironment,
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
import { resolveSecureStorageHome } from '../../utils/secureStorage/home.js'

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
      lower === 'api-key' ||
      lower === 'x-goog-api-key' ||
      lower === 'x-goog-user-project'
    ) {
      continue
    }
    safeHeaders[key] = value
  }
  return safeHeaders
}

export async function getproviderClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<ProviderSdk> {
  const providerEnvironment = getSelectedProviderEnvironment()
  const credentialHome = resolveSecureStorageHome()
  const containerId = providerEnvironment.AGENC_CONTAINER_ID
  const remoteSessionId = providerEnvironment.AGENC_REMOTE_SESSION_ID
  const clientApp = providerEnvironment.AGENC_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders(providerEnvironment)
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
    `[API:request] Creating client, ANTHROPIC_CUSTOM_HEADERS present: ${!!providerEnvironment.ANTHROPIC_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`,
  )

  // Add additional protection header if enabled via env var
  const additionalProtectionEnabled = isEnvTruthy(
    providerEnvironment.AGENC_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  const resolvedFetch = buildFetch(fetchOverride, source)

  const ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: parseInt(
      providerEnvironment.API_TIMEOUT_MS || String(600 * 1000),
      10,
    ),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({
      forAnthropicAPI: true,
      environment: providerEnvironment,
    }) as ClientOptions['fetchOptions'],
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  }
  // GitHub provider in native provider API mode: send requests in provider
  // format so cache_control blocks are honoured and prompt caching works.
  // Requires the GitHub endpoint (GITHUB_BASE_URL) to support provider's
  // messages API — set AGENC_GITHUB_ANTHROPIC_API=1 to opt in.
  if (model !== undefined && isGithubNativeproviderMode(model)) {
    const githubBaseUrl =
      providerEnvironment.GITHUB_BASE_URL?.replace(/\/$/, '') ??
      providerEnvironment.OPENAI_BASE_URL?.replace(/\/$/, '') ??
      'https://api.githubcopilot.com'
    const githubToken =
      providerEnvironment.GITHUB_TOKEN ?? providerEnvironment.GH_TOKEN ?? ''
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
  if (apiProvider !== 'firstParty') {
    if (apiProvider === 'gemini') {
      throw new Error(
        'Gemini requests must use the canonical native provider transport',
      )
    }
    const { createOpenAiShimClient } = await import('./openaiShim.js')
    return createOpenAiShimClient({
      home: credentialHome,
      ...(model !== undefined ? { model } : {}),
      providerEnvironment,
      defaultHeaders: stripForwardedAuthHeaders(defaultHeaders),
      maxRetries,
      timeout: parseInt(providerEnvironment.API_TIMEOUT_MS || String(600 * 1000), 10),
      selectedProvider: apiProvider,
    }) as unknown as ProviderSdk
  }

  // First-party OAuth and API-key state is irrelevant to explicitly selected
  // external providers. Keep native secure storage access behind the first-party
  // routing boundary so third-party requests cannot acquire a second auth
  // authority or fail because unrelated first-party storage is unavailable.
  logForDebugging('[API:auth] OAuth token check starting')
  await checkAndRefreshOAuthTokenIfNeeded(
    credentialHome,
    providerEnvironment,
  )
  logForDebugging('[API:auth] OAuth token check complete')

  if (!isAgenCAISubscriber(credentialHome)) {
    await configureApiKeyHeaders(
      defaultHeaders,
      getIsNonInteractiveSession(),
      providerEnvironment,
    )
  }

  // Determine authentication method based on available tokens
  const clientConfig: ConstructorParameters<typeof ProviderSdk>[0] = {
    apiKey: isAgenCAISubscriber(credentialHome) ? null : apiKey || getproviderApiKey(),
    authToken: isAgenCAISubscriber(credentialHome)
      ? getAgenCAIOAuthTokens(
          credentialHome,
          providerEnvironment,
        )?.accessToken
      : undefined,
    // Set baseURL from OAuth config when using staging OAuth
    ...(providerEnvironment.USER_TYPE === 'ant' &&
    isEnvTruthy(providerEnvironment.USE_STAGING_OAUTH)
      ? { baseURL: getOauthConfig().BASE_API_URL }
      : {}),
    ...ARGS,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }

  return new ProviderSdk(clientConfig)
}

async function configureApiKeyHeaders(
  headers: Record<string, string>,
  _isNonInteractiveSession: boolean,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const token = environment.ANTHROPIC_AUTH_TOKEN
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
}

function getCustomHeaders(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = environment.ANTHROPIC_CUSTOM_HEADERS

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
