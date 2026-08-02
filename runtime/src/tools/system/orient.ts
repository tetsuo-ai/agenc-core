/**
 * `Orient` — ephemeral on-demand repository orientation map.
 *
 * Given a natural-language query ("where is the retry logic", "what handles
 * settlement"), Orient builds a token-bounded structural map of the workspace's
 * source files *on the fly*, ranks the files by relevance, and returns only the
 * top-ranked files + a compact symbol map — then discards the map. There is no
 * persistent index to maintain.
 *
 * This is the read-side complement to Glob/Grep: instead of a literal pattern,
 * the model asks "where should I look for X" and gets a localized shortlist. It
 * reads many files internally but returns a *small* result, so it localizes
 * without flooding context (the same flood-avoidance reason subagents exist).
 *
 * Ranking = lexical (BM25) + a structural symbol-definition index + a small
 * 1-hop ego boost — validated against SWE-bench Lite (n=300): +8.3pp
 * file-localization recall@5 over a BM25 baseline, CV-confirmed. See
 * `context/orientation-map.ts` and the orientation-map reproduction harness.
 */

import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

import { buildOrientationMap } from "../../context/orientation-map.js";
import {
  beginWorkspaceReadToolOperation,
  captureWorkspaceAuthoritativeDirtySnapshots,
  endWorkspaceToolOperation,
  type WorkspaceToolOperationToken,
} from "../../workspace/mutation-coordinator.js";
import type { Tool, ToolResult } from "../types.js";
import {
  resolveToolAllowedPaths,
  safePath,
  type FilesystemToolConfig,
} from "./filesystem.js";
import {
  createSearchIgnoreMatcher,
  searchPathUsesDefaultExcludedDirectory,
} from "./grep.js";
import {
  discoverRipgrepRootIgnoreFiles,
  formatRipgrepFilesError,
  runRipgrepFiles,
} from "./glob.js";
import { selectPinnedRipgrepPath } from "./pinned-ripgrep.js";
import {
  decodeRipgrepPathBytes,
  GrepBoundaryError,
} from "./ripgrep-protocol.js";
import { readFileInRange } from "../../utils/readFileInRange.js";
import {
  bindWorkspaceDirectoryReadCapability,
  type WorkspaceBoundReadCapability,
  type WorkspaceBoundReadIdentity,
} from "../../workspace/file-mutation-transaction.js";

export const ORIENT_TOOL_NAME = "Orient";

const ORIENT_DESCRIPTION =
  "Locate the most relevant source files for a natural-language query by " +
  "building an ephemeral structural map of the repository (symbols + " +
  "references + lexical match). Use it to orient before reading — ask 'where " +
  "is X handled' and get a ranked shortlist of files plus their key symbols, " +
  "instead of bulk-reading or guessing. Read-only; respects .gitignore and " +
  "skips generated/build/vendored dirs.";

/** Source extensions the map understands (def/ref extraction is language-aware). */
const SOURCE_GLOB =
  "*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,rb,php,c,cc,cpp,cxx,h,hpp,cs,kt,kts,swift,scala,m,mm}";
const DEFAULT_MAX_FILES = 2000;
const HARD_MAX_FILES = 4000;
const MAX_BYTES_PER_FILE = 64 * 1024;
const MAX_RANKED = 20;
const MAP_TOKEN_BUDGET = 1000;
const PINNED_RIPGREP_UNAVAILABLE_MESSAGE =
  "Orient error [PINNED_RIPGREP_UNAVAILABLE]: AgenC's packaged ripgrep executable is unavailable. Run `agenc doctor`, then reinstall the same AgenC version.";
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".rb",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
  ".cs",
  ".kt",
  ".kts",
  ".swift",
  ".scala",
  ".m",
  ".mm",
]);

interface OrientToolInput {
  readonly query?: unknown;
  readonly path?: unknown;
  readonly maxFiles?: unknown;
  readonly __abortSignal?: AbortSignal;
}

function textResult(
  content: string,
  metadata?: Record<string, unknown>,
): ToolResult {
  return metadata ? { content, metadata } : { content };
}

function errorResult(content: string): ToolResult {
  return { content, isError: true };
}

