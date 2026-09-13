import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { withSignedAllowedRoots } from "./system/filesystem.js";

/** The file tools whose `file_path` the dispatcher may widen a root for. */
const APPROVED_FILE_PATH_TOOLS: ReadonlySet<string> = new Set([
  "FileRead",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
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
  if (!APPROVED_FILE_PATH_TOOLS.has(toolName)) return null;
  return nonEmptyString(args["file_path"]) ?? null;
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
 * the session has already allowed. An approval always did this. The same is
 * owed when no prompt ran: the path lies in a directory the user added
 * (`--add-dir`, or approved during the session), or the session bypasses
 * approvals and runs without a sandbox, where the evaluator is skipped and
 * the tool's confinement was the only thing left saying no (observed:
 * "Path is outside allowed directories" on FileRead /build/... and on
 * `Glob path=/` under --dangerously-bypass-approvals-and-sandbox with
 * --add-dir /). Anything else leaves the args untouched, and tools without a
 * `file_path` or a search path are never widened.
 */
export function filesystemRootsForDispatch(
  toolName: string,
  args: Record<string, unknown>,
  params: FilesystemRootDispatchParams,
): Record<string, unknown> {
  const filePath = approvedFilePathForTool(toolName, args);
  const searchPath = filePath === null ? requestedSearchPath(toolName, args) : null;
  if (filePath === null && searchPath === null) return args;
  const resolvedPath = resolveFilePath((filePath ?? searchPath)!, args);
  const rootForPath = (): string => {
    if (filePath !== null) return dirname(resolvedPath);
    try {
      return statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath);
    } catch {
      return dirname(resolvedPath);
    }
  };
  const widen = (): Record<string, unknown> =>
    withSignedAllowedRoots(args, [rootForPath()]);
  if (params.approvalResolved) return widen();
  const context = publishedPermissionContext(params.session);
  if (
    context?.mode === "bypassPermissions" &&
    params.sandboxMode === "danger_full_access"
  ) {
    return widen();
  }
  if (addedDirectories(context).some((root) => isInside(resolvedPath, root))) {
    return widen();
  }
  return args;
}
