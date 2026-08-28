import {
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  refreshAuthorization as sdkRefreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import {
  InvalidGrantError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import {
  type AuthorizationServerMetadata,
  type OAuthClientInformation,
  type OAuthClientInformationFull,
  type OAuthClientMetadata,
  OAuthErrorResponseSchema,
  OAuthMetadataSchema,
  type OAuthTokens,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createHash, randomBytes } from 'crypto'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { MCP_CLIENT_METADATA_URL } from '../../constants/oauth.js'
import type { HomeContext } from '../../config/home.js'
import type { ProviderEnvironment } from '../../llm/provider-options.js'
import { errorMessage, getErrnoCode } from '../../utils/errors.js'
import * as lockfile from '../../utils/lockfile.js'
import { logMCPDebug } from '../../utils/log.js'
import { clearKeychainCache } from '../../utils/secureStorage/macOsKeychainHelpers.js'
import {
  readNativeSecureStorage,
  updateNativeSecureStorage,
} from '../../utils/secureStorage/native.js'
import { sleep } from '../../utils/sleep.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { buildRedirectUri } from './oauthPort.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from './types.js'
import { performCrossAppAccess, XaaTokenExchangeError } from './xaa.js'
import {
  clearIdpIdToken,
  discoverOidc,
  getCachedIdpIdToken,
  getIdpClientSecret,
  getXaaIdpConfig,
  isXaaEnabled,
} from './xaaIdpLogin.js'
/**
 * Timeout for individual OAuth requests (metadata discovery, token refresh, etc.)
 */
const AUTH_REQUEST_TIMEOUT_MS = 30000

const MAX_LOCK_RETRIES = 30

async function acquireMcpRefreshLock(
  home: HomeContext,
  serverName: string,
  serverKey: string,
): Promise<() => Promise<void>> {
  const agencDir = home.path
  await mkdir(agencDir, { recursive: true })
  const sanitizedKey = serverKey.replace(/[^a-zA-Z0-9]/g, '_')
  const lockfilePath = join(agencDir, `mcp-refresh-${sanitizedKey}.lock`)

  for (let retry = 0; retry < MAX_LOCK_RETRIES; retry++) {
    try {
      logMCPDebug(
        serverName,
        `Acquiring refresh lock (attempt ${retry + 1})`,
      )
      const release = await lockfile.lock(lockfilePath, {
        realpath: false,
        onCompromised: () => {
          logMCPDebug(serverName, `Refresh lock was compromised`)
        },
      })
      logMCPDebug(serverName, `Acquired refresh lock`)
      return release
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ELOCKED') {
        logMCPDebug(
          serverName,
          `Refresh lock held by another process, waiting (attempt ${retry + 1}/${MAX_LOCK_RETRIES})`,
        )
        await sleep(1000 + Math.random() * 1000)
        continue
      }
      logMCPDebug(
        serverName,
        `Failed to acquire refresh lock: ${code}`,
      )
      throw e
    }
  }

  throw new Error(
    `Could not acquire MCP refresh lock after ${MAX_LOCK_RETRIES} retries`,
  )
}

/**
 * OAuth query parameters that should be redacted from logs.
 * These contain sensitive values that could enable CSRF or session fixation attacks.
 */
const SENSITIVE_OAUTH_PARAMS = [
  'state',
  'nonce',
  'code_challenge',
  'code_verifier',
  'code',
]

type DiscoveredAuthorizationServerMetadata = Awaited<
  ReturnType<typeof discoverAuthorizationServerMetadata>
>

function assertHttpsMetadataUrl(
  field: string,
  value: unknown,
  issues: string[],
): void {
  if (value === undefined || value === null) {
    return
  }
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${field} must be a non-empty https:// URL`)
    return
  }
  try {
    if (new URL(value).protocol !== 'https:') {
      issues.push(`${field} must use https://`)
    }
  } catch {
    issues.push(`${field} must be a valid https:// URL`)
  }
}

/**
 * MCP OAuth discovery and token refresh consume endpoints controlled by server
 * metadata. The SDK's SafeUrlSchema rejects script URLs; AgenC additionally
 * requires every advertised authorization endpoint to use HTTPS.
 */
export function validateMcpOAuthAuthorizationServerMetadata(
  metadata: DiscoveredAuthorizationServerMetadata,
): DiscoveredAuthorizationServerMetadata {
  if (!metadata) return metadata

  const issues: string[] = []
  const metadataRecord = metadata as Record<string, unknown>

  assertHttpsMetadataUrl('issuer', metadataRecord.issuer, issues)
  for (const [field, value] of Object.entries(metadataRecord)) {
    if (field.endsWith('_endpoint') || field === 'jwks_uri') {
      assertHttpsMetadataUrl(field, value, issues)
    }
  }

  if (issues.length > 0) {
    throw new Error(
      `Incompatible MCP OAuth authorization server metadata: ${issues.join('; ')}`,
    )
  }

  return metadata
}

/**
 * Redacts sensitive OAuth query parameters from a URL for safe logging.
 * Prevents exposure of state, nonce, code_challenge, code_verifier, and authorization codes.
 */
function redactSensitiveUrlParams(url: string): string {
  try {
    const parsedUrl = new URL(url)
    for (const param of SENSITIVE_OAUTH_PARAMS) {
      if (parsedUrl.searchParams.has(param)) {
        parsedUrl.searchParams.set(param, '[REDACTED]')
      }
    }
    return parsedUrl.toString()
  } catch {
    // Return as-is if not a valid URL
    return url
  }
}


