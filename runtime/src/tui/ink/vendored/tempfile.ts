/**
 * Vendored from AgenC/src/utils/tempfile.ts — minimal temp-path
 * generator used by OSC 52 clipboard fallback paths.
 */

import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function generateTempFilePath(
  prefix: string = 'agenc-ink',
  extension: string = '.tmp',
  options?: { contentHash?: string },
): string {
  const id = options?.contentHash
    ? createHash('sha256')
        .update(options.contentHash)
        .digest('hex')
        .slice(0, 16)
    : randomUUID()
  return join(tmpdir(), `${prefix}-${id}${extension}`)
}
