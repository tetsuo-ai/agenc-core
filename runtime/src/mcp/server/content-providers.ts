/**
 * MCP prompt + resource providers for `agenc mcp serve`.
 *
 * The runtime already loads skills (natural MCP prompts) and memory /
 * instruction files (natural MCP resources), but the MCP server exposed
 * only tools — other MCP hosts saw none of it. These providers surface
 * that content read-only:
 *
 *   - Prompts: skills discovered from the standard skill roots
 *     (`<root>/<name>/SKILL.md` and legacy `<root>/<name>.md`). Skills
 *     marked `disable-model-invocation: true` are NOT exposed — an MCP
 *     client's model can trigger prompts/get, so the flag is honored
 *     the same way it gates in-process model invocation.
 *   - Resources: memory files (via the same scanner the runtime uses)
 *     plus explicitly-passed instruction files (AGENC.md tiers).
 *     `readResource` only serves URIs minted by a fresh listing — it never
 *     resolves client-supplied paths. Only the selected resource body is
 *     read, then its contents pass through the canonical egress secret
 *     sanitizer.
 *
 * Containment is bound to a descriptor, not to a pathname. Each skill root,
 * memory directory, and instruction-file parent is opened once per request
 * and retained (`bindVerifiedRoot`); the retained handle is proven to sit
 * inside `scopeRoot`, and every candidate below it is admitted, opened, read,
 * and re-proven against that handle through the shared verified-read
 * primitives. In particular `verifyParentChain` rejects a symlinked or
 * escaped ancestor before and after the bytes are taken.
 *
 * That ancestor proof is the point. Deciding containment by resolving the
 * candidate's pathname a second time is not a proof at all: `lstat` and
 * `realpath` are independent resolutions, and a writable workspace can flip an
 * ancestor between them so the identity check lands on an out-of-scope inode
 * while the containment check lands on an in-scope name. The two proofs then
 * describe different files and out-of-scope bytes are served under an in-scope
 * path. Nothing here resolves a candidate pathname twice.
 *
 * Platform: the shared primitives need a descriptor-path mechanism
 * (`/proc/self/fd` on linux; an identity comparison on darwin and freebsd).
 * Where the platform offers neither — Windows included — these providers fail
 * closed: the affected root contributes nothing and the reason is reported
 * through `onRejected`. There is deliberately no weaker fallback, so `agenc
 * mcp serve` on Windows advertises no skills, memory, or instruction
 * resources. That is a real loss of function, taken over serving bytes whose
 * location cannot be proven; memory resources were already empty there,
 * because `scanMemoryRoots` reports "unsupported" on win32.
 *
 * @module
 */