/**
 * Some OAuth servers (notably Slack) return HTTP 200 for all responses,
 * signaling errors via the JSON body instead. The SDK's executeTokenRequest
 * only calls parseErrorResponse when !response.ok, so a 200 with
 * {"error":"invalid_grant"} gets fed to OAuthTokensSchema.parse() and
 * surfaces as a ZodError — which the refresh retry/invalidation logic
 * treats as opaque request_failed instead of invalid_grant.
 *
 * This wrapper peeks at 2xx POST response bodies and rewrites ones that
 * match OAuthErrorResponseSchema (but not OAuthTokensSchema) to a 400
 * Response, so the SDK's normal error-class mapping applies. The same
 * fetchFn is also used for DCR POSTs, but DCR success responses have no
 * {error: string} field so they don't match the rewrite condition.
 *
 * Slack uses non-standard error codes (invalid_refresh_token observed live
 * at oauth.v2.user.access; expired_refresh_token/token_expired per Slack's
 * token rotation docs) where RFC 6749 specifies invalid_grant. We normalize
 * those so OAUTH_ERRORS['invalid_grant'] → InvalidGrantError matches and
 * token invalidation fires correctly.
 */
const NONSTANDARD_INVALID_GRANT_ALIASES = new Set([
  'invalid_refresh_token',
  'expired_refresh_token',
  'token_expired',
])

/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins --
 * Response has been stable in Node since 18; the rule flags it as
 * experimental-until-21 which is incorrect. Pattern matches existing
 * createAuthFetch suppressions in this file. */
async function normalizeOAuthErrorBody(
  response: Response,
): Promise<Response> {
  if (!response.ok) {
    return response
  }
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = jsonParse(text)
  } catch {
    return new Response(text, response)
  }
  if (OAuthTokensSchema.safeParse(parsed).success) {
    return new Response(text, response)
  }
  const result = OAuthErrorResponseSchema.safeParse(parsed)
  if (!result.success) {
    return new Response(text, response)
  }
  const normalized = NONSTANDARD_INVALID_GRANT_ALIASES.has(result.data.error)
    ? {
        error: 'invalid_grant',
        error_description:
          result.data.error_description ??
          `Server returned non-standard error code: ${result.data.error}`,
      }
    : result.data
  return new Response(jsonStringify(normalized), {
    status: 400,
    statusText: 'Bad Request',
    headers: response.headers,
  })
}
/* eslint-enable eslint-plugin-n/no-unsupported-features/node-builtins */

/**
 * Creates a fetch function with a fresh 30-second timeout for each OAuth request.
 * Used by AgenCAuthProvider for metadata discovery and token refresh.
 * Prevents stale timeout signals from affecting auth operations.
 */
function createAuthFetch(environment: ProviderEnvironment): FetchLike {
  const transportOptions = getProxyFetchOptions({ environment })
  return async (url: string | URL, init?: RequestInit) => {
    const timeoutSignal = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)
    const isPost = init?.method?.toUpperCase() === 'POST'

    // No existing signal - just use timeout
    if (!init?.signal) {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const response = await fetch(url, {
        ...init,
        signal: timeoutSignal,
        ...transportOptions,
      })
      return isPost ? normalizeOAuthErrorBody(response) : response
    }

    // Combine signals: abort when either fires
    const controller = new AbortController()
    const abort = () => controller.abort()

    init.signal.addEventListener('abort', abort)
    timeoutSignal.addEventListener('abort', abort)

    // Cleanup to prevent event listener leaks after fetch completes
    const cleanup = () => {
      init.signal?.removeEventListener('abort', abort)
      timeoutSignal.removeEventListener('abort', abort)
    }

    if (init.signal.aborted) {
      controller.abort()
    }

    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        ...transportOptions,
      })
      cleanup()
      return isPost ? normalizeOAuthErrorBody(response) : response
    } catch (error) {
      cleanup()
      throw error
    }
  }
}

/**
 * Fetches authorization server metadata, using a configured metadata URL if available,
 * otherwise performing RFC 9728 → RFC 8414 discovery via the SDK.
 *
 * Discovery order when no configured URL:
 * 1. RFC 9728: probe /.well-known/oauth-protected-resource on the MCP server,
 *    read authorization_servers[0], then RFC 8414 against that URL.
 * 2. Fallback: RFC 8414 directly against the MCP server URL (path-aware). Covers
 *    compatibility servers that co-host auth metadata at /.well-known/oauth-authorization-server/{path}
 *    without implementing RFC 9728. The SDK's own fallback strips the path, so this
 *    preserves the pre-existing path-aware probe for backward compatibility.
 *
 * Note: configuredMetadataUrl is user-controlled via canonical project config.toml.
 * Project-scoped MCP servers require user approval before connecting (same trust level
 * as the MCP server URL itself). The HTTPS requirement here is defense-in-depth beyond
 * schema validation — RFC 8414 mandates OAuth metadata retrieval over TLS.
 */
async function fetchAuthServerMetadata(
  serverName: string,
  serverUrl: string,
  configuredMetadataUrl: string | undefined,
  fetchFn: FetchLike,
  resourceMetadataUrl?: URL,
): Promise<Awaited<ReturnType<typeof discoverAuthorizationServerMetadata>>> {
  if (configuredMetadataUrl) {
    if (!configuredMetadataUrl.startsWith('https://')) {
      throw new Error(
        `authServerMetadataUrl must use https:// (got: ${configuredMetadataUrl})`,
      )
    }
    const response = await fetchFn(configuredMetadataUrl, {
      headers: { Accept: 'application/json' },
    })
    if (response.ok) {
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new Error(
          `Configured auth server metadata returned invalid JSON from ${configuredMetadataUrl}`,
        )
      }
      return validateMcpOAuthAuthorizationServerMetadata(
        OAuthMetadataSchema.parse(payload),
      )
    }
    throw new Error(
      `HTTP ${response.status} fetching configured auth server metadata from ${configuredMetadataUrl}`,
    )
  }

  try {
    const { authorizationServerMetadata } = await discoverOAuthServerInfo(
      serverUrl,
      {
        fetchFn,
        ...(resourceMetadataUrl && { resourceMetadataUrl }),
      },
    )
    if (authorizationServerMetadata) {
      return validateMcpOAuthAuthorizationServerMetadata(
        authorizationServerMetadata,
      )
    }
  } catch (err) {
    // Any error from the RFC 9728 → RFC 8414 chain (5xx from the root or
    // resolved-AS probe, schema parse failure, network error) — fall through
    // to the compatibility path-aware retry.
    logMCPDebug(
      serverName,
      `RFC 9728 discovery failed, falling back: ${errorMessage(err)}`,
    )
  }

  // Fallback only when the URL has a path component; for root URLs the SDK's
  // own fallback already probed the same endpoints.
  const url = new URL(serverUrl)
  if (url.pathname === '/') {
    return undefined
  }
  const metadata = await discoverAuthorizationServerMetadata(url, {
    fetchFn,
  })
  return validateMcpOAuthAuthorizationServerMetadata(metadata)
}


