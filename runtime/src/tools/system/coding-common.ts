import { readdir, stat } from "node:fs/promises";
import {
  dirname,
  join,
  resolve as resolvePath,
} from "node:path";

import {
  SESSION_ID_ARG,
  SESSION_ID_SIG_ARG,
  verifySessionId,
} from "../../agents/_deps/filesystem-args.js";
import {
  isSessionPlanFile,
  type PlanFileContext,
} from "../../planning/plan-files.js";
import type { Logger } from "../../utils/logger.js";
import { runCommand } from "../../utils/process.js";
import type { Tool, ToolCatalogEntry, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import {
  canonicalizePath,
  resolveToolAllowedPaths,
  safePath,
} from "./filesystem.js";

/**
 * Optional plan-file allowlist context derived from injected tool args.
 * When the dispatcher injects `__agencSessionId`, the filesystem tools
 * can resolve the active session's plan file path via plan-files.ts and
 * allowlist it regardless of the workspace allowlist — mirrors
 * AgenC's `checkEditableInternalPath` carve-out
 * (utils/permissions/filesystem.ts:1488-1506).
 *
 * SECURITY: this carve-out grants a WRITE target outside the workspace
 * allowlist, so the session id must come from a TRUSTED source. We verify
 * the HMAC signature ({@link verifySessionId}) the runtime attaches via
 * `withSignedSessionId`; an unsigned/forged `__agencSessionId` (e.g. a
 * model-supplied value) verifies as absent and yields no carve-out.
 */
function planFileContextFromArgs(
  args: Record<string, unknown>,
): PlanFileContext | null {
  const verified = verifySessionId(args[SESSION_ID_ARG], args[SESSION_ID_SIG_ARG]);
  const sessionId =
    typeof verified === "string" && verified.trim().length > 0 ? verified : null;
  if (sessionId === null) return null;
  const ctx: PlanFileContext = { sessionId };
  if (
    typeof process.env.AGENC_HOME === "string" &&
    process.env.AGENC_HOME.length > 0
  ) {
    return { ...ctx, agencHome: process.env.AGENC_HOME };
  }
  return ctx;
}

/**
 * True when `targetPath` belongs to the active session's plan-file
 * family AND the request carries enough session context to identify it.
 * Centralises the "is this a plan-file write that bypasses the
 * workspace allowlist" decision so writeFile / appendFile / editFile /
 * mkdir / delete / move all stay in sync.
 */
function isPlanFileWriteAllowed(
  args: Record<string, unknown>,
  targetPath: string,
): boolean {
  const ctx = planFileContextFromArgs(args);
  if (ctx === null) return false;
  return isSessionPlanFile(targetPath, ctx);
}

export const SESSION_ADVERTISED_TOOL_NAMES_ARG = "__agencAdvertisedToolNames";

export interface CodingToolConfig {
  readonly allowedPaths: readonly string[];
  readonly persistenceRootDir: string;
  readonly logger?: Logger;
  readonly getToolCatalog?: () => readonly ToolCatalogEntry[];
  readonly onDiscoverTools?: (toolNames: readonly string[]) => void;
  /**
   * Enable heavier AgenC-owned structured tools:
   * system.repoInventory, system.git*, system.symbol*.
   */
  readonly codeIntelligenceTools?: boolean;
}

export const MAX_RESULTS = 200;
export const MAX_DIFF_BYTES = 256_000;
export const MANIFEST_NAMES = [
  "package.json",
  "tsconfig.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Makefile",
  "README.md",
] as const;

export function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

export function okResult(data: unknown): ToolResult {
  return { content: safeStringify(data) };
}

export function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

export function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function toOptionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

export async function resolveWorkspacePath(params: {
  readonly config: CodingToolConfig;
  readonly args: Record<string, unknown>;
  readonly pathArgKeys?: readonly string[];
}): Promise<string | { error: string }> {
  const rawPath = params.pathArgKeys
    ?.map((key) => toOptionalString(params.args[key]))
    .find((value): value is string => typeof value === "string") ??
    toOptionalString(params.args.cwd);

  if (!rawPath) {
    return { error: "path is required when no default working directory is available" };
  }
  const allowedPaths = resolveToolAllowedPaths(params.config.allowedPaths, params.args);
  const safe = await safePath(rawPath, allowedPaths);
  if (safe.safe) return safe.resolved;

  // Plan-file allowlist (AgenC behavior, filesystem.ts:1488-1506).
  // When the rejection is for a path outside the workspace AND the
  // target is the active session's plan file, allow it — that's the
  // only writable target outside the workspace root, and the same
  // carve-out applies in plan mode and outside (mode-agnostic, matches
  // AgenC's `checkEditableInternalPath` which has no mode gate).
  // Defence-in-depth: still reject the obvious unsafe shapes that
  // safePath would have caught (null bytes, traversal, length).
  if (
    typeof rawPath !== "string" ||
    rawPath.length === 0 ||
    rawPath.includes("\0") ||
    /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(rawPath)
  ) {
    return { error: safe.reason ?? "Path is outside allowed directories" };
  }
  try {
    const canonical = (await canonicalizePath(rawPath)).normalize("NFC");
    if (isPlanFileWriteAllowed(params.args, canonical)) {
      return canonical;
    }
  } catch {
    // canonicalize threw — fall through to the original rejection.
  }
  return { error: safe.reason ?? "Path is outside allowed directories" };
}

export async function resolveRepoRoot(params: {
  readonly config: CodingToolConfig;
  readonly args: Record<string, unknown>;
  readonly pathArgKeys?: readonly string[];
}): Promise<string | { error: string }> {
  const workspacePath = await resolveWorkspacePath(params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  const target = await stat(workspacePath).catch(() => undefined);
  const cwd = target?.isDirectory() ? workspacePath : dirname(workspacePath);
  const result = await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    cwd,
  });
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    return { error: `No git repository found for ${cwd}` };
  }
  return resolvePath(result.stdout.trim());
}

