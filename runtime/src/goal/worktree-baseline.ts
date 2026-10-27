import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readlink, realpath, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, join } from "node:path";
import { runGit } from "../utils/git.js";
import { syncDirectory } from "../utils/durable-atomic-file.js";
import { getAgenCHomeDir } from "../utils/envUtils.js";
import type { GoalBaselineFile, GoalFileIdentity, GoalWorkingTreeBaseline } from "./goal.js";

async function git(args: readonly string[], cwd: string): Promise<string> {
  const result = await runGit(["-c", "core.fsmonitor=false", "-c", "diff.relative=false", ...args], cwd);
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    throw new Error("The goal working-tree baseline could not be read completely.");
  }
  return result.stdout;
}

async function repositoryRoot(cwd: string): Promise<string> {
  const output = await git(["rev-parse", "--show-toplevel"], cwd);
  return realpath(output.endsWith("\n") ? output.slice(0, -1) : output);
}

async function paths(root: string, baseCommit: string) {
  const [tracked, untracked] = await Promise.all([
    git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", baseCommit, "--"], root),
    git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"], root),
  ]);
  const parse = (output: string): string[] => {
    if (output.length > 0 && !output.endsWith("\0")) throw new Error("Incomplete goal baseline path list.");
    return [...new Set(output.split("\0").filter(Boolean))].sort();
  };
  return { tracked: parse(tracked), untracked: parse(untracked) };
}

export async function readGoalFileIdentity(root: string, path: string, contentOutput?: string): Promise<GoalFileIdentity | null> {
  if (!path || isAbsolute(path) || /^[A-Za-z]:/u.test(path) || path.split(/[\\/]/u).some(part => part === ".." || part === ".")) {
    throw new Error("Invalid goal baseline path.");
  }
  const absolute = resolve(root, path);
  let before: BigIntStats;
  try {
    const parent = await realpath(dirname(absolute));
    const outside = relative(root, parent);
    if (isAbsolute(outside) || outside === ".." || outside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error("Goal baseline path leaves the repository.");
    }
    before = await lstat(absolute, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const hash = createHash("sha256");
  const stable = (after: typeof before) => before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
  const output = contentOutput === undefined ? undefined : await open(contentOutput, "wx", 0o600);
  const consume = async (chunk: Buffer): Promise<void> => {
    hash.update(chunk);
    await output?.writeFile(chunk);
  };
  try {
    if (before.isSymbolicLink()) {
      await consume(await readlink(absolute, { encoding: "buffer" }));
      if (!stable(await lstat(absolute, { bigint: true }))) throw new Error("A file changed while reading the goal baseline.");
      return { kind: "symlink", mode: Number(before.mode & 0o7777n), sha256: hash.digest("hex") };
    }
    if (!before.isFile()) throw new Error("Unsupported file type in goal baseline.");
    const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!stable(await file.stat({ bigint: true }))) throw new Error("A file changed while opening the goal baseline.");
      for await (const chunk of file.createReadStream({ autoClose: false })) await consume(chunk);
      if (!stable(await file.stat({ bigint: true })) || !stable(await lstat(absolute, { bigint: true }))) {
        throw new Error("A file changed while reading the goal baseline.");
      }
      return { kind: "file", mode: Number(before.mode & 0o7777n), sha256: hash.digest("hex") };
    } finally {
      await file.close();
    }
  } finally {
    await output?.close();
  }
}

export function goalBaselineBlobName(sha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("Invalid goal baseline content identity.");
  return `.goal-baseline-${sha256}.blob`;
}

export async function captureGoalWorkingTreeBaseline(cwd: string, baseCommit: string | undefined, agencHome = getAgenCHomeDir()): Promise<GoalWorkingTreeBaseline | undefined> {
  if (baseCommit === undefined) return undefined;
  const root = await repositoryRoot(cwd);
  await mkdir(agencHome, { recursive: true, mode: 0o700 });
  const listed = await paths(root, baseCommit);
  const capture = async (list: readonly string[], untracked = false): Promise<GoalBaselineFile[]> => {
    const files: GoalBaselineFile[] = [];
    for (const path of list) {
      const temporary = join(agencHome, `.goal-baseline-${randomUUID()}.tmp`);
      let value: GoalFileIdentity | null;
      try {
        value = await readGoalFileIdentity(root, path, temporary);
        if (value !== null) {
          const stored = await open(temporary, "r");
          try { await stored.sync(); } finally { await stored.close(); }
          await rename(temporary, join(agencHome, goalBaselineBlobName(value.sha256)));
          // The bytes and their directory entry precede the durable goal event.
          await syncDirectory(agencHome);
        }
      } finally {
        await rm(temporary, { force: true });
      }
      if (untracked && value === null) throw new Error("An untracked file disappeared while capturing the goal baseline.");
      files.push({ path, identity: value });
    }
    return files;
  };
  const baseline = { version: 2 as const, trackedChanges: await capture(listed.tracked), untrackedFiles: await capture(listed.untracked, true) };
  if (JSON.stringify(listed) !== JSON.stringify(await paths(root, baseCommit))) {
    throw new Error("The working tree changed while capturing the goal baseline. Try setting the goal again.");
  }
  return baseline;
}

export async function changedGoalWorkingTreePaths(cwd: string, baseCommit: string, baseline: GoalWorkingTreeBaseline): Promise<readonly string[]> {
  const root = await repositoryRoot(cwd);
  const current = await paths(root, baseCommit);
  const before = new Map([...baseline.trackedChanges, ...baseline.untrackedFiles].map(entry => [entry.path, entry.identity]));
  const candidates = new Set([...current.tracked, ...current.untracked, ...before.keys()]);
  const changed: string[] = [];
  for (const path of [...candidates].sort()) {
    if (!before.has(path)) {
      changed.push(path);
      continue;
    }
    const previous = before.get(path)!;
    const currentIdentity = await readGoalFileIdentity(root, path);
    const same = previous === null || currentIdentity === null
      ? previous === currentIdentity
      : previous.kind === currentIdentity.kind && previous.mode === currentIdentity.mode && previous.sha256 === currentIdentity.sha256;
    if (!same) changed.push(path);
  }
  return changed;
}
