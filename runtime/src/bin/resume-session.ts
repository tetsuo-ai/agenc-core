import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import {
  DEFAULT_SESSION_ROOT_MARKERS,
  getAgencHomeDir,
  getProjectDir,
  hasSupportedFileIdentity,
  isSafeSessionIdSegment,
  readAndValidateSchemaVersionFd,
  resolveCanonicalSessionCwd,
} from "../session/session-store.js";
import { sanitizePath } from "../utils/sessionStoragePortable.js";
import {
  DEFAULT_MAX_STARTUP_RECOVERY_MS,
  MAX_RECOVERY_CANONICAL_SOURCE_BYTES,
} from "../state/recovery-contract.js";

export const RESUME_SEARCH_LIMITS = Object.freeze({
  projects: 512,
  sessionsPerProject: 2_048,
  rolloutFilesPerSession: 256,
  metadataBytes: 4 * 1024 * 1024,
  milliseconds: DEFAULT_MAX_STARTUP_RECOVERY_MS,
});

export interface ResolvedResumeSession {
  readonly sessionId: string;
  readonly rolloutPath: string;
  readonly cwd: string;
  /** Frozen source generation, reproved before trust handoff and RPC. */
  readonly sourceDev: string;
  readonly sourceIno: string;
  readonly sourceSize: string;
  readonly sourceSha256: string;
  /** Frozen canonical workspace generation selected from session metadata. */
  readonly cwdDev: string;
  readonly cwdIno: string;
}

export type ResumeSessionResolution =
  | ({ readonly kind: "ok" } & ResolvedResumeSession)
  | { readonly kind: "none" }
  | { readonly kind: "not_found"; readonly input: string }
  | {
      readonly kind: "ambiguous";
      readonly input: string;
      readonly matches: readonly string[];
    }
  | {
      readonly kind: "search_incomplete";
      readonly input: string;
      readonly reason:
        | "project_limit"
        | "session_limit"
        | "file_limit"
        | "metadata_limit"
        | "source_limit"
        | "source_unavailable"
        | "identity_unavailable"
        | "time_limit";
    };

interface ResumeCandidate extends Omit<ResolvedResumeSession, "sourceSha256"> {
  readonly mtimeNs: bigint;
  readonly sourceMtimeNs: bigint;
  readonly sourceCtimeNs: bigint;
}

export interface ResumeSessionTestHooks {
  readonly beforeOpenDirectory?: (path: string) => void;
  readonly afterCandidateMetadataRead?: (path: string) => void;
  readonly afterCandidateHashRead?: (path: string) => void;
  readonly beforeCandidateClose?: (path: string, fd: number) => void;
}

let resumeSessionTestHooks: ResumeSessionTestHooks = {};

/** Install deterministic filesystem-race seams for contract tests. */
export function __setResumeSessionTestHooksForTest(
  hooks: ResumeSessionTestHooks = {},
): void {
  resumeSessionTestHooks = hooks;
}

