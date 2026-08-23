/**
 * Storage for the ChatGPT sign-in: the RFC 8693-exchanged platform API
 * key (long-lived — the thing the runtime actually consumes) plus the
 * login tokens that produced it. Modeled on xaiOauthCredentials, minus
 * the refresh machinery the exchanged key does not need.
 */

import { getSecureStorage, type SecureStorageData } from './secureStorage/index.js'
import { isBareMode } from './envUtils.js'

export const OPENAI_OAUTH_STORAGE_KEY = 'openAiOauth' as const

export type OpenAiOauthCredentialBlob = NonNullable<
  SecureStorageData[typeof OPENAI_OAUTH_STORAGE_KEY]
>

const READ_CACHE_TTL_MS = 30_000
let readCache: { at: number; blob: OpenAiOauthCredentialBlob | undefined } | null =
  null

export function readOpenAiOauthCredentials(): OpenAiOauthCredentialBlob | undefined {
  if (isBareMode()) return undefined
  if (readCache !== null && Date.now() - readCache.at < READ_CACHE_TTL_MS) {
    return readCache.blob
  }
  const data = getSecureStorage().read()
  const blob = data?.[OPENAI_OAUTH_STORAGE_KEY]
  readCache = { at: Date.now(), blob }
  return blob
}

/** The exchanged platform API key, when signed in. */
export function readOpenAiOauthApiKey(): string | undefined {
  const blob = readOpenAiOauthCredentials()
  const key = blob?.apiKey?.trim()
  return key !== undefined && key.length > 0 ? key : undefined
}

export function saveOpenAiOauthCredentials(
  blob: OpenAiOauthCredentialBlob,
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }
  if (!blob.apiKey?.trim()) {
    return { success: false, warning: 'API key is empty.' }
  }
  const secureStorage = getSecureStorage()
  const prev = secureStorage.read() ?? {}
  const result = secureStorage.update({
    ...prev,
    [OPENAI_OAUTH_STORAGE_KEY]: blob,
  })
  if (result.success) {
    readCache = { at: Date.now(), blob }
  }
  return result
}

export function clearOpenAiOauthCredentials(): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) return { success: true }
  const secureStorage = getSecureStorage()
  const prev = secureStorage.read() ?? {}
  const next = { ...prev }
  delete next[OPENAI_OAUTH_STORAGE_KEY]
  const result = secureStorage.update(next)
  if (result.success) {
    readCache = { at: Date.now(), blob: undefined }
  }
  return result
}
