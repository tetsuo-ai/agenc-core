import { closeSync, openSync, writeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgenCHomeDir } from "../utils/envUtils.js";
import { gitExe, runGit } from "../utils/git.js";
import { runSupervisedProcess } from "../utils/supervisedProcess.js";
import type { GoalFileIdentity, GoalWorkingTreeBaseline } from "./goal.js";
import { changedGoalWorkingTreePaths, goalBaselineBlobName, readGoalFileIdentity } from "./worktree-baseline.js";

const MAX_DIFF_CHARACTERS = 60_000;
const MAX_BLOB_BYTES = 512 * 1024 * 1024;

async function copyGitBlob(root: string, sha: string, destination: string): Promise<void> {
  const descriptor = openSync(destination, "wx", 0o600);
  let bytes = 0;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  try {
    const result = await runSupervisedProcess({ program: gitExe(), args: ["cat-file", "blob", sha], cwd: root, env }, {
      timeoutMs: 30_000,
      maxOutputBytes: 16_000,
      captureStdout: false,
      onStdout(chunk, control) {
        bytes += chunk.length;
        if (bytes > MAX_BLOB_BYTES) { control.stop(); return; }
        let at = 0;
        while (at < chunk.length) at += writeSync(descriptor, chunk, at, chunk.length - at);
      },
    });
    if (result.exitCode !== 0 || result.stopReason !== undefined || result.error !== undefined || result.backstopExpired || result.processTreeCleanupProven === false) {
      throw new Error("The goal diff's starting Git content could not be read completely.");
    }
  } finally { closeSync(descriptor); }
}

async function gitEntry(root: string, commit: string, path: string): Promise<{ identity: GoalFileIdentity; objectId: string } | null> {
  const result = await runGit(["--literal-pathspecs", "ls-tree", "-z", "--full-tree", commit, "--", path], root);
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) throw new Error("The goal diff's starting tree could not be read completely.");
  if (result.stdout === "") return null;
  const match = result.stdout.match(/^([0-7]{6}) blob ([0-9a-f]{40,64})\t([\s\S]*)\0$/u);
  if (!match || match[3] !== path) throw new Error("Unsupported starting entry in the goal diff.");
  return {
    objectId: match[2]!,
    identity: { kind: match[1] === "120000" ? "symlink" : "file", mode: match[1] === "120000" ? 0o777 : match[1] === "100755" ? 0o755 : 0o644, sha256: "" },
  };
}

async function materializeKind(path: string, identity: GoalFileIdentity): Promise<void> {
  if (identity.kind === "symlink") {
    const target = await readFile(path);
    await unlink(path);
    await symlink(target, path);
  } else {
    // Git records the executable bit; do not recreate setuid/sticky permissions.
    await chmod(path, identity.mode & 0o111 ? 0o700 : 0o600);
  }
}

/** Compare only the goal's changes, including untracked bytes, without touching the repository's index or refs. */
export async function goalWorkingTreeDiff(cwd: string, baseCommit: string, baseline: GoalWorkingTreeBaseline, agencHome = getAgenCHomeDir()): Promise<{ stat: string; diff: string }> {
  const rootResult = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (rootResult.code !== 0 || rootResult.timedOut || rootResult.stdoutTruncated) throw new Error("The goal repository could not be resolved.");
  const root = await realpath(rootResult.stdout.replace(/\n$/u, ""));
  const changed = await changedGoalWorkingTreePaths(cwd, baseCommit, baseline);
  if (changed.length === 0) return { stat: "", diff: "" };
  const contentHome = await realpath(agencHome);
  const original = new Map([...baseline.trackedChanges, ...baseline.untrackedFiles].map(entry => [entry.path, entry.identity]));
  const temporary = await mkdtemp(join(contentHome, ".goal-diff-"));
  const beforeRoot = join(temporary, "before");
  const afterRoot = join(temporary, "after");
  const summary: string[] = [];
  try {
    await mkdir(beforeRoot); await mkdir(afterRoot);
    for (const path of changed) {
      const before = join(beforeRoot, path);
      const after = join(afterRoot, path);
      await mkdir(dirname(before), { recursive: true });
      await mkdir(dirname(after), { recursive: true });
      let prior: GoalFileIdentity | null;
      if (original.has(path)) {
        prior = original.get(path)!;
        if (prior !== null) {
          if (baseline.version !== 2) throw new Error(`This older goal did not retain starting contents for ${path}. Set a new goal before changing that file.`);
          const stored = await readGoalFileIdentity(contentHome, goalBaselineBlobName(prior.sha256), before);
          if (stored === null || stored.kind !== "file" || stored.sha256 !== prior.sha256) {
            throw new Error(`The durable goal baseline content is missing or corrupt for ${path}.`);
          }
        }
      } else {
        const entry = await gitEntry(root, baseCommit, path);
        prior = entry?.identity ?? null;
        if (entry !== null) await copyGitBlob(root, entry.objectId, before);
      }
      const current = await readGoalFileIdentity(root, path, after);
      if (prior !== null) await materializeKind(before, prior);
      if (current !== null) await materializeKind(after, current);
      summary.push(`${path}: ${prior === null ? "added" : current === null ? "deleted" : "changed"}`);
      if (original.has(path) && prior !== null && current !== null && prior.mode !== current.mode) {
        summary.push(`  file mode ${prior.mode.toString(8)} -> ${current.mode.toString(8)}`);
      }
    }
    const result = await runGit(["-c", "core.fsmonitor=false", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--binary", "--src-prefix=a/", "--dst-prefix=b/", "before", "after"], temporary);
    if ((result.code !== 0 && result.code !== 1) || result.timedOut || result.stdoutTruncated) throw new Error("The goal's working-tree diff could not be read completely.");
    // Preserve Git's quoted paths verbatim. The two relative tree names are
    // the baseline and current snapshot, not paths in the user's repository.
    const diff = result.stdout;
    return {
      stat: summary.join("\n"),
      diff: diff.length > MAX_DIFF_CHARACTERS ? `${diff.slice(0, MAX_DIFF_CHARACTERS)}\n[diff truncated at ${MAX_DIFF_CHARACTERS} characters]` : diff.trimEnd(),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