interface SearchBudget {
  readonly deadlineMs: number;
  /** Canonical authority root; configured AGENC_HOME may itself be an alias. */
  readonly projectsRoot: string | undefined;
  metadataBytes: number;
  incompleteReason?: Extract<
    ResumeSessionResolution,
    { kind: "search_incomplete" }
  >["reason"];
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function boundedEntries(
  path: string,
  maximum: number,
  budget: SearchBudget,
  limitReason: SearchBudget["incompleteReason"],
): readonly { readonly name: string; readonly directory: boolean }[] {
  const entries: { name: string; directory: boolean }[] = [];
  let directory;
  try {
    resumeSessionTestHooks.beforeOpenDirectory?.(path);
    directory = opendirSync(path);
  } catch (error) {
    if (!isMissingPathError(error)) {
      budget.incompleteReason ??= "source_unavailable";
    }
    return entries;
  }
  try {
    while (entries.length <= maximum) {
      if (Date.now() >= budget.deadlineMs) {
        budget.incompleteReason = "time_limit";
        break;
      }
      const entry = directory.readSync();
      if (entry === null) break;
      entries.push({ name: entry.name, directory: entry.isDirectory() });
    }
  } catch {
    budget.incompleteReason ??= "source_unavailable";
  } finally {
    try {
      directory.closeSync();
    } catch {
      budget.incompleteReason ??= "source_unavailable";
    }
  }
  if (entries.length > maximum) {
    budget.incompleteReason ??= limitReason;
    return entries.slice(0, maximum);
  }
  return entries;
}

function candidateFromPath(
  sessionId: string,
  rolloutPath: string,
  mtimeNs: bigint,
  budget: SearchBudget,
): ResumeCandidate | null {
  if (!isSafeSessionIdSegment(sessionId)) return null;
  if (Date.now() >= budget.deadlineMs) {
    budget.incompleteReason ??= "time_limit";
    return null;
  }
  let canonicalPath: string;
  let sourceDev: string;
  let sourceIno: string;
  let sourceSize: string;
  let sourceMtimeNs: bigint;
  let sourceCtimeNs: bigint;
  let meta: ReturnType<typeof readAndValidateSchemaVersionFd>;
  try {
    const stats = lstatSync(rolloutPath, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
      budget.incompleteReason ??= "source_unavailable";
      return null;
    }
    if (!hasSupportedFileIdentity(stats)) {
      budget.incompleteReason ??= "identity_unavailable";
      return null;
    }
    const metadataBytes = stats.size > 65_536n ? 65_536 : Number(stats.size);
    budget.metadataBytes += metadataBytes;
    if (budget.metadataBytes > RESUME_SEARCH_LIMITS.metadataBytes) {
      budget.incompleteReason ??= "metadata_limit";
      return null;
    }
    canonicalPath = realpathSync(rolloutPath);
    const noFollow =
      "O_NOFOLLOW" in fsConstants ? (fsConstants.O_NOFOLLOW as number) : 0;
    const fd = openSync(rolloutPath, fsConstants.O_RDONLY | noFollow);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        !hasSupportedFileIdentity(opened) ||
        opened.dev !== stats.dev ||
        opened.ino !== stats.ino ||
        opened.size !== stats.size
      ) {
        budget.incompleteReason ??= "source_unavailable";
        return null;
      }
      meta = readAndValidateSchemaVersionFd(fd);
      resumeSessionTestHooks.afterCandidateMetadataRead?.(rolloutPath);
      const observed = lstatSync(rolloutPath, { bigint: true });
      if (
        !observed.isFile() ||
        observed.isSymbolicLink() ||
        !hasSupportedFileIdentity(observed) ||
        observed.dev !== opened.dev ||
        observed.ino !== opened.ino ||
        observed.size !== opened.size ||
        observed.mtimeNs !== opened.mtimeNs ||
        observed.ctimeNs !== opened.ctimeNs ||
        opened.mtimeNs !== stats.mtimeNs ||
        opened.ctimeNs !== stats.ctimeNs ||
        mtimeNs !== stats.mtimeNs ||
        observed.nlink !== 1n ||
        realpathSync(rolloutPath) !== canonicalPath
      ) {
        budget.incompleteReason ??= "source_unavailable";
        return null;
      }
      sourceDev = opened.dev.toString(10);
      sourceIno = opened.ino.toString(10);
      sourceSize = opened.size.toString(10);
      sourceMtimeNs = opened.mtimeNs;
      sourceCtimeNs = opened.ctimeNs;
    } finally {
      closeSync(fd);
    }
  } catch {
    budget.incompleteReason ??= "source_unavailable";
    return null;
  }
  if (budget.projectsRoot === undefined) {
    budget.incompleteReason ??= "source_unavailable";
    return null;
  }
  const fromProjectsRoot = relative(budget.projectsRoot, canonicalPath);
  if (
    fromProjectsRoot === "" ||
    fromProjectsRoot === ".." ||
    fromProjectsRoot.startsWith("../") ||
    fromProjectsRoot.startsWith("..\\") ||
    isAbsolute(fromProjectsRoot) ||
    basename(dirname(canonicalPath)) !== sessionId ||
    !basename(canonicalPath).startsWith("rollout-") ||
    !basename(canonicalPath).endsWith(`-${sessionId}.jsonl`)
  ) {
    budget.incompleteReason ??= "source_unavailable";
    return null;
  }
  if (Date.now() >= budget.deadlineMs) {
    budget.incompleteReason ??= "time_limit";
    return null;
  }
  const canonicalCwd =
    meta === null
      ? { kind: "unavailable" as const }
      : resolveCanonicalSessionCwd(meta.cwd);
  if (canonicalCwd.kind === "identity_unsupported") {
    budget.incompleteReason ??= "identity_unavailable";
  }
  if (
    meta === null ||
    meta.sessionId !== sessionId ||
    canonicalCwd.kind !== "ok"
  ) {
    budget.incompleteReason ??= "source_unavailable";
    return null;
  }
  return {
    sessionId,
    rolloutPath: canonicalPath,
    cwd: canonicalCwd.cwd,
    sourceDev,
    sourceIno,
    sourceSize,
    cwdDev: canonicalCwd.dev.toString(10),
    cwdIno: canonicalCwd.ino.toString(10),
    mtimeNs,
    sourceMtimeNs,
    sourceCtimeNs,
  };
}

