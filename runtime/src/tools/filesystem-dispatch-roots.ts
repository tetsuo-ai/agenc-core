import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { withSignedAllowedRoots } from "./system/filesystem.js";

/**
 * The file tools the dispatcher may widen a root for, each with the argument
 * that names its file. NotebookEdit's schema has `notebook_path` and no
 * `file_path`.
 */
const APPROVED_FILE_PATH_ARGS: ReadonlyMap<string, string> = new Map([
  ["FileRead", "file_path"],
  ["Write", "file_path"],
  ["Edit", "file_path"],
  ["MultiEdit", "file_path"],
  ["NotebookEdit", "notebook_path"],
]);

/**
 * The search tools whose search root (`path`, or the directory an absolute
 * Glob pattern starts with) the dispatcher may widen a root for. Their root
 * is the directory itself, not its parent: `Glob path=/` must be allowed to
 * list `/`.
 */
const SEARCH_PATH_TOOLS: ReadonlySet<string> = new Set(["Glob", "Grep"]);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function approvedFilePathForTool(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const pathArg = APPROVED_FILE_PATH_ARGS.get(toolName);
  if (pathArg === undefined) return null;
  return nonEmptyString(args[pathArg]) ?? null;
}

/** The directory an absolute glob pattern is anchored at: everything before the first segment with a metacharacter. */
function globPatternBaseDirectory(pattern: string): string {
  const match = pattern.match(/[*?[{]/);
  if (!match || match.index === undefined) return dirname(pattern);
  const head = pattern.slice(0, match.index);
  const cut = head.lastIndexOf("/");
  return cut <= 0 ? "/" : head.slice(0, cut);
}

/** The search root a Glob or Grep call asks for, or null when it searches the workspace. */
function requestedSearchPath(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (!SEARCH_PATH_TOOLS.has(toolName)) return null;
  const explicit = nonEmptyString(args["path"]) ?? nonEmptyString(args["cwd"]);
  if (explicit !== undefined) return explicit;
  const pattern = nonEmptyString(args["pattern"]);
  if (toolName === "Glob" && pattern !== undefined && isAbsolute(pattern)) {
    return globPatternBaseDirectory(pattern);
  }
  return null;
}

type PermissionModeRegistryLike = {
  readonly current?: () => unknown;
};

/** The session shape the dispatcher can read a permission mode from. */
export type FilesystemRootSessionLike = {
  readonly permissionModeRegistry?: PermissionModeRegistryLike;
  readonly services?: {
    readonly permissionModeRegistry?: PermissionModeRegistryLike;
  };
};

export interface FilesystemRootDispatchParams {
  /** The approval resolver accepted this exact call. */
  readonly approvalResolved: boolean;
  /**
   * The root {@link approvalRootForDispatch} captured before the approval
   * prompt. An approval widens to exactly this root, never to one derived
   * from the path afterwards; without it an approval widens nothing.
   */
  readonly approvalRoot?: string | null;
  /** The sandbox mode this dispatch runs under (`danger_full_access` means none). */
  readonly sandboxMode?: string;
  readonly session?: FilesystemRootSessionLike | undefined;
}

function resolveFilePath(
  filePath: string,
  args: Record<string, unknown>,
): string {
  const cwd =
    typeof args["cwd"] === "string" && args["cwd"].trim().length > 0
      ? args["cwd"]
      : process.cwd();
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

function isInside(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The absolute path a file or search tool call names, or null when it names none. */
function requestedTarget(
  toolName: string,
  args: Record<string, unknown>,
): { readonly path: string; readonly isFile: boolean } | null {
  const filePath = approvedFilePathForTool(toolName, args);
  if (filePath !== null) {
    return { path: resolveFilePath(filePath, args), isFile: true };
  }
  const searchPath = requestedSearchPath(toolName, args);
  return searchPath === null
    ? null
    : { path: resolveFilePath(searchPath, args), isFile: false };
}

/**
 * `path` with every symlink in its longest existing prefix resolved and the
 * missing tail (a file about to be created) kept as written: the form the
 * tools' own confinement checks. Null when it cannot be resolved safely (a
 * loop, a permission error, a FIFO or a device).
 */
function canonicalPath(path: string): string | null {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      const stats = lstatSync(current);
      if (
        stats.isFIFO() ||
        stats.isSocket() ||
        stats.isCharacterDevice() ||
        stats.isBlockDevice()
      ) {
        return null;
      }
      const real = realpathSync(current);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** A file's directory, or a search path itself when it is a directory. */
function rootForCanonicalTarget(canonical: string, isFile: boolean): string {
  if (isFile) return dirname(canonical);
  try {
    return statSync(canonical).isDirectory() ? canonical : dirname(canonical);
  } catch {
    return dirname(canonical);
  }
}

/**
 * The root an approval of this call grants, captured before the prompt.
 *
 * It is resolved through symlinks now, while the permission decision that led
 * to the prompt still describes the filesystem. Signing the path's directory
 * after the prompt instead let a symlink retargeted while the prompt was open
 * carry an approved write into a directory nobody approved, because the
 * tool's confinement resolves a signed root through symlinks again when it
 * runs. Null when the call names no file or search path, or the path cannot
 * be resolved.
 */
export function approvalRootForDispatch(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const target = requestedTarget(toolName, args);
  if (target === null) return null;
  const canonical = canonicalPath(target.path);
  return canonical === null
    ? null
    : rootForCanonicalTarget(canonical, target.isFile);
}

/**
 * The permission context the session publishes (mode plus the directories the
 * user added), read the way the arbiter reads it; unreadable means unknown.
 */
function publishedPermissionContext(
  session: FilesystemRootSessionLike | undefined,
): { readonly mode?: unknown; readonly additionalWorkingDirectories?: unknown } | undefined {
  const registry =
    session?.permissionModeRegistry ?? session?.services?.permissionModeRegistry;
  if (registry === undefined || typeof registry.current !== "function") {
    return undefined;
  }
  try {
    const current = registry.current();
    return typeof current === "object" && current !== null
      ? (current as { readonly mode?: unknown; readonly additionalWorkingDirectories?: unknown })
      : undefined;
  } catch {
    return undefined;
  }
}

function addedDirectories(context: ReturnType<typeof publishedPermissionContext>): string[] {
  const directories = context?.additionalWorkingDirectories;
  if (!(directories instanceof Map)) return [];
  const roots: string[] = [];
  for (const entry of directories.values()) {
    const path = (entry as { readonly path?: unknown } | null)?.path;
    if (typeof path === "string" && path.trim().length > 0) roots.push(path.trim());
  }
  return roots;
}

/**
 * Hand a file tool the directory of the file it is about to touch, signed, so
 * its own confinement (the workspace root plus signed roots) accepts a path
 * the session has already allowed. An approval grants the root captured
 * before its prompt ({@link approvalRootForDispatch}). The same is owed when
 * no prompt ran: the path lies in a directory the user added (`--add-dir`, or
 * approved during the session), or the session bypasses approvals and runs
 * without a sandbox, where the evaluator is skipped and the tool's
 * confinement was the only thing left saying no (observed: "Path is outside
 * allowed directories" on FileRead /build/... and on `Glob path=/` under
 * --dangerously-bypass-approvals-and-sandbox with --add-dir /). Those roots
 * are the canonical directory, and an added directory must hold the resolved
 * path, not only its text, since a symlink inside it may lead anywhere.
 * Anything else leaves the args untouched, and tools without a file path
 * argument or a search path are never widened.
 */
export function filesystemRootsForDispatch(
  toolName: string,
  args: Record<string, unknown>,
  params: FilesystemRootDispatchParams,
): Record<string, unknown> {
  const target = requestedTarget(toolName, args);
  if (target === null) return args;
  if (params.approvalResolved && typeof params.approvalRoot === "string") {
    return withSignedAllowedRoots(args, [params.approvalRoot]);
  }
  const context = publishedPermissionContext(params.session);
  const fullBypass =
    context?.mode === "bypassPermissions" &&
    params.sandboxMode === "danger_full_access";
  const added = fullBypass ? [] : addedDirectories(context);
  if (!fullBypass && added.length === 0) return args;
  const canonical = canonicalPath(target.path);
  if (canonical === null) return args;
  const widen = (): Record<string, unknown> =>
    withSignedAllowedRoots(args, [
      rootForCanonicalTarget(canonical, target.isFile),
    ]);
  if (fullBypass) return widen();
  const inAddedDirectory = added.some((directory) => {
    const canonicalDirectory = canonicalPath(resolve(directory));
    return canonicalDirectory !== null && isInside(canonical, canonicalDirectory);
  });
  return inAddedDirectory ? widen() : args;
}
