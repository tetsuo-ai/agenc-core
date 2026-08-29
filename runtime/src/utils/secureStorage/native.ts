import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { HomeContext } from '../../config/home.js'
import * as lockfile from '../lockfile.js'
import {
  getSecureStorage,
  type SecureStorageData,
} from './index.js'

const NATIVE_STORAGE_TRANSACTION_LOCK = '.secure-storage-transaction'

export class NativeSecureStorageError extends Error {
  readonly name = 'NativeSecureStorageError'
}

export interface NativeSecureStorageTransaction {
  readonly previous: Readonly<SecureStorageData>
  readonly written: Readonly<SecureStorageData>
}

function cloneSecureStorageData(
  data: Readonly<SecureStorageData>,
): SecureStorageData {
  return structuredClone(data)
}

function sameData(
  left: Readonly<SecureStorageData>,
  right: Readonly<SecureStorageData>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function readStorageOrThrow(
  storage: ReturnType<typeof getSecureStorage>,
  failureMessage: string,
  fresh = false,
): SecureStorageData {
  try {
    const data = fresh && storage.readFresh !== undefined
      ? storage.readFresh()
      : storage.read()
    return cloneSecureStorageData(data ?? {})
  } catch (error) {
    throw new NativeSecureStorageError(
      `${failureMessage}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function withNativeStorageLock<T>(
  home: HomeContext,
  operation: () => T,
): T {
  mkdirSync(home.path, { recursive: true, mode: 0o700 })
  const target = join(home.path, NATIVE_STORAGE_TRANSACTION_LOCK)
  const release = lockfile.lockSync(target, {
    lockfilePath: `${target}.lock`,
    realpath: false,
  })
  try {
    return operation()
  } finally {
    release()
  }
}

/**
 * Read the native secure storage. This deliberately disables the
 * plaintext fallback. A null result means no credential record is present;
 * availability is proven by a successful update when a write is requested.
 */
export function readNativeSecureStorage(
  home: HomeContext,
): SecureStorageData {
  return readStorageOrThrow(
    getSecureStorage(home),
    'Native secure storage read failed',
  )
}

/** Fresh locked read for destructive migration preconditions. */
export function readNativeSecureStorageFresh(
  home: HomeContext,
): SecureStorageData {
  return withNativeStorageLock(home, () =>
    readStorageOrThrow(
      getSecureStorage(home),
      'Native secure storage fresh read failed',
      true,
    )
  )
}

/** Native secure-storage read exposed through the async adapter contract. */
export async function readNativeSecureStorageAsync(
  home: HomeContext,
): Promise<SecureStorageData> {
  try {
    return cloneSecureStorageData(
      (await getSecureStorage(home).readAsync()) ?? {},
    )
  } catch (error) {
    throw new NativeSecureStorageError(
      `Native secure storage read failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Serialize read-modify-write operations across AgenC processes so one
 * credential namespace cannot overwrite another in the shared native secure storage
 * blob. Returns null when the mutation is a no-op.
 */
export function updateNativeSecureStorage(
  home: HomeContext,
  updater: (
    current: Readonly<SecureStorageData>,
  ) => SecureStorageData,
  unavailableMessage: string,
): NativeSecureStorageTransaction | null {
  return withNativeStorageLock(home, () => {
    const storage = getSecureStorage(home)
    const previous = readStorageOrThrow(storage, unavailableMessage, true)
    const written = cloneSecureStorageData(updater(previous))
    if (sameData(previous, written)) return null

    const result = storage.update(written)
    if (!result.success) {
      throw new NativeSecureStorageError(result.warning ?? unavailableMessage)
    }
    const verified = readStorageOrThrow(storage, unavailableMessage, true)
    if (!sameData(verified, written)) {
      throw new NativeSecureStorageError(
        `${unavailableMessage} Native secure storage did not persist the complete shared credential record.`,
      )
    }
    return Object.freeze({
      previous: Object.freeze(previous),
      written: Object.freeze(written),
    })
  })
}

/**
 * Migration-only replacement for a Windows DPAPI file that exists at the
 * canonical path but is encrypted with the retired account-derived entropy.
 * The caller must hold the retired-source authority lock and has already
 * verified/decrypted the old record. No ordinary runtime path may use this to
 * bypass the fail-closed read-before-write contract.
 */
export function replaceUnreadableNativeSecureStorageForMigration(
  home: HomeContext,
  replacement: Readonly<SecureStorageData>,
  unavailableMessage: string,
): NativeSecureStorageTransaction {
  return withNativeStorageLock(home, () => {
    const storage = getSecureStorage(home)
    const written = cloneSecureStorageData(replacement)
    const result = storage.update(written)
    if (!result.success) {
      throw new NativeSecureStorageError(result.warning ?? unavailableMessage)
    }
    const verified = readStorageOrThrow(storage, unavailableMessage, true)
    if (!sameData(verified, written)) {
      throw new NativeSecureStorageError(
        `${unavailableMessage} Native secure storage did not persist the complete replacement credential record.`,
      )
    }
    return Object.freeze({
      previous: Object.freeze({}),
      written: Object.freeze(written),
    })
  })
}

/**
 * Compensate a state-write failure without clobbering unrelated credentials.
 * The caller restores only its namespace and must verify that namespace still
 * equals the value it wrote; a concurrent change is an explicit conflict.
 */
export function rollbackNativeSecureStorage(
  home: HomeContext,
  transaction: NativeSecureStorageTransaction | null,
  updater: (
    current: Readonly<SecureStorageData>,
    transaction: NativeSecureStorageTransaction,
  ) => SecureStorageData,
  failureMessage: string,
): void {
  if (transaction === null) return
  withNativeStorageLock(home, () => {
    const storage = getSecureStorage(home)
    const current = readStorageOrThrow(storage, failureMessage, true)
    const restored = cloneSecureStorageData(updater(current, transaction))
    const result = storage.update(restored)
    if (!result.success) {
      throw new NativeSecureStorageError(result.warning ?? failureMessage)
    }
    const verified = readStorageOrThrow(storage, failureMessage, true)
    if (!sameData(verified, restored)) {
      throw new NativeSecureStorageError(
        `${failureMessage} Native secure storage rollback could not be verified.`,
      )
    }
  })
}