function sealCandidate(
  candidate: ResumeCandidate,
  search: SearchBudget,
): ResolvedResumeSession | null {
  const noFollow =
    "O_NOFOLLOW" in fsConstants ? (fsConstants.O_NOFOLLOW as number) : 0;
  let fd: number;
  try {
    fd = openSync(candidate.rolloutPath, fsConstants.O_RDONLY | noFollow);
  } catch {
    search.incompleteReason ??= "source_unavailable";
    return null;
  }
  let result: ResolvedResumeSession | null;
  try {
    result = (() => {
      const opened = fstatSync(fd, { bigint: true });
      if (!hasSupportedFileIdentity(opened)) {
        search.incompleteReason ??= "identity_unavailable";
        return null;
      }
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.dev.toString(10) !== candidate.sourceDev ||
        opened.ino.toString(10) !== candidate.sourceIno ||
        opened.size.toString(10) !== candidate.sourceSize ||
        opened.mtimeNs !== candidate.sourceMtimeNs ||
        opened.ctimeNs !== candidate.sourceCtimeNs ||
        opened.size > BigInt(MAX_RECOVERY_CANONICAL_SOURCE_BYTES)
      ) {
        search.incompleteReason ??=
          opened.size > BigInt(MAX_RECOVERY_CANONICAL_SOURCE_BYTES)
            ? "source_limit"
            : "source_unavailable";
        return null;
      }
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < Number(opened.size)) {
        if (Date.now() >= search.deadlineMs) {
          search.incompleteReason ??= "time_limit";
          return null;
        }
        const bytesRead = readSync(
          fd,
          chunk,
          0,
          Math.min(chunk.byteLength, Number(opened.size) - position),
          position,
        );
        if (bytesRead === 0) {
          search.incompleteReason ??= "source_unavailable";
          return null;
        }
        hash.update(chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
      resumeSessionTestHooks.afterCandidateHashRead?.(candidate.rolloutPath);
      const observed = lstatSync(candidate.rolloutPath, { bigint: true });
      const reopened = fstatSync(fd, { bigint: true });
      if (
        !reopened.isFile() ||
        reopened.nlink !== 1n ||
        !hasSupportedFileIdentity(reopened) ||
        reopened.dev !== opened.dev ||
        reopened.ino !== opened.ino ||
        reopened.size !== opened.size ||
        reopened.mtimeNs !== opened.mtimeNs ||
        reopened.ctimeNs !== opened.ctimeNs ||
        !observed.isFile() ||
        observed.isSymbolicLink() ||
        !hasSupportedFileIdentity(observed) ||
        observed.dev !== opened.dev ||
        observed.ino !== opened.ino ||
        observed.size !== opened.size ||
        observed.mtimeNs !== opened.mtimeNs ||
        observed.ctimeNs !== opened.ctimeNs ||
        observed.nlink !== 1n ||
        realpathSync(candidate.rolloutPath) !== candidate.rolloutPath
      ) {
        search.incompleteReason ??= "source_unavailable";
        return null;
      }
      const {
        mtimeNs: _mtimeNs,
        sourceMtimeNs: _sourceMtimeNs,
        sourceCtimeNs: _sourceCtimeNs,
        ...descriptor
      } = candidate;
      return { ...descriptor, sourceSha256: hash.digest("hex") };
    })();
  } catch {
    search.incompleteReason ??= "source_unavailable";
    result = null;
  }
  let closeFailed = false;
  try {
    resumeSessionTestHooks.beforeCandidateClose?.(candidate.rolloutPath, fd);
  } catch {
    closeFailed = true;
  }
  try {
    closeSync(fd);
  } catch {
    closeFailed = true;
  }
  if (closeFailed) {
    search.incompleteReason ??= "source_unavailable";
    return null;
  }
  return result;
}