function editorCoherenceError(error?: unknown): ToolResult {
  const detail =
    error === undefined
      ? "an Editor buffer changed while orientation was running"
      : error instanceof Error
        ? error.message
        : String(error);
  return errorResult(
    `Orient error: authoritative Editor workspace contents are unavailable: ${detail}. Retry after Editor synchronization settles.`,
  );
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function clampMaxFiles(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.min(HARD_MAX_FILES, Math.max(1, Math.floor(v)));
  }
  return DEFAULT_MAX_FILES;
}

export interface OrientToolConfig {
  readonly allowedPaths: readonly string[];
  /** Test override for the ripgrep binary. Production uses the pinned runtime binary. */
  readonly ripgrepCommand?: string;
  /** Deterministic test seam for a revision change immediately before return. */
  readonly beforeAuthoritativeSnapshotValidation?: () => void | Promise<void>;
  /** Deterministic test seam immediately after the final path check. */
  readonly __testAfterFinalPathCheck?: () => void | Promise<void>;
  /** Deterministic test seam after admission but before capability binding. */
  readonly __testBeforeReadCapabilityBind?: () => void | Promise<void>;
  /** Test-only subprocess timeout override. */
  readonly __testRipgrepTimeoutMs?: number;
  /** Test-only subprocess output ceiling override. */
  readonly __testRipgrepMaxOutputBytes?: number;
  /** Deterministic test seam after root ignore bytes have been snapshotted. */
  readonly __testAfterRootIgnoreSnapshot?: () => void | Promise<void>;
}

function bigintStatIdentity(value: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
}): WorkspaceBoundReadIdentity {
  return {
    dev: value.dev.toString(10),
    ino: value.ino.toString(10),
    mode: value.mode.toString(10),
  };
}

