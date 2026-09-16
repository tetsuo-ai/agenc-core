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
  let branch: ProjectTreeGitBranch | null = null;
  let dirtyCount = 0;

  const nulDelimited = raw.includes("\0");
  const records = raw.split(nulDelimited ? "\0" : "\n");
  for (let index = 0; index < records.length; index += 1) {
    const line = records[index]!;
    if (line.startsWith("# branch.")) {
      branch = parseBranchHeader(line, branch);
      continue;
    }
    const entry = parseStatusRecord(line);
    if (entry === null) continue;
    // Rename/copy origins are a separate NUL record, not another change.
    if (entry.hasOrigin && nulDelimited) index += 1;
    const path = normalizeV2Path(entry, nulDelimited);
    if (path === null) continue;
    status.set(path, entry.state);
    if (entry.state !== "ignored") dirtyCount += 1;
  }

  return {
    status,
    branch: branch === null ? null : { ...branch, dirtyCount },
  };
}

function parseBranchHeader(
  record: string,
  previous: ProjectTreeGitBranch | null,
): ProjectTreeGitBranch {
  const branch = previous ?? { branch: null, head: null, dirtyCount: 0 };
  const [key, ...rest] = record.slice(2).split(" ");
  const value = rest.join(" ");
  // Git spells a detached HEAD "(detached)" and an unborn commit "(initial)".
  switch (key) {
    case "branch.head":
      return { ...branch, branch: value.startsWith("(") ? null : value };
    case "branch.oid":
      return { ...branch, head: value.startsWith("(") ? null : value.slice(0, 7) };
    case "branch.upstream":
      return { ...branch, upstream: value };
    case "branch.ab": {
      const match = /^\+(\d+) -(\d+)$/u.exec(value);
      if (match !== null) {
        return { ...branch, ahead: Number(match[1]), behind: Number(match[2]) };
      }
      return branch;
    }
    default:
      return branch;
  }
}

type PorcelainV2Entry = {
  readonly path: string | null;
  readonly state: ProjectTreeGitState;
  readonly hasOrigin: boolean;
};

const PORCELAIN_V2_PATH_FIELDS = new Map([["1", 8], ["2", 9], ["u", 10]]);

function parseStatusRecord(record: string): PorcelainV2Entry | null {
  if (record[1] !== " ") return null;
  const kind = record[0]!;
  if (kind === "?" || kind === "!") {
    return {
      path: record.slice(2),
      state: kind === "?" ? "untracked" : "ignored",
      hasOrigin: false,
    };
  }
  const fieldCount = PORCELAIN_V2_PATH_FIELDS.get(kind);
  if (fieldCount === undefined) return null;
  return {
    // Consume only metadata fields: spaces, tabs and newlines can be part
    // of the path, and must never be trimmed or split in the -z format.
    path: pathAfterFields(record, fieldCount),
    state: kind === "u" ? "unmerged" : statusForCode(record.slice(2, 4)),
    hasOrigin: kind === "2",
  };
}

function normalizeV2Path(entry: PorcelainV2Entry, nulDelimited: boolean): string | null {
  let path = entry.path;
  if (entry.hasOrigin && !nulDelimited && path !== null) {
    path = path.split("\t", 1)[0]!;
  }
  if (!path) return null;
  return nulDelimited ? path : path.replace(/^"|"$/gu, "");
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