/**
 * Generates a unique key for server credentials based on both name and config hash
 * This prevents credentials from being reused across different servers
 * with the same name or different configurations
 */
export function getServerKey(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): string {
  const configJson = jsonStringify({
    type: serverConfig.type,
    url: serverConfig.url,
    headers: serverConfig.headers || {},
  })

  const hash = createHash('sha256')
    .update(configJson)
    .digest('hex')
    .substring(0, 16)

  return `${serverName}|${hash}`
}


// Utilizing platform-specific secure storage to protect sensitive tokens
export function clearServerTokensFromSecureStorage(
  home: HomeContext,
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): void {
  const serverKey = getServerKey(serverName, serverConfig)
  const transaction = updateNativeSecureStorage(
    home,
    current => {
      if (!current.mcpOAuth?.[serverKey]) return { ...current }
      const mcpOAuth = { ...current.mcpOAuth }
      delete mcpOAuth[serverKey]
      const next = { ...current }
      if (Object.keys(mcpOAuth).length === 0) delete next.mcpOAuth
      else next.mcpOAuth = mcpOAuth
      return next
    },
    `Failed to clear stored OAuth tokens for ${serverName}`,
  )
  if (transaction !== null) {
    logMCPDebug(serverName, 'Cleared stored tokens from secure storage')
  }
}


/**
 * Wraps fetch to detect 403 insufficient_scope responses and mark step-up
 * pending on the provider BEFORE the SDK's 403 handler calls auth(). Without
 * this, the SDK's authInternal sees refresh_token → refreshes (uselessly, since
 * RFC 6749 §6 forbids scope elevation via refresh) → returns 'AUTHORIZED' →
 * retry → 403 again → aborts with "Server returned 403 after trying upscoping".
 * With this flag set, tokens() omits refresh_token so the SDK surfaces that
 * interactive authorization is required instead of retrying the same scope.
 */
export function wrapFetchWithStepUpDetection(
  baseFetch: FetchLike,
  provider: AgenCAuthProvider,
): FetchLike {
  return async (url, init) => {
    const response = await baseFetch(url, init)
    if (response.status === 403) {
      const wwwAuth = response.headers.get('WWW-Authenticate')
      if (wwwAuth?.includes('insufficient_scope')) {
        // Match both quoted and unquoted values (RFC 6750 §3 allows either).
        // Same pattern as the SDK's extractFieldFromWwwAuth.
        const match = wwwAuth.match(/scope=(?:"([^"]+)"|([^\s,]+))/)
        const scope = match?.[1] ?? match?.[2]
        if (scope) {
          provider.markStepUpPending(scope)
        }
      }
    }
    return response
  }
}

export class AgenCAuthProvider implements OAuthClientProvider {
  private readonly home: HomeContext
  private readonly environment: ProviderEnvironment
  private serverName: string
  private serverConfig: McpSSEServerConfig | McpHTTPServerConfig
  private readonly redirectUri = buildRedirectUri()
  private _codeVerifier?: string
  private _state?: string
  private _metadata?: DiscoveredAuthorizationServerMetadata
  private _refreshInProgress?: Promise<OAuthTokens | undefined>
  private _pendingStepUpScope?: string

  constructor(
    home: HomeContext,
    serverName: string,
    serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
    environment: ProviderEnvironment = Object.freeze({}),
  ) {
    this.home = home
    this.environment = Object.freeze({ ...environment })
    this.serverName = serverName
    this.serverConfig = serverConfig
  }

  get redirectUrl(): string {
    return this.redirectUri
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      client_name: `AgenC (${this.serverName})`,
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // Public client
    }

    // Include scope from metadata if available
    const metadataScope = getScopeFromMetadata(this._metadata)
    if (metadataScope) {
      metadata.scope = metadataScope
      logMCPDebug(
        this.serverName,
        `Using scope from metadata: ${metadata.scope}`,
      )
    }