import { Buffer } from "node:buffer";
import type { BigIntStats } from "node:fs";
import { lstat, readdir, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

import {
  DEFAULT_VERIFIED_READ_CONTEXT,
  UnsupportedVerifiedReadPlatformError,
  assertCandidateUnchanged,
  bindVerifiedRoot,
  canonicalRelativePath,
  closeVerifiedHandle,
  descriptorHandlePath,
  descriptorRelativePath,
  identityFromStats,
  openVerifiedCandidate,
  sameStats,
  verifyParentChain,
  type FileIdentity,
  type VerifiedRoot,
} from "../../fs/verified-read.js";
import {
  detectSessionFileType,
  scanMemoryFiles,
} from "../../memory/index.js";
import { MAX_SECURE_PROJECT_FILE_BYTES } from "../../prompts/secure-instruction-file.js";
import { redactSecrets } from "../../secrets/sanitizer.js";
import {
  parseBooleanFrontmatter,
  parseFrontmatter,
} from "../../utils/frontmatterParser.js";
import type {
  McpGetPromptResult,
  McpPromptDefinition,
  McpPromptProvider,
  McpReadResourceResult,
  McpResourceDefinition,
  McpResourceProvider,
} from "../../mcp-server/types.js";

/** Byte ceiling for one skill or memory body served over MCP. */
export const MAX_SCOPED_FILE_BYTES = 1_048_576;

/**
 * Byte ceiling for one instruction file (AGENC.md tier) served over MCP.
 *
 * It is deliberately the same number the runtime uses for the very same file
 * in-process (`readInstructionFileSnapshot` with
 * `MAX_SECURE_PROJECT_FILE_BYTES`). When these diverged, a 2 MiB AGENC.md was
 * read in-process and silently dropped from `resources/list`, which reads as
 * "the MCP server cannot see my instructions" with no way to tell why.
 * Skills and memory files keep the smaller ceiling: they are many, are listed
 * on every request, and have no in-process counterpart to match.
 */
export const MAX_SCOPED_INSTRUCTION_FILE_BYTES = MAX_SECURE_PROJECT_FILE_BYTES;

/** Why one candidate did not become a prompt or a resource. */
export type ScopedReadRejectionReason =
  | "platform_unsupported"
  | "root_unavailable"
  | "root_outside_scope"
  | "not_found"
  | "not_admissible"
  | "too_large"
  | "verification_failed"
  | "ancestor_changed"
  | "invalid_utf8";

export interface ScopedReadRejection {
  readonly reason: ScopedReadRejectionReason;
  /** The requested (not canonical) path, so it names what the caller asked for. */
  readonly path: string;
}

/**
 * @internal Deterministic race seams for the shared verified reader:
 * tests replace the candidate at each filesystem I/O boundary.
 */
export interface ScopedRegularFileTestHooks {
  /** Fires after admission, before the verified open. */
  readonly beforeOpenForTesting?: (path: string) => void | Promise<void>;
  /** Fires after the verified open, before the bounded read. */
  readonly beforeReadForTesting?: (path: string) => void | Promise<void>;
}

/**
 * Observability for a rejection.
 *
 * Nothing under `runtime/src/mcp/server/` writes a log line, and a stdio MCP
 * server owns stdout as its protocol channel, so this stays a caller-supplied
 * observer rather than a new logger: rejections are ordinary for unreadable,
 * oversized, or foreign files, and a per-candidate log on every `prompts/list`
 * would be noise. Unwired it behaves exactly as before — the entry is dropped
 * — but the reason is now reachable instead of unobservable.
 */
export interface ScopedReadObserverOptions {
  readonly onRejected?: (rejection: ScopedReadRejection) => void;
}

export interface SkillPromptProviderOptions
  extends ScopedRegularFileTestHooks,
    ScopedReadObserverOptions {
  /** Directories whose children are skills (`<dir>/<name>/SKILL.md` or `<dir>/<name>.md`). */
  readonly skillRoots: readonly string[];
  /** Containment root; a skill root resolving outside it contributes nothing. */
  readonly scopeRoot?: string;
}

interface DiscoveredSkill {
  readonly name: string;
  readonly filePath: string;
  readonly description: string;
  readonly argumentHint: string | undefined;
  readonly rawContent: string;
}

interface ScopedFileBody {
  readonly canonicalPath: string;
  readonly rawContent: string;
}

/**
 * These providers answer one MCP request at a time and have no cancellation
 * channel of their own, so the shared primitives get a signal that never
 * fires and the default error behaviour.
 */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;
const VERIFIED_READ_CONTEXT = DEFAULT_VERIFIED_READ_CONTEXT;

function noteRejection(
  observer: ScopedReadObserverOptions,
  reason: ScopedReadRejectionReason,
  path: string,
): null {
  observer.onRejected?.({ reason, path });
  return null;
}

async function canonicalScopeRoot(
  scopeRoot: string | undefined,
): Promise<string | null> {
  if (scopeRoot === undefined) return null;
  try {
    return await realpath(scopeRoot);
  } catch {
    return null;
  }
}

function isSameOrChildPath(scopeRoot: string, candidate: string): boolean {
  const offset = relative(scopeRoot, candidate);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

/** One admission contract for listing and reading: regular, unlinked-again, bounded. */
function admitsScopedSnapshot(
  stats: BigIntStats,
  maximumBytes: number,
): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1n &&
    stats.size <= BigInt(maximumBytes)
  );
}

