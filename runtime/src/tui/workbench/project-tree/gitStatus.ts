import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { ProjectTreeGitBranch, ProjectTreeGitState } from "../types.js";

export type GitStatusByPath = ReadonlyMap<string, ProjectTreeGitState>;

/** Timeout for each project-tree Git read. */
export const GIT_LISTING_TIMEOUT_MS = 5_000;
/**
 * Hard stdout ceiling for streamed Git listings. Larger than Node's 1 MiB
 * `execFile` default so a typical large index is listed in full, but still
 * bounds memory if a repository keeps growing.
 */
export const GIT_LISTING_MAX_BYTES = 16 * 1024 * 1024;
/** Entry ceiling applied while parsing NUL-delimited Git paths. */
export const GIT_LISTING_MAX_ENTRIES = 250_000;
const GIT_LISTING_MAX_STDERR_BYTES = 64 * 1024;

export type GitListingKind =
  | "ok"
  | "truncated"
  | "not-git"
  | "timeout"
  | "output-limit"
  | "error";

export type ProjectTreeGitCommandOptions = {
  readonly git?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
};

export type GitFilesListing = {
  readonly kind: GitListingKind;
  readonly paths: readonly string[];
  readonly truncated: boolean;
  readonly message: string | null;
};

export type GitStatusListing = {
  readonly kind: GitListingKind;
  readonly status: Map<string, ProjectTreeGitState>;
  readonly truncated: boolean;
  readonly message: string | null;
};

export type GitBranchListing = {
  readonly kind: GitListingKind;
  readonly branch: ProjectTreeGitBranch | null;
  readonly truncated: boolean;
  readonly message: string | null;
};

type ResolvedGitCommandOptions = {
  readonly git: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxEntries: number;
};

type StreamGitResult = {
  readonly code: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly byteLimitReached: boolean;
  readonly entryLimitReached: boolean;
  readonly spawnError: NodeJS.ErrnoException | null;
};

