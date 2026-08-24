import { isBareMode } from './envUtils.js'
import type { HomeContext } from '../config/home.js'
import {
  readNativeSecureStorage,
  updateNativeSecureStorage,
} from './secureStorage/native.js'

export const GEMINI_TOKEN_STORAGE_KEY = 'gemini' as const
export type GeminiCredentialBlob = {
  accessToken: string
}

export function readGeminiAccessToken(home: HomeContext): string | undefined {
  if (isBareMode()) return undefined
  try {
    const data = readNativeSecureStorage(home)
    const token = data?.gemini?.accessToken?.trim()
    return token || undefined
  } catch {
    return undefined
  }
}

export function saveGeminiAccessToken(home: HomeContext, token: string): {
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
  try {
    updateNativeSecureStorage(
      home,
      current => ({
        ...current,
        [GEMINI_TOKEN_STORAGE_KEY]: { accessToken: trimmed },
      }),
      'Native secure storage is unavailable; the Gemini token was not saved.',
    )
    return { success: true }
  } catch (error) {
    return {
      success: false,
      warning: error instanceof Error ? error.message : 'Gemini token save failed.',
    }
  }
}

export function clearGeminiAccessToken(home: HomeContext): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: true }
  }
  try {
    updateNativeSecureStorage(
      home,
      current => {
        const next = { ...current }
        delete next[GEMINI_TOKEN_STORAGE_KEY]
        return next
      },
      'Native secure storage is unavailable; the Gemini token was not cleared.',
    )
    return { success: true }
  } catch (error) {
    return {
      success: false,
      warning: error instanceof Error ? error.message : 'Gemini token clear failed.',
    }
  }
}
