import {
  accessSync,
  constants as fsConstants,
  lstatSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SECURE_STORAGE_HELPER_PAYLOAD_LIMIT_BYTES = 16 * 1024 * 1024

/** Resolve an executable shipped beside the bundled runtime entrypoint. */
export function resolveBundledSecureStorageHelper(
  executableName: string,
): string {
  if (!/^[a-z0-9._-]+$/u.test(executableName)) {
    throw new Error('Invalid bundled secure-storage helper name')
  }

  const candidate = join(dirname(fileURLToPath(import.meta.url)), executableName)
  if (!isAbsolute(candidate)) {
    throw new Error('Bundled secure-storage helper resolved to a relative path')
  }

  try {
    const metadata = lstatSync(candidate)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('helper is not a regular non-symbolic-link file')
    }
    accessSync(candidate, fsConstants.X_OK)
  } catch (error) {
    throw new Error(
      `Bundled secure-storage helper is missing or not executable at ${candidate}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  return candidate
}
