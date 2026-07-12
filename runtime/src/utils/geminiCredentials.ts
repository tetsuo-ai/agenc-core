import { isBareMode, isEnvTruthy } from './envUtils.js'
import { getGeminiAuthMode } from './geminiAuth.js'
import { getSecureStorage } from './secureStorage/index.js'

export const GEMINI_TOKEN_STORAGE_KEY = 'gemini' as const
export const GEMINI_HYDRATED_ENV_MARKER =
  'AGENC_GEMINI_TOKEN_HYDRATED' as const

export type GeminiCredentialBlob = {
  accessToken: string
}

export function readGeminiAccessToken(): string | undefined {
  if (isBareMode()) return undefined
  try {
    const data = getSecureStorage().read() as
      | ({ gemini?: GeminiCredentialBlob } & Record<string, unknown>)
      | null
    const token = data?.gemini?.accessToken?.trim()
    return token || undefined
  } catch {
    return undefined
  }
}

export function hydrateGeminiAccessTokenFromSecureStorage(): void {
  if (!isEnvTruthy(process.env.AGENC_USE_GEMINI)) {
    return
  }
  const authMode = getGeminiAuthMode(process.env)
  if (authMode && authMode !== 'access-token') {
    return
  }
  // A user-provided env token always wins and is never overwritten. A token
  // that a previous hydration copied into the env (marker set) may be
  // refreshed from secure storage, so a rotated token does not stay stuck
  // in the daemon's process.env until restart.
  const envToken = process.env.GEMINI_ACCESS_TOKEN?.trim()
  const wasHydrated = process.env[GEMINI_HYDRATED_ENV_MARKER] === '1'
  if (envToken && !wasHydrated) {
    return
  }
  if (isBareMode()) {
    return
  }
  const token = readGeminiAccessToken()
  if (token) {
    process.env.GEMINI_ACCESS_TOKEN = token
    process.env[GEMINI_HYDRATED_ENV_MARKER] = '1'
  }
}

export function saveGeminiAccessToken(token: string): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }
  const trimmed = token.trim()
  if (!trimmed) {
    return { success: false, warning: 'Token is empty.' }
  }
  const secureStorage = getSecureStorage()
  const previous = secureStorage.read() || {}
  const next = {
    ...(previous as Record<string, unknown>),
    [GEMINI_TOKEN_STORAGE_KEY]: { accessToken: trimmed },
  }
  return secureStorage.update(next as typeof previous)
}

export function clearGeminiAccessToken(): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: true }
  }
  const secureStorage = getSecureStorage()
  const previous = secureStorage.read() || {}
  const next = { ...(previous as Record<string, unknown>) }
  delete next[GEMINI_TOKEN_STORAGE_KEY]
  return secureStorage.update(next as typeof previous)
}
