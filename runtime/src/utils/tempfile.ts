import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { resolveSessionTempRoot } from '../session/runtime-options.js'

const TEMP_PREFIX_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u
const TEMP_EXTENSION_PATTERN = /^\.[a-zA-Z0-9][a-zA-Z0-9._-]*$/u

export interface PrivateTempFileArtifact {
  readonly directory: string
  readonly path: string
  dispose(): void
}

export interface CreatePrivateTempFileOptions {
  readonly content: string
  readonly prefix?: string
  readonly extension?: string
  readonly flush?: boolean
}

/**
 * Create a session-owned temporary file without exposing a writable path race.
 *
 * The containing directory is unique and private (0700), and the file is
 * opened exclusively at 0600 before any content is written. Disposing the
 * artifact removes that exact directory and everything created inside it.
 */
export function createPrivateTempFile(
  options: CreatePrivateTempFileOptions,
): PrivateTempFileArtifact {
  const prefix = options.prefix ?? 'agenc-prompt'
  const extension = options.extension ?? '.md'
  if (!TEMP_PREFIX_PATTERN.test(prefix)) {
    throw new TypeError('temporary-file prefix contains unsupported characters')
  }
  if (!TEMP_EXTENSION_PATTERN.test(extension)) {
    throw new TypeError(
      'temporary-file extension contains unsupported characters',
    )
  }

  const directory = mkdtempSync(join(resolveSessionTempRoot(), `${prefix}-`))
  let fd: number | undefined
  try {
    chmodSync(directory, 0o700)
    const path = join(directory, `content${extension}`)
    fd = openSync(path, 'wx', 0o600)
    chmodSync(path, 0o600)
    writeFileSync(fd, options.content, { encoding: 'utf8' })
    if (options.flush === true) fsyncSync(fd)
    closeSync(fd)
    fd = undefined

    let disposed = false
    return Object.freeze({
      directory,
      path,
      dispose(): void {
        if (disposed) return
        rmSync(directory, { recursive: true, force: true })
        disposed = true
      },
    })
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Preserve the original creation failure.
      }
    }
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Preserve the original creation failure.
    }
    throw error
  }
}
