import type { HomeContext } from '../../config/home.js'
import { createMacOsKeychainStorage } from './macOsKeychainStorage.js'
import { createLinuxSecretStorage } from './linuxSecretStorage.js'
import { createWindowsCredentialStorage } from './windowsCredentialStorage.js'

/** Account identity and role metadata associated with the stored OAuth tokens. */
export interface OAuthAccountMetadata {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
  organizationName?: string | null
  organizationRole?: string | null
  workspaceRole?: string | null
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: unknown | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}

/** Browser-extension pairing identity. It is credential-adjacent, not UI state. */
export interface ChromePairingIdentity {
  pairedDeviceId: string
  pairedDeviceName: string
}

/** Content hashes recording explicit approval/rejection of ambient API keys. */
export interface ApiKeyApprovalState {
  approved?: string[]
  rejected?: string[]
}

/** Local-login and provider BYOK secrets owned by `auth/backends/local`. */
export interface LocalAuthSecureStorage {
  login?: {
    token: string
    createdAt: string
  }
  byokKeys?: Record<
    string,
    {
      provider: string
      apiKey: string
      savedAt: string
    }
  >
}

/** Remote bearer owned by `auth/backends/remote`. */
export interface RemoteAuthSecureStorage {
  bearerToken: string
  createdAt: string
}

/** Credentials injected into remote runtime/CCR processes and their children. */
export interface RemoteRuntimeAuthSecureStorage {
  oauthToken?: string
  apiKey?: string
  sessionIngressToken?: string
}

/** Channel and surface credentials owned by the standalone gateway process. */
export interface GatewaySecureStorage {
  readonly environment?: Readonly<Record<string, string>>
  readonly generatedTokens?: {
    readonly hooks?: string
    readonly webchat?: string
  }
}

export interface SecureStorageData {
  /** Primary API key used by the local auth facade. */
  primaryApiKey?: string
  oauthAccountMetadata?: OAuthAccountMetadata
  chromePairingIdentity?: ChromePairingIdentity
  apiKeyApprovals?: ApiKeyApprovalState
  localAuth?: LocalAuthSecureStorage
  remoteAuth?: RemoteAuthSecureStorage
  remoteRuntimeAuth?: RemoteRuntimeAuthSecureStorage
  gateway?: GatewaySecureStorage
  githubModels?: {
    accessToken: string
    oauthAccessToken?: string
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
    lastRefreshAt?: number
    lastRefreshFailureAt?: number
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
  /**
   * Return null only when the backend authoritatively proves that no record
   * exists. Backend, decrypt, and parse failures must throw so a shared-blob
   * read-modify-write can never mistake unreadable secure storage for empty storage.
  */
  read(): SecureStorageData | null
  /** Bypass any process-local cache for a locked read-modify-write. */
  readonly readFresh?: () => SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(): boolean
}

/** Exact native secure storage identity used only by the explicit migration command. */
export interface SecureStorageMigrationIdentity {
  readonly serviceName: string
  readonly accountName: string
  readonly homePath: string
}

const unavailableSecureStorage: SecureStorage = {
  name: 'unavailable-secure-storage',
  read: () => {
    throw new Error('Native secure storage is unavailable on this platform')
  },
  readAsync: async () => {
    throw new Error('Native secure storage is unavailable on this platform')
  },
  update: () => ({
    success: false,
    warning:
      'Secure storage is unavailable on this platform without plaintext fallback.',
  }),
  delete: () => true,
}

/**
 * Get the native secure storage implementation for the current platform.
 * AgenC never falls back to a plaintext credential file during ordinary
 * runtime operation.
 */
export function getSecureStorage(
  home: HomeContext,
): SecureStorage {
  if (process.platform === 'darwin') {
    return createMacOsKeychainStorage(home)
  }

  if (process.platform === 'linux') {
    return createLinuxSecretStorage(home)
  }

  if (process.platform === 'win32') {
    return createWindowsCredentialStorage(home)
  }

  return unavailableSecureStorage
}

/**
 * Open a specifically identified retired native secure storage namespace. Ordinary
 * runtime code must use getSecureStorage(home); this escape hatch exists only
 * so `agenc config migrate` can perform a checked, one-way namespace cutover.
 */
export function getSecureStorageForMigration(
  home: HomeContext,
  identity: SecureStorageMigrationIdentity,
): SecureStorage {
  if (process.platform === 'darwin') {
    return createMacOsKeychainStorage(
      home,
      undefined,
      identity.serviceName,
      true,
      identity.accountName,
    )
  }
  if (process.platform === 'linux') {
    return createLinuxSecretStorage(
      home,
      undefined,
      identity.serviceName,
      undefined,
      identity.accountName,
    )
  }
  if (process.platform === 'win32') {
    return createWindowsCredentialStorage(home, undefined, identity)
  }
  return unavailableSecureStorage
}
