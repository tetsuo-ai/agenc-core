// @aws-sdk/credential-provider-node and @smithy/node-http-handler are imported
// dynamically in getAWSClientProxyConfig() to defer ~929KB of AWS SDK.
// undici is lazy-required inside the request-scoped agent factories to defer
// ~1.5MB when no HTTPS_PROXY/mTLS env vars are set (the common case).
import axios, { type AxiosInstance } from 'axios'
import type { LookupOptions } from 'dns'
import type { Agent } from 'http'
import { HttpsProxyAgent, type HttpsProxyAgentOptions } from 'https-proxy-agent'
import type * as undici from 'undici'
import { getCACertificates } from './caCerts.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvTruthy } from './envUtils.js'
import {
  getMTLSAgent,
  getMTLSConfig,
  getTLSFetchOptions,
  type TLSConfig,
} from './mtls.js'

// Disable fetch keep-alive after a stale-pool ECONNRESET so retries open a
// fresh TCP connection instead of reusing the dead pooled socket. Sticky for
// the process lifetime — once the pool is known-bad, don't trust it again.
// Works under Bun (native fetch respects keepalive:false for pooling).
// Under Node/undici, keepalive is a no-op for pooling, but undici
// naturally evicts dead sockets from the pool on ECONNRESET.
let keepAliveDisabled = false

export function disableKeepAlive(): void {
  keepAliveDisabled = true
}

export function _resetKeepAliveForTesting(): void {
  keepAliveDisabled = false
}

/**
 * Convert dns.LookupOptions.family to a numeric address family value
 * Handles: 0 | 4 | 6 | 'IPv4' | 'IPv6' | undefined
 */
export function getAddressFamily(options: LookupOptions): 0 | 4 | 6 {
  switch (options.family) {
    case 0:
    case 4:
    case 6:
      return options.family
    case 'IPv6':
      return 6
    case 'IPv4':
    case undefined:
      return 4
    default:
      throw new Error(`Unsupported address family: ${options.family}`)
  }
}

type EnvLike = Readonly<Record<string, string | undefined>>

/**
 * Get the active proxy URL if one is configured
 * Prefers lowercase variants over uppercase (https_proxy > HTTPS_PROXY > http_proxy > HTTP_PROXY)
 * @param env Environment variables owned by the calling session or ingress
 */
export function getProxyUrl(env: EnvLike): string | undefined {
  return env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY
}

/**
 * Get the NO_PROXY environment variable value
 * Prefers lowercase over uppercase (no_proxy > NO_PROXY)
 * @param env Environment variables owned by the calling session or ingress
 */
export function getNoProxy(env: EnvLike): string | undefined {
  return env.no_proxy || env.NO_PROXY
}

/**
 * Check if a URL should bypass the proxy based on NO_PROXY environment variable
 * Supports:
 * - Exact hostname matches (e.g., "localhost")
 * - Domain suffix matches with leading dot (e.g., ".example.com")
 * - Wildcard "*" to bypass all
 * - Port-specific matches (e.g., "example.com:8080")
 * - IP addresses (e.g., "127.0.0.1")
 * @param urlString URL to check
 * @param noProxy NO_PROXY value from the calling session or ingress
 */
export function shouldBypassProxy(
  urlString: string,
  noProxy: string | undefined,
): boolean {
  if (!noProxy) return false

  // Handle wildcard
  if (noProxy === '*') return true

  try {
    const url = new URL(urlString)
    const hostname = url.hostname.toLowerCase()
    const port = url.port || (
      url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80'
    )
    const hostWithPort = `${hostname}:${port}`

    // Split by comma or space and trim each entry
    const noProxyList = noProxy.split(/[,\s]+/).filter(Boolean)

    return noProxyList.some(pattern => {
      pattern = pattern.toLowerCase().trim()

      // Check for port-specific match
      if (pattern.includes(':')) {
        return hostWithPort === pattern
      }

      // Check for domain suffix match (with or without leading dot)
      if (pattern.startsWith('.')) {
        // Pattern ".example.com" should match "sub.example.com" and "example.com"
        // but NOT "notexample.com"
        const suffix = pattern
        return hostname === pattern.substring(1) || hostname.endsWith(suffix)
      }

      // Check for exact hostname match or IP address
      return hostname === pattern
    })
  } catch {
    // If URL parsing fails, don't bypass proxy
    return false
  }
}

/**
 * Create an HttpsProxyAgent with optional mTLS configuration
 * Skips local DNS resolution to let the proxy handle it
 */