export function createOrientTool(
  config: OrientToolConfig | Pick<FilesystemToolConfig, "allowedPaths">,
): Tool {
  const allowedPaths = config.allowedPaths;
  const ripgrepCommand =
    "ripgrepCommand" in config && typeof config.ripgrepCommand === "string"
      ? config.ripgrepCommand
      : selectPinnedRipgrepPath();
  const beforeAuthoritativeSnapshotValidation =
    "beforeAuthoritativeSnapshotValidation" in config
      ? config.beforeAuthoritativeSnapshotValidation
      : undefined;
  const afterFinalPathCheck =
    "__testAfterFinalPathCheck" in config
      ? config.__testAfterFinalPathCheck
      : undefined;
  const beforeReadCapabilityBind =
    "__testBeforeReadCapabilityBind" in config
      ? config.__testBeforeReadCapabilityBind
      : undefined;
  const ripgrepTimeoutMs =
    "__testRipgrepTimeoutMs" in config
      ? config.__testRipgrepTimeoutMs
      : undefined;
  const ripgrepMaxOutputBytes =
    "__testRipgrepMaxOutputBytes" in config
      ? config.__testRipgrepMaxOutputBytes
      : undefined;
  const afterRootIgnoreSnapshot =
    "__testAfterRootIgnoreSnapshot" in config
      ? config.__testAfterRootIgnoreSnapshot
      : undefined;

  return {
    name: ORIENT_TOOL_NAME,
    description: ORIENT_DESCRIPTION,
    metadata: {
      family: "search",
      source: "builtin",
      keywords: [
        "orient",
        "map",
        "localize",
        "where",
        "repo",
        "structure",
        "navigate",
      ],
      preferredProfiles: ["coding", "general", "operator"],
      hiddenByDefault: false,
      mutating: false,
      deferred: false,
    },
    isReadOnly: true,
    recoveryCategory: "idempotent",
    requiresApproval: false,
    isConcurrencySafe: () => true,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What you are trying to locate, in natural language (e.g. 'where is the retry/backoff logic', 'what handles task settlement'). Mention specific symbol or file names in backticks when known.",
        },
        path: {
          type: "string",
          description:
            "Optional. Subdirectory to scope the map to. Defaults to the workspace root.",
        },
        maxFiles: {
          type: "number",
          description: `Optional. Cap on source files scanned (default ${DEFAULT_MAX_FILES}, max ${HARD_MAX_FILES}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as OrientToolInput;
      const query = asNonEmptyString(args.query);
      if (query === undefined) {
        return errorResult("query must be a non-empty string");
      }
      if (ripgrepCommand === undefined) {
        return errorResult(PINNED_RIPGREP_UNAVAILABLE_MESSAGE);
      }
      const signal = args.__abortSignal;
      const effectiveAllowed = resolveToolAllowedPaths(allowedPaths, rawArgs);
      const requestedRoot = effectiveAllowed[0];
      if (requestedRoot === undefined) {
        return errorResult("Orient has no allowed workspace root configured");
      }
      const checkedRoot = await safePath(requestedRoot, effectiveAllowed);
      if (!checkedRoot.safe) {
        return errorResult(
          `Orient workspace root is unavailable: ${checkedRoot.reason ?? "denied"}`,
        );
      }
      const root = checkedRoot.resolved;
      const rootStat = await stat(root, { bigint: true }).catch(
        () => undefined,
      );
      if (rootStat === undefined || !rootStat.isDirectory()) {
        return errorResult("Orient workspace root is not a directory");
      }
      const rootIdentity = bigintStatIdentity(rootStat);

      // Resolve the (optional) scoped directory and enforce containment.
      let baseDir = root;
      let baseIdentity = rootIdentity;
      const rawPath = asNonEmptyString(args.path);
      if (rawPath !== undefined) {
        const candidate = isAbsolute(rawPath)
          ? rawPath
          : resolve(root, rawPath);
        const checked = await safePath(candidate, effectiveAllowed);
        if (!checked.safe) {
          return errorResult(
            `path is outside the allowed workspace: ${checked.reason ?? "denied"}`,
          );
        }
        baseDir = checked.resolved;
        const baseStat = await stat(baseDir, { bigint: true }).catch(
          () => undefined,
        );
        if (baseStat === undefined || !baseStat.isDirectory()) {
          return errorResult("Orient path is not a directory");
        }
        baseIdentity = bigintStatIdentity(baseStat);
      }
      let readCapability: WorkspaceBoundReadCapability | undefined;
      let ignoreReadCapability: WorkspaceBoundReadCapability | undefined;
      let toolOperation: WorkspaceToolOperationToken | undefined;
      const bindReadCapabilities = async (): Promise<void> => {
        await beforeReadCapabilityBind?.();
        readCapability = await bindWorkspaceDirectoryReadCapability(baseDir, {
          expectedIdentity: baseIdentity,
        });
        ignoreReadCapability =
          resolve(baseDir) === resolve(root)
            ? readCapability
            : await bindWorkspaceDirectoryReadCapability(root, {
                expectedIdentity: rootIdentity,
              });
      };
      try {
        toolOperation = beginWorkspaceReadToolOperation(
          root,
          ORIENT_TOOL_NAME,
        ).token;
        await bindReadCapabilities();
      } catch (error) {
        await ignoreReadCapability?.dispose().catch(() => {});
        await readCapability?.dispose().catch(() => {});
        if (toolOperation !== undefined) {
          endWorkspaceToolOperation(toolOperation);
        }
        return errorResult(
          `Orient error: authoritative Editor workspace files cannot be read safely: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      try {
        let authoritativeCapture: ReturnType<
          typeof captureWorkspaceAuthoritativeDirtySnapshots
        >;
        try {
          authoritativeCapture =
            captureWorkspaceAuthoritativeDirtySnapshots(baseDir, {
              includeDescendants: true,
            });
        } catch (error) {
          return editorCoherenceError(error);
        }
        const authoritativeSnapshots = authoritativeCapture.snapshots;
        await afterFinalPathCheck?.();
        const finalizeAuthoritativeResult = async (
          result: ToolResult,
        ): Promise<ToolResult> => {
          await beforeAuthoritativeSnapshotValidation?.();
          try {
            return authoritativeCapture.isCurrent()
              ? result
              : editorCoherenceError();
          } catch (error) {
            return editorCoherenceError(error);
          }
        };

        const cap = clampMaxFiles(args.maxFiles);
        let rootIgnoreFiles: Awaited<
          ReturnType<typeof discoverRipgrepRootIgnoreFiles>
        >;
        try {
          rootIgnoreFiles = await discoverRipgrepRootIgnoreFiles({
            searchRoot: baseDir,
            displayRoot: root,
            ...(ignoreReadCapability !== undefined
              ? { readCapability: ignoreReadCapability }
              : {}),
          });
        } catch (error) {
          return finalizeAuthoritativeResult(editorCoherenceError(error));
        }
        await afterRootIgnoreSnapshot?.();
        const enumerationLimit = cap + 1;
        const listed = await runRipgrepFiles({
          command: ripgrepCommand,
          pattern: SOURCE_GLOB,
          cwd: root,
          searchPath: relative(root, baseDir) || ".",
          toolArgs: rawArgs,
          limit: enumerationLimit,
          includeIgnored: false,
          rootIgnoreFiles,
          signal,
          ...(ignoreReadCapability !== undefined
            ? { readCapability: ignoreReadCapability }
            : {}),
          ...(ripgrepTimeoutMs !== undefined
            ? { timeoutMs: ripgrepTimeoutMs }
            : {}),
          ...(ripgrepMaxOutputBytes !== undefined
            ? { maxOutputBytes: ripgrepMaxOutputBytes }
            : {}),
        });
        if (signal?.aborted || listed.aborted) {
          return finalizeAuthoritativeResult(errorResult("Orient aborted"));
        }
        if (listed.spawnError) {
          return finalizeAuthoritativeResult(
            errorResult(
              listed.spawnError instanceof GrepBoundaryError
                ? `Orient error: ${formatRipgrepFilesError(listed.spawnError)}`
                : PINNED_RIPGREP_UNAVAILABLE_MESSAGE,
            ),
          );
        }
        if (
          listed.stopReason !== undefined &&
          listed.stopReason !== "consumer_limit"
        ) {
          const detail =
            listed.stopReason === "timeout"
              ? "ripgrep timed out"
              : listed.stopReason === "output_limit"
                ? "ripgrep exceeded the output safety limit"
                : `ripgrep stopped before enumeration completed (${listed.stopReason})`;
          return finalizeAuthoritativeResult(
            errorResult(`Orient error: ${detail}.`),
          );
        }
        const snapshotsByPath = new Map(
          authoritativeSnapshots.map((snapshot) => [
            normalizedAbsolutePath(snapshot.path),
            snapshot,
          ]),
        );
        const isIgnored = await createSearchIgnoreMatcher(root, {
          ...(ignoreReadCapability !== undefined
            ? { readCapability: ignoreReadCapability }
            : {}),
        });
        const dirtyRelPaths: string[] = [];
        for (const snapshot of authoritativeSnapshots) {
          const rel = normalizedRelativePath(relative(baseDir, snapshot.path));
          if (
            !isOrientSourcePath(rel) ||
            !isSafeOrientDisplayPath(rel) ||
            searchPathUsesDefaultExcludedDirectory(rel, false) ||
            (await isIgnored(snapshot.path))
          ) {
            continue;
          }
          dirtyRelPaths.push(rel);
        }
        dirtyRelPaths.sort((left, right) => left.localeCompare(right));
        const dirtyRelPathSet = new Set(
          dirtyRelPaths.map(normalizedRelativePath),
        );
        const candidatePaths = [
          ...dirtyRelPaths,
          ...listed.pathRecords
            .map((path) => decodeRipgrepPathBytes(path))
            .filter((path): path is string => path !== undefined)
            .filter(isSafeOrientDisplayPath)
            .map((path) => relative(baseDir, resolve(root, path)))
            .filter(
              (path) =>
                path.length > 0 &&
                path !== ".." &&
                !path.startsWith(`..${sep}`) &&
                !isAbsolute(path),
            )
            .filter(
              (path) => !dirtyRelPathSet.has(normalizedRelativePath(path)),
            ),
        ];
        const capExceeded =
          listed.killedAfterLimit || candidatePaths.length > cap;
        const relPaths = candidatePaths.slice(0, cap);
        if (relPaths.length === 0) {
          return finalizeAuthoritativeResult(
            textResult(
              "No source files found to orient over (after ignoring generated/build/vendored dirs).",
            ),
          );
        }

        const files = new Map<string, string>();
        for (const rel of relPaths) {
          if (signal?.aborted) {
            return finalizeAuthoritativeResult(errorResult("Orient aborted"));
          }
          const abs = resolve(baseDir, rel);
          const editorSnapshot = snapshotsByPath.get(
            normalizedAbsolutePath(abs),
          );
          if (editorSnapshot !== undefined) {
            files.set(rel, truncateSnapshotForOrient(editorSnapshot.content));
            continue;
          }
          try {
            if (readCapability !== undefined) {
              const result = await readCapability.readRelativeFile(
                rel,
                MAX_BYTES_PER_FILE,
                { truncate: true },
              );
              files.set(rel, result.content.toString("utf8"));
            } else {
              const res = await readFileInRange(
                abs,
                0,
                undefined,
                MAX_BYTES_PER_FILE,
                signal,
                { truncateOnByteLimit: true },
              );
              files.set(rel, res.content);
            }
          } catch {
            // unreadable/binary/vanished file — skip, it just won't be ranked.
          }
        }
        if (files.size === 0) {
          return finalizeAuthoritativeResult(
            textResult("No readable source files found to orient over."),
          );
        }

        const map = buildOrientationMap(files, query);
        const top = map.ranked.slice(0, MAX_RANKED);
        const rendered = map.render(MAP_TOKEN_BUDGET);

        const scopeNote =
          baseDir === root
            ? ""
            : ` under ${relative(root, baseDir) || "."}${sep}`;
        const cappedNote = capExceeded ? ` (capped at ${cap})` : "";
        const header =
          `Orientation map for: ${query}\n` +
          `Scanned ${files.size} source file(s)${scopeNote}${cappedNote}. ` +
          `Most relevant first — read these, don't bulk-scan:\n\n`;
        const body = top.map((p, i) => `${i + 1}. ${p}`).join("\n");
        const mapSection = rendered
          ? `\n\nKey symbols by file:\n${rendered}`
          : "";

        return finalizeAuthoritativeResult(
          textResult(header + body + mapSection, {
            fileCount: files.size,
            topFiles: top,
          }),
        );
      } finally {
        try {
          try {
            if (ignoreReadCapability !== readCapability) {
              await ignoreReadCapability?.dispose();
            }
          } finally {
            await readCapability?.dispose();
          }
        } finally {
          if (toolOperation !== undefined) {
            endWorkspaceToolOperation(toolOperation);
          }
        }
      }
    },
  };
}

