import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import {
  readRemoteRuntimeCredential,
  storeRemoteRuntimeCredential,
  type RemoteRuntimeCredentialName,
} from './secureStorage/remoteRuntimeCredentials.js'
import type { HomeContext } from '../config/home.js'
import { secureStorageIdentityKey } from './secureStorage/home.js'

type DescriptorEnvironment = Readonly<Record<string, string | undefined>>

// Descriptors may be one-shot streams. Cache only successful reads and bind
// them to both the native secure storage home and descriptor identity; native secure storage
// reads remain live so another session/process update is immediately visible.
const descriptorCredentialCache = new Map<string, string>()

function getCredentialFromFd({
  home,
  environment,
  envVar,
  storageName,
  label,
}: {
  home: HomeContext
  environment: DescriptorEnvironment
  envVar: string
  storageName: RemoteRuntimeCredentialName
  label: string
}): string | null {
  const fdEnv = environment[envVar]?.trim()
  if (!fdEnv) {
    return readRemoteRuntimeCredential(home, storageName)
  }

  const cacheKey = `${secureStorageIdentityKey(home)}\0${storageName}\0${fdEnv}`
  const cached = descriptorCredentialCache.get(cacheKey)
  if (cached !== undefined) return cached

  const fd = parseInt(fdEnv, 10)
  if (Number.isNaN(fd)) {
    logForDebugging(
      `${envVar} must be a valid file descriptor number, got: ${fdEnv}`,
      { level: 'error' },
    )
    return null
  }

  try {
    // Use /dev/fd on macOS/BSD, /proc/self/fd on Linux
    const fsOps = getFsImplementation()
    const fdPath =
      process.platform === 'darwin' || process.platform === 'freebsd'
        ? `/dev/fd/${fd}`
        : `/proc/self/fd/${fd}`

    // eslint-disable-next-line custom-rules/no-sync-fs -- compatibility FD path, read once at startup, caller is sync
    const token = fsOps.readFileSync(fdPath, { encoding: 'utf8' }).trim()
    if (!token) {
      logForDebugging(`File descriptor contained empty ${label}`, {
        level: 'error',
      })
      return null
    }
    logForDebugging(`Successfully read ${label} from file descriptor ${fd}`)
    descriptorCredentialCache.set(cacheKey, token)
    try {
      storeRemoteRuntimeCredential(home, storageName, token)
    } catch (error) {
      logForDebugging(
        `Failed to persist ${label} in native secure storage: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
    return token
  } catch (error) {
    logForDebugging(
      `Failed to read ${label} from file descriptor ${fd}: ${errorMessage(error)}`,
      { level: 'error' },
    )
    // A subprocess may inherit the descriptor number without inheriting the
    // descriptor itself. The native secure storage is the only persisted fallback.
    const persisted = readRemoteRuntimeCredential(home, storageName)
    return persisted
  }
}

/**
 * Get the CCR-injected OAuth token. The descriptor is the explicit transient
 * source; the home-scoped native secure storage is the only persisted source.
 */
export function getOAuthTokenFromFileDescriptor(
  home: HomeContext,
  environment: DescriptorEnvironment,
): string | null {
  return getCredentialFromFd({
    home,
    environment,
    envVar: 'AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR',
    storageName: 'oauthToken',
    label: 'OAuth token',
  })
}

/**
 * Get the CCR-injected API key. The descriptor is the explicit transient
 * source; the home-scoped native secure storage is the only persisted source.
 */
export function getApiKeyFromFileDescriptor(
  home: HomeContext,
  environment: DescriptorEnvironment,
): string | null {
  return getCredentialFromFd({
    home,
    environment,
    envVar: 'AGENC_API_KEY_FILE_DESCRIPTOR',
    storageName: 'apiKey',
    label: 'API key',
  })
}