function createHttpsProxyAgent(
  proxyUrl: string,
  extra: HttpsProxyAgentOptions<string>,
  environment: EnvLike,
): HttpsProxyAgent<string> {
  const mtlsConfig = getMTLSConfig(environment)
  const caCerts = getCACertificates(environment)

  const agentOptions: HttpsProxyAgentOptions<string> = {
    ...(mtlsConfig && {
      cert: mtlsConfig.cert,
      key: mtlsConfig.key,
      passphrase: mtlsConfig.passphrase,
    }),
    ...(caCerts && { ca: caCerts }),
  }

  if (isEnvTruthy(environment.AGENC_PROXY_RESOLVES_HOSTS)) {
    // Skip local DNS resolution - let the proxy resolve hostnames
    // This is needed for environments where DNS is not configured locally
    // and instead handled by the proxy (as in sandboxes)
    agentOptions.lookup = (hostname, options, callback) => {
      callback(null, hostname, getAddressFamily(options))
    }
  }

  return new HttpsProxyAgent(proxyUrl, { ...agentOptions, ...extra })
}

/**
 * Axios instance with its own proxy agent. Same NO_PROXY/mTLS/CA
 * resolution as the global interceptor, but agent options stay
 * scoped to this instance.
 */
export function createAxiosInstance(
  environment: EnvLike,
  extra: HttpsProxyAgentOptions<string> = {},
): AxiosInstance {
  const proxyUrl = getProxyUrl(environment)
  const mtlsAgent = getMTLSAgent(environment)
  const instance = axios.create({ proxy: false })

  if (!proxyUrl) {
    if (mtlsAgent) instance.defaults.httpsAgent = mtlsAgent
    return instance
  }

  const proxyAgent = createHttpsProxyAgent(proxyUrl, extra, environment)
  instance.interceptors.request.use(config => {
    if (config.url && shouldBypassProxy(config.url, getNoProxy(environment))) {
      config.httpsAgent = mtlsAgent
      config.httpAgent = mtlsAgent
    } else {
      config.httpsAgent = proxyAgent
      config.httpAgent = proxyAgent
    }
    return config
  })
  return instance
}

/**
 * Get or create a proxy agent owned by one immutable environment snapshot.
 * Agent reuse never crosses session boundaries, even when proxy URLs match.
 */
let proxyAgentsByEnvironment = new WeakMap<object, Map<string, undici.Dispatcher>>()
let directAgentsByEnvironment = new WeakMap<object, undici.Dispatcher>()

export function getProxyAgent(
  uri: string,
  environment: EnvLike,
): undici.Dispatcher {
  let agents = proxyAgentsByEnvironment.get(environment)
  if (agents === undefined) {
    agents = new Map()
    proxyAgentsByEnvironment.set(environment, agents)
  }
  const cached = agents.get(uri)
  if (cached !== undefined) return cached

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const undiciMod = require('undici') as typeof undici
  const mtlsConfig = getMTLSConfig(environment)
  const caCerts = getCACertificates(environment)

  // Use EnvHttpProxyAgent to respect NO_PROXY
  // This agent automatically checks NO_PROXY for each request
  const proxyOptions: undici.EnvHttpProxyAgent.Options & {
    requestTls?: {
      cert?: string | Buffer
      key?: string | Buffer
      passphrase?: string
      ca?: string | string[] | Buffer
    }
  } = {
    // Override both HTTP and HTTPS proxy with the provided URI
    httpProxy: uri,
    httpsProxy: uri,
    noProxy: getNoProxy(environment),
  }

  // Set both connect and requestTls so TLS options apply to both paths:
  // - requestTls: used by ProxyAgent for the TLS connection through CONNECT tunnels
  // - connect: used by Agent for direct (no-proxy) connections
  if (mtlsConfig || caCerts) {
    const tlsOpts = {
      ...(mtlsConfig && {
        cert: mtlsConfig.cert,
        key: mtlsConfig.key,
        passphrase: mtlsConfig.passphrase,
      }),
      ...(caCerts && { ca: caCerts }),
    }
    proxyOptions.connect = tlsOpts
    proxyOptions.requestTls = tlsOpts
  }

  const agent = new undiciMod.EnvHttpProxyAgent(proxyOptions)
  agents.set(uri, agent)
  return agent
}

/**
 * Get an HTTP agent configured for WebSocket proxy support
 * Returns undefined if no proxy is configured or URL should bypass proxy
 */
export function getWebSocketProxyAgent(
  url: string,
  environment: EnvLike,
): Agent | undefined {
  const proxyUrl = getProxyUrl(environment)

  if (!proxyUrl) {
    return undefined
  }

  // Check if URL should bypass proxy
  if (shouldBypassProxy(url, getNoProxy(environment))) {
    return undefined
  }

  return createHttpsProxyAgent(proxyUrl, {}, environment)
}

