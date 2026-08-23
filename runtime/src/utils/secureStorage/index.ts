import { createFallbackStorage } from './fallbackStorage.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { linuxSecretStorage } from './linuxSecretStorage.js'
import { windowsCredentialStorage } from './windowsCredentialStorage.js'
import { plainTextStorage } from './plainTextStorage.js'

export interface SecureStorageData {
  agenc?: {
    apiKey?: string
    accessToken: string
    refreshToken?: string
    idToken?: string
    accountId?: string
    profileId?: string
    lastRefreshAt?: number
    lastRefreshFailureAt?: number
  }
  /** AgenC AI subscription OAuth tokens (separate surface from the base API key blob). */
  agencAiOauth?: {
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    scopes?: string[]
    subscriptionType?: string | null
    rateLimitTier?: string | null
  }
  mcpOAuth?: Record<
    string,
    {
      serverName: string
      serverUrl: string
      accessToken: string
      refreshToken?: string
      expiresAt: number
      scope?: string
      clientId?: string
      clientSecret?: string
      discoveryState?: {
        authorizationServerUrl: string
        resourceMetadataUrl?: string
      }
      stepUpScope?: string
    }
  >
  mcpOAuthClientConfig?: Record<string, { clientSecret: string }>
  mcpXaaIdp?: Record<string, { idToken: string; expiresAt: number }>
  mcpXaaIdpConfig?: Record<string, { clientSecret: string }>
  trustedDeviceToken?: string
  pluginSecrets?: Record<string, Record<string, string>>
  /** OpenAI OAuth (Sign in with ChatGPT): the exchanged platform API
   * key plus the login tokens that produced it. */
  openAiOauth?: {
    /**
     * Exchanged platform API key. Only accounts belonging to an OpenAI
     * platform organization can mint one, so it is optional: a plain
     * ChatGPT subscription authenticates with `accessToken` +
     * `accountId` against the ChatGPT backend instead.
     */
    apiKey?: string
    /** 'apiKey' = platform key; 'chatgpt' = subscription tokens. */
    authMode?: 'apiKey' | 'chatgpt'
    accessToken?: string
    /** chatgpt_account_id, required alongside accessToken. */
    accountId?: string
    accountLabel?: string
    idToken?: string
    refreshToken?: string
    obtainedAt?: number
  }
  /** xAI OAuth (Sign in with X / Grok subscription) tokens. */
  xaiOauth?: {
    accessToken: string
    refreshToken?: string
    idToken?: string
    expiresAt?: number
    tokenEndpoint?: string
    accountLabel?: string
    lastRefreshAt?: number
    quarantinedAt?: number
    quarantineReason?: string
  }
}

export interface SecureStorage {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(): boolean
}

const unavailableSecureStorage: SecureStorage = {
  name: 'unavailable-secure-storage',
  read: () => null,
  readAsync: async () => null,
  update: () => ({
    success: false,
    warning:
      'Secure storage is unavailable on this platform without plaintext fallback.',
  }),
  delete: () => true,
}

/**
 * Get the appropriate secure storage implementation for the current platform.
 * Prefers native OS vaults (Keychain, libsecret, Credential Locker) with a plaintext fallback.
 */
export function getSecureStorage(options?: {
  allowPlainTextFallback?: boolean
}): SecureStorage {
  const allowPlainTextFallback = options?.allowPlainTextFallback ?? true

  if (process.platform === 'darwin') {
    return allowPlainTextFallback
      ? createFallbackStorage(macOsKeychainStorage, plainTextStorage)
      : macOsKeychainStorage
  }

  if (process.platform === 'linux') {
    return allowPlainTextFallback
      ? createFallbackStorage(linuxSecretStorage, plainTextStorage)
      : linuxSecretStorage
  }

  if (process.platform === 'win32') {
    return allowPlainTextFallback
      ? createFallbackStorage(windowsCredentialStorage, plainTextStorage)
      : windowsCredentialStorage
  }

  return allowPlainTextFallback ? plainTextStorage : unavailableSecureStorage
}
