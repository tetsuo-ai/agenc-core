/**
 * Ports the upstream `src/memdir/memoryScan.ts` scanner onto AgenC memory paths.
 *
 * Memory-directory scanning primitives. Split out of findRelevantMemories.ts
 * so extractMemories can import the scan without pulling in sideQuery and
 * the API-client chain (which closed a cycle through memdir.ts — #25372).
 */

import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import { type MemoryType, parseMemoryType } from './types.js'

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

export const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30
const MAX_SCAN_DEPTH = 3
const FRONTMATTER_READ_CONCURRENCY = 8

/**
 * Scan a memory directory for .md files, read their frontmatter, and return
 * a header list sorted newest-first (capped at MAX_MEMORY_FILES). Shared by
 * findRelevantMemories (query-time recall) and extractMemories (pre-injects
 * the listing so the extraction agent doesn't spend a turn on `ls`).
 *
 * Single-pass: readFileInRange stats internally and returns mtimeMs, so we
 * read-then-sort rather than stat-sort-read. For the common case (N ≤ 200)
 * this halves syscalls vs a separate stat round; for large N we read a few
 * extra small files but still avoid the double-stat on the surviving 200.
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  try {
    const candidates = await collectMemoryMarkdownFiles(memoryDir, signal)
    const mdFiles = await selectNewestMemoryFiles(
      memoryDir,
      candidates,
      signal,
      MAX_MEMORY_FILES,
    )
    const headers = await mapWithConcurrency(
      mdFiles,
      FRONTMATTER_READ_CONCURRENCY,
      async relativePath => readMemoryHeader(memoryDir, relativePath, signal),
    )

    return headers
      .filter((header): header is MemoryHeader => header !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES)
  } catch {
    return []
  }
}

async function collectMemoryMarkdownFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<string[]> {
  const results: string[] = []
  const pending: Array<{ dir: string; relativeDir: string; depth: number }> = [
    { dir: memoryDir, relativeDir: '', depth: 0 },
  ]

  while (pending.length > 0) {
    if (signal.aborted) break
    const current = pending.shift()!
    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (signal.aborted) break
      const relativePath = current.relativeDir
        ? join(current.relativeDir, entry.name)
        : entry.name
      if (entry.isDirectory()) {
        if (current.depth + 1 < MAX_SCAN_DEPTH) {
          pending.push({
            dir: join(current.dir, entry.name),
            relativeDir: relativePath,
            depth: current.depth + 1,
          })
        }
        continue
      }
      if (
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        basename(entry.name) !== 'MEMORY.md'
      ) {
        results.push(relativePath)
      }
    }
  }

  return results
}

async function selectNewestMemoryFiles(
  memoryDir: string,
  candidates: readonly string[],
  signal: AbortSignal,
  limit: number,
): Promise<string[]> {
  const rows = await mapWithConcurrency(
    candidates,
    FRONTMATTER_READ_CONCURRENCY,
    async relativePath => {
      if (signal.aborted) return null
      try {
        const info = await stat(join(memoryDir, relativePath))
        if (!info.isFile()) return null
        return { relativePath, mtimeMs: info.mtimeMs }
      } catch {
        return null
      }
    },
  )
  return rows
    .filter(
      (row): row is { relativePath: string; mtimeMs: number } => row !== null,
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map(row => row.relativePath)
}

async function readMemoryHeader(
  memoryDir: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<MemoryHeader | null> {
  try {
    const filePath = join(memoryDir, relativePath)
    const { content, mtimeMs } = await readFileInRange(
      filePath,
      0,
      FRONTMATTER_MAX_LINES,
      undefined,
      signal,
    )
    const { frontmatter } = parseFrontmatter(content, filePath)
    return {
      filename: relativePath,
      filePath,
      mtimeMs,
      description: frontmatter.description || null,
      type: parseMemoryType(frontmatter.type),
    }
  } catch {
    return null
  }
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = []
  let next = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const item = items[next++]
        results.push(await mapper(item))
      }
    }),
  )
  return results
}

/**
 * Format memory headers as a text manifest: one line per file with
 * [type] filename (timestamp): description. Used by both the recall
 * selector prompt and the extraction-agent prompt.
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}