    return metadata
  }

  /**
   * CIMD (SEP-991): URL-based client_id. When the auth server advertises
   * client_id_metadata_document_supported: true, the SDK uses this URL as the
   * client_id instead of performing Dynamic Client Registration.
   * Override via MCP_OAUTH_CLIENT_METADATA_URL env var (e.g. for testing, FedStart).
   */
  get clientMetadataUrl(): string | undefined {
    const override = this.environment.MCP_OAUTH_CLIENT_METADATA_URL
    if (override) {
      logMCPDebug(this.serverName, `Using CIMD URL from env: ${override}`)
      return override
    }
    return MCP_CLIENT_METADATA_URL
  }

  setMetadata(
    metadata: DiscoveredAuthorizationServerMetadata,
  ): void {
    this._metadata = validateMcpOAuthAuthorizationServerMetadata(metadata)
  }

  /**
   * Called by the fetch wrapper when a 403 insufficient_scope response is
   * detected. Setting this causes tokens() to omit refresh_token, forcing
   * the SDK's authInternal to skip its (useless) refresh path and fall through
   * to startAuthorization and surface that interactive authorization is needed.
   * RFC 6749 §6 forbids scope elevation via refresh, so refreshing would just
   * return the same-scoped token and the retry would 403 again.
   */
  markStepUpPending(scope: string): void {
    this._pendingStepUpScope = scope
    logMCPDebug(this.serverName, `Marked step-up pending: ${scope}`)
  }

  async state(): Promise<string> {
    // Generate state if not already generated for this instance
    if (!this._state) {
      this._state = randomBytes(32).toString('base64url')
      logMCPDebug(this.serverName, 'Generated new OAuth state')
    }
    return this._state
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const data = readNativeSecureStorage(this.home)
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    // Check session credentials first (from DCR or previous auth)
    const storedInfo = data?.mcpOAuth?.[serverKey]
    if (storedInfo?.clientId) {
      logMCPDebug(this.serverName, `Found client info`)
      return {
        client_id: storedInfo.clientId,
        client_secret: storedInfo.clientSecret,
      }
    }

    // Fallback: pre-configured client ID from server config
    const configClientId = this.serverConfig.oauth?.clientId
    if (configClientId) {
      const clientConfig = data?.mcpOAuthClientConfig?.[serverKey]
      logMCPDebug(this.serverName, `Using pre-configured client ID`)
      return {
        client_id: configClientId,
        client_secret: clientConfig?.clientSecret,
      }
    }

    // If we don't have stored client info, return undefined to trigger registration
    logMCPDebug(this.serverName, `No client info found`)
    return undefined
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationFull,
  ): Promise<void> {
    const serverKey = getServerKey(this.serverName, this.serverConfig)
    updateNativeSecureStorage(
      this.home,
      current => ({
        ...current,
        mcpOAuth: {
          ...current.mcpOAuth,
          [serverKey]: {
            ...current.mcpOAuth?.[serverKey],
            serverName: this.serverName,
            serverUrl: this.serverConfig.url,
            clientId: clientInformation.client_id,
            clientSecret: clientInformation.client_secret,
            // Provide default values for required fields if not present
            accessToken: current.mcpOAuth?.[serverKey]?.accessToken || '',
            expiresAt: current.mcpOAuth?.[serverKey]?.expiresAt || 0,
          },
        },
      }),
      `Failed to save OAuth client information for ${this.serverName}`,
    )
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // On macOS, the Keychain cache TTL picks up token changes made by another
    // AgenC process. Linux and Windows do not use that in-process record cache.
    // In-process writes invalidate the macOS cache.
    // We do not call clearKeychainCache() here. tokens() is called by the MCP SDK's
    // _commonHeaders on every request, and forcing a cache miss would trigger
    // a blocking spawnSync(`security find-generic-password`) 30-40x/sec.
    // See CPU profile: spawnSync was 7.2% of total CPU after PR #19436.
    const data = readNativeSecureStorage(this.home)
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    const tokenData = data?.mcpOAuth?.[serverKey]

    // XAA: a cached id_token plays the same UX role as a refresh_token — run
    // the silent exchange to get a fresh access_token without a browser. The
    // id_token does expire (we re-acquire via `xaa login` when it does); the
    // point is that while it's valid, re-auth is zero-interaction.
    //
    // Only fire when we don't have a refresh_token. If the AS returned one,
    // the normal refresh path (below) is cheaper — 1 request vs the 4-request
    // XAA chain. If that refresh is revoked, refreshAuthorization() clears it
    // (invalidateCredentials('tokens')), and the next tokens() falls through
    // to here.
    //
    // Fires on:
    //   - never authed (!tokenData)                 → first connect, auto-auth
    //   - SDK partial write {accessToken:''}        → stale from past session
    //   - expired/expiring, no refresh_token        → proactive XAA re-auth
    //
    // No special-casing of {accessToken:'', expiresAt:0}. Yes, SDK auth()
    // writes that mid-flow (saveClientInformation defaults). But with this
    // auto-auth branch, the *first* tokens() call — before auth() writes
    // anything — fires xaaRefresh. If id_token is cached, SDK short-circuits
    // there and never reaches the write. If id_token isn't cached, xaaRefresh
    // returns undefined when no usable cached id_token is available. auth()
    // proceeds, writes the marker, calls tokens() again, and xaaRefresh fails
    // again identically.
    // Harmless redundancy, not a wasted exchange. And guarding on `!==''`
    // permanently bricks auto-auth when a *prior* session left that marker
    // in native secure storage. This caused a real bug with xaa.dev.
    //
    // xaaRefresh() internally short-circuits to undefined when the id_token
    // isn't cached (or canonical xaa_idp is gone) → we fall through to the
    // existing needs-auth path → user runs `xaa login`.
    //
    if (
      isXaaEnabled(this.environment) &&
      this.serverConfig.oauth?.xaa &&
      !tokenData?.refreshToken &&
      (!tokenData?.accessToken ||
        (tokenData.expiresAt - Date.now()) / 1000 <= 300)
    ) {
      if (!this._refreshInProgress) {
        logMCPDebug(
          this.serverName,
          tokenData
            ? `XAA: access_token expiring, attempting silent exchange`
            : `XAA: no access_token yet, attempting silent exchange`,
        )
        this._refreshInProgress = this.xaaRefresh().finally(() => {
          this._refreshInProgress = undefined
        })
      }
      try {
        const refreshed = await this._refreshInProgress
        if (refreshed) return refreshed
      } catch (e) {
        logMCPDebug(
          this.serverName,
          `XAA silent exchange failed: ${errorMessage(e)}`,
        )
      }
      // Fall through. Either id_token isn't cached (xaaRefresh returned
      // undefined) or the exchange errored. Normal path below handles both:
      // !tokenData → undefined → 401 → needs-auth; expired → undefined → same.
    }

    if (!tokenData) {
      logMCPDebug(this.serverName, `No token data found`)
      return undefined
    }

    // Check if token is expired
    const expiresIn = (tokenData.expiresAt - Date.now()) / 1000

    // Step-up check: if a 403 insufficient_scope was detected and the current
    // token doesn't have the requested scope, omit refresh_token below so the
    // SDK skips the ineffective refresh and surfaces interactive auth required.
    const currentScopes = tokenData.scope?.split(' ') ?? []
    const needsStepUp =
      this._pendingStepUpScope !== undefined &&
      this._pendingStepUpScope.split(' ').some(s => !currentScopes.includes(s))
    if (needsStepUp) {
      logMCPDebug(
        this.serverName,
        `Step-up pending (${this._pendingStepUpScope}), omitting refresh_token`,
      )
    }

    // If token is expired and we don't have a refresh token, return undefined
    if (expiresIn <= 0 && !tokenData.refreshToken) {
      logMCPDebug(this.serverName, `Token expired without refresh token`)
      return undefined
    }

    // If token is expired or about to expire (within 5 minutes) and we have a refresh token, refresh it proactively.
    // This proactive refresh is a UX improvement - it avoids the latency of a failed request followed by token refresh.
    // While MCP servers should return 401 for expired tokens (which triggers SDK-level refresh), proactively refreshing
    // before expiry provides a smoother user experience.
    // Skip when step-up is pending — refreshing can't elevate scope (RFC 6749 §6).
    if (expiresIn <= 300 && tokenData.refreshToken && !needsStepUp) {
      // Reuse existing refresh promise if one is in progress to prevent concurrent refreshes
      if (!this._refreshInProgress) {
        logMCPDebug(
          this.serverName,
          `Token expires in ${Math.floor(expiresIn)}s, attempting proactive refresh`,
        )
        this._refreshInProgress = this.refreshAuthorization(
          tokenData.refreshToken,
        ).finally(() => {
          this._refreshInProgress = undefined
        })
      } else {
        logMCPDebug(
          this.serverName,
          `Token refresh already in progress, reusing existing promise`,
        )
      }

      try {
        const refreshed = await this._refreshInProgress
        if (refreshed) {
          logMCPDebug(this.serverName, `Token refreshed successfully`)
          return refreshed
        }
        logMCPDebug(
          this.serverName,
          `Token refresh failed, returning current tokens`,
        )
      } catch (error) {
        logMCPDebug(
          this.serverName,
          `Token refresh error: ${errorMessage(error)}`,
        )
      }
    }

    // Return current tokens (may be expired if refresh failed or not needed yet)
    const tokens = {
      access_token: tokenData.accessToken,
      refresh_token: needsStepUp ? undefined : tokenData.refreshToken,
      expires_in: expiresIn,
      scope: tokenData.scope,
      token_type: 'Bearer',
    }

    logMCPDebug(this.serverName, `Returning tokens`)
    logMCPDebug(this.serverName, `Token length: ${tokens.access_token?.length}`)
    logMCPDebug(this.serverName, `Has refresh token: ${!!tokens.refresh_token}`)
    logMCPDebug(this.serverName, `Expires in: ${Math.floor(expiresIn)}s`)

    return tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this._pendingStepUpScope = undefined
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    logMCPDebug(this.serverName, `Saving tokens`)
    logMCPDebug(this.serverName, `Token expires in: ${tokens.expires_in}`)
    logMCPDebug(this.serverName, `Has refresh token: ${!!tokens.refresh_token}`)

    updateNativeSecureStorage(
      this.home,
      current => ({
        ...current,
        mcpOAuth: {
          ...current.mcpOAuth,
          [serverKey]: {
            ...current.mcpOAuth?.[serverKey],
            serverName: this.serverName,
            serverUrl: this.serverConfig.url,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
            scope: tokens.scope,
          },
        },
      }),
      `Failed to save OAuth tokens for ${this.serverName}`,
    )
  }

  /**
   * XAA silent refresh: cached id_token → Layer-2 exchange → new access_token.
   * No browser.
   *
   * Returns undefined if the id_token is gone from cache — caller treats this
   * as needs-interactive-reauth (transport will 401, AgenC surfaces it).
   *
   * On exchange failure, clears the id_token cache so the next interactive
   * auth does a fresh IdP login (the cached id_token is likely stale/revoked).
   *
   * Uses the same per-server cross-process refresh lock as normal OAuth
   * refresh. `_refreshInProgress` dedupes within one process; the lock
   * closes the native secure storage write race across concurrent AgenC
   * processes.
   */
  private async xaaRefresh(): Promise<OAuthTokens | undefined> {
    const idp = getXaaIdpConfig()
    if (!idp) return undefined // config was removed mid-session

    const serverKey = getServerKey(this.serverName, this.serverConfig)
    const release = await acquireMcpRefreshLock(
      this.home,
      this.serverName,
      serverKey,
    )

    try {
      clearKeychainCache()
      const existingData = readNativeSecureStorage(this.home)
      const tokenData = existingData.mcpOAuth?.[serverKey]
      if (tokenData) {
        const expiresIn = (tokenData.expiresAt - Date.now()) / 1000
        if (expiresIn > 300) {
          logMCPDebug(
            this.serverName,
            `Another process already refreshed XAA tokens (expires in ${Math.floor(expiresIn)}s)`,
          )
          return {
            access_token: tokenData.accessToken,
            refresh_token: tokenData.refreshToken,
            expires_in: expiresIn,
            scope: tokenData.scope,
            token_type: 'Bearer',
          }
        }
      }

      const idToken = getCachedIdpIdToken(idp.issuer, this.home)
      if (!idToken) {
        logMCPDebug(
          this.serverName,
          'XAA: id_token not cached, needs interactive re-auth',
        )
        return undefined
      }

      const clientId = this.serverConfig.oauth?.clientId
      const clientConfig = getMcpClientConfig(
        this.home,
        this.serverName,
        this.serverConfig,
      )
      if (!clientId || !clientConfig?.clientSecret) {
        logMCPDebug(
          this.serverName,
          'XAA: missing clientId or clientSecret in config — skipping silent refresh',
        )
        return undefined // shouldn't happen if `mcp add` was correct
      }

      const idpClientSecret = getIdpClientSecret(idp.issuer, this.home)

      // Discover IdP token endpoint. Could cache (fetchCache.ts already
      // caches /.well-known/ requests), but OIDC metadata is cheap + idempotent.
      // xaaRefresh is the silent tokens() path — soft-fail to undefined so the
      // caller falls through to needs-authentication instead of throwing mid-connect.
      let oidc
      try {
        oidc = await discoverOidc(idp.issuer, this.environment)
      } catch (e) {
        logMCPDebug(
          this.serverName,
          `XAA: OIDC discovery failed in silent refresh: ${errorMessage(e)}`,
        )
        return undefined
      }

      const tokens = await performCrossAppAccess(
        this.serverConfig.url,
        {
          clientId,
          clientSecret: clientConfig.clientSecret,
          idpClientId: idp.client_id,
          idpClientSecret,
          idpIdToken: idToken,
          idpTokenEndpoint: oidc.token_endpoint,
        },
        this.environment,
        this.serverName,
      )
      // Write directly (not via saveTokens) so clientId + clientSecret land in
      // storage even when this is the first write for serverKey. saveTokens
      // only spreads existing data; without this first-write path,
      // revokeServerTokens would later read tokenData.clientId as undefined
      // and send a client_id-less RFC 7009 request that strict ASes reject.
      updateNativeSecureStorage(
        this.home,
        current => {
          const prev = current.mcpOAuth?.[serverKey]
          return {
            ...current,
            mcpOAuth: {
              ...current.mcpOAuth,
              [serverKey]: {
                ...prev,
                serverName: this.serverName,
                serverUrl: this.serverConfig.url,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token ?? prev?.refreshToken,
                expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
                scope: tokens.scope,
                clientId,
                clientSecret: clientConfig.clientSecret,
                discoveryState: {
                  authorizationServerUrl: tokens.authorizationServerUrl,
                },
              },
            },
          }
        },
        `Failed to save refreshed XAA tokens for ${this.serverName}`,
      )
      return {
        access_token: tokens.access_token,
        token_type: 'Bearer',
        expires_in: tokens.expires_in,
        scope: tokens.scope,
        refresh_token: tokens.refresh_token,
      }
    } catch (e) {
      if (e instanceof XaaTokenExchangeError && e.shouldClearIdToken) {
        clearIdpIdToken(idp.issuer, this.home)
        logMCPDebug(
          this.serverName,
          'XAA: cleared id_token after exchange failure',
        )
      }
      throw e
    } finally {
      if (release) {
        try {
          await release()
          logMCPDebug(this.serverName, `Released refresh lock`)
        } catch {
          logMCPDebug(this.serverName, `Failed to release refresh lock`)
        }
      }
    }
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // OAuthClientProvider requires this method. AgenC deliberately has no
    // interactive standard-OAuth action, so transport auth must surface
    // `needs-auth` instead of opening a browser from the runtime.
    logMCPDebug(
      this.serverName,
      `Interactive authorization required; redirect unavailable: ${redactSensitiveUrlParams(authorizationUrl.toString())}`,
    )
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    logMCPDebug(this.serverName, `Saving code verifier`)
    this._codeVerifier = codeVerifier
  }

  async codeVerifier(): Promise<string> {
    if (!this._codeVerifier) {
      logMCPDebug(this.serverName, `No code verifier saved`)
      throw new Error('No code verifier saved')
    }
    logMCPDebug(this.serverName, `Returning code verifier`)
    return this._codeVerifier
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    const serverKey = getServerKey(this.serverName, this.serverConfig)
    if (scope === 'verifier') {
      this._codeVerifier = undefined
      return
    }
    const transaction = updateNativeSecureStorage(
      this.home,
      current => {
        const tokenData = current.mcpOAuth?.[serverKey]
        if (!tokenData) return { ...current }
        const mcpOAuth = { ...current.mcpOAuth }
        if (scope === 'all') {
          delete mcpOAuth[serverKey]
        } else {
          const nextToken = { ...tokenData }
          if (scope === 'client') {
            nextToken.clientId = undefined
            nextToken.clientSecret = undefined
          } else if (scope === 'tokens') {
            nextToken.accessToken = ''
            nextToken.refreshToken = undefined
            nextToken.expiresAt = 0
          } else {
            nextToken.discoveryState = undefined
          }
          mcpOAuth[serverKey] = nextToken
        }
        const next = { ...current }
        if (Object.keys(mcpOAuth).length === 0) delete next.mcpOAuth
        else next.mcpOAuth = mcpOAuth
        return next
      },
      `Failed to invalidate OAuth credentials for ${this.serverName}`,
    )
    if (transaction !== null) {
      logMCPDebug(this.serverName, `Invalidated credentials (scope: ${scope})`)
    }
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const discoveryIssues: string[] = []
    assertHttpsMetadataUrl(
      'authorizationServerUrl',
      state.authorizationServerUrl,
      discoveryIssues,
    )
    if (discoveryIssues.length > 0) {
      throw new Error(
        `Incompatible MCP OAuth discovery state: ${discoveryIssues.join('; ')}`,
      )
    }

    const metadata = validateMcpOAuthAuthorizationServerMetadata(
      state.authorizationServerMetadata,
    )
    if (metadata) {
      this._metadata = metadata
    }

    const serverKey = getServerKey(this.serverName, this.serverConfig)

    logMCPDebug(
      this.serverName,
      `Saving discovery state (authServer: ${state.authorizationServerUrl})`,
    )

    // Persist only the authoritative discovery URLs, not a stale copy of the
    // full provider metadata. The SDK re-fetches metadata from those URLs on
    // the next auth when needed.
    updateNativeSecureStorage(
      this.home,
      current => ({
        ...current,
        mcpOAuth: {
          ...current.mcpOAuth,
          [serverKey]: {
            ...current.mcpOAuth?.[serverKey],
            serverName: this.serverName,
            serverUrl: this.serverConfig.url,
            accessToken: current.mcpOAuth?.[serverKey]?.accessToken || '',
            expiresAt: current.mcpOAuth?.[serverKey]?.expiresAt || 0,
            discoveryState: {
              authorizationServerUrl: state.authorizationServerUrl,
              resourceMetadataUrl: state.resourceMetadataUrl,
            },
          },
        },
      }),
      `Failed to save OAuth discovery state for ${this.serverName}`,
    )
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const data = readNativeSecureStorage(this.home)
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    const cached = data?.mcpOAuth?.[serverKey]?.discoveryState
    if (cached?.authorizationServerUrl) {
      const issues: string[] = []
      assertHttpsMetadataUrl(
        'authorizationServerUrl',
        cached.authorizationServerUrl,
        issues,
      )
      if (issues.length > 0) {
        throw new Error(
          `Incompatible MCP OAuth discovery state: ${issues.join('; ')}`,
        )
      }

      logMCPDebug(
        this.serverName,
        `Returning cached discovery state (authServer: ${cached.authorizationServerUrl})`,
      )

      return {
        authorizationServerUrl: cached.authorizationServerUrl,
        resourceMetadataUrl: cached.resourceMetadataUrl,
      }
    }

    // Check config hint for direct metadata URL
    const metadataUrl = this.serverConfig.oauth?.authServerMetadataUrl
    if (metadataUrl) {
      logMCPDebug(
        this.serverName,
        `Fetching metadata from configured URL: ${metadataUrl}`,
      )
      try {
        const metadata = await fetchAuthServerMetadata(
          this.serverName,
          this.serverConfig.url,
          metadataUrl,
          createAuthFetch(this.environment),
        )
        if (metadata) {
          const validatedMetadata =
            validateMcpOAuthAuthorizationServerMetadata(metadata)
          if (!validatedMetadata) {
            return undefined
          }
          return {
            authorizationServerUrl: validatedMetadata.issuer,
            authorizationServerMetadata: validatedMetadata,
          }
        }
      } catch (error) {
        logMCPDebug(
          this.serverName,
          `Failed to fetch from configured metadata URL: ${errorMessage(error)}`,
        )
      }
    }

    return undefined
  }

  async refreshAuthorization(
    refreshToken: string,
  ): Promise<OAuthTokens | undefined> {
    const serverKey = getServerKey(this.serverName, this.serverConfig)
    const release = await acquireMcpRefreshLock(
      this.home,
      this.serverName,
      serverKey,
    )

    try {
      // Re-read tokens after acquiring lock — another process may have refreshed
      clearKeychainCache()
      const data = readNativeSecureStorage(this.home)
      const tokenData = data?.mcpOAuth?.[serverKey]
      if (tokenData) {
        const expiresIn = (tokenData.expiresAt - Date.now()) / 1000
        if (expiresIn > 300) {
          logMCPDebug(
            this.serverName,
            `Another process already refreshed tokens (expires in ${Math.floor(expiresIn)}s)`,
          )
          return {
            access_token: tokenData.accessToken,
            refresh_token: tokenData.refreshToken,
            expires_in: expiresIn,
            scope: tokenData.scope,
            token_type: 'Bearer',
          }
        }
        // Use the freshest refresh token from storage
        if (tokenData.refreshToken) {
          refreshToken = tokenData.refreshToken
        }
      }
      return await this._doRefresh(refreshToken)
    } finally {
      if (release) {
        try {
          await release()
          logMCPDebug(this.serverName, `Released refresh lock`)
        } catch {
          logMCPDebug(this.serverName, `Failed to release refresh lock`)
        }
      }
    }
  }

  private async _doRefresh(
    refreshToken: string,
  ): Promise<OAuthTokens | undefined> {
    const MAX_ATTEMPTS = 3

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        logMCPDebug(this.serverName, `Starting token refresh`)
        const authFetch = createAuthFetch(this.environment)

        // Reuse cached metadata from the initial OAuth flow if available,
        // since metadata (token endpoint URL, etc.) is static per auth server.
        // Priority:
        // 1. In-memory cache (same-session refreshes)
        // 2. Persisted discovery state from initial auth (cross-session) —
        //    avoids re-running RFC 9728 discovery on every refresh.
        // 3. Full RFC 9728 → RFC 8414 re-discovery via fetchAuthServerMetadata.
        let metadata = this._metadata
        if (!metadata) {
          const cached = await this.discoveryState()
          if (cached?.authorizationServerMetadata) {
            logMCPDebug(
              this.serverName,
              `Using persisted auth server metadata for refresh`,
            )
            metadata = cached.authorizationServerMetadata
          } else if (cached?.authorizationServerUrl) {
            logMCPDebug(
              this.serverName,
              `Re-discovering metadata from persisted auth server URL: ${cached.authorizationServerUrl}`,
            )
            metadata = validateMcpOAuthAuthorizationServerMetadata(
              await discoverAuthorizationServerMetadata(
                cached.authorizationServerUrl,
                { fetchFn: authFetch },
              ),
            )
          }
        }
        if (!metadata) {
          metadata = await fetchAuthServerMetadata(
            this.serverName,
            this.serverConfig.url,
            this.serverConfig.oauth?.authServerMetadataUrl,
            authFetch,
          )
        }
        if (!metadata) {
          logMCPDebug(this.serverName, `Failed to discover OAuth metadata`)
          return undefined
        }
        // Cache for future refreshes
        this._metadata = metadata

        const clientInfo = await this.clientInformation()
        if (!clientInfo) {
          logMCPDebug(this.serverName, `No client information available`)
          return undefined
        }

        const newTokens = await sdkRefreshAuthorization(
          new URL(this.serverConfig.url),
          {
            metadata,
            clientInformation: clientInfo,
            refreshToken,
            resource: new URL(this.serverConfig.url),
            fetchFn: authFetch,
          },
        )

        if (newTokens) {
          logMCPDebug(this.serverName, `Token refresh successful`)
          await this.saveTokens(newTokens)
          return newTokens
        }

        logMCPDebug(this.serverName, `Token refresh returned no tokens`)
        return undefined
      } catch (error) {
        // Invalid grant means the refresh token itself is invalid/revoked/expired.
        // But another process may have already refreshed successfully — check first.
        if (error instanceof InvalidGrantError) {
          logMCPDebug(
            this.serverName,
            `Token refresh failed with invalid_grant: ${error.message}`,
          )
          clearKeychainCache()
          const data = readNativeSecureStorage(this.home)
          const serverKey = getServerKey(this.serverName, this.serverConfig)
          const tokenData = data?.mcpOAuth?.[serverKey]
          if (tokenData) {
            const expiresIn = (tokenData.expiresAt - Date.now()) / 1000
            if (expiresIn > 300) {
              logMCPDebug(
                this.serverName,
                `Another process refreshed tokens, using those`,
              )
              return {
                access_token: tokenData.accessToken,
                refresh_token: tokenData.refreshToken,
                expires_in: expiresIn,
                scope: tokenData.scope,
                token_type: 'Bearer',
              }
            }
          }
          logMCPDebug(
            this.serverName,
            `No valid tokens in storage, clearing stored tokens`,
          )
          await this.invalidateCredentials('tokens')
          return undefined
        }

        // Retry on timeouts or transient server errors
        const isTimeoutError =
          error instanceof Error &&
          /timeout|timed out|etimedout|econnreset/i.test(error.message)
        const isTransientServerError =
          error instanceof ServerError ||
          error instanceof TemporarilyUnavailableError ||
          error instanceof TooManyRequestsError
        const isRetryable = isTimeoutError || isTransientServerError

        if (!isRetryable || attempt >= MAX_ATTEMPTS) {
          logMCPDebug(
            this.serverName,
            `Token refresh failed: ${errorMessage(error)}`,
          )
          return undefined
        }

        const delayMs = 1000 * Math.pow(2, attempt - 1) // 1s, 2s, 4s
        logMCPDebug(
          this.serverName,
          `Token refresh failed, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`,
        )
        await sleep(delayMs)
      }
    }

    return undefined
  }
}

