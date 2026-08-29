import type {
  Base64ImageSource,
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createFetchWithInit,
  type FetchLike,
  type Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  type ElicitRequestURLParams,
  type ElicitResult,
  ErrorCode,
  ListResourcesResultSchema,
  type ListToolsResult,
  ListToolsResultSchema,
  McpError,
  type PromptMessage,
  type ResourceLink,
} from '@modelcontextprotocol/sdk/types.js'
import mapValues from 'lodash-es/mapValues.js'
import memoize from 'lodash-es/memoize.js'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import type { HomeContext } from '../../config/home.js'
import { secureStorageIdentityKey } from '../../utils/secureStorage/home.js'
import type { ProviderEnvironment } from '../../llm/provider-options.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { PRODUCT_URL } from '../../constants/product.js'
import type { AppState } from '../../tui/state/AppState.js'
import {
  type Tool,
  type ToolCallProgress,
} from '../../tools/Tool.js'
import { type MCPProgress, MCPTool } from '../../tools/MCPTool/MCPTool.js'
import { createAbortController } from '../../utils/abortController.js'
import { AbortError, isAbortError } from '../../utils/errors.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAgenCAIOAuthTokens,
  handleOAuth401Error,
} from '../../utils/auth.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import {
  errorMessage,
  LogSafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../../utils/errors.js'
import { quote as quoteShellArgs } from '../../utils/bash/shellQuote.js'
import { getMCPUserAgent } from '../../utils/http.js'
import { maybeNotifyIDEConnected } from '../../utils/ide.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import {
  getBinaryBlobSavedMessage,
  getFormatDescription,
  getLargeOutputInstructions,
  persistBinaryContent,
  type MCPResultType,
} from '../../utils/mcpOutputStorage.js'
import {
  type MCPToolResult,
  mcpContentNeedsTruncation,
  truncateMcpContentIfNeeded,
} from '../../utils/mcpValidation.js'
import { WebSocketTransport } from '../../utils/mcpWebSocketTransport.js'
import { memoizeWithLRU } from '../../utils/memoize.js'
import {
  resolveSessionTempRoot,
  type AgentRuntimeOptions,
} from '../../session/runtime-options.js'
import { getWebSocketTLSOptions } from '../../utils/mtls.js'
import {
  getProxyFetchOptions,
  getWebSocketProxyAgent,
  getWebSocketProxyUrl,
} from '../../utils/proxy.js'
import { recursivelySanitizeUnicode } from '../../utils/sanitization.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import {
  subprocessEnv,
  withChildTempAuthority,
} from '../../utils/subprocessEnv.js'
import {
  isPersistError,
  persistToolResult,
} from '../../utils/toolResultStorage.js'
import {
  type ElicitationWaitingState,
  runElicitationHooks,
  runElicitationResultHooks,
} from './elicitationHandler.js'
import { buildMcpToolName } from './mcpStringUtils.js'
import { normalizeNameForMCP } from './normalization.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { AssistantMessage } from 'src/types/message.js'
import { classifyMcpToolForCollapse } from '../../tools/MCPTool/classifyForCollapse.js'
import { sleep } from '../../utils/sleep.js'
import { AgenCAuthProvider, wrapFetchWithStepUpDetection } from './auth.js'
import { getMcpServerHeaders } from './headersHelper.js'
import {
  buildModelFacingMcpToolDescription,
  MCP_MODEL_FACING_METADATA_LIMITS,
  sanitizeMcpInputSchemaForModel,
  sanitizeMcpModelFacingText,
  sanitizeMcpSearchHint,
  sanitizeOptionalMcpModelFacingText,
} from '../../mcp-client/model-facing-sanitization.js'
import {
  buildMcpHostClientCapabilities,
  configureMcpHostRequestHandlers,
  type McpSamplingHandlers,
} from './hostCapabilities.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from './types.js'


/**
 * Custom error class to indicate that an MCP tool call failed due to
 * authentication issues (e.g., expired OAuth token returning 401).
 * This error should be caught at the tool execution layer to update
 * the client's status to 'needs-auth'.
 */
export class McpAuthError extends Error {
  serverName: string
  constructor(serverName: string, message: string) {
    super(message)
    this.name = 'McpAuthError'
    this.serverName = serverName
  }
}

/**
 * Thrown when an MCP session has expired and the connection cache has been cleared.
 * The caller should get a fresh client via ensureConnectedClient and retry.
 */
class McpSessionExpiredError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}" session expired`)
    this.name = 'McpSessionExpiredError'
  }
}

/**
 * Thrown when an MCP tool returns `isError: true`. Carries the result's `_meta`
 * so SDK consumers can still receive it — per the MCP spec, `_meta` is on the
 * base Result type and is valid on error results.
 */
export class McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends LogSafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  constructor(
    message: string,
    safeLogMessage: string,
    readonly mcpMeta?: { _meta?: Record<string, unknown> },
  ) {
    super(message, safeLogMessage)
    this.name = 'McpToolCallError'
  }
}

/**
 * Detects whether an error is an MCP "Session not found" error (HTTP 404 + JSON-RPC code -32001).
 * Per the MCP spec, servers return 404 when a session ID is no longer valid.
 * We check both signals to avoid false positives from generic 404s (wrong URL, server gone, etc.).
 */
function isMcpSessionExpiredError(error: Error): boolean {
  const httpStatus =
    'code' in error ? (error as Error & { code?: number }).code : undefined
  if (httpStatus !== 404) {
    return false
  }
  // The SDK embeds the response body text in the error message.
  // MCP servers return: {"error":{"code":-32001,"message":"Session not found"},...}
  // Check for the JSON-RPC error code to distinguish from generic web server 404s.
  return (
    error.message.includes('"code":-32001') ||
    error.message.includes('"code": -32001')
  )
}

// The MCP SDK requires a finite timer even when the runtime has no deadline.
// Its largest safe Node timer is ~24.8 days, far beyond an agent/tool turn;
// progress resets that SDK guard. AgenC itself adds no implicit tool deadline.
const MCP_SDK_UNBOUNDED_WINDOW_MS = 2_147_483_647

/** Server instructions are a separate protocol field with a character cap. */
const MAX_MCP_SERVER_INSTRUCTIONS_LENGTH = 2048

function modelFacingMcpInputSchema(
  serverName: string,
  toolName: string,
  inputSchema: unknown,
): Tool['inputJSONSchema'] {
  const result = sanitizeMcpInputSchemaForModel(inputSchema)
  if (result.issue?.code === 'too_large') {
    logMCPDebug(
      serverName,
      `Tool ${JSON.stringify(toolName)} model-facing input schema exceeded ${result.issue.maxBytes} bytes after metadata sanitization; using an open object schema`,
    )
  } else if (result.issue?.code === 'unsafe_key') {
    logMCPDebug(
      serverName,
      `Tool ${JSON.stringify(toolName)} model-facing input schema contained an unsafe or colliding key; using an open object schema`,
    )
  }
  return result.schema as Tool['inputJSONSchema']
}

/**
 * Gets an explicit MCP tool-call timeout in milliseconds. Unset or invalid
 * values mean that AgenC does not impose a tool deadline.
 */
