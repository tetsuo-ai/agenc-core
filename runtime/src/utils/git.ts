import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { URL } from "node:url";

const DEFAULT_GIT_TIMEOUT_MS = 5_000;
const MAX_GIT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 100 * 1024 * 1024;

export interface GitResult {
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface RunGitOptions {
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBufferBytes?: number;
}

export interface GitInfo {
  readonly commitHash: string | null;
  readonly branch: string | null;
  readonly repositoryUrl: string | null;
}

export interface CommitLogEntry {
  readonly sha: string;
  readonly timestamp: number;
  readonly subject: string;
}

export class GitCommandError extends Error {
  readonly command: string;
  readonly code: number;
  readonly stderr: string;

  constructor(command: string, result: GitResult) {
    super(
      `git command \`${command}\` failed with status ${result.code}: ${result.stderr.trim()}`,
    );
    this.name = "GitCommandError";
    this.command = command;
    this.code = result.code;
    this.stderr = result.stderr;
  }
}

export function gitExe(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GIT?.trim();
  return configured && configured.length > 0 ? configured : "git";
}

export function findGitRoot(startPath: string): string | null {
  let dir = resolveStartDirectory(startPath);

  while (dir !== null) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      return dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }

  return null;
}

export function findCanonicalGitRoot(startPath: string): string | null {
  const gitRoot = findGitRoot(startPath);
  if (!gitRoot) {
    return null;
  }
  return resolveCanonicalGitRoot(gitRoot);
}

export async function dirIsInGitRepo(cwd: string): Promise<boolean> {
  if (findGitRoot(cwd) !== null) {
    return true;
  }
  return isInsideGitWorkTree(cwd);
}

export async function getIsGit(cwd: string = process.cwd()): Promise<boolean> {
  return dirIsInGitRepo(cwd);
}

export async function runGit(
  args: ReadonlyArray<string>,
  cwd: string,
  options: RunGitOptions = {},
): Promise<GitResult> {
  const timeoutMs = normalizePositiveInteger(
    options.timeoutMs,
    DEFAULT_GIT_TIMEOUT_MS,
    MAX_GIT_TIMEOUT_MS,
  );
  const maxBufferBytes = normalizePositiveInteger(
    options.maxBufferBytes,
    DEFAULT_MAX_GIT_OUTPUT_BYTES,
    MAX_GIT_OUTPUT_BYTES,
  );
  const commandEnv = {
    ...process.env,
    ...options.env,
    GIT_OPTIONAL_LOCKS: "0",
  };
  const child = spawn(gitExe(commandEnv), [...args], {
    cwd,
    env: commandEnv,
    stdio: "pipe",
  });
  child.stdin.end();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  let settled = false;
  let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;

  return new Promise<GitResult>((resolve) => {
    const appendChunk = (
      chunks: Buffer[],
      chunk: Buffer,
      usedBytes: number,
    ): { readonly bytes: number; readonly truncated: boolean } => {
      const nextBytes = usedBytes + chunk.length;
      if (usedBytes >= maxBufferBytes) {
        return { bytes: nextBytes, truncated: true };
      }
      const remaining = maxBufferBytes - usedBytes;
      chunks.push(
        chunk.length <= remaining ? chunk : chunk.subarray(0, remaining),
      );
      return { bytes: nextBytes, truncated: nextBytes > maxBufferBytes };
    };

    const finish = (
      code: number,
      signal: NodeJS.Signals | null,
      stderrOverride?: string,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: stderrOverride ?? Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 250);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const next = appendChunk(stdoutChunks, chunk, stdoutBytes);
      stdoutBytes = next.bytes;
      stdoutTruncated ||= next.truncated;
      if (stdoutTruncated) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const next = appendChunk(stderrChunks, chunk, stderrBytes);
      stderrBytes = next.bytes;
      stderrTruncated ||= next.truncated;
      if (stderrTruncated) {
        child.kill("SIGTERM");
      }
    });
    child.on("close", (code, signal) => finish(code ?? 1, signal));
    child.on("error", (error) => finish(127, null, error.message));
  });
}

export async function runGitForStdout(
  args: ReadonlyArray<string>,
  cwd: string,
  options: RunGitOptions = {},
): Promise<string> {
  const result = await runGit(args, cwd, options);
  if (result.code !== 0) {
    throw new GitCommandError(buildGitCommand(args), result);
  }
  return result.stdout.trim();
}