type BranchParseState = {
  branch: string | null;
  head: string | null;
  upstream?: string;
  ahead?: number;
  behind?: number;
  dirtyCount: number;
  sawHeader: boolean;
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

export function parseGitStatusPorcelainZ(
  raw: string,
): Map<string, ProjectTreeGitState> {
  const out = new Map<string, ProjectTreeGitState>();
  const parsed = consumeNulFields("", raw);
  applyGitStatusFields(out, [...parsed.fields, parsed.pending]);
  return out;
}

/**
 * Split NUL-delimited Git output across chunk boundaries. The trailing
 * incomplete field stays in `pending` so a filename that contains newlines
 * (legal in `ls-files -z` / `status -z`) is never split on `\n`.
 */
export function consumeNulFields(
  pending: string,
  chunk: string,
): { readonly fields: readonly string[]; readonly pending: string } {
  const parts = (pending + chunk).split("\0");
  const nextPending = parts.pop() ?? "";
  return { fields: parts, pending: nextPending };
}

export function collectGitStatus(
  cwd: string,
  options: ProjectTreeGitCommandOptions = {},
): Promise<GitStatusListing> {
  const resolved = resolveGitCommandOptions(options);
  const status = new Map<string, ProjectTreeGitState>();
  let pending = "";
  let expectingRenameSource = false;

  return streamGit(
    [
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ],
    cwd,
    resolved,
    (chunk) => {
      const parsed = consumeNulFields(pending, chunk);
      pending = parsed.pending;
      for (const field of parsed.fields) {
        if (expectingRenameSource) {
          expectingRenameSource = false;
          continue;
        }
        if (field.length < 4) continue;
        const code = field.slice(0, 2);
        const path = field.slice(3);
        if (path) status.set(path, statusForCode(code));
        if (isRenameOrCopyCode(code)) expectingRenameSource = true;
        if (status.size >= resolved.maxEntries) return "stop";
      }
      return "continue";
    },
  ).then((result) => {
    if (
      !result.byteLimitReached &&
      !result.entryLimitReached &&
      !expectingRenameSource &&
      pending.length >= 4
    ) {
      const code = pending.slice(0, 2);
      const path = pending.slice(3);
      if (path) status.set(path, statusForCode(code));
    }
    const kind = classifyGitResult(result);
    return {
      kind,
      status,
      truncated: isTruncatedKind(kind),
      message: listingMessage(kind, result.stderr, resolved),
    };
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
 *
 * Headers and the dirty count are parsed incrementally so a multi-megabyte
 * status dump never has to sit in one `execFile` buffer.
 */
export function collectGitBranch(
  cwd: string,
  options: ProjectTreeGitCommandOptions = {},
): Promise<GitBranchListing> {
  const resolved = resolveGitCommandOptions(options);
  const state = createBranchParseState();
  let pending = "";

  return streamGit(
    ["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
    cwd,
    resolved,
    (chunk) => {
      const combined = pending + chunk;
      const lines = combined.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) consumeGitBranchLine(state, line);
      return "continue";
    },
  ).then((result) => {
    if (pending.length > 0) consumeGitBranchLine(state, pending);
    const kind = classifyGitResult(result);
    return {
      kind,
      branch: kind === "not-git" ? null : finishBranchParse(state),
      truncated: isTruncatedKind(kind),
      message: listingMessage(kind, result.stderr, resolved),
    };
  });
}

export function parseGitBranchPorcelainV2(
  raw: string,
): ProjectTreeGitBranch | null {
  const state = createBranchParseState();
  for (const line of raw.split("\n")) consumeGitBranchLine(state, line);
  return finishBranchParse(state);
}

export function listGitFiles(
  cwd: string,
  options: ProjectTreeGitCommandOptions = {},
): Promise<GitFilesListing> {
  const resolved = resolveGitCommandOptions(options);
  const paths: string[] = [];
  let pending = "";

  return streamGit(
    [
      "-c",
      "core.quotepath=false",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    cwd,
    resolved,
    (chunk) => {
      const parsed = consumeNulFields(pending, chunk);
      pending = parsed.pending;
      for (const field of parsed.fields) {
        if (!field) continue;
        paths.push(field);
        if (paths.length >= resolved.maxEntries) return "stop";
      }
      return "continue";
    },
  ).then((result) => {
    if (
      pending &&
      !result.byteLimitReached &&
      !result.entryLimitReached
    ) {
      paths.push(pending);
    }
    const kind = classifyGitResult(result);
    return {
      kind,
      paths: paths.sort((a, b) => a.localeCompare(b)),
      truncated: isTruncatedKind(kind),
      message: listingMessage(kind, result.stderr, resolved),
    };
  });
}

/**
 * Scan fallback is only for a non-Git cwd or an empty successful Git index.
 * Timeout, output-limit, truncated, and other Git failures must stay visible
 * instead of being replaced by the 10,000-entry filesystem walk.
 */
export function shouldScanWorkspaceFallback(listing: {
  readonly kind: GitListingKind;
  readonly paths: readonly string[];
}): boolean {
  switch (listing.kind) {
    case "ok":
      return listing.paths.length === 0;
    case "not-git":
      return true;
    case "truncated":
    case "timeout":
    case "output-limit":
    case "error":
      return false;
    default: {
      const exhaustive: never = listing.kind;
      return exhaustive;
    }
  }
}

export function listingWarning(listing: {
  readonly kind: GitListingKind;
  readonly message: string | null;
}): string | null {
  switch (listing.kind) {
    case "ok":
    case "not-git":
      return null;
    case "truncated":
    case "timeout":
    case "output-limit":
    case "error":
      return listing.message;
    default: {
      const exhaustive: never = listing.kind;
      return exhaustive;
    }
  }
}

function resolveGitCommandOptions(
  options: ProjectTreeGitCommandOptions,
): ResolvedGitCommandOptions {
  return {
    git: options.git ?? "git",
    timeoutMs: options.timeoutMs ?? GIT_LISTING_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? GIT_LISTING_MAX_BYTES,
    maxEntries: options.maxEntries ?? GIT_LISTING_MAX_ENTRIES,
  };
}

function streamGit(
  args: readonly string[],
  cwd: string,
  options: ResolvedGitCommandOptions,
  onChunk: (text: string) => "continue" | "stop",
): Promise<StreamGitResult> {
  return new Promise((resolve) => {
    const child = spawn(options.git, [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const decoder = new StringDecoder("utf8");
    let stderr = "";
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let timedOut = false;
    let byteLimitReached = false;
    let entryLimitReached = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let settled = false;
    let stopping = false;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const tail = decoder.end();
      if (tail && !stopping) {
        if (onChunk(tail) === "stop") entryLimitReached = true;
      }
      resolve({
        code,
        stderr,
        timedOut,
        byteLimitReached,
        entryLimitReached,
        spawnError,
      });
    };

    const stopChild = (): void => {
      stopping = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Process may already have exited.
      }
    };

    const timeout =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stopChild();
          }, options.timeoutMs)
        : undefined;
    timeout?.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stopping || settled) return;
      const remaining = options.maxBytes - stdoutBytes;
      if (remaining <= 0) {
        byteLimitReached = true;
        stopChild();
        return;
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stdoutBytes += slice.length;
      if (slice.length < chunk.length) byteLimitReached = true;
      const decision = onChunk(decoder.write(slice));
      if (decision === "stop") entryLimitReached = true;
      if (byteLimitReached || entryLimitReached) stopChild();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= GIT_LISTING_MAX_STDERR_BYTES) return;
      const remaining = GIT_LISTING_MAX_STDERR_BYTES - stderrBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderrBytes += slice.length;
      stderr += slice.toString("utf8");
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
      if (timeout) clearTimeout(timeout);
      finish(127);
    });

    child.once("close", (code) => {
      finish(code);
    });
  });
}

