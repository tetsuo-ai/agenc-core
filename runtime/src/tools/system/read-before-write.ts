import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { nonEmptyString } from "../../utils/stringUtils.js";
import { readToolRuntimeContext } from "../runtimes/context.js";
import type { ToolPreflightFailure } from "../types.js";
import { hasSessionRead, resolveSessionId } from "./filesystem.js";
import { mayProvePrintedRead } from "./printed-read-proof.js";

/** Keep the recovery instruction usable for both preflight and execute-time races. */
export function readBeforeWriteMessage(paths: readonly string[]): string {
  return "File has not been read yet. Read it first before writing to it. " +
    "Call FileRead for each file, then retry the edit: " +
    [...new Set(paths)].map(file_path => `FileRead(${JSON.stringify({ file_path })})`).join("; ");
}

/**
 * Reject a known missing prerequisite before permission evaluation. This only
 * inspects file identity/metadata, never file contents, and grants no authority.
 * Network paths, paths outside the trusted closure roots and symlinks defer to
 * permission arbitration without resolving their targets. Confinement, drift
 * and read checks still run at the write boundary.
 * The dispatcher attaches an authenticated runtime context before preflight;
 * internal callers without it use their injected session id as at execute time.
 */
export function unreadFilePreflight(
  args: Readonly<Record<string, unknown>>,
  paths: readonly string[],
  defaultCwd: string,
  allowedPaths: readonly string[],
): ToolPreflightFailure | null {
  const runtime = readToolRuntimeContext(args);
  const sessionId = nonEmptyString(runtime?.invocation.session.conversationId) ?? resolveSessionId(args);
  if (sessionId === undefined) return null;
  const cwd = nonEmptyString(args.cwd) ?? runtime?.invocation.turn.cwd ?? defaultCwd;
  // Match the permission guard before any filesystem operation. Check the raw
  // spellings first: resolve() can collapse a leading // on POSIX systems.
  if (isNetworkPath(cwd)) return null;
  const roots = allowedPaths.filter(root => !isNetworkPath(root)).map(root => resolve(root));
  const unread: string[] = [];
  for (const path of paths) {
    try {
      if (isNetworkPath(path)) continue;
      const absolute = resolve(cwd, path);
      if (!insideRoots(absolute, roots)) continue;
      // A local-looking operand can cross a junction or symlink into a share
      // or an unapproved directory. Inspect components without following links;
      // defer the whole target as soon as a link is encountered.
      let current = parse(absolute).root;
      let isFile = false;
      for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
        current = join(current, part);
        const entry = lstatSync(current);
        if (entry.isSymbolicLink()) { current = ""; break; }
        isFile = entry.isFile();
      }
      if (current !== absolute || !isFile) continue;
      const resolved = realpathSync(absolute);
      if (isNetworkPath(resolved) || !insideRoots(resolved, roots)) continue;
      // Match safePath: POSIX Unicode spellings retain their file identity.
      const canonical = process.platform === "win32" ? resolved.normalize("NFC") : resolved;
      // Missing files, directories and special files have separate execute-time
      // diagnostics. In particular, creation must not require an impossible read.
      // A file a kept exec_command result may show whole is proved, or refused, at execute time.
      if (!hasSessionRead(sessionId, canonical) && !mayProvePrintedRead(sessionId, canonical)) unread.push(canonical);
    } catch {
      // No known unmet read prerequisite. Existing path/permission gates decide.
    }
  }
  return unread.length === 0 ? null : { code: "file_read_required", message: readBeforeWriteMessage(unread) };
}

function isNetworkPath(path: string): boolean {
  return path.startsWith("\\\\") || path.startsWith("//");
}

function insideRoots(path: string, roots: readonly string[]): boolean {
  return roots.some(root => {
    const tail = relative(root, path);
    return tail === "" || (tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
  });
}