export async function isInsideGitWorkTree(cwd: string): Promise<boolean> {
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.code === 0 && result.stdout.trim() === "true";
}

export async function resolveRepositoryRoot(cwd: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (result.code !== 0) {
    return null;
  }
  const root = result.stdout.trim();
  return root.length > 0 ? root : null;
}

export async function getGitDir(cwd: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--git-dir"], cwd);
  if (result.code !== 0) {
    return null;
  }
  const gitDir = result.stdout.trim();
  if (gitDir.length === 0) {
    return null;
  }
  return resolvePath(cwd, gitDir);
}

export async function collectGitInfo(cwd: string): Promise<GitInfo | null> {
  if (!(await isInsideGitWorkTree(cwd))) {
    return null;
  }

  const [commit, branch, remote] = await Promise.all([
    runGit(["rev-parse", "HEAD"], cwd),
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    runGit(["remote", "get-url", "origin"], cwd),
  ]);

  return {
    commitHash:
      commit.code === 0 && commit.stdout.trim().length > 0
        ? commit.stdout.trim()
        : null,
    branch:
      branch.code === 0 &&
      branch.stdout.trim().length > 0 &&
      branch.stdout.trim() !== "HEAD"
        ? branch.stdout.trim()
        : null,
    repositoryUrl:
      remote.code === 0 && remote.stdout.trim().length > 0
        ? remote.stdout.trim()
        : null,
  };
}

export async function getHeadCommitHash(cwd: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "HEAD"], cwd);
  if (result.code !== 0) {
    return null;
  }
  const hash = result.stdout.trim();
  return hash.length > 0 ? hash : null;
}

export async function currentBranchName(cwd: string): Promise<string | null> {
  const result = await runGit(["branch", "--show-current"], cwd);
  if (result.code !== 0) {
    return null;
  }
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : null;
}

export async function getBranch(cwd: string = process.cwd()): Promise<string | null> {
  return currentBranchName(cwd);
}

export async function getHasChanges(cwd: string): Promise<boolean | null> {
  const result = await runGit(["status", "--porcelain"], cwd);
  if (result.code !== 0) {
    return null;
  }
  return result.stdout.length > 0;
}

export async function localGitBranches(cwd: string): Promise<string[]> {
  const result = await runGit(["branch", "--format=%(refname:short)"], cwd);
  if (result.code !== 0) {
    return [];
  }

  const branches = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort((a, b) => a.localeCompare(b));

  const defaultBranch = await defaultBranchName(cwd);
  if (defaultBranch) {
    const index = branches.indexOf(defaultBranch);
    if (index > 0) {
      branches.splice(index, 1);
      branches.unshift(defaultBranch);
    }
  }

  return branches;
}

export async function getGitRemoteUrls(
  cwd: string,
): Promise<Record<string, string> | null> {
  if (!(await isInsideGitWorkTree(cwd))) {
    return null;
  }
  const result = await runGit(["remote", "-v"], cwd);
  if (result.code !== 0) {
    return null;
  }
  return parseGitRemoteUrls(result.stdout);
}

export async function getRemoteUrl(
  cwd: string = process.cwd(),
  remote = "origin",
): Promise<string | null> {
  const remotes = await getGitRemoteUrls(cwd);
  return remotes?.[remote] ?? null;
}

export function parseGitRemoteUrls(stdout: string): Record<string, string> | null {
  const remotes: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;

  for (const line of stdout.split(/\r?\n/)) {
    const fetchLine = line.endsWith(" (fetch)")
      ? line.slice(0, -" (fetch)".length)
      : null;
    if (!fetchLine) {
      continue;
    }

    const match = fetchLine.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      continue;
    }

    const [, name, url] = match;
    const trimmedUrl = url.trim();
    if (trimmedUrl.length > 0) {
      remotes[name] = trimmedUrl;
    }
  }

  return Object.keys(remotes).length > 0 ? remotes : null;
}

