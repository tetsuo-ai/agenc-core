import type { HomeContext } from '../config/home.js'
import type { SecureStorageData } from './secureStorage/index.js'
import {
  readNativeSecureStorage,
  readNativeSecureStorageAsync,
  updateNativeSecureStorage,
} from './secureStorage/native.js'
import { secureStorageIdentityKey } from './secureStorage/home.js'
import { exchangeForCopilotToken } from '../services/github/deviceFlow.js'
import { getSelectedProviderName } from './model/providers.js'

/** JSON key in the shared AgenC secure storage blob. */
export const GITHUB_MODELS_STORAGE_KEY = 'githubModels' as const
export type GithubModelsCredentialBlob = {
  accessToken: string
  oauthAccessToken?: string
}

type GithubTokenStatus = 'valid' | 'expired' | 'invalid_format'

function checkGithubTokenStatus(token: string): GithubTokenStatus {
  const expMatch = token.match(/exp=(\d+)/)
  if (expMatch) {
    const expSeconds = Number(expMatch[1])
    if (!Number.isNaN(expSeconds)) {
      return Date.now() >= expSeconds * 1000 ? 'expired' : 'valid'
    }
  }

  const parts = token.split('.')
  const looksLikeJwt =
    parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))
  if (looksLikeJwt) {
    try {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
      const json = Buffer.from(padded, 'base64').toString('utf8')
      const parsed = JSON.parse(json)
      if (parsed && typeof parsed === 'object' && parsed.exp) {
        return Date.now() >= (parsed.exp as number) * 1000 ? 'expired' : 'valid'
      }
    } catch {
      return 'invalid_format'
    }
  }

  return 'invalid_format'
}

export function readGithubModelsToken(home: HomeContext): string | undefined {
  try {
    const data = readNativeSecureStorage(home)
    const t = data?.githubModels?.accessToken?.trim()
    return t || undefined
  } catch {
    return undefined
  }
}

export async function readGithubModelsTokenAsync(
  home: HomeContext,
): Promise<string | undefined> {
  try {
    const data = await readNativeSecureStorageAsync(home)
    const t = data?.githubModels?.accessToken?.trim()
    return t || undefined
  } catch {
    return undefined
  }
}

/**
 * Startup auto-refresh for GitHub Models mode.
 *
 * If a stored Copilot token is expired/invalid and an OAuth token is present,
 * exchange the OAuth token for a fresh Copilot token and persist it.
 */
const refreshByHome = new Map<string, Promise<boolean>>()

export function refreshGithubModelsTokenIfNeeded(
  home: HomeContext,
): Promise<boolean> {
  const storageIdentity = secureStorageIdentityKey(home)
  const existing = refreshByHome.get(storageIdentity)
  if (existing) return existing
  const pending = refreshGithubModelsTokenIfNeededImpl(home).finally(() => {
    if (refreshByHome.get(storageIdentity) === pending) {
      refreshByHome.delete(storageIdentity)
    }
  })
  refreshByHome.set(storageIdentity, pending)
  return pending
}

async function refreshGithubModelsTokenIfNeededImpl(
  home: HomeContext,
): Promise<boolean> {
  if (getSelectedProviderName() !== 'github') {
    return false
  }

  try {
    const data = await readNativeSecureStorageAsync(home)
    const blob = normalizedGithubBlob(data.githubModels)
    const accessToken = blob?.accessToken?.trim() || ''
    const oauthToken = blob?.oauthAccessToken?.trim() || ''

    if (!accessToken && !oauthToken) {
      return false
    }

    const status = accessToken ? checkGithubTokenStatus(accessToken) : 'expired'
    if (status === 'valid') {
      return false
    }

    if (!oauthToken) {
      return false
    }

    const refreshed = await exchangeForCopilotToken(oauthToken)
    let conflict = false
    updateNativeSecureStorage(
      home,
      current => {
        const latest = normalizedGithubBlob(current.githubModels)
        if (!sameGithubBlob(latest, blob)) {
          conflict = true
          return structuredClone(current) as SecureStorageData
        }
        return {
          ...current,
          githubModels: {
            accessToken: refreshed.token.trim(),
            oauthAccessToken: oauthToken,
          },
        }
      },
      'Native secure storage is unavailable; the refreshed GitHub Models token was not saved.',
    )
    return !conflict
  } catch {
    return false
  }
}

export function saveGithubModelsToken(
  home: HomeContext,
  token: string,
  oauthToken?: string,
): {
  success: boolean
  warning?: string
} {
  const trimmed = token.trim()
  if (!trimmed) {
    return { success: false, warning: 'Token is empty.' }
  }
  const oauthTrimmed = oauthToken?.trim()
  try {
    updateNativeSecureStorage(
      home,
      current => {
        const previous = normalizedGithubBlob(current.githubModels)
        const preservedOauth = oauthTrimmed ?? previous?.oauthAccessToken
        return {
          ...current,
          [GITHUB_MODELS_STORAGE_KEY]: {
            accessToken: trimmed,
            ...(preservedOauth ? { oauthAccessToken: preservedOauth } : {}),
          },
        }
      },
      'Native secure storage is unavailable; the GitHub Models token was not saved.',
    )
    return { success: true }
  } catch (error) {
    return nativeFailure(error, 'GitHub Models token save failed.')
  }
}

export function clearGithubModelsToken(
  home: HomeContext,
): { success: boolean; warning?: string } {
  try {
    updateNativeSecureStorage(
      home,
      current => {
        const next = { ...current }
        delete next[GITHUB_MODELS_STORAGE_KEY]
        return next
      },
      'Native secure storage is unavailable; the GitHub Models token was not cleared.',
    )
    return { success: true }
  } catch (error) {
    return nativeFailure(error, 'GitHub Models token clear failed.')
  }
}

function normalizedGithubBlob(
  value: GithubModelsCredentialBlob | undefined,
): GithubModelsCredentialBlob | undefined {
  const accessToken = value?.accessToken?.trim()
  if (!accessToken) return undefined
  const oauthAccessToken = value?.oauthAccessToken?.trim()
  return {
    accessToken,
    ...(oauthAccessToken ? { oauthAccessToken } : {}),
  }
}

function sameGithubBlob(
  left: GithubModelsCredentialBlob | undefined,
  right: GithubModelsCredentialBlob | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function nativeFailure(error: unknown, fallback: string): {
  success: false
  warning: string
} {
  return {
    success: false,
    warning: error instanceof Error ? error.message : fallback,
  }
}
