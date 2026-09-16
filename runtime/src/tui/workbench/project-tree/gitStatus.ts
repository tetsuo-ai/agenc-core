import { execFile } from "node:child_process";

import type { ProjectTreeGitBranch, ProjectTreeGitState } from "../types.js";

export type GitStatusByPath = ReadonlyMap<string, ProjectTreeGitState>;

export type GitSnapshot = {
  readonly status: Map<string, ProjectTreeGitState>;
  readonly branch: ProjectTreeGitBranch | null;
};

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

export function parseGitStatusPorcelainZ(raw: string): Map<string, ProjectTreeGitState> {
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

/** Read file states and branch identity from the same Git status scan. */
export function collectGitSnapshot(cwd: string): Promise<GitSnapshot> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
      {
        cwd,
        encoding: "utf8",
        timeout: 5_000,
        // V2 adds modes and object IDs to each tracked path. Allow its metadata
        // overhead without reducing v1's usable capacity, while staying bounded.
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          resolve({ status: new Map(), branch: null });
          return;
        }
        resolve(parseGitSnapshotPorcelainV2(stdout));
      },
    );
  });
}

export async function collectGitStatus(cwd: string): Promise<Map<string, ProjectTreeGitState>> {
  return (await collectGitSnapshot(cwd)).status;
}

export async function collectGitBranch(
  cwd: string,
): Promise<ProjectTreeGitBranch | null> {
  return (await collectGitSnapshot(cwd)).branch;
}

export function parseGitBranchPorcelainV2(
  raw: string,
): ProjectTreeGitBranch | null {
  return parseGitSnapshotPorcelainV2(raw).branch;
}

/** Paths remain relative to the repository root, as in porcelain v1. */
export function parseGitSnapshotPorcelainV2(raw: string): GitSnapshot {
  const status = new Map<string, ProjectTreeGitState>();
  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  let dirtyCount = 0;
  let sawHeader = false;

  const nulDelimited = raw.includes("\0");
  const records = raw.split(nulDelimited ? "\0" : "\n");
  for (let index = 0; index < records.length; index += 1) {
    const line = records[index]!;
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
    const kind = line[0];
    let path: string | null = null;
    let state: ProjectTreeGitState;
    if ((kind === "?" || kind === "!") && line[1] === " ") {
      path = line.slice(2);
      state = kind === "?" ? "untracked" : "ignored";
    } else if ((kind === "1" || kind === "2" || kind === "u") && line[1] === " ") {
      // Consume only metadata fields: spaces, tabs and newlines can be part
      // of the path, and must never be trimmed or split in the -z format.
      path = pathAfterFields(line, kind === "1" ? 8 : kind === "2" ? 9 : 10);
      state = kind === "u" ? "unmerged" : statusForCode(line.slice(2, 4));
      if (kind === "2") {
        // Rename/copy origins are a separate NUL record, not another change.
        if (nulDelimited) index += 1;
        else if (path !== null) path = path.split("\t", 1)[0]!;
      }
    } else {
      continue;
    }
    if (!path) continue;
    if (!nulDelimited) path = path.replace(/^"|"$/gu, "");
    status.set(path, state);
    if (state !== "ignored") dirtyCount += 1;
  }

  return {
    status,
    branch: sawHeader ? {
      branch,
      head,
      ...(upstream !== undefined ? { upstream } : {}),
      ...(ahead !== undefined ? { ahead } : {}),
      ...(behind !== undefined ? { behind } : {}),
      dirtyCount,
    } : null,
  };
}

function pathAfterFields(record: string, fieldCount: number): string | null {
  let offset = 0;
  for (let field = 0; field < fieldCount; field += 1) {
    const separator = record.indexOf(" ", offset);
    if (separator < 0) return null;
    offset = separator + 1;
  }
  return record.slice(offset);
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
  if (UNMERGED_CODES.has(code)) return "unmerged";
  if (code.includes("?")) return "untracked";
  if (code.includes("!")) return "ignored";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added";
  if (code.includes("M")) return "modified";
  return "modified";
}

const UNMERGED_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
