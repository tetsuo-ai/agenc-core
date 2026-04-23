/**
 * `/diff` — show `git diff HEAD` + untracked files.
 *
 * Shells out via `child_process.spawn` with a 5s timeout to guard
 * against a hung git. Returns `"not a git repository"` if the cwd has
 * no `.git` directory in the ancestor chain (detected by running
 * `git rev-parse --is-inside-work-tree`; non-zero exit treated as
 * "not a repo").
 *
 * @module
 */

import { spawn } from "node:child_process";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

const GIT_TIMEOUT_MS = 5_000;

interface GitResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Run `git <args>` in `cwd` with a timeout. Kept as an internal helper
 * so tests can swap the whole diff command via dependency injection.
 */
export function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", [...args], { cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

/** Exported for injection from tests. */
export interface DiffDeps {
  runGit: typeof runGit;
}

export async function computeDiff(
  cwd: string,
  deps: DiffDeps = { runGit },
): Promise<SlashCommandResult> {
  // Check if we're in a git repo.
  const check = await deps.runGit(
    ["rev-parse", "--is-inside-work-tree"],
    cwd,
  );
  if (check.code !== 0 || check.timedOut) {
    return { kind: "text", text: "not a git repository" };
  }

  const diff = await deps.runGit(["diff", "HEAD"], cwd);
  const untracked = await deps.runGit(
    ["ls-files", "--others", "--exclude-standard"],
    cwd,
  );

  const parts: string[] = [];
  const diffOut = diff.stdout.trimEnd();
  if (diffOut.length > 0) {
    parts.push("# git diff HEAD");
    parts.push(diffOut);
  } else {
    parts.push("# git diff HEAD");
    parts.push("(no changes)");
  }

  const untrackedLines = untracked.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  parts.push("");
  parts.push("# untracked files");
  if (untrackedLines.length === 0) {
    parts.push("(none)");
  } else {
    for (const f of untrackedLines) parts.push(`  ${f}`);
  }

  return { kind: "text", text: parts.join("\n") };
}

export const diffCommand: SlashCommand = {
  name: "diff",
  description: "Show uncommitted changes (git diff HEAD + untracked files)",
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(() => computeDiff(ctx.cwd)),
};

export default diffCommand;