function normalizedAbsolutePath(path: string): string {
  if (/^[A-Za-z]:[\\/]/u.test(path) || /^\\\\/u.test(path)) {
    return win32.normalize(path).toLowerCase().normalize("NFC");
  }
  // POSIX path spelling is identity. Canonical filesystem boundaries already
  // coalesce aliases when realpath proves they name the same existing entry.
  return resolve(path);
}

function normalizedRelativePath(path: string): string {
  const normalized =
    process.platform === "win32" ? path.replace(/\\/gu, "/") : path;
  return normalized;
}

function isSafeOrientDisplayPath(path: string): boolean {
  // The orientation map is line-oriented user output. Reject control-bearing
  // filenames instead of letting one filesystem record invent output lines.
  return !/[\u0000-\u001f\u007f]/u.test(path);
}

function isOrientSourcePath(path: string): boolean {
  const normalized = normalizedRelativePath(path);
  return (
    normalized.length > 0 &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !isAbsolute(path) &&
    SOURCE_EXTENSIONS.has(extname(normalized).toLowerCase())
  );
}

function truncateSnapshotForOrient(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= MAX_BYTES_PER_FILE) {
    return content;
  }
  const lines: string[] = [];
  let bytes = 0;
  for (const line of content.split(/\r?\n/u)) {
    const nextBytes =
      bytes + (lines.length === 0 ? 0 : 1) + Buffer.byteLength(line, "utf8");
    if (nextBytes > MAX_BYTES_PER_FILE) break;
    lines.push(line);
    bytes = nextBytes;
  }
  return lines.join("\n");
}