export async function defaultBranchName(cwd: string): Promise<string | null> {
  const remotes = await gitRemotes(cwd);

  for (const remote of remotes) {
    const symbolic = await runGit(
      ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`],
      cwd,
    );
    if (symbolic.code === 0) {
      const ref = symbolic.stdout.trim();
      const prefix = `refs/remotes/${remote}/`;
      const branch = ref.startsWith(prefix) ? ref.slice(prefix.length) : "";
      if (branch.length > 0) {
        return branch;
      }
    }

    const show = await runGit(["remote", "show", remote], cwd);
    if (show.code === 0) {
      for (const line of show.stdout.split(/\r?\n/)) {
        const headBranch = line.trim().match(/^HEAD branch:\s*(.+)$/);
        if (headBranch?.[1]?.trim()) {
          return headBranch[1].trim();
        }
      }
    }
  }

  for (const candidate of ["main", "master"]) {
    const local = await runGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`],
      cwd,
    );
    if (local.code === 0) {
      return candidate;
    }
  }

  return null;
}

export async function recentCommits(
  cwd: string,
  limit: number,
): Promise<CommitLogEntry[]> {
  if (limit <= 0) {
    return [];
  }
  if (!(await isInsideGitWorkTree(cwd))) {
    return [];
  }

  const args = [
    "log",
    "-n",
    String(limit),
    "--pretty=format:%H%x1f%ct%x1f%s",
  ];
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => {
      const [sha = "", timestamp = "", subject = ""] = line.split("\u001f");
      return {
        sha: sha.trim(),
        timestamp: Number.parseInt(timestamp.trim(), 10) || 0,
        subject: subject.trim(),
      };
    })
    .filter((entry) => entry.sha.length > 0);
}

function resolveStartDirectory(startPath: string): string | null {
  const absolute = resolvePath(startPath);
  try {
    const stat = statSync(absolute);
    return stat.isDirectory() ? absolute : dirname(absolute);
  } catch {
    return absolute;
  }
}

function resolveCanonicalGitRoot(gitRoot: string): string {
  const dotGit = join(gitRoot, ".git");

  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) {
      return gitRoot;
    }
  } catch {
    return gitRoot;
  }

  try {
    const gitContent = readFileSync(dotGit, "utf8").trim();
    const gitDir = gitContent.startsWith("gitdir:")
      ? gitContent.slice("gitdir:".length).trim()
      : "";
    if (gitDir.length === 0) {
      return gitRoot;
    }

    const worktreeGitDir = resolvePath(gitRoot, gitDir);
    const worktreesDir = dirname(worktreeGitDir);
    if (basename(worktreesDir) !== "worktrees") {
      return gitRoot;
    }

    const commonDir = resolvePath(
      worktreeGitDir,
      readFileSync(join(worktreeGitDir, "commondir"), "utf8").trim(),
    );
    if (resolvePath(worktreesDir) !== join(commonDir, "worktrees")) {
      return gitRoot;
    }
    const backlink = realpathSync(
      readFileSync(join(worktreeGitDir, "gitdir"), "utf8").trim(),
    );
    if (backlink !== join(realpathSync(gitRoot), ".git")) {
      return gitRoot;
    }

    return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
  } catch {
    return gitRoot;
  }
}

async function gitRemotes(cwd: string): Promise<string[]> {
  const result = await runGit(["remote"], cwd);
  if (result.code !== 0) {
    return [];
  }

  const remotes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const originIndex = remotes.indexOf("origin");
  if (originIndex > 0) {
    remotes.splice(originIndex, 1);
    remotes.unshift("origin");
  }
  return remotes;
}

function buildGitCommand(args: ReadonlyArray<string>): string {
  return ["git", ...args.map(formatCommandArg)].join(" ");
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(value), max);
}

function formatCommandArg(arg: string): string {
  const redacted = redactCredentialLikeValue(arg);
  if (/^[A-Za-z0-9_./:@=-]+$/.test(redacted)) {
    return redacted;
  }
  return JSON.stringify(redacted);
}

function redactCredentialLikeValue(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      if (url.username) {
        url.username = "redacted";
      }
      if (url.password) {
        url.password = "redacted";
      }
      return url.toString();
    }
  } catch {
    // Not a URL; fall through to query-style redaction.
  }

  return value.replace(
    /\b(token|password|api[_-]?key|secret)=([^&\s]+)/gi,
    "$1=redacted",
  );
}