export async function readClientSecret(
  environment: ProviderEnvironment,
): Promise<string> {
  const envSecret = environment.MCP_CLIENT_SECRET
  if (envSecret) {
    return envSecret
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'No TTY available to prompt for client secret. Set MCP_CLIENT_SECRET env var instead.',
    )
  }

  return new Promise((resolve, reject) => {
    process.stderr.write('Enter OAuth client secret: ')
    process.stdin.setRawMode?.(true)
    let secret = ''
    const onData = (ch: Buffer) => {
      const c = ch.toString()
      if (c === '\n' || c === '\r') {
        process.stdin.setRawMode?.(false)
        process.stdin.removeListener('data', onData)
        process.stderr.write('\n')
        resolve(secret)
      } else if (c === '\u0003') {
        process.stdin.setRawMode?.(false)
        process.stdin.removeListener('data', onData)
        reject(new Error('Cancelled'))
      } else if (c === '\u007F' || c === '\b') {
        secret = secret.slice(0, -1)
      } else {
        secret += c
      }
    }
    process.stdin.on('data', onData)
  })
}

export function saveMcpClientSecret(
  home: HomeContext,
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
  clientSecret: string,
): void {
  const serverKey = getServerKey(serverName, serverConfig)
  updateNativeSecureStorage(
    home,
    current => ({
      ...current,
      mcpOAuthClientConfig: {
        ...current.mcpOAuthClientConfig,
        [serverKey]: { clientSecret },
      },
    }),
    `Failed to save OAuth client secret for ${serverName}`,
  )
}

