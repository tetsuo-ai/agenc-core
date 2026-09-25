/**
 * A subagent isolated in a git worktree writes files inside that worktree only.
 *
 * Worktree isolation exists so the parent's checkout does not change: the
 * verified-change workflow (Goal) builds every change in its own worktree
 * and promises that the user's checkout is never mutated. But a worktree
 * child's file tools are the parent's, bound to the parent's workspace root:
 * `injectChildToolArgs` adds the worktree to their allowed roots and
 * `resolveToolAllowedPaths` unions it with the root the tool was built with.
 * So a Write to `<checkout>/src/slug.js` counted as inside the workspace, was
 * auto-approved under acceptEdits, and landed in the user's files (Goal E2E
 * run wf-97c581d7, 2026-09-25, whose worktree came from an empty base).
 *
 * This is the refusal both places a child's call goes through apply: the
 * permission check (so no approval card is shown and bypass cannot skip it,
 * a tool's own deny is bypass-immune) and the execution preparation.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { getDurableMemoryRoots } from "../memory/paths.js";
import { parsePatch } from "../tools/apply-patch/parser.js";
import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ALLOWED_ROOTS_SIG_ARG,
  verifyAllowedRoots,
} from "./_deps/filesystem-args.js";

/** The file tools that create, change or delete a file at a path they are given. */
const PATH_WRITE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
};
const APPLY_PATCH_TOOL = "apply_patch";

/** Whether a tool writes files at paths it is given, which a worktree child may only do inside its worktree. */
export function isWorktreeConfinedWriteTool(toolName: string): boolean {
  return PATH_WRITE_TOOLS[toolName] !== undefined || toolName === APPLY_PATCH_TOOL;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * The real location a path would be written to: symlinks in the part that
 * already exists are followed, so a link inside the worktree that points
 * back into the checkout does not count as inside.
 */
function realTarget(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
    existing = parent;
  }
  try {
    return resolve(realpathSync(existing), ...rest);
  } catch {
    return path;
  }
}

/** A root measured the same way as the targets, so a root that does not exist yet still matches. */
function realRoot(root: string): string {
  return realTarget(resolve(root));
}

/** Where a call would write, as absolute paths; undefined for a call that is not a file write. */
function writeTargets(
  toolName: string,
  args: Record<string, unknown>,
  base: string,
): readonly { readonly given: string; readonly absolute: string }[] | undefined {
  const fields = PATH_WRITE_TOOLS[toolName];
  if (fields !== undefined) {
    return fields
      .map((field) => args[field])
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((given) => ({ given, absolute: resolve(base, given) }));
  }
  if (toolName === APPLY_PATCH_TOOL) {
    const patch = args.input;
    if (typeof patch !== "string" || patch.trim().length === 0) return [];
    try {
      const parsed = parsePatch(patch);
      const patchBase = parsed.workdir !== null ? resolve(base, parsed.workdir) : base;
      return parsed.hunks
        .flatMap((hunk) => [hunk.path, ...(hunk.kind === "update" && typeof hunk.movePath === "string" ? [hunk.movePath] : [])])
        .map((given) => ({ given, absolute: resolve(patchBase, given) }));
    } catch {
      // The tool itself reports a patch it cannot parse; nothing is written.
      return [];
    }
  }
  return undefined;
}

/**
 * The refusal for a worktree child's file write that lands outside its
 * worktree, or undefined when the call is not such a write.
 */
export function worktreeWriteRefusal(
  toolName: string,
  input: unknown,
  worktreePath: string | undefined,
): string | undefined {
  if (worktreePath === undefined || worktreePath.length === 0) return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const args = input as Record<string, unknown>;
  const base = typeof args.cwd === "string" && args.cwd.trim().length > 0 ? args.cwd : worktreePath;
  const targets = writeTargets(toolName, args, base);
  if (targets === undefined || targets.length === 0) return undefined;
  // Besides the worktree: roots a trusted child-tool policy signed into this
  // call (a session memory directory, for example) and durable memory. The
  // parent's own workspace root is not among them: it is the tool's closure
  // root, which is exactly what let the child write into the checkout.
  const roots = [
    worktreePath,
    ...verifyAllowedRoots(args[SESSION_ALLOWED_ROOTS_ARG], args[SESSION_ALLOWED_ROOTS_SIG_ARG]),
    ...getDurableMemoryRoots(),
  ].map((root) => ({ lexical: resolve(root), real: realRoot(root) }));
  for (const { given, absolute } of targets) {
    const real = realTarget(absolute);
    if (roots.some((root) => isInside(absolute, root.lexical) && isInside(real, root.real))) continue;
    return `This agent works in its own git worktree (${worktreePath}); ${given} is outside it. ` +
      "Write inside the worktree: files outside it belong to the checkout the worktree isolates, and they must not change.";
  }
  return undefined;
}
