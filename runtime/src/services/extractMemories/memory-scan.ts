/**
 * Source-aligned with `src/memdir/memoryScan.ts` at donor commit
 * 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Why this lives here / shape difference from upstream:
 *   - The extraction prompt needs a cheap manifest but cannot import the
 *     excluded `runtime/src/memdir/**` mirror from the strict build.
 *   - Directory traversal is explicit and ignores symlinks before reading so
 *     the background child never receives a manifest for paths outside the
 *     configured memory root.
 *
 * Scope boundaries:
 *   - full frontmatter parser reuse; only the `description` and `type`
 *     headers needed by the extraction prompt are parsed.
 */

import { opendir, lstat, open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { AUTO_MEMORY_INDEX_FILE, isPathInsideMemoryDir } from "./memory-paths.js";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryHeader {
  readonly filename: string;
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly description: string | null;
  readonly type: MemoryType | undefined;
}

const MAX_MEMORY_FILES = 200;
const MAX_SCAN_DEPTH = 3;
const FRONTMATTER_MAX_BYTES = 16 * 1024;
const FRONTMATTER_MAX_LINES = 120;

function parseMemoryType(raw: unknown): MemoryType | undefined {
  return typeof raw === "string"
    ? MEMORY_TYPES.find((type) => type === raw)
    : undefined;
}

function stripYamlString(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatterHeader(content: string): {
  readonly description?: string;
  readonly type?: string;
} {
  const lines = content.split(/\r?\n/u).slice(0, FRONTMATTER_MAX_LINES);
  if (lines[0]?.trim() !== "---") return {};
  const result: { description?: string; type?: string } = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.trim() === "---") break;
    const match = line?.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u);
    if (!match) continue;
    const key = match[1];
    const value = stripYamlString(match[2] ?? "");
    if (key === "description") result.description = value;
    if (key === "type") result.type = value;
  }
  return result;
}

async function readHeaderBytes(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(FRONTMATTER_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function toDisplayPath(path: string): string {
  return path.split(sep).join("/");
}

async function collectMarkdownFiles(params: {
  readonly memoryDir: string;
  readonly realRoot: string;
  readonly dir: string;
  readonly depth: number;
  readonly out: string[];
  readonly signal?: AbortSignal;
}): Promise<void> {
  if (params.out.length >= MAX_MEMORY_FILES || params.signal?.aborted) return;
  let dir;
  try {
    dir = await opendir(params.dir);
  } catch {
    return;
  }
  try {
    for await (const entry of dir) {
      if (params.out.length >= MAX_MEMORY_FILES || params.signal?.aborted) return;
      if (entry.isSymbolicLink()) continue;
      const absolute = join(params.dir, entry.name);
      if (entry.isDirectory()) {
        if (params.depth + 1 < MAX_SCAN_DEPTH) {
          await collectMarkdownFiles({
            ...params,
            dir: absolute,
            depth: params.depth + 1,
          });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md") || entry.name === AUTO_MEMORY_INDEX_FILE) {
        continue;
      }
      let realFile: string;
      try {
        const stat = await lstat(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        realFile = await realpath(absolute);
      } catch {
        continue;
      }
      if (
        isPathInsideMemoryDir(realFile, params.realRoot) &&
        isPathInsideMemoryDir(realFile, params.memoryDir)
      ) {
        params.out.push(realFile);
      }
    }
  } finally {
    await dir.close().catch(() => {});
  }
}

export async function scanMemoryFiles(
  memoryDir: string,
  signal?: AbortSignal,
): Promise<MemoryHeader[]> {
  try {
    const realRoot = await realpath(memoryDir);
    const files: string[] = [];
    await collectMarkdownFiles({
      memoryDir,
      realRoot,
      dir: memoryDir,
      depth: 0,
      out: files,
      signal,
    });

    const headers = await Promise.allSettled(
      files.map(async (filePath): Promise<MemoryHeader> => {
        const [stat, content] = await Promise.all([
          lstat(filePath),
          readHeaderBytes(filePath),
        ]);
        const frontmatter = parseFrontmatterHeader(content);
        const rel = toDisplayPath(relative(realRoot, filePath));
        return {
          filename: rel,
          filePath,
          mtimeMs: stat.mtimeMs,
          description:
            frontmatter.description && frontmatter.description.length > 0
              ? frontmatter.description
              : null,
          type: parseMemoryType(frontmatter.type),
        };
      }),
    );

    return headers
      .filter(
        (entry): entry is PromiseFulfilledResult<MemoryHeader> =>
          entry.status === "fulfilled",
      )
      .map((entry) => entry.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES);
  } catch {
    return [];
  }
}

export function formatMemoryManifest(memories: readonly MemoryHeader[]): string {
  return memories
    .map((memory) => {
      const tag = memory.type ? `[${memory.type}] ` : "";
      const timestamp = new Date(memory.mtimeMs).toISOString();
      return memory.description
        ? `- ${tag}${memory.filename} (${timestamp}): ${memory.description}`
        : `- ${tag}${memory.filename} (${timestamp})`;
    })
    .join("\n");
}
