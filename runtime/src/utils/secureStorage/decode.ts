import {
  duplicateJsonObjectPaths,
  isPlainRecord,
} from '../../config/json.js'
import { jsonParse } from '../slowOperations.js'
import type { SecureStorageData } from './index.js'

/** Decode one shared native secure storage blob without accepting corrupt emptiness. */
export function decodeSecureStorageData(
  text: string,
  backendLabel: string,
): SecureStorageData {
  const duplicates = duplicateJsonObjectPaths(text)
  if (duplicates.length > 0) {
    throw new Error(
      `${backendLabel} credential record contains duplicate object keys: ${duplicates.join(', ')}`,
    )
  }
  let parsed: unknown
  try {
    parsed = jsonParse(text)
  } catch (error) {
    throw new Error(
      `${backendLabel} credential record is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isPlainRecord(parsed)) {
    throw new Error(
      `${backendLabel} credential record must be a non-null JSON object`,
    )
  }
  const mcpOAuth = parsed.mcpOAuth
  if (!isPlainRecord(mcpOAuth)) return parsed as SecureStorageData

  let changed = false
  const normalizedMcpOAuth = Object.fromEntries(
    Object.entries(mcpOAuth).map(([serverKey, value]) => {
      if (!isPlainRecord(value) || !Object.hasOwn(value, 'stepUpScope')) {
        return [serverKey, value]
      }
      const normalized = { ...value }
      delete normalized.stepUpScope
      changed = true
      return [serverKey, normalized]
    }),
  )
  return (changed
    ? { ...parsed, mcpOAuth: normalizedMcpOAuth }
    : parsed) as SecureStorageData
}
