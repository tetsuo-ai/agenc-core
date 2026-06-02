import { chmodSync } from 'fs'
import { join } from 'path'
import { getAgenCConfigHomeDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../slowOperations.js'
import type { SecureStorage, SecureStorageData } from './index.js'

function getStoragePath(): { storageDir: string; storagePath: string } {
  const storageDir = getAgenCConfigHomeDir()
  const storageFileName = '.credentials.json'
  return { storageDir, storagePath: join(storageDir, storageFileName) }
}

export const plainTextStorage = {
  name: 'plaintext',
  read(): SecureStorageData | null {
    // sync IO: called from sync context (SecureStorage interface)
    const { storagePath } = getStoragePath()
    try {
      const data = getFsImplementation().readFileSync(storagePath, {
        encoding: 'utf8',
      })
      return jsonParse(data)
    } catch {
      return null
    }
  },
  async readAsync(): Promise<SecureStorageData | null> {
    const { storagePath } = getStoragePath()
    try {
      const data = await getFsImplementation().readFile(storagePath, {
        encoding: 'utf8',
      })
      return jsonParse(data)
    } catch {
      return null
    }
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    // sync IO: called from sync context (SecureStorage interface)
    try {
      const { storageDir, storagePath } = getStoragePath()
      try {
        // gaphunt3 #24: create the config dir with 0o700 so the credentials
        // file is never exposed via a world/group-readable parent directory.
        getFsImplementation().mkdirSync(storageDir, { mode: 0o700 })
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code !== 'EEXIST') {
          throw e
        }
      }

      // gaphunt3 #24: if the file already exists, tighten its mode to 0o600
      // BEFORE writing — otherwise an existing world/group-readable file would
      // stay exposed for the duration of the write (the open 'w' below reuses
      // the existing inode's permissions and does not re-apply `mode`).
      try {
        chmodSync(storagePath, 0o600)
      } catch (e: unknown) {
        if (getErrnoCode(e) !== 'ENOENT') {
          throw e
        }
      }

      // gaphunt3 #24: create the file atomically with restrictive perms via
      // openSync(path, 'w', 0o600) (the flush:true path honors `mode`), so the
      // plaintext secrets are never created world/group-readable in the window
      // before the post-write chmod.
      writeFileSync_DEPRECATED(storagePath, jsonStringify(data), {
        encoding: 'utf8',
        flush: true,
        mode: 0o600,
      })
      chmodSync(storagePath, 0o600)
      return {
        success: true,
        warning: 'Warning: Storing credentials in plaintext.',
      }
    } catch {
      return { success: false }
    }
  },
  delete(): boolean {
    // sync IO: called from sync context (SecureStorage interface)
    const { storagePath } = getStoragePath()
    try {
      getFsImplementation().unlinkSync(storagePath)
      return true
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        return true
      }
      return false
    }
  },
} satisfies SecureStorage