function getMcpToolTimeoutMs(
  environment: ProviderEnvironment,
): number | undefined {
  const parsed = Number.parseInt(environment.MCP_TOOL_TIMEOUT || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

import { isAgenCInChromeMCPServer } from '../../utils/agencInChrome/common.js'

// Lazy: toolRendering.tsx pulls React/ink; only needed when AgenC-in-Chrome MCP server is connected
/* eslint-disable @typescript-eslint/no-require-imports */
const agencInChromeToolRendering =
  (): typeof import('../../utils/agencInChrome/toolRendering.js') =>
    require('../../utils/agencInChrome/toolRendering.js')

/* eslint-enable @typescript-eslint/no-require-imports */
import { jsonStringify } from '../../utils/slowOperations.js'

/** Return the canonical needs-auth connection result for remote transports. */
function handleRemoteAuthFailure(
  home: HomeContext,
  name: string,
  serverRef: ScopedMcpServerConfig,
  transportType: 'sse' | 'http' | 'agencai-proxy',
): MCPServerConnection {
  const label: Record<typeof transportType, string> = {
    sse: 'SSE',
    http: 'HTTP',
    'agencai-proxy': 'agenc.tech proxy',
  }
  logMCPDebug(
    name,
    `Authentication required for ${label[transportType]} server`,
  )
  return { name, type: 'needs-auth', config: serverRef, homeContext: home }
}

/**
 * Fetch wrapper for agenc.tech proxy connections. Attaches the OAuth bearer
 * token and retries once on 401 via handleOAuth401Error (force-refresh).
 *
 * Retrying once handles memoized-token staleness and clock drift. Without it,
 * a single stale token can put every agenc.tech connector into needs-auth state.
 */
function createAgenCAiProxyFetch(
  home: HomeContext,
  environment: ProviderEnvironment,
  innerFetch: FetchLike,
): FetchLike {
  return async (url, init) => {
    const doRequest = async () => {
      await checkAndRefreshOAuthTokenIfNeeded(home, environment)
      const currentTokens = getAgenCAIOAuthTokens(home, environment)
      if (!currentTokens) {
        throw new Error('No agenc.tech OAuth token available')
      }
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${currentTokens.accessToken}`)
      const response = await innerFetch(url, { ...init, headers })
      // Return the exact token that was sent. Reading getAgenCAIOAuthTokens()
      // again after the request is wrong under concurrent 401s: another
      // connector's handleOAuth401Error clears the memoize cache, so we'd read
      // the new token from native secure storage, pass it to
      // handleOAuth401Error, and incorrectly skip the retry because it matches
      // the stored token. bridgeApi.ts withOAuthRetry also passes the sent
      // token as a function parameter.
      return { response, sentToken: currentTokens.accessToken }
    }

    const { response, sentToken } = await doRequest()
    if (response.status !== 401) {
      return response
    }
    // handleOAuth401Error returns true only if the token actually changed
    // (native secure storage held a newer one, or force-refresh succeeded).
    // Gate retry on that result. Otherwise, we double the round-trip time for
    // every connector whose downstream service genuinely needs auth (the
    // common case: 30+ servers
    // with "MCP server requires authentication but no OAuth token configured").
    const tokenChanged = await handleOAuth401Error(
      home,
      sentToken,
      environment,
    ).catch(() => false)
    if (!tokenChanged) {
      // ELOCKED contention: another connector may have won the lockfile and refreshed — check if token changed underneath us
      const now = getAgenCAIOAuthTokens(home, environment)?.accessToken
      if (!now || now === sentToken) {
        return response
      }
    }
    try {
      return (await doRequest()).response
    } catch {
      // Retry itself failed (network error). Return the original 401 so the
      // outer handler can classify it.
      return response
    }
  }
}

// Minimal interface for WebSocket instances passed to mcpWebSocketTransport
type WsClientLike = {
  readonly readyState: number
  close(): void
  send(data: string): void
}

/**
 * Create a ws.WebSocket client with the MCP protocol.
 * Bun's ws shim types lack the 3-arg constructor (url, protocols, options)
 * that the real ws package supports, so we cast the constructor here.
 */
async function createNodeWsClient(
  url: string,
  options: Record<string, unknown>,
): Promise<WsClientLike> {
  const wsModule = await import('ws')
  const WS = wsModule.default as unknown as new (
    url: string,
    protocols: string[],
    options: Record<string, unknown>,
  ) => WsClientLike
  return new WS(url, ['mcp'], options)
}

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

function getConnectionTimeoutMs(environment: ProviderEnvironment): number {
  return parseInt(environment.MCP_TIMEOUT || '', 10) || 30000
}

/**
 * MCP Streamable HTTP spec requires clients to advertise acceptance of both
 * JSON and SSE on every POST. Servers that enforce this strictly reject
 * requests without it (HTTP 406).
 * https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#sending-messages-to-the-server
 */
const MCP_STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream'

export { getMcpRootUriForPath } from './hostCapabilities.js'

export function formatMcpShellPrefixCommand(
  command: string,
  args: readonly string[],
): string {
  return quoteShellArgs([command, ...args])
}

/**
 * Ensures the Accept header required by the MCP Streamable HTTP spec is
 * present on POSTs. The MCP SDK sets this inside
 * StreamableHTTPClientTransport.send(), but some runtimes have dropped it
 * before the wire. The wrapper deliberately adds no deadline: MCP tools can
 * legitimately run for hours, and cancellation remains owned by the request's
 * AbortSignal or an explicit MCP_TOOL_TIMEOUT.
 */
export function wrapMcpTransportFetch(baseFetch: FetchLike): FetchLike {
  return async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()

    // MCP transport GETs are long-lived SSE streams and need no header repair.
    if (method === 'GET') {
      return baseFetch(url, init)
    }

    // Normalize headers and guarantee the Streamable-HTTP Accept value. new Headers()
    // accepts HeadersInit | undefined and copies from plain objects, tuple arrays,
    // and existing Headers instances — so whatever shape the SDK handed us, the
    // Accept value survives the spread below as an own property of a concrete object.
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    if (!headers.has('accept')) {
      headers.set('accept', MCP_STREAMABLE_HTTP_ACCEPT)
    }

    return baseFetch(url, {
      ...init,
      headers,
    })
  }
}

export function getMcpServerConnectionBatchSize(
  environment: ProviderEnvironment = EMPTY_MCP_ENVIRONMENT,
): number {
  return parseInt(environment.MCP_SERVER_CONNECTION_BATCH_SIZE || '', 10) || 3
}

type InProcessMcpServer = {
  connect(t: Transport): Promise<void>
  close(): Promise<void>
}

export async function cleanupFailedConnection(
  transport: Pick<Transport, 'close'>,
  inProcessServer?: Pick<InProcessMcpServer, 'close'>,
): Promise<void> {
  if (inProcessServer) {
    await inProcessServer.close().catch(() => {})
  }

  await transport.close().catch(() => {})
}

// For the IDE MCP servers, we only include specific tools
const ALLOWED_IDE_TOOLS = ['mcp__ide__executeCode', 'mcp__ide__getDiagnostics']
function isIncludedMcpTool(tool: Tool): boolean {
  return (
    !tool.name.startsWith('mcp__ide__') || ALLOWED_IDE_TOOLS.includes(tool.name)
  )
}

/**
 * Generates the cache key for a server connection
 * @param name Server name
 * @param serverRef Server configuration
 * @returns Cache key string
 */
function getServerCacheKey(
  name: string,
  serverRef: ScopedMcpServerConfig,
  _serverStats?: unknown,
  options?: ConnectToServerOptions,
): string {
  const baseKey = `${name}-${jsonStringify(serverRef)}`
  const usesCredentialHome =
    serverRef.type === 'sse' ||
    serverRef.type === 'http' ||
    serverRef.type === 'agencai-proxy'
  const homeKey =
    !usesCredentialHome || options?.home === undefined
      ? ''
      : `-secure-storage-${secureStorageIdentityKey(options.home)}`
  const environment = options?.environment ?? EMPTY_MCP_ENVIRONMENT
  // The one module-owned empty sentinel represents process-ingress utilities
  // with no bound session and keeps their historical deterministic cache key.
  // Every real session snapshot, including an empty frozen snapshot, remains
  // identity-keyed so two session authorities never share a live connection.
  const environmentKey = environment === EMPTY_MCP_ENVIRONMENT
    ? ''
    : `-environment-${mcpEnvironmentIdentity(environment)}`
  const commandWrapperKey = options?.runtimeOptions?.commandWrapperArgv === undefined
    ? ''
    : `-command-wrapper-${jsonStringify(options.runtimeOptions.commandWrapperArgv)}`
  const sessionTempRootKey =
    serverRef.type === 'stdio' || serverRef.type === undefined
      ? `-session-temp-${jsonStringify(mcpSessionTempRoot(options))}`
      : ''
  if (options?.samplingHandlers === undefined) {
    return `${baseKey}${homeKey}${environmentKey}${commandWrapperKey}${sessionTempRootKey}`
  }
  return `${baseKey}${homeKey}${environmentKey}${commandWrapperKey}${sessionTempRootKey}-sampling-${options.samplingCacheKey ?? 'anonymous'}`
}

interface ConnectToServerOptions {
  readonly home?: HomeContext
  readonly environment?: ProviderEnvironment
  readonly runtimeOptions?: AgentRuntimeOptions
  readonly samplingHandlers?: McpSamplingHandlers
  readonly samplingCacheKey?: string
}

function mcpSessionTempRoot(options: ConnectToServerOptions | undefined): string {
  return options?.runtimeOptions?.sessionTempRoot ?? resolveSessionTempRoot()
}

const EMPTY_MCP_ENVIRONMENT: ProviderEnvironment = Object.freeze({})
interface McpConnectionAuthority {
  readonly environment: ProviderEnvironment
  readonly runtimeOptions?: AgentRuntimeOptions
}

const EMPTY_MCP_CONNECTION_AUTHORITY: McpConnectionAuthority = Object.freeze({
  environment: EMPTY_MCP_ENVIRONMENT,
})
const MCP_CONNECTION_AUTHORITIES = new WeakMap<object, McpConnectionAuthority>()
const MCP_ENVIRONMENT_IDENTITIES = new WeakMap<object, number>()
let nextMcpEnvironmentIdentity = 1

function mcpEnvironmentIdentity(environment: ProviderEnvironment): number {
  const existing = MCP_ENVIRONMENT_IDENTITIES.get(environment)
  if (existing !== undefined) return existing
  const identity = nextMcpEnvironmentIdentity
  nextMcpEnvironmentIdentity += 1
  MCP_ENVIRONMENT_IDENTITIES.set(environment, identity)
  return identity
}

/** Bind immutable construction authority to an in-process MCP connection. */
export function bindMcpConnectionAuthority(
  connection: ConnectedMCPServer,
  environment: ProviderEnvironment,
  runtimeOptions: AgentRuntimeOptions | undefined,
): ConnectedMCPServer {
  MCP_CONNECTION_AUTHORITIES.set(
    connection,
    Object.freeze({
      environment,
      ...(runtimeOptions !== undefined ? { runtimeOptions } : {}),
    }),
  )
  return connection
}

function mcpConnectionAuthority(
  connection: ConnectedMCPServer,
): McpConnectionAuthority {
  return MCP_CONNECTION_AUTHORITIES.get(connection) ??
    EMPTY_MCP_CONNECTION_AUTHORITY
}

const MCP_FETCH_IDENTITIES = new WeakMap<object, number>()
const MCP_FETCH_CACHE_KEYS_BY_SERVER = new Map<string, Set<string>>()
let nextMcpFetchIdentity = 1

function mcpFetchCacheKey(connection: MCPServerConnection): string {
  const object = connection as object
  let identity = MCP_FETCH_IDENTITIES.get(object)
  if (identity === undefined) {
    identity = nextMcpFetchIdentity
    nextMcpFetchIdentity += 1
    MCP_FETCH_IDENTITIES.set(object, identity)
  }
  const key = `${connection.name}-${identity}`
  const serverKeys = MCP_FETCH_CACHE_KEYS_BY_SERVER.get(connection.name) ??
    new Set<string>()
  serverKeys.add(key)
  MCP_FETCH_CACHE_KEYS_BY_SERVER.set(connection.name, serverKeys)
  return key
}

function clearMcpFetchCachesForServer(name: string): void {
  const keys = MCP_FETCH_CACHE_KEYS_BY_SERVER.get(name)
  if (keys !== undefined) {
    for (const key of keys) {
      fetchToolsForClient.cache.delete(key)
      fetchResourcesForClient.cache.delete(key)
    }
    MCP_FETCH_CACHE_KEYS_BY_SERVER.delete(name)
  }
}

function createEnvironmentScopedFetch(
  environment: ProviderEnvironment,
  innerFetch: FetchLike = globalThis.fetch.bind(globalThis),
): FetchLike {
  const transportOptions = getProxyFetchOptions({ environment })
  return (url, init) => innerFetch(url, {
    ...init,
    ...transportOptions,
  })
}

/**
 * Follow-up (ollie): The memoization here increases complexity by a lot, and im not sure it really improves performance
 * Attempts to connect to a single MCP server
 * @param name Server name
 * @param serverRef Scoped server configuration
 * @returns A wrapped client (either connected or failed)
 */
export const connectToServer = memoize(
  async (
    name: string,
    serverRef: ScopedMcpServerConfig,
    _serverStats?: {
      totalServers: number
      stdioCount: number
      sseCount: number
      httpCount: number
      sseIdeCount: number
      wsIdeCount: number
    },
    options?: ConnectToServerOptions,
  ): Promise<MCPServerConnection> => {
    const connectStartTime = Date.now()
    let inProcessServer: InProcessMcpServer | undefined
    try {
      let transport
      const credentialHome =
        serverRef.type === 'sse' ||
        serverRef.type === 'http' ||
        serverRef.type === 'agencai-proxy'
          ? options?.home
          : undefined
      if (
        (serverRef.type === 'sse' ||
          serverRef.type === 'http' ||
          serverRef.type === 'agencai-proxy') &&
        credentialHome === undefined
      ) {
        throw new Error(
          `MCP server ${JSON.stringify(name)} requires an explicit HomeContext`,
        )
      }

      // If we have the session ingress JWT, we will connect via the session ingress rather than
      // to remote MCP's directly.
      const environment = options?.environment ?? EMPTY_MCP_ENVIRONMENT
      const scopedFetch = createEnvironmentScopedFetch(environment)
      const sessionIngressToken = credentialHome === undefined
        ? undefined
        : getSessionIngressAuthToken(credentialHome, environment)

      if (serverRef.type === 'sse') {
        // Create an auth provider for this server
        const authProvider = new AgenCAuthProvider(
          credentialHome!,
          name,
          serverRef,
          environment,
        )

        // Get combined headers (static + dynamic)
        const combinedHeaders = await getMcpServerHeaders(
          name,
          serverRef,
          environment,
        )

        // Use the auth provider with SSEClientTransport
        const transportOptions: SSEClientTransportOptions = {
          authProvider,
          // Step-up detection wraps innermost so the 403 is seen before the
          // SDK's handler calls auth() → tokens().
          fetch: wrapMcpTransportFetch(
            wrapFetchWithStepUpDetection(
              createFetchWithInit(scopedFetch),
              authProvider,
            ),
          ),
          requestInit: {
            headers: {
              'User-Agent': getMCPUserAgent(),
              ...combinedHeaders,
            },
          },
        }

        // Keep the long-lived EventSource fetch separate from POST header
        // normalization. Auth-related GETs use their own bounded control-plane
        // fetch wrapper in auth.ts.
        transportOptions.eventSourceInit = {
          fetch: async (url: string | URL, init?: RequestInit) => {
            // Get auth headers from the auth provider
            const authHeaders: Record<string, string> = {}
            const tokens = await authProvider.tokens()
            if (tokens) {
              authHeaders.Authorization = `Bearer ${tokens.access_token}`
            }

            return scopedFetch(url, {
              ...init,
              headers: {
                'User-Agent': getMCPUserAgent(),
                ...authHeaders,
                ...init?.headers,
                ...combinedHeaders,
                Accept: 'text/event-stream',
              },
            })
          },
        }

        transport = new SSEClientTransport(
          new URL(serverRef.url),
          transportOptions,
        )
        logMCPDebug(name, `SSE transport initialized, awaiting connection`)
      } else if (serverRef.type === 'sse-ide') {
        logMCPDebug(name, `Setting up SSE-IDE transport to ${serverRef.url}`)
        // IDE servers don't need authentication
        // Follow-up: Use the auth token provided in the lockfile
        const transportOptions: SSEClientTransportOptions = {
          fetch: scopedFetch,
          eventSourceInit: {
            fetch: async (url: string | URL, init?: RequestInit) =>
              scopedFetch(url, {
                ...init,
                headers: {
                  'User-Agent': getMCPUserAgent(),
                  ...init?.headers,
                },
              }),
          },
        }

        transport = new SSEClientTransport(
          new URL(serverRef.url),
          transportOptions,
        )
      } else if (serverRef.type === 'ws-ide') {
        const tlsOptions = getWebSocketTLSOptions(environment)
        const wsHeaders = {
          'User-Agent': getMCPUserAgent(),
          ...(serverRef.authToken && {
            'X-AgenC-Code-Ide-Authorization': serverRef.authToken,
          }),
        }

        let wsClient: WsClientLike
        if (typeof Bun !== 'undefined') {
          // Bun's WebSocket supports headers/proxy/tls options but the DOM typings don't
          // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
          wsClient = new globalThis.WebSocket(serverRef.url, {
            protocols: ['mcp'],
            headers: wsHeaders,
            proxy: getWebSocketProxyUrl(serverRef.url, environment),
            tls: tlsOptions || undefined,
          } as unknown as string[])
        } else {
          wsClient = await createNodeWsClient(serverRef.url, {
            headers: wsHeaders,
            agent: getWebSocketProxyAgent(serverRef.url, environment),
            ...(tlsOptions || {}),
          })
        }
        transport = new WebSocketTransport(wsClient)
      } else if (serverRef.type === 'ws') {
        logMCPDebug(
          name,
          `Initializing WebSocket transport to ${serverRef.url}`,
        )

        const combinedHeaders = await getMcpServerHeaders(
          name,
          serverRef,
          environment,
        )

        const tlsOptions = getWebSocketTLSOptions(environment)
        const wsHeaders = {
          'User-Agent': getMCPUserAgent(),
          ...(sessionIngressToken && {
            Authorization: `Bearer ${sessionIngressToken}`,
          }),
          ...combinedHeaders,
        }

        // Redact sensitive headers before logging
        const wsHeadersForLogging = mapValues(wsHeaders, (value, key) =>
          key.toLowerCase() === 'authorization' ? '[REDACTED]' : value,
        )

        logMCPDebug(
          name,
          `WebSocket transport options: ${jsonStringify({
            url: serverRef.url,
            headers: wsHeadersForLogging,
            hasSessionAuth: !!sessionIngressToken,
          })}`,
        )

        let wsClient: WsClientLike
        if (typeof Bun !== 'undefined') {
          // Bun's WebSocket supports headers/proxy/tls options but the DOM typings don't
          // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
          wsClient = new globalThis.WebSocket(serverRef.url, {
            protocols: ['mcp'],
            headers: wsHeaders,
            proxy: getWebSocketProxyUrl(serverRef.url, environment),
            tls: tlsOptions || undefined,
          } as unknown as string[])
        } else {
          wsClient = await createNodeWsClient(serverRef.url, {
            headers: wsHeaders,
            agent: getWebSocketProxyAgent(serverRef.url, environment),
            ...(tlsOptions || {}),
          })
        }
        transport = new WebSocketTransport(wsClient)
      } else if (serverRef.type === 'http') {
        logMCPDebug(name, `Initializing HTTP transport to ${serverRef.url}`)
        logMCPDebug(
          name,
          `Node version: ${process.version}, Platform: ${process.platform}`,
        )
        logMCPDebug(
          name,
          `Environment: ${jsonStringify({
            NODE_OPTIONS: environment.NODE_OPTIONS || 'not set',
            UV_THREADPOOL_SIZE: environment.UV_THREADPOOL_SIZE || 'default',
            HTTP_PROXY: environment.HTTP_PROXY || 'not set',
            HTTPS_PROXY: environment.HTTPS_PROXY || 'not set',
            NO_PROXY: environment.NO_PROXY || 'not set',
          })}`,
        )

        // Create an auth provider for this server
        const authProvider = new AgenCAuthProvider(
          credentialHome!,
          name,
          serverRef,
          environment,
        )

        // Get combined headers (static + dynamic)
        const combinedHeaders = await getMcpServerHeaders(
          name,
          serverRef,
          environment,
        )

        // Check if this server has stored OAuth tokens. If so, the SDK's
        // authProvider will set Authorization — don't override with the
        // session ingress token (SDK merges requestInit AFTER authProvider).
        // CCR proxy URLs (ccr_shttp_mcp) have no stored OAuth, so they still
        // get the ingress token. See PR #24454 discussion.
        const hasOAuthTokens = !!(await authProvider.tokens())

        // Use the auth provider with StreamableHTTPClientTransport
        const proxyOptions = getProxyFetchOptions({ environment })
        logMCPDebug(
          name,
          `Proxy options: ${proxyOptions.dispatcher ? 'custom dispatcher' : 'default'}`,
        )

        const transportOptions: StreamableHTTPClientTransportOptions = {
          authProvider,
          // Step-up detection wraps innermost so the 403 is seen before the
          // SDK's handler calls auth() → tokens().
          fetch: wrapMcpTransportFetch(
            wrapFetchWithStepUpDetection(
              createFetchWithInit(scopedFetch),
              authProvider,
            ),
          ),
          requestInit: {
            ...proxyOptions,
            headers: {
              'User-Agent': getMCPUserAgent(),
              ...(sessionIngressToken &&
                !hasOAuthTokens && {
                Authorization: `Bearer ${sessionIngressToken}`,
              }),
              ...combinedHeaders,
            },
          },
        }

        // Redact sensitive headers before logging
        const headersForLogging = transportOptions.requestInit?.headers
          ? mapValues(
            transportOptions.requestInit.headers as Record<string, string>,
            (value, key) =>
              key.toLowerCase() === 'authorization' ? '[REDACTED]' : value,
          )
          : undefined

        logMCPDebug(
          name,
          `HTTP transport options: ${jsonStringify({
            url: serverRef.url,
            headers: headersForLogging,
            hasAuthProvider: !!authProvider,
            requestDeadline: 'none',
          })}`,
        )

        transport = new StreamableHTTPClientTransport(
          new URL(serverRef.url),
          transportOptions,
        )
        logMCPDebug(name, `HTTP transport created successfully`)
      } else if (serverRef.type === 'agencai-proxy') {
        logMCPDebug(
          name,
          `Initializing agenc.tech proxy transport for server ${serverRef.id}`,
        )

        const tokens = getAgenCAIOAuthTokens(credentialHome!, environment)
        if (!tokens) {
          throw new Error('No agenc.tech OAuth token found')
        }

        const oauthConfig = getOauthConfig()
        const proxyUrl = `${oauthConfig.MCP_PROXY_URL}${oauthConfig.MCP_PROXY_PATH.replace('{server_id}', serverRef.id)}`

        logMCPDebug(name, `Using agenc.tech proxy at ${proxyUrl}`)

        // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
        const fetchWithAuth = createAgenCAiProxyFetch(
          credentialHome!,
          environment,
          scopedFetch,
        )

        const proxyOptions = getProxyFetchOptions({ environment })
        const transportOptions: StreamableHTTPClientTransportOptions = {
          fetch: wrapMcpTransportFetch(fetchWithAuth),
          requestInit: {
            ...proxyOptions,
            headers: {
              'User-Agent': getMCPUserAgent(),
              'X-Mcp-Client-Session-Id': getSessionId(),
            },
          },
        }

        transport = new StreamableHTTPClientTransport(
          new URL(proxyUrl),
          transportOptions,
        )
        logMCPDebug(name, `agenc.tech proxy transport created successfully`)
      } else if (
        (serverRef.type === 'stdio' || !serverRef.type) &&
        isAgenCInChromeMCPServer(name)
      ) {
        // Run the Chrome MCP server in-process to avoid spawning a ~325 MB subprocess
        const { createChromeContext } = await import(
          '../../utils/agencInChrome/mcpServer.js'
        )
        const { createAgenCForChromeMcpServer } = await import(
          '@ant/agenc-for-chrome-mcp'
        )
        const { createLinkedTransportPair } = await import(
          './InProcessTransport.js'
        )
        const context = createChromeContext(
          environment,
          serverRef.env,
          options?.home,
        )
        const chromeMcpServer = createAgenCForChromeMcpServer(context)
        inProcessServer = chromeMcpServer
        const [clientTransport, serverTransport] = createLinkedTransportPair()
        await chromeMcpServer.connect(serverTransport)
        transport = clientTransport
        logMCPDebug(name, `In-process Chrome MCP server started`)
      } else if (serverRef.type === 'stdio' || !serverRef.type) {
        const commandWrapperArgv = options?.runtimeOptions?.commandWrapperArgv
        const finalCommand = commandWrapperArgv?.[0] ?? serverRef.command
        const finalArgs =
          commandWrapperArgv !== undefined && commandWrapperArgv.length > 0
            ? [
                ...commandWrapperArgv.slice(1),
                formatMcpShellPrefixCommand(serverRef.command, serverRef.args),
              ]
            : serverRef.args
        transport = new StdioClientTransport({
          command: finalCommand,
          args: finalArgs,
          env: withChildTempAuthority(
            {
              ...subprocessEnv({ ...environment }),
              ...serverRef.env,
            },
            mcpSessionTempRoot(options),
          ),
          stderr: 'pipe', // prevents error output from the MCP server from printing to the UI
        })
      } else {
        throw new Error(`Unsupported server type: ${serverRef.type}`)
      }

      // Set up stderr logging for stdio transport before connecting in case there are any stderr
      // outputs emitted during the connection start (this can be useful for debugging failed connections).
      // Store handler reference for cleanup to prevent memory leaks
      let stderrHandler: ((data: Buffer) => void) | undefined
      let stderrOutput = ''
      if (serverRef.type === 'stdio' || !serverRef.type) {
        const stdioTransport = transport as StdioClientTransport
        if (stdioTransport.stderr) {
          stderrHandler = (data: Buffer) => {
            // Cap stderr accumulation to prevent unbounded memory growth
            if (stderrOutput.length < 64 * 1024 * 1024) {
              try {
                stderrOutput += data.toString()
              } catch {
                // Ignore errors from exceeding max string length
              }
            }
          }
          stdioTransport.stderr.on('data', stderrHandler)
        }
      }

      const client = new Client(
        {
          // name stays 'agenc-code' for compatibility with MCP servers that
          // gate features on the upstream client identifier.
          name: 'agenc-code',
          title: 'AgenC',
          version: MACRO.VERSION ?? 'unknown',
          description: 'AgenC — coding-agent CLI for any LLM provider',
          websiteUrl: PRODUCT_URL,
        },
        {
          // Empty elicitation object declares the capability. Sending
          // {form:{},url:{}} breaks Java MCP SDK servers (Spring AI) whose
          // Elicitation class has zero fields and fails on unknown properties.
          capabilities: buildMcpHostClientCapabilities('empty'),
        },
      )

      // Add debug logging for client events if available
      if (serverRef.type === 'http') {
        logMCPDebug(name, `Client created, setting up request handler`)
      }

      configureMcpHostRequestHandlers(client, name, {
        rootPath: getOriginalCwd(),
        ...(options?.samplingHandlers !== undefined
          ? { samplingHandlers: options.samplingHandlers }
          : {}),
      })

      // Add a timeout to connection attempts to prevent tests from hanging indefinitely
      const connectionTimeoutMs = getConnectionTimeoutMs(environment)
      logMCPDebug(
        name,
        `Starting connection with timeout of ${connectionTimeoutMs}ms`,
      )

      // For HTTP transport, try a basic connectivity test first
      if (serverRef.type === 'http') {
        logMCPDebug(name, `Testing basic HTTP connectivity to ${serverRef.url}`)
        try {
          const testUrl = new URL(serverRef.url)
          logMCPDebug(
            name,
            `Parsed URL: host=${testUrl.hostname}, port=${testUrl.port || 'default'}, protocol=${testUrl.protocol}`,
          )

          // Log DNS resolution attempt
          if (
            testUrl.hostname === '127.0.0.1' ||
            testUrl.hostname === 'localhost'
          ) {
            logMCPDebug(name, `Using loopback address: ${testUrl.hostname}`)
          }
        } catch (urlError) {
          logMCPDebug(name, `Failed to parse URL: ${urlError}`)
        }
      }

      const connectPromise = client.connect(transport)
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timeoutId = setTimeout(() => {
          const elapsed = Date.now() - connectStartTime
          logMCPDebug(
            name,
            `Connection timeout triggered after ${elapsed}ms (limit: ${connectionTimeoutMs}ms)`,
          )
          if (inProcessServer) {
            inProcessServer.close().catch(() => { })
          }
          transport.close().catch(() => { })
          reject(
            new LogSafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
              `MCP server "${name}" connection timed out after ${connectionTimeoutMs}ms`,
              'MCP connection timeout',
            ),
          )
        }, connectionTimeoutMs)

        // Clean up timeout if connect resolves or rejects
        connectPromise.then(
          () => {
            clearTimeout(timeoutId)
          },
          _error => {
            clearTimeout(timeoutId)
          },
        )
      })

      try {
        await Promise.race([connectPromise, timeoutPromise])
        if (stderrOutput) {
          logMCPError(name, `Server stderr: ${stderrOutput}`)
          stderrOutput = '' // Release accumulated string to prevent memory growth
        }
        const elapsed = Date.now() - connectStartTime
        logMCPDebug(
          name,
          `Successfully connected (transport: ${serverRef.type || 'stdio'}) in ${elapsed}ms`,
        )
      } catch (error) {
        const elapsed = Date.now() - connectStartTime
        // SSE-specific error logging
        if (serverRef.type === 'sse' && error instanceof Error) {
          logMCPDebug(
            name,
            `SSE Connection failed after ${elapsed}ms: ${jsonStringify({
              url: serverRef.url,
              error: error.message,
              errorType: error.constructor.name,
              stack: error.stack,
            })}`,
          )
          logMCPError(name, error)

          if (error instanceof UnauthorizedError) {
            return handleRemoteAuthFailure(credentialHome!, name, serverRef, 'sse')
          }
        } else if (serverRef.type === 'http' && error instanceof Error) {
          const errorObj = error as Error & {
            cause?: unknown
            code?: string
            errno?: string | number
            syscall?: string
          }
          logMCPDebug(
            name,
            `HTTP Connection failed after ${elapsed}ms: ${error.message} (code: ${errorObj.code || 'none'}, errno: ${errorObj.errno || 'none'})`,
          )
          logMCPError(name, error)

          if (error instanceof UnauthorizedError) {
            return handleRemoteAuthFailure(credentialHome!, name, serverRef, 'http')
          }
        } else if (
          serverRef.type === 'agencai-proxy' &&
          error instanceof Error
        ) {
          logMCPDebug(
            name,
            `agenc.tech proxy connection failed after ${elapsed}ms: ${error.message}`,
          )
          logMCPError(name, error)

          // StreamableHTTPError has a `code` property with the HTTP status
          const errorCode = (error as Error & { code?: number }).code
          if (errorCode === 401) {
            return handleRemoteAuthFailure(
              credentialHome!,
              name,
              serverRef,
              'agencai-proxy',
            )
          }
        }
        if (inProcessServer) {
          await cleanupFailedConnection(transport, inProcessServer)
        } else {
          await cleanupFailedConnection(transport)
        }
        if (stderrOutput) {
          logMCPError(name, `Server stderr: ${stderrOutput}`)
        }
        throw error
      }

      const capabilities = client.getServerCapabilities()
      const serverVersion = client.getServerVersion()
      const rawInstructions = client.getInstructions()
      let instructions = rawInstructions
      if (
        rawInstructions &&
        rawInstructions.length > MAX_MCP_SERVER_INSTRUCTIONS_LENGTH
      ) {
        instructions =
          rawInstructions.slice(0, MAX_MCP_SERVER_INSTRUCTIONS_LENGTH) +
          '… [truncated]'
        logMCPDebug(
          name,
          `Server instructions truncated from ${rawInstructions.length} to ${MAX_MCP_SERVER_INSTRUCTIONS_LENGTH} chars`,
        )
      }

      // Log successful connection details
      logMCPDebug(
        name,
        `Connection established with capabilities: ${jsonStringify({
          hasTools: !!capabilities?.tools,
          hasPrompts: !!capabilities?.prompts,
          hasResources: !!capabilities?.resources,
          hasResourceSubscribe: !!capabilities?.resources?.subscribe,
          serverVersion: serverVersion || 'unknown',
        })}`,
      )
      logForDebugging(
        `[MCP] Server "${name}" connected with subscribe=${!!capabilities?.resources?.subscribe}`,
      )

      // Register default elicitation handler that returns cancel during the
      // window before a session owner installs the UI elicitation handler.
      client.setRequestHandler(ElicitRequestSchema, async request => {
        logMCPDebug(
          name,
          `Elicitation request received during initialization: ${jsonStringify(request)}`,
        )
        return { action: 'cancel' as const }
      })

      if (serverRef.type === 'sse-ide' || serverRef.type === 'ws-ide') {
        try {
          void maybeNotifyIDEConnected(client)
        } catch (error) {
          logMCPError(
            name,
            `Failed to send ide_connected notification: ${error}`,
          )
        }
      }

      // Enhanced connection drop detection and logging for all transport types
      const connectionStartTime = Date.now()
      let hasErrorOccurred = false

      // Store original handlers
      const originalOnerror = client.onerror
      const originalOnclose = client.onclose

      // The SDK's transport calls onerror on connection failures but doesn't call onclose,
      // which CC uses to trigger reconnection. We bridge this gap by tracking consecutive
      // terminal errors and manually closing after MAX_ERRORS_BEFORE_RECONNECT failures.
      let consecutiveConnectionErrors = 0
      const MAX_ERRORS_BEFORE_RECONNECT = 3

      // Guard against re-entry: close() aborts in-flight streams which may fire
      // onerror again before the close chain completes.
      let hasTriggeredClose = false

      // client.close() → transport.close() → transport.onclose → SDK's _onclose():
      // rejects all pending request handlers (so hung callTool() promises fail with
      // McpError -32000 "Connection closed") and then invokes our client.onclose
      // handler below (which clears the memo cache so the next call reconnects).
      // Calling client.onclose?.() directly would only clear the cache — pending
      // tool calls would stay hung.
      const closeTransportAndRejectPending = (reason: string) => {
        if (hasTriggeredClose) return
        hasTriggeredClose = true
        logMCPDebug(name, `Closing transport (${reason})`)
        void client.close().catch(e => {
          logMCPDebug(name, `Error during close: ${errorMessage(e)}`)
        })
      }

      const isTerminalConnectionError = (msg: string): boolean => {
        return (
          msg.includes('ECONNRESET') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('EPIPE') ||
          msg.includes('EHOSTUNREACH') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('Body Timeout Error') ||
          msg.includes('terminated') ||
          // SDK SSE reconnection intermediate errors — may be wrapped around the
          // actual network error, so the substrings above won't match
          msg.includes('SSE stream disconnected') ||
          msg.includes('Failed to reconnect SSE stream')
        )
      }

      // Enhanced error handler with detailed logging
      client.onerror = (error: Error) => {
        const uptime = Date.now() - connectionStartTime
        hasErrorOccurred = true
        const transportType = serverRef.type || 'stdio'

        // Log the connection drop with context
        logMCPDebug(
          name,
          `${transportType.toUpperCase()} connection dropped after ${Math.floor(uptime / 1000)}s uptime`,
        )

        // Log specific error details for debugging
        if (error.message) {
          if (error.message.includes('ECONNRESET')) {
            logMCPDebug(
              name,
              `Connection reset - server may have crashed or restarted`,
            )
          } else if (error.message.includes('ETIMEDOUT')) {
            logMCPDebug(
              name,
              `Connection timeout - network issue or server unresponsive`,
            )
          } else if (error.message.includes('ECONNREFUSED')) {
            logMCPDebug(name, `Connection refused - server may be down`)
          } else if (error.message.includes('EPIPE')) {
            logMCPDebug(
              name,
              `Broken pipe - server closed connection unexpectedly`,
            )
          } else if (error.message.includes('EHOSTUNREACH')) {
            logMCPDebug(name, `Host unreachable - network connectivity issue`)
          } else if (error.message.includes('ESRCH')) {
            logMCPDebug(
              name,
              `Process not found - stdio server process terminated`,
            )
          } else if (error.message.includes('spawn')) {
            logMCPDebug(
              name,
              `Failed to spawn process - check command and permissions`,
            )
          } else {
            logMCPDebug(name, `Connection error: ${error.message}`)
          }
        }

        // For HTTP transports, detect session expiry (404 + JSON-RPC -32001)
        // and close the transport so pending tool calls reject and the next
        // call reconnects with a fresh session ID.
        if (
          (transportType === 'http' || transportType === 'agencai-proxy') &&
          isMcpSessionExpiredError(error)
        ) {
          logMCPDebug(
            name,
            `MCP session expired (server returned 404 with session-not-found), triggering reconnection`,
          )
          closeTransportAndRejectPending('session expired')
          if (originalOnerror) {
            originalOnerror(error)
          }
          return
        }

        // For remote transports (SSE/HTTP), track terminal connection errors
        // and trigger reconnection via close if we see repeated failures.
        if (
          transportType === 'sse' ||
          transportType === 'http' ||
          transportType === 'agencai-proxy'
        ) {
          // The SDK's StreamableHTTP transport fires this after exhausting its
          // own SSE reconnect attempts (default maxRetries: 2) — but it never
          // calls onclose, so pending callTool() promises hang indefinitely.
          // This is the definitive "transport gave up" signal.
          if (error.message.includes('Maximum reconnection attempts')) {
            closeTransportAndRejectPending('SSE reconnection exhausted')
            if (originalOnerror) {
              originalOnerror(error)
            }
            return
          }

          if (isTerminalConnectionError(error.message)) {
            consecutiveConnectionErrors++
            logMCPDebug(
              name,
              `Terminal connection error ${consecutiveConnectionErrors}/${MAX_ERRORS_BEFORE_RECONNECT}`,
            )

            if (consecutiveConnectionErrors >= MAX_ERRORS_BEFORE_RECONNECT) {
              consecutiveConnectionErrors = 0
              closeTransportAndRejectPending('max consecutive terminal errors')
            }
          } else {
            // Non-terminal error (e.g., transient issue), reset counter
            consecutiveConnectionErrors = 0
          }
        }

        // Call original handler
        if (originalOnerror) {
          originalOnerror(error)
        }
      }

      // Enhanced close handler with connection drop context
      client.onclose = () => {
        const uptime = Date.now() - connectionStartTime
        const transportType = serverRef.type ?? 'unknown'

        logMCPDebug(
          name,
          `${transportType.toUpperCase()} connection closed after ${Math.floor(uptime / 1000)}s (${hasErrorOccurred ? 'with errors' : 'cleanly'})`,
        )

        // Clear the memoization cache so next operation reconnects
        const key = getServerCacheKey(name, serverRef, undefined, options)

        // Also clear fetch caches (keyed by server name). Reconnection
        // creates a new connection object; without clearing, the next
        // fetch would return stale tools/resources from the old connection.
        clearMcpFetchCachesForServer(name)

        connectToServer.cache.delete(key)
        logMCPDebug(name, `Cleared connection cache for reconnection`)

        if (originalOnclose) {
          originalOnclose()
        }
      }

      const cleanup = async () => {
        // In-process servers (e.g. Chrome MCP) don't have child processes or stderr
        if (inProcessServer) {
          try {
            await inProcessServer.close()
          } catch (error) {
            logMCPDebug(name, `Error closing in-process server: ${error}`)
          }
          try {
            await client.close()
          } catch (error) {
            logMCPDebug(name, `Error closing client: ${error}`)
          }
          return
        }

        // Remove stderr event listener to prevent memory leaks
        if (stderrHandler && (serverRef.type === 'stdio' || !serverRef.type)) {
          const stdioTransport = transport as StdioClientTransport
          stdioTransport.stderr?.off('data', stderrHandler)
        }

        // For stdio transports, explicitly terminate the child process with proper signals
        // NOTE: StdioClientTransport.close() only sends an abort signal, but many MCP servers
        // (especially Docker containers) need explicit SIGINT/SIGTERM signals to trigger graceful shutdown
        if (serverRef.type === 'stdio') {
          try {
            const stdioTransport = transport as StdioClientTransport
            const childPid = stdioTransport.pid

            if (childPid) {
              logMCPDebug(name, 'Sending SIGINT to MCP server process')

              // First try SIGINT (like Ctrl+C)
              try {
                process.kill(childPid, 'SIGINT')
              } catch (error) {
                logMCPDebug(name, `Error sending SIGINT: ${error}`)
                return
              }

              // Wait for graceful shutdown with rapid escalation (total 500ms to keep CLI responsive)
              await new Promise<void>(async resolve => {
                let resolved = false

                // Set up a timer to check if process still exists
                const checkInterval = setInterval(() => {
                  try {
                    // process.kill(pid, 0) checks if process exists without killing it
                    process.kill(childPid, 0)
                  } catch {
                    // Process no longer exists
                    if (!resolved) {
                      resolved = true
                      clearInterval(checkInterval)
                      clearTimeout(failsafeTimeout)
                      logMCPDebug(name, 'MCP server process exited cleanly')
                      resolve()
                    }
                  }
                }, 50)

                // Absolute failsafe: clear interval after 600ms no matter what
                const failsafeTimeout = setTimeout(() => {
                  if (!resolved) {
                    resolved = true
                    clearInterval(checkInterval)
                    logMCPDebug(
                      name,
                      'Cleanup timeout reached, stopping process monitoring',
                    )
                    resolve()
                  }
                }, 600)

                try {
                  // Wait 100ms for SIGINT to work (usually much faster)
                  await sleep(100)

                  if (!resolved) {
                    // Check if process still exists
                    try {
                      process.kill(childPid, 0)
                      // Process still exists, SIGINT failed, try SIGTERM
                      logMCPDebug(
                        name,
                        'SIGINT failed, sending SIGTERM to MCP server process',
                      )
                      try {
                        process.kill(childPid, 'SIGTERM')
                      } catch (termError) {
                        logMCPDebug(name, `Error sending SIGTERM: ${termError}`)
                        resolved = true
                        clearInterval(checkInterval)
                        clearTimeout(failsafeTimeout)
                        resolve()
                        return
                      }
                    } catch {
                      // Process already exited
                      resolved = true
                      clearInterval(checkInterval)
                      clearTimeout(failsafeTimeout)
                      resolve()
                      return
                    }

                    // Wait 400ms for SIGTERM to work (slower than SIGINT, often used for cleanup)
                    await sleep(400)

                    if (!resolved) {
                      // Check if process still exists
                      try {
                        process.kill(childPid, 0)
                        // Process still exists, SIGTERM failed, force kill with SIGKILL
                        logMCPDebug(
                          name,
                          'SIGTERM failed, sending SIGKILL to MCP server process',
                        )
                        try {
                          process.kill(childPid, 'SIGKILL')
                        } catch (killError) {
                          logMCPDebug(
                            name,
                            `Error sending SIGKILL: ${killError}`,
                          )
                        }
                      } catch {
                        // Process already exited
                        resolved = true
                        clearInterval(checkInterval)
                        clearTimeout(failsafeTimeout)
                        resolve()
                      }
                    }
                  }

                  // Final timeout - always resolve after 500ms max (total cleanup time)
                  if (!resolved) {
                    resolved = true
                    clearInterval(checkInterval)
                    clearTimeout(failsafeTimeout)
                    resolve()
                  }
                } catch {
                  // Handle any errors in the escalation sequence
                  if (!resolved) {
                    resolved = true
                    clearInterval(checkInterval)
                    clearTimeout(failsafeTimeout)
                    resolve()
                  }
                }
              })
            }
          } catch (processError) {
            logMCPDebug(name, `Error terminating process: ${processError}`)
          }
        }

        // Close the client connection (which also closes the transport)
        try {
          await client.close()
        } catch (error) {
          logMCPDebug(name, `Error closing client: ${error}`)
        }
      }

      // Register cleanup for all transport types - even network transports might need cleanup
      // This ensures all MCP servers get properly terminated, not just stdio ones
      const cleanupUnregister = registerCleanup(cleanup)

      // Create the wrapped cleanup that includes unregistering
      const wrappedCleanup = async () => {
        cleanupUnregister?.()
        await cleanup()
      }

      return bindMcpConnectionAuthority({
        name,
        client,
        type: 'connected' as const,
        capabilities: capabilities ?? {},
        serverInfo: serverVersion,
        instructions,
        config: serverRef,
        ...(credentialHome !== undefined ? { homeContext: credentialHome } : {}),
        cleanup: wrappedCleanup,
      }, environment, options?.runtimeOptions)
    } catch (error) {
      const connectionDurationMs = Date.now() - connectStartTime
      logMCPDebug(
        name,
        `Connection failed after ${connectionDurationMs}ms: ${errorMessage(error)}`,
      )
      logMCPError(name, `Connection failed: ${errorMessage(error)}`)

      if (inProcessServer) {
        inProcessServer.close().catch(() => { })
      }
      return {
        name,
        type: 'failed' as const,
        config: serverRef,
        error: errorMessage(error),
      }
    }
  },
  getServerCacheKey,
)

/**
 * Clears the memoize cache for a specific server
 * @param name Server name
 * @param serverRef Server configuration
 */
export async function clearServerCache(
  name: string,
  serverRef: ScopedMcpServerConfig,
  home?: HomeContext,
  environment: ProviderEnvironment = EMPTY_MCP_ENVIRONMENT,
  runtimeOptions?: AgentRuntimeOptions,
): Promise<void> {
  const connectOptions: ConnectToServerOptions = {
    ...(home !== undefined ? { home } : {}),
    environment,
    ...(runtimeOptions !== undefined ? { runtimeOptions } : {}),
  }
  const key = getServerCacheKey(name, serverRef, undefined, connectOptions)

  try {
    const wrappedClient = await (
      connectToServer.cache as {
        get: (cacheKey: string) => Promise<MCPServerConnection> | undefined
      }
    ).get(key)

    if (wrappedClient?.type === 'connected') {
      await wrappedClient.cleanup()
    }
  } catch {
    // Ignore errors - server might have failed to connect
  }

  // Clear from cache (both connection and fetch caches so reconnect
  // fetches fresh tools/resources instead of stale ones)
  connectToServer.cache.delete(key)
  clearMcpFetchCachesForServer(name)
}

/**
 * Ensures a valid connected client for an MCP server.
 * For most server types, uses the memoization cache if available, or reconnects
 * if the cache was cleared (e.g., after onclose). This ensures tool/resource
 * calls always use a valid connection.
 *
 * @param client The connected MCP server client
 * @returns Connected MCP server client (same or reconnected)
 * @throws Error if server cannot be connected
 */
export async function ensureConnectedClient(
  client: ConnectedMCPServer,
): Promise<ConnectedMCPServer> {
  const authority = mcpConnectionAuthority(client)

  const connectedClient = await connectToServer(
    client.name,
    client.config,
    undefined,
    {
      ...(client.homeContext !== undefined ? { home: client.homeContext } : {}),
      environment: authority.environment,
      ...(authority.runtimeOptions !== undefined
        ? { runtimeOptions: authority.runtimeOptions }
        : {}),
    },
  )
  if (connectedClient.type !== 'connected') {
    throw new LogSafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
      `MCP server "${client.name}" is not connected`,
      'MCP server not connected',
    )
  }
  return connectedClient
}

// Max cache size for fetch* caches. Keyed by server name (stable across
// reconnects), bounded to prevent unbounded growth with many MCP servers.
const MCP_FETCH_CACHE_SIZE = 20

/**
 * Encode MCP tool input for the auto-mode security classifier.
 * Exported so the auto-mode eval scripts can mirror production encoding
 * for `mcp__*` tool stubs without duplicating this logic.
 */
function mcpToolInputToAutoClassifierInput(
  input: Record<string, unknown>,
  toolName: string,
): string {
  const keys = Object.keys(input)
  return keys.length > 0
    ? keys.map(k => `${k}=${String(input[k])}`).join(' ')
    : toolName
}

export const fetchToolsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Tool[]> => {
    if (client.type !== 'connected') return []

    try {
      if (!client.capabilities?.tools) {
        return []
      }

      // Retry tool list fetch up to 2 times on transient failures.
      // Without retry, a single timeout during tools/list makes all MCP tools
      // silently disappear from the model's context until the next reconnect.
      let result: ListToolsResult | undefined
      let lastError: unknown
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = (await client.client.request(
            { method: 'tools/list' },
            ListToolsResultSchema,
          )) as ListToolsResult
          break
        } catch (err) {
          lastError = err
          if (attempt < 2) {
            logMCPDebug(
              client.name,
              `tools/list failed (attempt ${attempt + 1}/3): ${errorMessage(err)}. Retrying...`,
            )
            await sleep(1000 * (attempt + 1))
          }
        }
      }
      if (!result) {
        throw lastError ?? new Error('tools/list failed after 3 attempts')
      }

      // Keep the protocol identity byte-for-byte intact for tools/call. Only
      // fields exposed to the model or UI pass through the shared metadata
      // sanitizer below.
      return result.tools
        .map((tool): Tool => {
          const fullyQualifiedName = buildMcpToolName(client.name, tool.name)
          const modelFacingRawToolName =
            sanitizeMcpModelFacingText(tool.name) || fullyQualifiedName
          const modelFacingDescription =
            buildModelFacingMcpToolDescription({
              modelFacingName: fullyQualifiedName,
              rawToolName: tool.name,
              rawDescription: tool.description,
            })
          const modelFacingTitle = sanitizeOptionalMcpModelFacingText(
            tool.annotations?.title,
            MCP_MODEL_FACING_METADATA_LIMITS.toolTitleBytes,
          )
          return {
            ...MCPTool,
            name: fullyQualifiedName,
            mcpInfo: { serverName: client.name, toolName: tool.name },
            isMcp: true,
            // Collapse whitespace: _meta is open to external MCP servers, and
            // a newline here would inject orphan lines into the deferred-tool
            // list (formatDeferredToolLine joins on '\n').
            searchHint: sanitizeMcpSearchHint(
              tool._meta?.['anthropic/searchHint'],
            ),
            async description() {
              return modelFacingDescription
            },
            async prompt() {
              return modelFacingDescription
            },
            isConcurrencySafe() {
              return tool.annotations?.readOnlyHint ?? false
            },
            isReadOnly() {
              return tool.annotations?.readOnlyHint ?? false
            },
            toAutoClassifierInput(input) {
              return mcpToolInputToAutoClassifierInput(
                input,
                modelFacingRawToolName,
              )
            },
            isDestructive() {
              return tool.annotations?.destructiveHint ?? false
            },
            isOpenWorld() {
              return tool.annotations?.openWorldHint ?? false
            },
            isSearchOrReadCommand() {
              return classifyMcpToolForCollapse(client.name, tool.name)
            },
            inputJSONSchema: modelFacingMcpInputSchema(
              client.name,
              tool.name,
              tool.inputSchema,
            ),
            async checkPermissions() {
              return {
                behavior: 'passthrough' as const,
                message: 'MCPTool requires permission.',
                suggestions: [
                  {
                    type: 'addRules' as const,
                    rules: [
                      {
                        toolName: fullyQualifiedName,
                        ruleContent: undefined,
                      },
                    ],
                    behavior: 'allow' as const,
                    destination: 'session' as const,
                  },
                ],
              }
            },
            async call(
              args: Record<string, unknown>,
              context,
              _canUseTool,
              parentMessage,
              onProgress?: ToolCallProgress<MCPProgress>,
            ) {
              const toolUseId = extractToolUseId(parentMessage)
              const meta = toolUseId
                ? { 'agenccode/toolUseId': toolUseId }
                : {}

              // Emit progress when tool starts
              if (onProgress && toolUseId) {
                onProgress({
                  toolUseID: toolUseId,
                  data: {
                    type: 'mcp_progress',
                    status: 'started',
                    serverName: client.name,
                    toolName: tool.name,
                  },
                })
              }

              const startTime = Date.now()
              const MAX_SESSION_RETRIES = 1
              for (let attempt = 0; ; attempt++) {
                try {
                  const connectedClient = await ensureConnectedClient(client)
                  const mcpResult = await callMCPToolWithUrlElicitationRetry({
                    client: connectedClient,
                    clientConnection: client,
                    tool: tool.name,
                    args,
                    meta,
                    signal: context.abortController.signal,
                    setAppState: context.setAppState,
                    onProgress:
                      onProgress && toolUseId
                        ? progressData => {
                          onProgress({
                            toolUseID: toolUseId,
                            data: progressData,
                          })
                        }
                        : undefined,
                    handleElicitation: context.handleElicitation,
                  })

                  // Emit progress when tool completes successfully
                  if (onProgress && toolUseId) {
                    onProgress({
                      toolUseID: toolUseId,
                      data: {
                        type: 'mcp_progress',
                        status: 'completed',
                        serverName: client.name,
                        toolName: tool.name,
                        elapsedTimeMs: Date.now() - startTime,
                      },
                    })
                  }

                  return {
                    data: mcpResult.content,
                    ...((mcpResult._meta || mcpResult.structuredContent) && {
                      mcpMeta: {
                        ...(mcpResult._meta && {
                          _meta: mcpResult._meta,
                        }),
                        ...(mcpResult.structuredContent && {
                          structuredContent: mcpResult.structuredContent,
                        }),
                      },
                    }),
                  }
                } catch (error) {
                  // Session expired — the connection cache has been
                  // cleared, so retry with a fresh client.
                  if (
                    error instanceof McpSessionExpiredError &&
                    attempt < MAX_SESSION_RETRIES
                  ) {
                    logMCPDebug(
                      client.name,
                      `Retrying tool '${tool.name}' after session recovery`,
                    )
                    continue
                  }

                  // Emit progress when tool fails
                  if (onProgress && toolUseId) {
                    onProgress({
                      toolUseID: toolUseId,
                      data: {
                        type: 'mcp_progress',
                        status: 'failed',
                        serverName: client.name,
                        toolName: tool.name,
                        elapsedTimeMs: Date.now() - startTime,
                      },
                    })
                  }
                  // Wrap MCP SDK errors so logs get useful context
                  // instead of just "Error" or "McpError" (the constructor
                  // name). MCP SDK errors are protocol-level messages and
                  // don't contain user file paths or code.
                  if (
                    error instanceof Error &&
                    !(
                      error instanceof
                      LogSafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
                    )
                  ) {
                    const name = error.constructor.name
                    if (name === 'Error') {
                      throw new LogSafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
                        error.message,
                        error.message.slice(0, 200),
                      )
                    }
                    // McpError has a numeric `code` with the JSON-RPC error
                    // code (e.g. -32000 ConnectionClosed, -32001 RequestTimeout)
                    if (
                      name === 'McpError' &&
                      'code' in error &&
                      typeof error.code === 'number'
                    ) {
                      throw new LogSafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
                        error.message,
                        `McpError ${error.code}`,
                      )
                    }
                  }
                  throw error
                }
              }
            },
            userFacingName() {
              // Prefer title annotation if available, otherwise use tool name
              const displayName = modelFacingTitle || modelFacingRawToolName
              return `${client.name} - ${displayName} (MCP)`
            },
            ...(isAgenCInChromeMCPServer(client.name) &&
              (client.config.type === 'stdio' || !client.config.type)
              ? agencInChromeToolRendering().getAgenCInChromeMCPToolOverrides(
                tool.name,
              )
              : {}),
          }
        })
        .filter(isIncludedMcpTool)
    } catch (error) {
      logMCPError(client.name, `Failed to fetch tools: ${errorMessage(error)}`)
      return []
    }
  },
  mcpFetchCacheKey,
  MCP_FETCH_CACHE_SIZE,
)

export const fetchResourcesForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<ServerResource[]> => {
    if (client.type !== 'connected') return []

    try {
      if (!client.capabilities?.resources) {
        return []
      }

      const result = await client.client.request(
        { method: 'resources/list' },
        ListResourcesResultSchema,
      )

      if (!result.resources) return []

      // Add server name to each resource
      return result.resources.map(resource => ({
        ...resource,
        server: client.name,
      }))
    } catch (error) {
      logMCPError(
        client.name,
        `Failed to fetch resources: ${errorMessage(error)}`,
      )
      return []
    }
  },
  mcpFetchCacheKey,
  MCP_FETCH_CACHE_SIZE,
)


/**
 * Call an IDE tool directly as an RPC
 * @param toolName The name of the tool to call
 * @param args The arguments to pass to the tool
 * @param client The IDE client to use for the RPC call
 * @returns The result of the tool call
 */
export async function callIdeRpc(
  toolName: string,
  args: Record<string, unknown>,
  client: ConnectedMCPServer,
): Promise<string | ContentBlockParam[] | undefined> {
  const result = await callMCPTool({
    client,
    tool: toolName,
    args,
    signal: createAbortController().signal,
  })
  return result.content
}

/**
 * Transform result content from an MCP tool or MCP prompt into message blocks
 */
async function transformResultContent(
  resultContent: PromptMessage['content'],
  serverName: string,
): Promise<Array<ContentBlockParam>> {
  switch (resultContent.type) {
    case 'text':
      return [
        {
          type: 'text',
          text: recursivelySanitizeUnicode(resultContent.text) as string,
        },
      ]
    case 'audio': {
      const audioData = resultContent as {
        type: 'audio'
        data: string
        mimeType?: string
      }
      return await persistBlobToTextBlock(
        Buffer.from(audioData.data, 'base64'),
        audioData.mimeType,
        serverName,
        `[Audio from ${serverName}] `,
      )
    }
    case 'image': {
      // Resize and compress image data, enforcing API dimension limits
      const imageBuffer = Buffer.from(String(resultContent.data), 'base64')
      const ext = resultContent.mimeType?.split('/')[1] || 'png'
      const resized = await maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        ext,
      )
      return [
        {
          type: 'image',
          source: {
            data: resized.buffer.toString('base64'),
            media_type:
              `image/${resized.mediaType}` as Base64ImageSource['media_type'],
            type: 'base64',
          },
        },
      ]
    }
    case 'resource': {
      const resource = resultContent.resource
      const prefix = `[Resource from ${serverName} at ${resource.uri}] `

      if ('text' in resource) {
        return [
          {
            type: 'text',
            text: recursivelySanitizeUnicode(
              `${prefix}${resource.text}`,
            ) as string,
          },
        ]
      } else if ('blob' in resource) {
        const isImage = IMAGE_MIME_TYPES.has(resource.mimeType ?? '')

        if (isImage) {
          // Resize and compress image blob, enforcing API dimension limits
          const imageBuffer = Buffer.from(resource.blob, 'base64')
          const ext = resource.mimeType?.split('/')[1] || 'png'
          const resized = await maybeResizeAndDownsampleImageBuffer(
            imageBuffer,
            imageBuffer.length,
            ext,
          )
          const content: MessageParam['content'] = []
          if (prefix) {
            content.push({
              type: 'text',
              text: prefix,
            })
          }
          content.push({
            type: 'image',
            source: {
              data: resized.buffer.toString('base64'),
              media_type:
                `image/${resized.mediaType}` as Base64ImageSource['media_type'],
              type: 'base64',
            },
          })
          return content
        } else {
          return await persistBlobToTextBlock(
            Buffer.from(resource.blob, 'base64'),
            resource.mimeType,
            serverName,
            prefix,
          )
        }
      }
      return []
    }
    case 'resource_link': {
      const resourceLink = resultContent as ResourceLink
      let text = `[Resource link: ${resourceLink.name}] ${resourceLink.uri}`
      if (resourceLink.description) {
        text += ` (${resourceLink.description})`
      }
      return [
        {
          type: 'text',
          text,
        },
      ]
    }
    default:
      return []
  }
}

/**
 * Decode base64 binary content, write it to disk with the proper extension,
 * and return a small text block with the file path. Replaces the old behavior
 * of dumping raw base64 into the context.
 */
async function persistBlobToTextBlock(
  bytes: Buffer,
  mimeType: string | undefined,
  serverName: string,
  sourceDescription: string,
): Promise<Array<ContentBlockParam>> {
  const persistId = `mcp-${normalizeNameForMCP(serverName)}-blob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const result = await persistBinaryContent(bytes, mimeType, persistId)

  if ('error' in result) {
    return [
      {
        type: 'text',
        text: `${sourceDescription}Binary content (${mimeType || 'unknown type'}, ${bytes.length} bytes) could not be saved to disk: ${result.error}`,
      },
    ]
  }

  return [
    {
      type: 'text',
      text: getBinaryBlobSavedMessage(
        result.filepath,
        mimeType,
        result.size,
        sourceDescription,
      ),
    },
  ]
}

/**
 * Processes MCP tool result into a normalized format.
 */
export type TransformedMCPResult = {
  content: MCPToolResult
  type: MCPResultType
  schema?: string
}

/**
 * Generates a compact, jq-friendly type signature for a value.
 * e.g. "{title: string, items: [{id: number, name: string}]}"
 */
function inferCompactSchema(value: unknown, depth = 2): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${inferCompactSchema(value[0], depth - 1)}]`
  }
  if (typeof value === 'object') {
    if (depth <= 0) return '{...}'
    const entries = Object.entries(value).slice(0, 10)
    const props = entries.map(
      ([k, v]) => `${k}: ${inferCompactSchema(v, depth - 1)}`,
    )
    const suffix = Object.keys(value).length > 10 ? ', ...' : ''
    return `{${props.join(', ')}${suffix}}`
  }
  return typeof value
}

async function transformMCPResult(
  result: unknown,
  tool: string, // Tool name for validation (e.g., "search")
  name: string, // Server name for transformation (e.g., "slack")
): Promise<TransformedMCPResult> {
  if (result && typeof result === 'object') {
    if ('toolResult' in result) {
      return {
        content: String(result.toolResult),
        type: 'toolResult',
      }
    }

    if (
      'structuredContent' in result &&
      result.structuredContent !== undefined
    ) {
      return {
        content: jsonStringify(result.structuredContent),
        type: 'structuredContent',
        schema: inferCompactSchema(result.structuredContent),
      }
    }

    if ('content' in result && Array.isArray(result.content)) {
      const transformedContent = (
        await Promise.all(
          result.content.map(item => transformResultContent(item, name)),
        )
      ).flat()
      return {
        content: transformedContent,
        type: 'contentArray',
        schema: inferCompactSchema(transformedContent),
      }
    }
  }

  const errorMessage = `MCP server "${name}" tool "${tool}": unexpected response format`
  logMCPError(name, errorMessage)
  throw new LogSafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
    errorMessage,
    'MCP tool unexpected response format',
  )
}

/**
 * Check if MCP content contains any image blocks.
 * Used to decide whether to persist to file (images should use truncation instead
 * to preserve image compression and viewability).
 */
function contentContainsImages(content: MCPToolResult): boolean {
  if (!content || typeof content === 'string') {
    return false
  }
  return content.some(block => block.type === 'image')
}

async function processMCPResult(
  result: unknown,
  tool: string, // Tool name for validation (e.g., "search")
  name: string, // Server name for IDE check and transformation (e.g., "slack")
  environment: ProviderEnvironment,
): Promise<MCPToolResult> {
  const { content, type, schema } = await transformMCPResult(result, tool, name)

  // IDE tools are not going to the model directly, so we don't need to
  // handle large output.
  if (name === 'ide') {
    return content
  }

  // Check if content needs truncation (i.e., is too large)
  if (!(await mcpContentNeedsTruncation(content, environment))) {
    return content
  }

  // If large output files feature is disabled, fall back to old truncation behavior
  if (isEnvDefinedFalsy(environment.ENABLE_MCP_LARGE_OUTPUT_FILES)) {
    return await truncateMcpContentIfNeeded(content, environment)
  }

  // Save large output to file and return instructions for reading it
  // Content is guaranteed to exist at this point (we checked mcpContentNeedsTruncation)
  if (!content) {
    return content
  }

  // If content contains images, fall back to truncation - persisting images as JSON
  // defeats the image compression logic and makes them non-viewable
  if (contentContainsImages(content)) {
    return await truncateMcpContentIfNeeded(content, environment)
  }

  // Generate a unique ID for the persisted file (server__tool-timestamp)
  const timestamp = Date.now()
  const persistId = `mcp-${normalizeNameForMCP(name)}-${normalizeNameForMCP(tool)}-${timestamp}`
  // Convert to string for persistence (persistToolResult expects string or specific block types)
  const contentStr =
    typeof content === 'string' ? content : jsonStringify(content, null, 2)
  const persistResult = await persistToolResult(contentStr, persistId)

  if (isPersistError(persistResult)) {
    // If file save failed, fall back to returning truncated content info
    const contentLength = contentStr.length
    return `Error: result (${contentLength.toLocaleString()} characters) exceeds maximum allowed tokens. Failed to save output to file: ${persistResult.error}. If this MCP server provides pagination or filtering tools, use them to retrieve specific portions of the data.`
  }

  const formatDescription = getFormatDescription(type, schema)
  return getLargeOutputInstructions(
    persistResult.filepath,
    persistResult.originalSize,
    formatDescription,
  )
}

/**
 * Call an MCP tool, handling UrlElicitationRequiredError (-32042) by
 * displaying the URL elicitation to the user, waiting for the completion
 * notification, and retrying the tool call.
 */
type MCPToolCallResult = {
  content: MCPToolResult
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
}

/** @internal Exported for testing. */
export async function callMCPToolWithUrlElicitationRetry({
  client: connectedClient,
  clientConnection,
  tool,
  args,
  meta,
  signal,
  setAppState,
  onProgress,
  callToolFn = callMCPTool,
  handleElicitation,
}: {
  client: ConnectedMCPServer
  clientConnection: MCPServerConnection
  tool: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
  signal: AbortSignal
  setAppState: (f: (prev: AppState) => AppState) => void
  onProgress?: (data: MCPProgress) => void
  /** Injectable for testing. Defaults to callMCPTool. */
  callToolFn?: (opts: {
    client: ConnectedMCPServer
    tool: string
    args: Record<string, unknown>
    meta?: Record<string, unknown>
    signal: AbortSignal
    onProgress?: (data: MCPProgress) => void
  }) => Promise<MCPToolCallResult>
  /** Handler for URL elicitations when no hook handles them.
   * In print/SDK mode, delegates to structuredIO. In REPL, falls back to queue. */
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
}): Promise<MCPToolCallResult> {
  const MAX_URL_ELICITATION_RETRIES = 3
  for (let attempt = 0; ; attempt++) {
    // Check abort signal before each attempt — without this, a cancelled
    // elicitation retry loop continues spinning until MAX retries
    if (signal.aborted) {
      throw new Error('Tool call aborted during URL elicitation')
    }
    try {
      return await callToolFn({
        client: connectedClient,
        tool,
        args,
        meta,
        signal,
        onProgress,
      })
    } catch (error) {
      // The MCP SDK's Protocol creates plain McpError (not UrlElicitationRequiredError)
      // for error responses, so we check the error code instead of instanceof.
      if (
        !(error instanceof McpError) ||
        error.code !== ErrorCode.UrlElicitationRequired
      ) {
        throw error
      }

      // Limit the number of URL elicitation retries
      if (attempt >= MAX_URL_ELICITATION_RETRIES) {
        throw error
      }

      const errorData = error.data
      const rawElicitations =
        errorData != null &&
          typeof errorData === 'object' &&
          'elicitations' in errorData &&
          Array.isArray(errorData.elicitations)
          ? (errorData.elicitations as unknown[])
          : []

      // Validate each element has the required fields for ElicitRequestURLParams
      const elicitations = rawElicitations.filter(
        (e): e is ElicitRequestURLParams => {
          if (e == null || typeof e !== 'object') return false
          const obj = e as Record<string, unknown>
          return (
            obj.mode === 'url' &&
            typeof obj.url === 'string' &&
            typeof obj.elicitationId === 'string' &&
            typeof obj.message === 'string'
          )
        },
      )

      const serverName =
        clientConnection.type === 'connected'
          ? clientConnection.name
          : 'unknown'

      if (elicitations.length === 0) {
        logMCPDebug(
          serverName,
          `Tool '${tool}' returned -32042 but no valid elicitations in error data`,
        )
        throw error
      }

      logMCPDebug(
        serverName,
        `Tool '${tool}' requires URL elicitation (error -32042, attempt ${attempt + 1}), processing ${elicitations.length} elicitation(s)`,
      )

      // Process each URL elicitation from the error.
      // The completion notification handler (in registerElicitationHandler) sets
      // `completed: true` on the matching queue event; the dialog reacts to this flag.
      for (const elicitation of elicitations) {
        const { elicitationId } = elicitation

        // Run elicitation hooks — they can resolve URL elicitations programmatically
        const hookResponse = await runElicitationHooks(
          serverName,
          elicitation,
          signal,
        )
        if (hookResponse) {
          logMCPDebug(
            serverName,
            `URL elicitation ${elicitationId} resolved by hook: ${jsonStringify(hookResponse)}`,
          )
          if (hookResponse.action !== 'accept') {
            return {
              content: `URL elicitation was ${hookResponse.action === 'decline' ? 'declined' : hookResponse.action + 'ed'} by a hook. The tool "${tool}" could not complete because it requires the user to open a URL.`,
            }
          }
          // Hook accepted — skip the UI and proceed to retry
          continue
        }

        // Resolve the URL elicitation via callback (print/SDK mode) or queue (REPL mode).
        let userResult: ElicitResult
        if (handleElicitation) {
          // Print/SDK mode: delegate to structuredIO which sends a control request
          userResult = await handleElicitation(serverName, elicitation, signal)
        } else {
          // REPL mode: queue for ElicitationDialog with two-phase consent/waiting flow
          const waitingState: ElicitationWaitingState = {
            actionLabel: 'Retry now',
            showCancel: true,
          }
          userResult = await new Promise<ElicitResult>(resolve => {
            const onAbort = () => {
              void resolve({ action: 'cancel' })
            }
            if (signal.aborted) {
              onAbort()
              return
            }
            signal.addEventListener('abort', onAbort, { once: true })

            setAppState(prev => ({
              ...prev,
              elicitation: {
                queue: [
                  ...prev.elicitation.queue,
                  {
                    serverName,
                    requestId: `error-elicit-${elicitationId}`,
                    params: elicitation,
                    signal,
                    waitingState,
                    respond: result => {
                      // Phase 1 consent: accept is a no-op (doesn't resolve retry Promise)
                      if (result.action === 'accept') {
                        return
                      }
                      // Decline or cancel: resolve the retry Promise
                      signal.removeEventListener('abort', onAbort)
                      void resolve(result)
                    },
                    onWaitingDismiss: action => {
                      signal.removeEventListener('abort', onAbort)
                      if (action === 'retry') {
                        void resolve({ action: 'accept' })
                      } else {
                        void resolve({ action: 'cancel' })
                      }
                    },
                  },
                ],
              },
            }))
          })
        }

        // Run ElicitationResult hooks — they can modify or block the response
        const finalResult = await runElicitationResultHooks(
          serverName,
          userResult,
          signal,
          'url',
          elicitationId,
        )

        if (finalResult.action !== 'accept') {
          logMCPDebug(
            serverName,
            `User ${finalResult.action === 'decline' ? 'declined' : finalResult.action + 'ed'} URL elicitation ${elicitationId}`,
          )
          return {
            content: `URL elicitation was ${finalResult.action === 'decline' ? 'declined' : finalResult.action + 'ed'} by the user. The tool "${tool}" could not complete because it requires the user to open a URL.`,
          }
        }

        logMCPDebug(
          serverName,
          `Elicitation ${elicitationId} completed, retrying tool call`,
        )
      }

      // Loop back to retry the tool call
    }
  }
}

async function callMCPTool({
  client: connectedServer,
  tool,
  args,
  meta,
  signal,
  onProgress,
}: {
  client: ConnectedMCPServer
  tool: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
  signal: AbortSignal
  onProgress?: (data: MCPProgress) => void
}): Promise<{
  content: MCPToolResult
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
}> {
  const { client, name, config, homeContext } = connectedServer
  const { environment, runtimeOptions } = mcpConnectionAuthority(connectedServer)
  const toolStartTime = Date.now()
  let progressInterval: NodeJS.Timeout | undefined

  try {
    logMCPDebug(name, `Calling MCP tool: ${tool}`)

    // Set up progress logging for long-running tools (every 30 seconds)
    progressInterval = setInterval(
      (startTime, name, tool) => {
        const elapsed = Date.now() - startTime
        const elapsedSeconds = Math.floor(elapsed / 1000)
        const duration = `${elapsedSeconds}s`
        logMCPDebug(name, `Tool '${tool}' still running (${duration} elapsed)`)
      },
      30000, // Log every 30 seconds
      toolStartTime,
      name,
      tool,
    )

    const timeoutMs = getMcpToolTimeoutMs(environment)
    signal.throwIfAborted()
    const effectController = new AbortController()
    const timeoutError =
      timeoutMs === undefined
        ? undefined
        : new LogSafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
            `MCP server "${name}" tool "${tool}" timed out after ${Math.floor(timeoutMs / 1000)}s`,
            'MCP tool timeout',
          )
    let timedOut = false
    const forwardCallerAbort = (): void => {
      if (!effectController.signal.aborted) {
        effectController.abort(signal.reason)
      }
    }
    signal.addEventListener('abort', forwardCallerAbort, { once: true })
    const timeoutId =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            if (!effectController.signal.aborted) {
              effectController.abort(timeoutError)
            }
          }, timeoutMs)

    let result: Awaited<ReturnType<typeof client.callTool>>
    try {
      // Abort the physical RPC on cancellation/deadline, but keep this call
      // pending until the transport promise settles. The outer admitted tool
      // must retain its concurrency slot while an abort-ignoring transport is
      // still physically live.
      result = await client.callTool(
        {
          name: tool,
          arguments: args,
          _meta: meta,
        },
        CallToolResultSchema,
        {
          signal: effectController.signal,
          timeout: timeoutMs ?? MCP_SDK_UNBOUNDED_WINDOW_MS,
          ...(timeoutMs === undefined
            ? { resetTimeoutOnProgress: true }
            : {}),
          onprogress: onProgress
            ? sdkProgress => {
              onProgress({
                type: 'mcp_progress',
                status: 'progress',
                serverName: name,
                toolName: tool,
                progress: sdkProgress.progress,
                total: sdkProgress.total,
                progressMessage: sdkProgress.message,
              })
            }
            : undefined,
        },
      )
      signal.throwIfAborted()
      if (timedOut && timeoutError !== undefined) throw timeoutError
    } catch (error) {
      signal.throwIfAborted()
      if (timedOut && timeoutError !== undefined) throw timeoutError
      throw error
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      signal.removeEventListener('abort', forwardCallerAbort)
    }

    if ('isError' in result && result.isError) {
      let errorDetails = 'Unknown error'
      if (
        'content' in result &&
        Array.isArray(result.content) &&
        result.content.length > 0
      ) {
        const firstContent = result.content[0]
        if (
          firstContent &&
          typeof firstContent === 'object' &&
          'text' in firstContent
        ) {
          errorDetails = firstContent.text
        }
      } else if ('error' in result) {
        // Fallback for compatibility error format
        errorDetails = String(result.error)
      }
      logMCPError(name, errorDetails)
      // Include server and tool name in logs for debugging, but keep
      // the human-readable message unchanged to avoid breaking error consumers
      // that parse the message string.
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        errorDetails,
        `MCP tool [${name}] ${tool}: ${errorDetails}`,
        '_meta' in result && result._meta ? { _meta: result._meta } : undefined,
      )
    }
    const elapsed = Date.now() - toolStartTime
    const duration =
      elapsed < 1000
        ? `${elapsed}ms`
        : elapsed < 60000
          ? `${Math.floor(elapsed / 1000)}s`
          : `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`

    logMCPDebug(name, `Tool '${tool}' completed successfully in ${duration}`)

    const content = await processMCPResult(result, tool, name, environment)
    return {
      content,
      _meta: result._meta as Record<string, unknown> | undefined,
      structuredContent: result.structuredContent as
        | Record<string, unknown>
        | undefined,
    }
  } catch (e) {
    // Clear intervals on error
    if (progressInterval !== undefined) {
      clearInterval(progressInterval)
    }

    const elapsed = Date.now() - toolStartTime

    if (e instanceof Error && e.name !== 'AbortError') {
      logMCPDebug(
        name,
        `Tool '${tool}' failed after ${Math.floor(elapsed / 1000)}s: ${e.message}`,
      )
    }

    // Check for 401 errors indicating expired/invalid OAuth tokens
    // The MCP SDK's StreamableHTTPError has a `code` property with the HTTP status
    if (e instanceof Error) {
      const errorCode = 'code' in e ? (e.code as number | undefined) : undefined
      if (errorCode === 401 || e instanceof UnauthorizedError) {
        logMCPDebug(
          name,
          `Tool call returned 401 Unauthorized - token may have expired`,
        )
        throw new McpAuthError(
          name,
          `MCP server "${name}" requires re-authorization (token expired)`,
        )
      }

      // Check for session expiry — two error shapes can surface here:
      // 1. Direct 404 + JSON-RPC -32001 from the server (StreamableHTTPError)
      // 2. -32000 "Connection closed" (McpError) — the SDK closes the transport
      //    after the onerror handler fires, so the pending callTool() rejects
      //    with this derived error instead of the original 404.
      // In both cases, clear the connection cache so the next tool call
      // creates a fresh session.
      const isSessionExpired = isMcpSessionExpiredError(e)
      const isConnectionClosedOnHttp =
        'code' in e &&
        (e as Error & { code?: number }).code === -32000 &&
        e.message.includes('Connection closed') &&
        (config.type === 'http' || config.type === 'agencai-proxy')
      if (isSessionExpired || isConnectionClosedOnHttp) {
        logMCPDebug(
          name,
          `MCP session expired during tool call (${isSessionExpired ? '404/-32001' : 'connection closed'}), clearing connection cache for re-initialization`,
        )
        await clearServerCache(
          name,
          config,
          homeContext,
          environment,
          runtimeOptions,
        )
        throw new McpSessionExpiredError(name)
      }
    }

    // When the user hits esc, convert to our AbortError class so the tool
    // execution framework handles it properly (skips logging, creates
    // is_error: true result with [Request interrupted by user for tool use]).
    // Previously this returned { content: undefined }, which masked the
    // cancellation and caused mapToolResultToToolResultBlockParam to send
    // empty/undefined content to the API as if it were a successful result.
    if (isAbortError(e)) {
      throw new AbortError(
        e instanceof Error ? e.message : 'Tool execution cancelled',
      )
    }
    throw e
  } finally {
    // Always clear intervals
    if (progressInterval !== undefined) {
      clearInterval(progressInterval)
    }
  }
}

function extractToolUseId(message: AssistantMessage): string | undefined {
  if (message.message.content[0]?.type !== 'tool_use') {
    return undefined
  }
  return message.message.content[0].id
}
