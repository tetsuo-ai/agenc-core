import { isAbsolute } from 'node:path'
import { jsonStringify } from '../slowOperations.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getSecureStorageServiceName,
} from './macOsKeychainHelpers.js'
import type { HomeContext } from '../../config/home.js'
import type { SecureStorage, SecureStorageData } from './index.js'
import { decodeSecureStorageData } from './decode.js'
import {
  resolveBundledSecureStorageHelper,
  SECURE_STORAGE_HELPER_PAYLOAD_LIMIT_BYTES,
} from './nativeHelper.js'
import {
  runSecureStorageCommand,
  type SecureStorageCommandRunner,
} from './subprocess.js'

const LINUX_SECRET_SERVICE_HELPER = 'agenc-secret-service-helper'
const INJECTED_SECRET_SERVICE_HELPER =
  `/opt/agenc/runtime/${LINUX_SECRET_SERVICE_HELPER}`

/**
 * Linux native storage backed by exact Secret Service item operations.
 *
 * The bundled helper searches every collection and refuses duplicate exact
 * identities. It updates or deletes only the one item it inspected.
 */
export function createLinuxSecretStorage(
  home: HomeContext,
  runCommand: SecureStorageCommandRunner = runSecureStorageCommand,
  serviceNameOverride?: string,
  resolveExecutable?: () => string,
  accountNameOverride?: string,
): SecureStorage {
  const accountName = accountNameOverride ?? home.secureStorageAccount
  const serviceName = serviceNameOverride ??
    getSecureStorageServiceName(home, CREDENTIALS_SERVICE_SUFFIX)
  const resolveHelper = resolveExecutable ??
    (runCommand === runSecureStorageCommand
      ? () => resolveBundledSecureStorageHelper(LINUX_SECRET_SERVICE_HELPER)
      : () => INJECTED_SECRET_SERVICE_HELPER)
  let helperExecutable: string | undefined
  const getHelperExecutable = (): string => {
    helperExecutable ??= resolveHelper()
    if (!isAbsolute(helperExecutable)) {
      throw new Error(
        'Linux Secret Service helper resolver returned a relative path',
      )
    }
    return helperExecutable
  }

  const read = (): SecureStorageData | null => {
    let result
    try {
      result = runCommand(
        getHelperExecutable(),
        ['read', serviceName, accountName],
        { reject: false },
      )
    } catch (error) {
      throw new Error(
        `Secret Service lookup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    if (result.exitCode === 2 && !result.stderr?.trim()) {
      return null
    }
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr?.trim() ||
          `Secret Service lookup failed with exit code ${result.exitCode}`,
      )
    }
    if (!result.stdout?.trim()) {
      throw new Error('Secret Service returned an empty credential record')
    }
    return decodeSecureStorageData(result.stdout, 'Secret Service')
  }

  return {
    name: 'libsecret',
    read,
    readFresh: read,
    async readAsync(): Promise<SecureStorageData | null> {
      return read()
    },
    update(data: SecureStorageData): { success: boolean; warning?: string } {
      try {
        const payload = jsonStringify(data)
        const payloadBytes = Buffer.byteLength(payload, 'utf8')
        if (payloadBytes >= SECURE_STORAGE_HELPER_PAYLOAD_LIMIT_BYTES) {
          return {
            success: false,
            warning:
              `Secret Service credential payload is ${payloadBytes} bytes; ` +
              `records at or above ${SECURE_STORAGE_HELPER_PAYLOAD_LIMIT_BYTES} bytes are rejected`,
          }
        }
        const result = runCommand(
          getHelperExecutable(),
          ['write', serviceName, accountName],
          { input: payload, reject: false },
        )
        if (result.exitCode === 0) {
          return { success: true }
        }
        return {
          success: false,
          warning:
            result.stderr?.trim() ||
            `Secret Service update failed with exit code ${result.exitCode}`,
        }
      } catch (error) {
        return {
          success: false,
          warning:
            `Secret Service update could not start: ${
              error instanceof Error ? error.message : String(error)
            }`,
        }
      }
    },
    delete(): boolean {
      try {
        const result = runCommand(
          getHelperExecutable(),
          ['delete', serviceName, accountName],
          { reject: false },
        )
        return result.exitCode === 0 ||
          (result.exitCode === 2 && !result.stderr?.trim())
      } catch {
        return false
      }
    },
  }
}