/**
 * Open a root directory, retain its descriptor, and prove it sits inside the
 * scope root. Every later containment decision is made against this handle,
 * so a root that cannot be proven contributes nothing at all.
 */
async function bindScopedRoot(
  directory: string,
  scopeRoot: string | null,
  observer: ScopedReadObserverOptions,
): Promise<VerifiedRoot | null> {
  let root: VerifiedRoot | null;
  try {
    root = await bindVerifiedRoot(
      directory,
      NEVER_ABORTED,
      VERIFIED_READ_CONTEXT,
    );
  } catch (error) {
    return noteRejection(
      observer,
      error instanceof UnsupportedVerifiedReadPlatformError
        ? "platform_unsupported"
        : "root_unavailable",
      directory,
    );
  }
  if (root === null) {
    return noteRejection(observer, "root_unavailable", directory);
  }
  if (
    scopeRoot !== null &&
    !isSameOrChildPath(scopeRoot, root.binding.canonicalPath)
  ) {
    await closeVerifiedHandle(root.handle, NEVER_ABORTED, VERIFIED_READ_CONTEXT);
    return noteRejection(observer, "root_outside_scope", directory);
  }
  return root;
}

async function releaseScopedRoot(root: VerifiedRoot): Promise<void> {
  await closeVerifiedHandle(root.handle, NEVER_ABORTED, VERIFIED_READ_CONTEXT);
}

/**
 * Stat contract for a candidate that is only going to be *listed*. No handle
 * is opened and no bytes are taken, so the entry never advertises a
 * directory, FIFO, device, symlink, multiply-linked, or oversized object.
 */
