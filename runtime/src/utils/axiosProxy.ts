import axios, { type AxiosInstance } from 'axios'
import type { HttpsProxyAgentOptions } from 'https-proxy-agent'
import { getMTLSAgent } from './mtls.js'
import {
  createHttpsProxyAgent,
  getNoProxy,
  getProxyUrl,
  shouldBypassProxy,
} from './proxy.js'

/**
 * Axios instance with its own proxy agent. Same NO_PROXY/mTLS/CA
 * resolution as the global interceptor, but agent options stay
 * scoped to this instance.
 */
export function createAxiosInstance(
  environment: Readonly<Record<string, string | undefined>>,
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
