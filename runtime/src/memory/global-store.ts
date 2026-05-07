/**
 * Ports the upstream memory path, prompt, and scan primitives into AgenC's
 * global durable memory store.
 *
 * Why this lives here:
 *   - MM-01 owns the low-level D-13 primitives. This module provides the
 *     user-level global store surface that later memory items can consume
 *     without knowing how paths, prompt loading, and manifest scanning compose.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Project memory routing is owned by project-memory follow-up work.
 *   - Background extraction and consolidation scheduling are owned by later
 *     memory persistence items.
 */
import {
  buildMemoryPrompt,
  ensureMemoryDirExists,
  type EntrypointTruncation,
  truncateEntrypointContent,
} from './memdir.js'
import {
  getGlobalMemoryEntrypoint,
  getGlobalMemoryPath,
  isGlobalMemoryPath,
} from './paths.js'
import {
  formatMemoryManifest,
  type MemoryHeader,
  scanMemoryFiles,
} from './scan.js'
import { getFsImplementation } from '../utils/fsOperations.js'

export const GLOBAL_MEMORY_DISPLAY_NAME = 'global memory'

export type GlobalMemoryStoreInfo = {
  readonly root: string
  readonly entrypoint: string
}

export type GlobalMemoryStoreSnapshot = GlobalMemoryStoreInfo & {
  readonly headers: readonly MemoryHeader[]
  readonly manifest: string
}

export function getGlobalMemoryStoreInfo(): GlobalMemoryStoreInfo {
  return {
    root: getGlobalMemoryPath(),
    entrypoint: getGlobalMemoryEntrypoint(),
  }
}

export function isGlobalMemoryStorePath(absolutePath: string): boolean {
  return isGlobalMemoryPath(absolutePath)
}

export async function ensureGlobalMemoryStore(): Promise<GlobalMemoryStoreInfo> {
  const info = getGlobalMemoryStoreInfo()
  await ensureMemoryDirExists(info.root)
  return info
}

export function buildGlobalMemoryStorePrompt(params: {
  readonly extraGuidelines?: readonly string[]
} = {}): string {
  return buildMemoryPrompt({
    displayName: GLOBAL_MEMORY_DISPLAY_NAME,
    memoryDir: getGlobalMemoryPath(),
    extraGuidelines: [...(params.extraGuidelines ?? [])],
  })
}

export async function loadGlobalMemoryStorePrompt(params: {
  readonly extraGuidelines?: readonly string[]
} = {}): Promise<string> {
  await ensureGlobalMemoryStore()
  return buildGlobalMemoryStorePrompt(params)
}

export async function readGlobalMemoryEntrypoint(): Promise<EntrypointTruncation | null> {
  const fs = getFsImplementation()
  try {
    const content = await fs.readFile(getGlobalMemoryEntrypoint(), {
      encoding: 'utf-8',
    })
    if (!content.trim()) return null
    return truncateEntrypointContent(content)
  } catch {
    return null
  }
}

export async function scanGlobalMemoryStore(
  signal: AbortSignal = new AbortController().signal,
): Promise<MemoryHeader[]> {
  await ensureGlobalMemoryStore()
  return scanMemoryFiles(getGlobalMemoryPath(), signal)
}

export async function formatGlobalMemoryStoreManifest(
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  return formatMemoryManifest(await scanGlobalMemoryStore(signal))
}

export async function getGlobalMemoryStoreSnapshot(
  signal: AbortSignal = new AbortController().signal,
): Promise<GlobalMemoryStoreSnapshot> {
  const info = await ensureGlobalMemoryStore()
  const headers = await scanGlobalMemoryStore(signal)
  return {
    ...info,
    headers,
    manifest: formatMemoryManifest(headers),
  }
}