function candidateUnderProjectDir(
  projectDir: string,
  sessionId: string,
  budget: SearchBudget,
): ResumeCandidate | null {
  const sessionDir = join(projectDir, "sessions", sessionId);
  const discoveredFiles = boundedEntries(
    sessionDir,
    RESUME_SEARCH_LIMITS.rolloutFilesPerSession,
    budget,
    "file_limit",
  ).filter(
    (entry) =>
      !entry.directory &&
      entry.name.startsWith("rollout-") &&
      entry.name.endsWith(`-${sessionId}.jsonl`),
  );
  if (budget.incompleteReason !== undefined) return null;
  // A recovery rollout is the crash-safe old generation from a two-entry
  // Windows replacement. It is authoritative only while no normally named
  // generation exists; otherwise a failed backup cleanup must not roll back a
  // successfully published compaction on the next --continue.
  const normalFiles = discoveredFiles.filter(
    (entry) => !entry.name.startsWith("rollout-recovery-"),
  );
  const files = normalFiles.length > 0 ? normalFiles : discoveredFiles;
  const candidates = files
    .flatMap((entry) => {
      const path = join(sessionDir, entry.name);
      try {
        const stats = lstatSync(path, { bigint: true });
        return [{ path, mtimeNs: stats.mtimeNs }];
      } catch {
        budget.incompleteReason ??= "source_unavailable";
        return [];
      }
    })
    .sort((left, right) =>
      left.mtimeNs === right.mtimeNs
        ? right.path.localeCompare(left.path)
        : left.mtimeNs > right.mtimeNs
          ? -1
          : 1,
    );
  const selected = candidates[0];
  return selected === undefined
    ? null
    : candidateFromPath(sessionId, selected.path, selected.mtimeNs, budget);
}