/**
 * Get the proxy URL for WebSocket connections under Bun.
 * Bun's native WebSocket supports a `proxy` string option instead of Node's `agent`.
 * Returns undefined if no proxy is configured or URL should bypass proxy.
 */
export function getWebSocketProxyUrl(
  url: string,
  environment: EnvLike,
): string | undefined {
  const proxyUrl = getProxyUrl(environment)

  if (!proxyUrl) {
    return undefined
  }

  if (shouldBypassProxy(url, getNoProxy(environment))) {
    return undefined
  }

  return proxyUrl
}

/**
 * Get fetch options for the provider SDK with proxy and mTLS configuration
 * Returns fetch options with appropriate dispatcher for proxy and/or mTLS
 *
 * @param opts.forAnthropicAPI - Enables ANTHROPIC_UNIX_SOCKET tunneling. This
 *   env var is set by `agenc ssh` on the remote CLI to route API calls through
 *   an ssh -R forwarded unix socket to a local auth proxy. It MUST NOT leak
 *   into non-provider-API fetch paths (MCP HTTP/SSE transports, etc.) or those
 *   requests get misrouted to api.anthropic.com. Only the provider SDK client
 *   should pass `true` here.
 */
export function getProxyFetchOptions(opts: {
  forAnthropicAPI?: boolean
  environment: EnvLike
}): {
  tls?: TLSConfig
  dispatcher?: undici.Dispatcher
  proxy?: string
  unix?: string
  keepalive?: false
} {
  const base = keepAliveDisabled ? ({ keepalive: false } as const) : {}

  // ANTHROPIC_UNIX_SOCKET tunnels through the `agenc ssh` auth proxy, which
  // hardcodes the upstream to the provider API. Scope to the provider API
  // client so MCP/SSE/other callers don't get their requests misrouted.
  if (opts?.forAnthropicAPI) {
    const unixSocket = opts.environment.ANTHROPIC_UNIX_SOCKET
    if (unixSocket && typeof Bun !== 'undefined') {
      return { ...base, unix: unixSocket }
    }
  }

  const environment = opts.environment
  const proxyUrl = getProxyUrl(environment)

  // If we have a proxy, use the proxy agent (which includes mTLS config)
  if (proxyUrl) {
    if (typeof Bun !== 'undefined') {
      return { ...base, proxy: proxyUrl, ...getTLSFetchOptions(environment) }
    }
    return { ...base, dispatcher: getProxyAgent(proxyUrl, environment) }
  }

  // Otherwise, use a session-owned direct dispatcher. Returning no dispatcher
  // here would silently fall back to undici's process-global dispatcher, which
  // may have been configured by a different daemon client or test harness.
  if (typeof Bun !== 'undefined') {
    return { ...base, ...getTLSFetchOptions(environment) }
  }
  return { ...base, dispatcher: getDirectAgent(environment) }
}

function getDirectAgent(environment: EnvLike): undici.Dispatcher {
  const cached = directAgentsByEnvironment.get(environment)
  if (cached !== undefined) return cached

  const tlsDispatcher = getTLSFetchOptions(environment).dispatcher
  if (tlsDispatcher !== undefined) {
    directAgentsByEnvironment.set(environment, tlsDispatcher)
    return tlsDispatcher
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const agent = new (require('undici') as typeof undici).Agent({ pipelining: 1 })
  directAgentsByEnvironment.set(environment, agent)
  return agent
}

/**
 * Get AWS SDK client configuration with proxy support
 * Returns configuration object that can be spread into AWS service client constructors
 */
export async function getAWSClientProxyConfig(
  environment: EnvLike,
): Promise<object> {
  const proxyUrl = getProxyUrl(environment)

  if (!proxyUrl) {
    return {}
  }

  const [{ NodeHttpHandler }, credentialProviderNode] = await Promise.all([
    import('@smithy/node-http-handler'),
    import('@aws-sdk/credential-provider-node'),
  ])
  const { defaultProvider } = credentialProviderNode as {
    defaultProvider: (init?: {
      readonly clientConfig?: { readonly requestHandler?: unknown }
    }) => unknown
  }

  const agent = createHttpsProxyAgent(proxyUrl, {}, environment)
  const requestHandler = new NodeHttpHandler({
    httpAgent: agent,
    httpsAgent: agent,
  })

  return {
    requestHandler,
    credentials: defaultProvider({
      clientConfig: { requestHandler },
    }),
  }
}

/**
 * Clear proxy agent cache.
 */
export function clearProxyCache(): void {
  proxyAgentsByEnvironment = new WeakMap()
  directAgentsByEnvironment = new WeakMap()
  logForDebugging('Cleared proxy agent cache')
}
