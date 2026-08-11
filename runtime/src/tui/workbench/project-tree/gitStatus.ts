import { execFile } from "node:child_process";

import type { ProjectTreeGitBranch, ProjectTreeGitState } from "../types.js";

export type GitStatusByPath = ReadonlyMap<string, ProjectTreeGitState>;

export function parseGitStatusPorcelain(raw: string): Map<string, ProjectTreeGitState> {
  const out = new Map<string, ProjectTreeGitState>();
  for (const line of raw.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const pathPart = line.slice(3);
    if (!pathPart) continue;
    const path = normalizePorcelainPath(pathPart);
    out.set(path, statusForCode(code));
  }
  return out;
}

function parseGitStatusPorcelainZ(raw: string): Map<string, ProjectTreeGitState> {
  const out = new Map<string, ProjectTreeGitState>();
  const fields = raw.split("\0");
  for (let index = 0; index < fields.length;) {
    const entry = fields[index++]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) out.set(path, statusForCode(code));
    if (isRenameOrCopyCode(code)) index += 1;
  }
  return out;
}

export function collectGitStatus(cwd: string): Promise<Map<string, ProjectTreeGitState>> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd, encoding: "utf8", timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          resolve(new Map());
          return;
        }
        resolve(parseGitStatusPorcelainZ(stdout));
      },
    );
  });
}

/**
 * Branch identity for the explorer footer, read on the same refresh as the
 * per-file states so the panel never shows a branch from a previous checkout.
 *
 * `--porcelain=v2 --branch` returns the branch, the head sha and the upstream
 * divergence in ONE call, so adding the footer costs no extra git invocation
 * beyond the one this module already makes. Resolves to null outside a
 * repository, which is how the footer decides to render nothing at all.
 */
export function collectGitBranch(
  cwd: string,
): Promise<ProjectTreeGitBranch | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
      { cwd, encoding: "utf8", timeout: 5_000 },
      (error, stdout) => {
        resolve(error ? null : parseGitBranchPorcelainV2(stdout));
      },
    );
  });
}

export function parseGitBranchPorcelainV2(
  raw: string,
): ProjectTreeGitBranch | null {
  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  let dirtyCount = 0;
  let sawHeader = false;

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith("# branch.")) {
      sawHeader = true;
      const [key, ...rest] = line.slice(2).split(" ");
      const value = rest.join(" ");
      // git spells a detached HEAD "(detached)" and an unborn branch
      // "(initial)"; neither is a branch name a user could check out.
      if (key === "branch.head") {
        branch = value.startsWith("(") ? null : value;
      } else if (key === "branch.oid") {
        head = value.startsWith("(") ? null : value.slice(0, 7);
      } else if (key === "branch.upstream") {
        upstream = value;
      } else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/u.exec(value);
        if (match !== null) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    // Every remaining record is one changed path: 1/2 tracked, u unmerged,
    // ? untracked, ! ignored (never emitted without --ignored).
    if (/^[12u?]\s/u.test(line)) dirtyCount += 1;
  }

  if (!sawHeader) return null;
  return {
    branch,
    head,
    ...(upstream !== undefined ? { upstream } : {}),
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
    dirtyCount,
  };
}

export function listGitFiles(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, encoding: "utf8", timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(
          stdout.split("\0").filter(Boolean).sort((a, b) => a.localeCompare(b)),
        );
      },
    );
  });
}

function normalizePorcelainPath(pathPart: string): string {
  const rename = pathPart.match(/^(.+)\s+->\s+(.+)$/u);
  const value = rename?.[2] ?? pathPart;
  return value.replace(/^"|"$/gu, "");
}

function isRenameOrCopyCode(code: string): boolean {
  return code.includes("R") || code.includes("C");
}

function statusForCode(code: string): ProjectTreeGitState {
  if (code.includes("U")) return "unmerged";
  if (code.includes("?")) return "untracked";
  if (code.includes("!")) return "ignored";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added";
  if (code.includes("M")) return "modified";
  return "modified";
}
