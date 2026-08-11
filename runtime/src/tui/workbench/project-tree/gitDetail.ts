import { execFile } from "node:child_process";

/** One line of `git status --porcelain=v2`, grouped for a human. */
export type GitDetailChange = {
  readonly code: string;
  readonly path: string;
  readonly staged: boolean;
};

export type GitDetail = {
  readonly root: string | null;
  readonly head: string | null;
  readonly subject: string | null;
  readonly author: string | null;
  readonly date: string | null;
  readonly changes: readonly GitDetailChange[];
  /** Set when git itself refused; the panel shows this instead of empty rows. */
  readonly error?: string;
};

const MAX_CHANGES = 200;

function git(cwd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

/**
 * The detail behind the footer chip: where the repository is, what HEAD is,
 * and what is currently uncommitted.
 *
 * Deliberately read-only. Nothing here writes to the repository, so opening
 * the panel can never interfere with whatever the agent is doing to the tree.
 */
export async function collectGitDetail(cwd: string): Promise<GitDetail> {
  const [root, head, status] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    // %h short sha · %an author · %ad date · %s subject, tab separated so a
    // subject containing any of them cannot desynchronize the split.
    git(cwd, ["log", "-1", "--date=iso", "--format=%h\t%an\t%ad\t%s"]),
    git(cwd, ["status", "--porcelain=v2", "--untracked-files=all"]),
  ]);

  if (root === null) {
    return {
      root: null,
      head: null,
      subject: null,
      author: null,
      date: null,
      changes: [],
      error: "not a git repository",
    };
  }

  const [sha, author, date, subject] = (head ?? "").trim().split("\t");
  return {
    root: root.trim(),
    head: sha ?? null,
    author: author ?? null,
    date: date ?? null,
    subject: subject ?? null,
    changes: parseGitDetailChanges(status ?? ""),
  };
}

export function parseGitDetailChanges(raw: string): GitDetailChange[] {
  const changes: GitDetailChange[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0 || changes.length >= MAX_CHANGES) continue;
    // 1 <XY> ... <path> | 2 <XY> ... <path><sep><orig> | u <XY> ... <path>
    const tracked = /^([12u]) (..) (?:\S+ ){6,7}(.+)$/u.exec(line);
    if (tracked !== null) {
      const code = tracked[2]!;
      changes.push({
        code,
        // A rename records "new<TAB>old"; the new name is what exists now.
        path: (tracked[3] ?? "").split("\t")[0] ?? "",
        staged: code[0] !== ".",
      });
      continue;
    }
    if (line.startsWith("? ")) {
      changes.push({ code: "??", path: line.slice(2), staged: false });
    }
  }
  return changes;
}
