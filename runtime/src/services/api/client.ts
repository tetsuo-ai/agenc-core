// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import ProviderSdk, { type ClientOptions } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { getUserAgent } from 'src/utils/http.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import { getSessionId } from '../../bootstrap/state.js'
import { isDebugToStdErr, logForDebugging } from 'src/utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { requireCurrentRuntimeSession } from '../../session/current-session.js'
import {
  projectBoundProviderConnection,
  type BoundProviderConnection,
} from '../../llm/registry/provider-connection.js'
import type { ProviderEnvironment } from '../../llm/provider-options.js'
import { stripForwardedProviderAuthHeaders } from '../../llm/provider-request.js'
import type { ProviderBinding } from '../../session/provider-service.js'

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

export async function getproviderClient({
  maxRetries,
  model,
  fetchOverride,
  source,
  providerBinding,
  providerEnvironment,
}: {
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
  providerBinding?: ProviderBinding
  providerEnvironment?: ProviderEnvironment
}): Promise<ProviderSdk> {
  const connection = resolveBoundConnection(
    providerBinding,
    providerEnvironment,
  )
  // The model parameter remains for the legacy SDK-shaped call surface. The
  // prepared binding is authoritative and cannot be overridden here.
  void model
  const environment = connection.environment
  const containerId = environment.AGENC_CONTAINER_ID
  const remoteSessionId = environment.AGENC_REMOTE_SESSION_ID
  const clientApp = environment.AGENC_AGENT_SDK_CLIENT_APP
  const configuredHeaders = connection.extra.defaultHeaders ?? {}
  const defaultHeaders: { [key: string]: string } = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-AgenC-Code-Session-Id': getSessionId(),
    ...configuredHeaders,
    ...(containerId ? { 'x-agenc-remote-container-id': containerId } : {}),
    ...(remoteSessionId
      ? { 'x-agenc-remote-session-id': remoteSessionId }
      : {}),
    // SDK consumers can identify their app/library in provider-side request metadata.
    ...(clientApp ? { 'x-client-app': clientApp } : {}),
  }

  // Log API client configuration for HFI debugging
  logForDebugging(
    `[API:request] Creating bound ${connection.provider} client, has Authorization header: ${!!defaultHeaders.Authorization}`,
  )

  // Add additional protection header if enabled via env var
  const additionalProtectionEnabled = isEnvTruthy(
    environment.AGENC_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  const resolvedFetch = buildFetch(
    fetchOverride ?? connection.extra.fetchImpl,
    source,
    connection.transport === 'anthropic' &&
      isFirstPartyAnthropicUrl(connection.baseURL),
  )

  const ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: connection.timeoutMs ?? 600 * 1000,
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({
      forAnthropicAPI: true,
      environment,
    }) as ClientOptions['fetchOptions'],
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  }
  // GitHub provider in native provider API mode: send requests in provider
  // format so cache_control blocks are honoured and prompt caching works.
  // The bound GitHub model and endpoint remain the only routing authority.
  if (
    connection.provider === 'github' &&
    connection.transport === 'anthropic'
  ) {
    if (!connection.apiKey) {
      throw new Error('bound GitHub provider has no prepared credential')
    }
    if (!connection.baseURL) {
      throw new Error('bound GitHub provider has no prepared base URL')
    }
    const nativeArgs: ConstructorParameters<typeof ProviderSdk>[0] = {
      ...ARGS,
      baseURL: connection.baseURL.replace(/\/$/, ''),
      authToken: connection.apiKey,
      // No apiKey — we authenticate via Bearer token (authToken)
      apiKey: null,
    }
    return new ProviderSdk(nativeArgs)
  }
  if (connection.transport === 'openai-compatible') {
    const { createOpenAiShimClient } = await import('./openaiShim.js')
    const shimConnection: BoundProviderConnection = Object.freeze({
      ...connection,
      extra: Object.freeze({
        ...connection.extra,
        fetchImpl: resolvedFetch,
      }),
    })
    return createOpenAiShimClient({
      connection: shimConnection,
      defaultHeaders: stripForwardedProviderAuthHeaders(defaultHeaders),
      maxRetries,
      timeout: connection.timeoutMs,
    }) as unknown as ProviderSdk
  }

  if (connection.transport !== 'anthropic') {
    throw new Error(
      `${connection.provider} requests require their canonical native provider transport`,
    )
  }
  if (!connection.apiKey && !connection.authToken) {
    throw new Error('bound Anthropic provider has no prepared credential')
  }
  if (!connection.baseURL) {
    throw new Error('bound Anthropic provider has no prepared base URL')
  }
  const clientConfig: ConstructorParameters<typeof ProviderSdk>[0] = {
    ...(connection.authToken
      ? { authToken: connection.authToken, apiKey: null }
      : { apiKey: connection.apiKey }),
    baseURL: connection.baseURL,
    ...ARGS,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }

  return new ProviderSdk(clientConfig)
}

function resolveBoundConnection(
  explicitBinding: ProviderBinding | undefined,
  explicitEnvironment: ProviderEnvironment | undefined,
): BoundProviderConnection {
  if (explicitBinding !== undefined) {
    return projectBoundProviderConnection({
      binding: explicitBinding,
      ...(explicitEnvironment !== undefined
        ? { environment: explicitEnvironment }
        : {}),
    })
  }
  const session = requireCurrentRuntimeSession('provider client')
  const providerService = session.services.providerService
  if (providerService === undefined) {
    throw new Error('active runtime session has no provider service')
  }
  return projectBoundProviderConnection({
    binding: providerService.current(),
    environment: providerService.environment(),
  })
}

function isFirstPartyAnthropicUrl(baseURL: string | undefined): boolean {
  if (baseURL === undefined) return false
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase()
    return (
      hostname === 'api.anthropic.com' ||
      hostname === 'api-staging.anthropic.com'
    )
  } catch {
    return false
  }
}

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'
function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
  injectClientRequestId: boolean,
): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    // Generate a client-side request ID so timeouts can be correlated with
    // server logs. Explicit compatibility endpoints never receive this header.
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