function candidatesUnderProjectDir(
  projectDir: string,
  budget: SearchBudget,
): readonly ResumeCandidate[] {
  const sessions = boundedEntries(
    join(projectDir, "sessions"),
    RESUME_SEARCH_LIMITS.sessionsPerProject,
    budget,
    "session_limit",
  );
  const candidates: ResumeCandidate[] = [];
  for (const entry of sessions) {
    if (budget.incompleteReason !== undefined) break;
    if (!entry.directory || !isSafeSessionIdSegment(entry.name)) continue;
    const candidate = candidateUnderProjectDir(projectDir, entry.name, budget);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
}

function legacyProjectDirFor(cwd: string, agencHome: string): string {
  return join(getAgencHomeDir(agencHome), "projects", sanitizePath(cwd));
}

function localProjectDirs(cwd: string, agencHome: string): readonly string[] {
  return [
    ...new Set([
      getProjectDir(cwd, DEFAULT_SESSION_ROOT_MARKERS, agencHome),
      legacyProjectDirFor(cwd, agencHome),
    ]),
  ];
}

function projectCandidatesCrossSlug(
  cwd: string,
  agencHome: string,
  budget: SearchBudget,
): readonly ResumeCandidate[] {
  const candidates = localProjectDirs(cwd, agencHome).flatMap((projectDir) =>
    candidatesUnderProjectDir(projectDir, budget),
  );
  const byPath = new Map<string, ResumeCandidate>();
  for (const candidate of candidates)
    byPath.set(candidate.rolloutPath, candidate);
  return [...byPath.values()].sort((left, right) =>
    left.mtimeNs === right.mtimeNs
      ? right.rolloutPath.localeCompare(left.rolloutPath)
      : left.mtimeNs > right.mtimeNs
        ? -1
        : 1,
  );
}

function exactLocalCandidates(
  cwd: string,
  id: string,
  agencHome: string,
  budget: SearchBudget,
): readonly ResumeCandidate[] {
  const matches = localProjectDirs(cwd, agencHome)
    .flatMap((projectDir) => {
      const candidate = candidateUnderProjectDir(projectDir, id, budget);
      return candidate === null ? [] : [candidate];
    })
    .sort((left, right) =>
      left.mtimeNs === right.mtimeNs
        ? right.rolloutPath.localeCompare(left.rolloutPath)
        : left.mtimeNs > right.mtimeNs
          ? -1
          : 1,
    );
  return matches;
}

function isLikelyConvId(id: string): boolean {
  return /^conv-[A-Za-z0-9]{6,}$/u.test(id);
}

function globalCandidates(
  id: string,
  budget: SearchBudget,
): readonly ResumeCandidate[] {
  const projectsDir = budget.projectsRoot;
  if (projectsDir === undefined) return [];
  const projects = boundedEntries(
    projectsDir,
    RESUME_SEARCH_LIMITS.projects,
    budget,
    "project_limit",
  );
  const candidates: ResumeCandidate[] = [];
  for (const project of projects) {
    if (budget.incompleteReason !== undefined) break;
    if (!project.directory) continue;
    const candidate = candidateUnderProjectDir(
      join(projectsDir, project.name),
      id,
      budget,
    );
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
}

function budget(agencHome: string): SearchBudget {
  let projectsRoot: string | undefined;
  let incompleteReason: SearchBudget["incompleteReason"];
  try {
    projectsRoot = realpathSync(
      resolve(getAgencHomeDir(agencHome), "projects"),
    );
  } catch (error) {
    projectsRoot = undefined;
    if (!isMissingPathError(error)) incompleteReason = "source_unavailable";
  }
  return {
    deadlineMs: Date.now() + RESUME_SEARCH_LIMITS.milliseconds,
    projectsRoot,
    metadataBytes: 0,
    ...(incompleteReason !== undefined ? { incompleteReason } : {}),
  };
}

function incomplete(
  input: string,
  search: SearchBudget,
): ResumeSessionResolution | undefined {
  return search.incompleteReason === undefined
    ? undefined
    : { kind: "search_incomplete", input, reason: search.incompleteReason };
}

function resolveMatches(
  input: string,
  matches: readonly ResumeCandidate[],
  search: SearchBudget,
): ResumeSessionResolution {
  if (matches.length === 1) {
    const descriptor = sealCandidate(matches[0]!, search);
    if (descriptor === null) {
      return incomplete(input, search) ?? { kind: "not_found", input };
    }
    return { kind: "ok", ...descriptor };
  }
  if (matches.length > 1) {
    const counts = new Map<string, number>();
    for (const candidate of matches) {
      counts.set(
        candidate.sessionId,
        (counts.get(candidate.sessionId) ?? 0) + 1,
      );
    }
    return {
      kind: "ambiguous",
      input,
      matches: matches
        .slice(0, 8)
        .map((candidate) =>
          (counts.get(candidate.sessionId) ?? 0) > 1
            ? `${candidate.sessionId} @ ${candidate.rolloutPath}`
            : candidate.sessionId,
        ),
    };
  }
  return { kind: "not_found", input };
}

export function resolveLatestSessionId(
  cwd: string,
  agencHome: string,
): ResumeSessionResolution {
  const search = budget(agencHome);
  const latest = projectCandidatesCrossSlug(cwd, agencHome, search)[0];
  const stopped = incomplete("--continue", search);
  if (stopped !== undefined) return stopped;
  if (latest === undefined) return { kind: "none" };
  const descriptor = sealCandidate(latest, search);
  return descriptor === null
    ? (incomplete("--continue", search) ?? { kind: "none" })
    : { kind: "ok", ...descriptor };
}

export function resolveResumeSessionId(
  cwd: string,
  input: string,
  agencHome: string,
): ResumeSessionResolution {
  const trimmed = input.trim();
  if (!isSafeSessionIdSegment(trimmed)) {
    return { kind: "not_found", input };
  }
  const exactSearch = budget(agencHome);
  const exact = exactLocalCandidates(cwd, trimmed, agencHome, exactSearch);
  const exactStopped = incomplete(trimmed, exactSearch);
  if (exactStopped !== undefined) return exactStopped;
  if (exact.length > 0) return resolveMatches(trimmed, exact, exactSearch);

  const prefixSearch = budget(agencHome);
  const prefixMatches = projectCandidatesCrossSlug(
    cwd,
    agencHome,
    prefixSearch,
  ).filter((candidate) => candidate.sessionId.startsWith(trimmed));
  const prefixStopped = incomplete(trimmed, prefixSearch);
  if (prefixStopped !== undefined) return prefixStopped;
  if (prefixMatches.length > 0) {
    return resolveMatches(trimmed, prefixMatches, prefixSearch);
  }

  if (isLikelyConvId(trimmed)) {
    const globalSearch = budget(agencHome);
    const matches = globalCandidates(trimmed, globalSearch);
    const globalStopped = incomplete(trimmed, globalSearch);
    if (globalStopped !== undefined) return globalStopped;
    return resolveMatches(trimmed, matches, globalSearch);
  }
  return { kind: "not_found", input: trimmed };
}
