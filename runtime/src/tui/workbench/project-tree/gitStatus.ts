import { execFile } from "node:child_process";

import type { ProjectTreeGitState } from "../types.js";

export type GitStatusByPath = ReadonlyMap<string, ProjectTreeGitState>;

export function parseGitStatusPorcelain(raw: string): Map<string, ProjectTreeGitState> {
  const out = new Map<string, ProjectTreeGitState>();
  for (const line of raw.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const pathPart = line.slice(3).trim();
    if (!pathPart) continue;
    const path = normalizePorcelainPath(pathPart);
    out.set(path, statusForCode(code));
  }
  return out;
}

export function collectGitStatus(cwd: string): Promise<Map<string, ProjectTreeGitState>> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd, encoding: "utf8", timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          resolve(new Map());
          return;
        }
        resolve(parseGitStatusPorcelain(stdout));
      },
    );
  });
}

export function listGitFiles(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd, encoding: "utf8", timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(
          stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b)),
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
