import {
  readRemoteRuntimeCredential,
  storeRemoteRuntimeCredential,
} from './secureStorage/remoteRuntimeCredentials.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import type { HomeContext } from '../config/home.js'
import { secureStorageIdentityKey } from './secureStorage/home.js'

type SessionIngressEnvironment = Readonly<Record<string, string | undefined>>
const descriptorTokenCache = new Map<string, string>()

/**
 * Read token via file descriptor, falling back to native secure storage.
 * Successful one-shot descriptor reads are isolated by home and descriptor.
 */
function getTokenFromFileDescriptor(
  home: HomeContext,
  environment: SessionIngressEnvironment,
): string | null {
  const fdEnv = environment.AGENC_WEBSOCKET_AUTH_FILE_DESCRIPTOR?.trim()
  if (!fdEnv) {
    return readRemoteRuntimeCredential(home, 'sessionIngressToken')
  }

  const cacheKey = `${secureStorageIdentityKey(home)}\0${fdEnv}`
  const cachedToken = descriptorTokenCache.get(cacheKey)
  if (cachedToken !== undefined) return cachedToken

  const fd = parseInt(fdEnv, 10)
  if (Number.isNaN(fd)) {
    logForDebugging(
      `AGENC_WEBSOCKET_AUTH_FILE_DESCRIPTOR must be a valid file descriptor number, got: ${fdEnv}`,
      { level: 'error' },
    )
    return null
  }

  try {
    // Read from the file descriptor
    // Use /dev/fd on macOS/BSD, /proc/self/fd on Linux
    const fsOps = getFsImplementation()
    const fdPath =
      process.platform === 'darwin' || process.platform === 'freebsd'
        ? `/dev/fd/${fd}`
        : `/proc/self/fd/${fd}`

    const token = fsOps.readFileSync(fdPath, { encoding: 'utf8' }).trim()
    if (!token) {
      logForDebugging('File descriptor contained empty token', {
        level: 'error',
      })
      return null
    }
    logForDebugging(`Successfully read token from file descriptor ${fd}`)
    descriptorTokenCache.set(cacheKey, token)
    try {
      storeRemoteRuntimeCredential(home, 'sessionIngressToken', token)
    } catch (error) {
      logForDebugging(
        `Failed to persist session ingress token in native secure storage: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
    return token
  } catch (error) {
    logForDebugging(
      `Failed to read token from file descriptor ${fd}: ${errorMessage(error)}`,
      { level: 'error' },
    )
    return readRemoteRuntimeCredential(home, 'sessionIngressToken')
  }
}

/**
 * Get session ingress authentication token.
 *
 * Priority order:
 *  1. Environment variable (AGENC_SESSION_ACCESS_TOKEN) — set at spawn time,
 *     updated in-process via updateSessionIngressAuthToken or
 *     update_environment_variables stdin message from the parent bridge process.
 *  2. File descriptor — AGENC_WEBSOCKET_AUTH_FILE_DESCRIPTOR, read once and
 *     cached.
 *  3. The home-scoped native secure storage credential. This covers subprocesses that
 *     cannot inherit the descriptor without creating a plaintext fallback.
 */
export function getSessionIngressAuthToken(
  home: HomeContext,
  environment: SessionIngressEnvironment,
): string | null {
  // 1. Check environment variable
  const envToken = environment.AGENC_SESSION_ACCESS_TOKEN
  if (envToken) {
    return envToken
  }

  // 2. Check file descriptor, then the native secure storage fallback.
  return getTokenFromFileDescriptor(home, environment)
}

/**
 * Build auth headers for the current session token.
 * Session keys (sk-ant-sid) use Cookie auth + X-Organization-Uuid;
 * JWTs use Bearer auth.
 */
export function getSessionIngressAuthHeaders(
  home: HomeContext,
  environment: SessionIngressEnvironment,
): Record<string, string> {
  const token = getSessionIngressAuthToken(home, environment)
  if (!token) return {}
  if (token.startsWith('sk-ant-sid')) {
    const headers: Record<string, string> = {
      Cookie: `sessionKey=${token}`,
    }
    const orgUuid = environment.AGENC_ORGANIZATION_UUID
    if (orgUuid) {
      headers['X-Organization-Uuid'] = orgUuid
    }
    return headers
  }
  return { Authorization: `Bearer ${token}` }
}

/**
 * Update the home-scoped native continuity credential. Provider/session
 * environment snapshots remain immutable after ingress.
 */
export function updateSessionIngressAuthToken(
  home: HomeContext,
  token: string,
): void {
  storeRemoteRuntimeCredential(home, 'sessionIngressToken', token)
}