async function admitScopedCandidate(
  root: VerifiedRoot,
  relativePath: string,
  maximumBytes: number,
  observer: ScopedReadObserverOptions,
): Promise<FileIdentity | null> {
  const requestedPath = join(root.binding.requestedPath, relativePath);
  try {
    // No test can kill this particular call: on the read path
    // `openVerifiedCandidate` walks the chain again a moment later, and the
    // listing path has no race seam to swap a root through. It is kept
    // because listing is the only verification a listed-but-unread resource
    // gets, and because dropping a containment check to tidy a mutation
    // matrix is the wrong trade. The guard itself — ancestor symlinks,
    // escapes, and the bound-root re-proof — is pinned in
    // tests/fs/verified-read.test.ts.
    if (
      !(await verifyParentChain(
        root,
        relativePath,
        NEVER_ABORTED,
        VERIFIED_READ_CONTEXT,
      ))
    ) {
      return noteRejection(observer, "verification_failed", requestedPath);
    }
    const stats = await lstat(
      descriptorRelativePath(root, relativePath, VERIFIED_READ_CONTEXT),
      { bigint: true },
    );
    if (!admitsScopedSnapshot(stats, maximumBytes)) {
      return noteRejection(
        observer,
        stats.isFile() && stats.size > BigInt(maximumBytes)
          ? "too_large"
          : "not_admissible",
        requestedPath,
      );
    }
    return identityFromStats(stats);
  } catch (error) {
    return noteRejection(
      observer,
      error instanceof UnsupportedVerifiedReadPlatformError
        ? "platform_unsupported"
        : (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "not_found"
          : "verification_failed",
      requestedPath,
    );
  }
}

/** Read exactly the validated byte count, plus one byte to catch growth. */
async function readScopedHandle(
  handle: FileHandle,
  expectedBytes: number,
): Promise<Buffer | null> {
  const buffer = Buffer.allocUnsafe(expectedBytes + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      length,
      buffer.length - length,
      null,
    );
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return length > expectedBytes ? null : buffer.subarray(0, length);
}

/**
 * Shared verified reader for skill prompts and resource bodies: admit the
 * candidate, open it below the retained root handle, prove the opened object
 * is the admitted one, read it under the byte ceiling, and re-prove both the
 * object and its whole ancestor chain afterwards. Any swap, relink, growth,
 * or escape between those boundaries yields `null`.
 */
async function readScopedRegularFile(
  root: VerifiedRoot,
  relativePath: string,
  maximumBytes: number,
  hooks: ScopedRegularFileTestHooks,
  observer: ScopedReadObserverOptions,
): Promise<ScopedFileBody | null> {
  const requestedPath = join(root.binding.requestedPath, relativePath);
  const before = await admitScopedCandidate(
    root,
    relativePath,
    maximumBytes,
    observer,
  );
  if (before === null) return null;
  let handle: FileHandle | null = null;
  try {
    await hooks.beforeOpenForTesting?.(requestedPath);
    handle = await openVerifiedCandidate(
      root,
      relativePath,
      NEVER_ABORTED,
      VERIFIED_READ_CONTEXT,
    );
    if (handle === null) {
      return noteRejection(observer, "verification_failed", requestedPath);
    }
    const opened = await handle.stat({ bigint: true });
    if (!admitsScopedSnapshot(opened, maximumBytes)) {
      return noteRejection(observer, "not_admissible", requestedPath);
    }
    const openedIdentity = identityFromStats(opened);
    if (!sameStats(before, openedIdentity)) {
      return noteRejection(observer, "verification_failed", requestedPath);
    }
    await hooks.beforeReadForTesting?.(requestedPath);
    const bytes = await readScopedHandle(handle, Number(opened.size));
    if (bytes === null || bytes.byteLength !== Number(opened.size)) {
      return noteRejection(observer, "too_large", requestedPath);
    }
    // Re-prove the object AND the ancestor chain that made it in-scope. A
    // pathname re-resolution here would prove nothing: it is exactly the
    // second, independent resolution an ancestor swap exploits.
    await assertCandidateUnchanged(
      handle,
      descriptorRelativePath(root, relativePath, VERIFIED_READ_CONTEXT),
      openedIdentity,
      NEVER_ABORTED,
      VERIFIED_READ_CONTEXT,
    );
    if (
      !(await verifyParentChain(
        root,
        relativePath,
        NEVER_ABORTED,
        VERIFIED_READ_CONTEXT,
      ))
    ) {
      return noteRejection(observer, "ancestor_changed", requestedPath);
    }
    let rawContent: string;
    try {
      rawContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // Substituting U+FFFD would hand the client a body that is not the
      // file, and would let invalid bytes reshape frontmatter. Fail instead,
      // the way the in-process instruction reader does.
      return noteRejection(observer, "invalid_utf8", requestedPath);
    }
    return {
      canonicalPath: canonicalRelativePath(root, relativePath),
      rawContent,
    };
  } catch (error) {
    return noteRejection(
      observer,
      error instanceof UnsupportedVerifiedReadPlatformError
        ? "platform_unsupported"
        : "verification_failed",
      requestedPath,
    );
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

interface SkillCandidate {
  readonly name: string;
  readonly relativePath: string;
}

function skillCandidate(entry: {
  name: string;
  isDirectory: () => boolean;
}): SkillCandidate | null {
  if (entry.isDirectory()) {
    return { name: entry.name, relativePath: join(entry.name, "SKILL.md") };
  }
  if (entry.name.endsWith(".md")) {
    return {
      name: entry.name.slice(0, -".md".length),
      relativePath: entry.name,
    };
  }
  return null;
}

async function discoverSkills(
  options: SkillPromptProviderOptions,
): Promise<Map<string, DiscoveredSkill>> {
  const skills = new Map<string, DiscoveredSkill>();
  const scopeRoot = await canonicalScopeRoot(options.scopeRoot);
  if (options.scopeRoot !== undefined && scopeRoot === null) return skills;
  for (const skillRoot of options.skillRoots) {
    const root = await bindScopedRoot(skillRoot, scopeRoot, options);
    if (root === null) continue;
    try {
      let entries;
      try {
        entries = await readdir(
          descriptorHandlePath(
            root.handle,
            root.binding.requestedPath,
            VERIFIED_READ_CONTEXT,
          ),
          { withFileTypes: true },
        );
      } catch {
        continue;
      }
      for (const entry of entries) {
        const candidate = skillCandidate(entry);
        if (candidate === null || skills.has(candidate.name)) continue;
        const file = await readScopedRegularFile(
          root,
          candidate.relativePath,
          MAX_SCOPED_FILE_BYTES,
          options,
          options,
        );
        if (file === null) continue;
        const { frontmatter } = parseFrontmatter(
          file.rawContent,
          file.canonicalPath,
        );
        if (parseBooleanFrontmatter(frontmatter["disable-model-invocation"])) {
          continue;
        }
        skills.set(candidate.name, {
          name: candidate.name,
          filePath: file.canonicalPath,
          description:
            typeof frontmatter.description === "string"
              ? frontmatter.description
              : `Skill: ${candidate.name}`,
          argumentHint:
            frontmatter["argument-hint"] != null
              ? String(frontmatter["argument-hint"])
              : undefined,
          rawContent: file.rawContent,
        });
      }
    } finally {
      await releaseScopedRoot(root);
    }
  }
  return skills;
}

export function createSkillPromptProvider(
  options: SkillPromptProviderOptions,
): McpPromptProvider {
  return {
    async listPrompts(): Promise<readonly McpPromptDefinition[]> {
      const skills = await discoverSkills(options);
      return [...skills.values()].map((skill) => ({
        name: skill.name,
        description: skill.description,
        arguments: [
          {
            name: "arguments",
            description:
              skill.argumentHint ?? "Optional arguments for the skill",
            required: false,
          },
        ],
      }));
    },
    async getPrompt(
      name: string,
      args?: Readonly<Record<string, string>>,
    ): Promise<McpGetPromptResult | null> {
      const skills = await discoverSkills(options);
      const skill = skills.get(name);
      if (skill === undefined) return null;
      const { content } = parseFrontmatter(skill.rawContent, skill.filePath);
      const argumentText = args?.arguments ?? "";
      const text = content.includes("$ARGUMENTS")
        ? content.replaceAll("$ARGUMENTS", argumentText)
        : argumentText.length > 0
          ? `${content}\n\nARGUMENTS: ${argumentText}`
          : content;
      return {
        description: skill.description,
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    },
  };
}

export interface MemoryResourceProviderOptions
  extends ScopedRegularFileTestHooks,
    ScopedReadObserverOptions {
  /** Memory directories scanned with the runtime's memory scanner. */
  readonly memoryDirs: readonly string[];
  /** Explicit instruction files (AGENC.md tiers). Listed only if they exist. */
  readonly instructionFiles?: readonly string[];
  /** Containment root; a directory resolving outside it contributes nothing. */
  readonly scopeRoot?: string;
  /** Captured config home used to exclude private session files. */
  readonly configHomeDir?: string;
}

const MEMORY_URI_SCHEME = "agenc-memory://";
const INSTRUCTIONS_URI_SCHEME = "agenc-instructions://";

interface ListedResource {
  readonly definition: McpResourceDefinition;
  /** Directory the body must be read from, and the name below it. */
  readonly rootDir: string;
  readonly relativePath: string;
  readonly maximumBytes: number;
}

async function listMemoryResources(
  options: MemoryResourceProviderOptions,
): Promise<Map<string, ListedResource>> {
  const resources = new Map<string, ListedResource>();
  const scopeRoot = await canonicalScopeRoot(options.scopeRoot);
  if (options.scopeRoot !== undefined && scopeRoot === null) return resources;
  for (const [dirIndex, dir] of options.memoryDirs.entries()) {
    const root = await bindScopedRoot(dir, scopeRoot, options);
    if (root === null) continue;
    try {
      const headers = await scanMemoryFiles(dir);
      for (const header of headers) {
        // Session memory/transcripts are excluded outright — same boundary
        // the permission layer enforces for in-process reads.
        if (
          detectSessionFileType(header.filePath, options.configHomeDir) !== null
        ) {
          continue;
        }
        const admitted = await admitScopedCandidate(
          root,
          header.relativePath,
          MAX_SCOPED_FILE_BYTES,
          options,
        );
        if (admitted === null) continue;
        const uri = `${MEMORY_URI_SCHEME}${dirIndex}/${header.filename}`;
        resources.set(uri, {
          definition: {
            uri,
            name: header.filename,
            ...(header.description !== null
              ? { description: header.description }
              : {}),
            mimeType: "text/markdown",
          },
          rootDir: dir,
          relativePath: header.relativePath,
          maximumBytes: MAX_SCOPED_FILE_BYTES,
        });
      }
      const entrypoint = await admitScopedCandidate(
        root,
        "MEMORY.md",
        MAX_SCOPED_FILE_BYTES,
        options,
      );
      if (entrypoint !== null) {
        const uri = `${MEMORY_URI_SCHEME}${dirIndex}/MEMORY.md`;
        resources.set(uri, {
          definition: {
            uri,
            name: "MEMORY.md",
            description: "Memory index",
            mimeType: "text/markdown",
          },
          rootDir: dir,
          relativePath: "MEMORY.md",
          maximumBytes: MAX_SCOPED_FILE_BYTES,
        });
      }
    } finally {
      await releaseScopedRoot(root);
    }
  }
  for (const [fileIndex, filePath] of (
    options.instructionFiles ?? []
  ).entries()) {
    if (detectSessionFileType(filePath, options.configHomeDir) !== null) {
      continue;
    }
    const requestedPath = resolve(filePath);
    const parentDir = dirname(requestedPath);
    const root = await bindScopedRoot(parentDir, scopeRoot, options);
    if (root === null) continue;
    try {
      const admitted = await admitScopedCandidate(
        root,
        basename(requestedPath),
        MAX_SCOPED_INSTRUCTION_FILE_BYTES,
        options,
      );
      if (admitted === null) continue;
      const uri = `${INSTRUCTIONS_URI_SCHEME}${fileIndex}/${basename(filePath)}`;
      resources.set(uri, {
        definition: {
          uri,
          name: basename(filePath),
          description: `Project instructions (${filePath})`,
          mimeType: "text/markdown",
        },
        rootDir: parentDir,
        relativePath: basename(requestedPath),
        maximumBytes: MAX_SCOPED_INSTRUCTION_FILE_BYTES,
      });
    } finally {
      await releaseScopedRoot(root);
    }
  }
  return resources;
}

export function createMemoryResourceProvider(
  options: MemoryResourceProviderOptions,
): McpResourceProvider {
  return {
    async listResources(): Promise<readonly McpResourceDefinition[]> {
      const resources = await listMemoryResources(options);
      return [...resources.values()].map((resource) => resource.definition);
    },
    async readResource(uri: string): Promise<McpReadResourceResult | null> {
      // Path bounding: only URIs from a fresh listing are readable. The
      // client-supplied uri is a map key, never a filesystem path.
      const resources = await listMemoryResources(options);
      const resource = resources.get(uri);
      if (resource === undefined) return null;
      const scopeRoot = await canonicalScopeRoot(options.scopeRoot);
      if (options.scopeRoot !== undefined && scopeRoot === null) return null;
      const root = await bindScopedRoot(resource.rootDir, scopeRoot, options);
      if (root === null) return null;
      let file: ScopedFileBody | null;
      try {
        file = await readScopedRegularFile(
          root,
          resource.relativePath,
          resource.maximumBytes,
          options,
          options,
        );
      } finally {
        await releaseScopedRoot(root);
      }
      if (file === null) return null;
      return {
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text: redactSecrets(file.rawContent),
          },
        ],
      };
    },
  };
}