export async function listRepoFiles(repoRoot: string): Promise<readonly string[]> {
  const gitFiles = await runCommand(
    "git",
    ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot },
  );
  if (gitFiles.exitCode === 0) {
    return gitFiles.stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => resolvePath(repoRoot, entry));
  }

  const files: string[] = [];
  const stack = [repoRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

export type ParsedGitWorktree = {
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
};

export function parseWorktreePorcelain(stdout: string): readonly ParsedGitWorktree[] {
  return stdout
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      return {
        path: lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? "",
        branch: lines.find((line) => line.startsWith("branch "))?.slice(7) ?? null,
        head: lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? null,
        detached: lines.includes("detached"),
        bare: lines.includes("bare"),
      };
    });
}

export function parseStatusPorcelain(stdout: string): {
  readonly branch?: string;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly detached: boolean;
  readonly changed: readonly {
    path: string;
    x: string;
    y: string;
  }[];
} {
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let detached = false;
  const changed: {
    path: string;
    x: string;
    y: string;
  }[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const branchLine = line.slice(3).trim();
      const [headPart, trackingPart] = branchLine.split("...");
      if (headPart === "HEAD (no branch)" || headPart === "HEAD") {
        detached = true;
      } else {
        branch = headPart;
      }
      if (trackingPart) {
        const trackingMatch = /^(\S+?)(?:\s+\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?$/.exec(
          trackingPart.trim(),
        );
        if (trackingMatch) {
          upstream = trackingMatch[1]?.trim() || undefined;
          ahead = Number(trackingMatch[2] ?? 0);
          behind = Number(trackingMatch[3] ?? 0);
        }
      }
      continue;
    }
    const prefix = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (path.length === 0) continue;
    changed.push({ path, x: prefix[0] ?? " ", y: prefix[1] ?? " " });
  }

  return { branch, upstream, ahead, behind, detached, changed };
}

export function summarizeChanges(changed: readonly {
  path: string;
  x: string;
  y: string;
}[]): Record<string, readonly string[]> {
  const staged = changed.filter((entry) => entry.x !== " ").map((entry) => entry.path);
  const unstaged = changed.filter((entry) => entry.y !== " ").map((entry) => entry.path);
  const untracked = changed
    .filter((entry) => entry.x === "?" || entry.y === "?")
    .map((entry) => entry.path);
  const conflicted = changed
    .filter((entry) => "AUUDDC".includes(entry.x) || "AUUDDC".includes(entry.y))
    .map((entry) => entry.path);
  return {
    staged,
    unstaged,
    untracked,
    conflicted,
  };
}

export function codingToolMetadata(
  name: string,
  mutating = false,
  preferredProfiles: readonly string[] = ["coding", "validation", "documentation"],
  opts: {
    readonly family?: string;
    readonly deferred?: boolean;
    readonly keywords?: readonly string[];
  } = {},
): Tool["metadata"] {
  return {
    family: opts.family ?? "coding",
    source: "builtin",
    preferredProfiles,
    mutating,
    keywords: [
      ...name.split(".").filter((part) => part.length > 0),
      ...(opts.keywords ?? []),
    ],
    hiddenByDefault: false,
    ...(opts.deferred === true ? { deferred: true } : {}),
  };
}