export function clearMcpClientConfig(
  home: HomeContext,
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): void {
  const serverKey = getServerKey(serverName, serverConfig)
  updateNativeSecureStorage(
    home,
    current => {
      if (!current.mcpOAuthClientConfig?.[serverKey]) return { ...current }
      const mcpOAuthClientConfig = { ...current.mcpOAuthClientConfig }
      delete mcpOAuthClientConfig[serverKey]
      const next = { ...current }
      if (Object.keys(mcpOAuthClientConfig).length === 0) {
        delete next.mcpOAuthClientConfig
      } else {
        next.mcpOAuthClientConfig = mcpOAuthClientConfig
      }
      return next
    },
    `Failed to clear OAuth client config for ${serverName}`,
  )
}
function getMcpClientConfig(
  home: HomeContext,
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): { clientSecret?: string } | undefined {
  const data = readNativeSecureStorage(home)
  const serverKey = getServerKey(serverName, serverConfig)
  return data?.mcpOAuthClientConfig?.[serverKey]
}
/**
 * Safely extracts scope information from AuthorizationServerMetadata.
 * The metadata can be either OAuthMetadata or OpenIdProviderDiscoveryMetadata,
 * and different providers use different fields for scope information.
 */
function getScopeFromMetadata(
  metadata: AuthorizationServerMetadata | undefined,
): string | undefined {
  if (!metadata) return undefined
  // Try 'scope' first (non-standard but used by some providers)
  if ('scope' in metadata && typeof metadata.scope === 'string') {
    return metadata.scope
  }
  // Try 'default_scope' (non-standard but used by some providers)
  if (
    'default_scope' in metadata &&
    typeof metadata.default_scope === 'string'
  ) {
    return metadata.default_scope
  }
  // Fall back to scopes_supported (standard OAuth 2.0 field)
  if (metadata.scopes_supported && Array.isArray(metadata.scopes_supported)) {
    return metadata.scopes_supported.join(' ')
  }
  return undefined
}
