import {
  duplicateJsonObjectPaths,
  isPlainRecord,
} from '../../config/json.js'
import { jsonParse } from '../slowOperations.js'
import type { SecureStorageData } from './index.js'

/** Decode one shared native-vault blob without accepting corrupt emptiness. */
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
  return parsed as SecureStorageData
}