function classifyGitResult(result: StreamGitResult): GitListingKind {
  if (result.timedOut) return "timeout";
  if (result.byteLimitReached) return "output-limit";
  if (result.entryLimitReached) return "truncated";
  if (result.spawnError) {
    return result.spawnError.code === "ENOENT" ? "not-git" : "error";
  }
  if (result.code === 0) return "ok";
  if (isNotGitRepository(result.stderr)) return "not-git";
  return "error";
}

function isNotGitRepository(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

function isTruncatedKind(kind: GitListingKind): boolean {
  switch (kind) {
    case "truncated":
    case "output-limit":
      return true;
    case "ok":
    case "not-git":
    case "timeout":
    case "error":
      return false;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function listingMessage(
  kind: GitListingKind,
  stderr: string,
  options: ResolvedGitCommandOptions,
): string | null {
  switch (kind) {
    case "ok":
      return null;
    case "not-git":
      return "not a git repository";
    case "timeout":
      return `Git listing timed out after ${options.timeoutMs}ms`;
    case "output-limit":
      return `Git listing exceeded the ${options.maxBytes} byte output bound`;
    case "truncated":
      return `Git listing truncated at ${options.maxEntries} files`;
    case "error":
      return stderr.trim() || "Git listing failed";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function applyGitStatusFields(
  out: Map<string, ProjectTreeGitState>,
  fields: readonly string[],
): void {
  for (let index = 0; index < fields.length; ) {
    const entry = fields[index++]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) out.set(path, statusForCode(code));
    if (isRenameOrCopyCode(code)) index += 1;
  }
}

function createBranchParseState(): BranchParseState {
  return {
    branch: null,
    head: null,
    dirtyCount: 0,
    sawHeader: false,
  };
}

function consumeGitBranchLine(state: BranchParseState, line: string): void {
  if (line.length === 0) return;
  if (line.startsWith("# branch.")) {
    state.sawHeader = true;
    const [key, ...rest] = line.slice(2).split(" ");
    const value = rest.join(" ");
    // git spells a detached HEAD "(detached)" and an unborn branch
    // "(initial)"; neither is a branch name a user could check out.
    if (key === "branch.head") {
      state.branch = value.startsWith("(") ? null : value;
    } else if (key === "branch.oid") {
      state.head = value.startsWith("(") ? null : value.slice(0, 7);
    } else if (key === "branch.upstream") {
      state.upstream = value;
    } else if (key === "branch.ab") {
      const match = /^\+(\d+) -(\d+)$/u.exec(value);
      if (match !== null) {
        state.ahead = Number(match[1]);
        state.behind = Number(match[2]);
      }
    }
    return;
  }
  if (line.startsWith("#")) return;
  // Every remaining record is one changed path: 1/2 tracked, u unmerged,
  // ? untracked, ! ignored (never emitted without --ignored).
  if (/^[12u?]\s/u.test(line)) state.dirtyCount += 1;
}

function finishBranchParse(state: BranchParseState): ProjectTreeGitBranch | null {
  if (!state.sawHeader) return null;
  return {
    branch: state.branch,
    head: state.head,
    ...(state.upstream !== undefined ? { upstream: state.upstream } : {}),
    ...(state.ahead !== undefined ? { ahead: state.ahead } : {}),
    ...(state.behind !== undefined ? { behind: state.behind } : {}),
    dirtyCount: state.dirtyCount,
  };
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
