import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { resolveAgencHome } from "../../config/env.js";
import { findProjectRootSync } from "../../session/session-store.js";
import type { ProjectTrust } from "../approval-policy.js";
import { isTrustRecord } from "./records.js";

export interface TrustedProjectEntry {
  readonly path: string;
  readonly trustedAt: string;
}

export interface TrustedProjectsFile {
  readonly version: 1;
  readonly trustedProjects: readonly TrustedProjectEntry[];
}

export interface ProjectTrustPathOptions {
  readonly agencHome?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProjectTrustRootOptions {
  readonly cwd: string;
  readonly projectRootMarkers?: readonly string[];
}

export interface ProjectTrustLookupOptions extends ProjectTrustPathOptions {
  readonly cwd?: string;
  readonly projectRoot?: string;
  readonly projectRootMarkers?: readonly string[];
}

export interface TrustProjectOptions extends ProjectTrustLookupOptions {
  readonly now?: () => Date;
}

const TRUSTED_PROJECTS_FILENAME = "trusted-projects.json";
const TRUSTED_PROJECTS_LOCK_TIMEOUT_MS = 5_000;
const TRUSTED_PROJECTS_LOCK_POLL_MS = 25;

function envWithProcessFallback(
  env: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  return env ?? process.env;
}

export function trustedProjectsPath(options: ProjectTrustPathOptions = {}): string {
  return join(
    options.agencHome ?? resolveAgencHome(envWithProcessFallback(options.env)),
    TRUSTED_PROJECTS_FILENAME,
  );
}

function canonicalizePathSync(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

async function canonicalizePath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

export function resolveProjectTrustRootSync(
  options: ProjectTrustRootOptions,
): string {
  const cwd = resolve(options.cwd);
  const found = findProjectRootSync(cwd, options.projectRootMarkers);
  return canonicalizePathSync(found?.rootDir ?? cwd);
}

async function resolveProjectTrustRoot(
  options: ProjectTrustRootOptions,
): Promise<string> {
  const cwd = resolve(options.cwd);
  const found = findProjectRootSync(cwd, options.projectRootMarkers);
  return canonicalizePath(found?.rootDir ?? cwd);
}

function parseTrustedProjects(raw: string): TrustedProjectsFile {
  try {
    const parsed = JSON.parse(raw);
    if (!isTrustRecord(parsed) || parsed.version !== 1) {
      return { version: 1, trustedProjects: [] };
    }
    const entries = Array.isArray(parsed.trustedProjects)
      ? parsed.trustedProjects
      : [];
    const trustedProjects: TrustedProjectEntry[] = [];
    for (const entry of entries) {
      if (!isTrustRecord(entry)) continue;
      if (typeof entry.path !== "string" || entry.path.length === 0) continue;
      if (typeof entry.trustedAt !== "string" || entry.trustedAt.length === 0) {
        continue;
      }
      trustedProjects.push({
        path: canonicalizePathSync(entry.path),
        trustedAt: entry.trustedAt,
      });
    }
    return { version: 1, trustedProjects };
  } catch {
    return { version: 1, trustedProjects: [] };
  }
}

function readTrustedProjectsSync(
  options: ProjectTrustPathOptions = {},
): TrustedProjectsFile {
  const path = trustedProjectsPath(options);
  if (!existsSync(path)) return { version: 1, trustedProjects: [] };
  try {
    return parseTrustedProjects(readFileSync(path, "utf8"));
  } catch {
    return { version: 1, trustedProjects: [] };
  }
}

export async function readTrustedProjects(
  options: ProjectTrustPathOptions = {},
): Promise<TrustedProjectsFile> {
  const path = trustedProjectsPath(options);
  try {
    return parseTrustedProjects(await readFile(path, "utf8"));
  } catch {
    return { version: 1, trustedProjects: [] };
  }
}

function containsTrustedPath(
  entries: readonly TrustedProjectEntry[],
  projectRoot: string,
): boolean {
  const canonicalRoot = canonicalizePathSync(projectRoot);
  return entries.some(
    (entry) => canonicalizePathSync(entry.path) === canonicalRoot,
  );
}

function resolveLookupRootSync(options: ProjectTrustLookupOptions): string {
  if (options.projectRoot !== undefined) {
    return canonicalizePathSync(options.projectRoot);
  }
  return resolveProjectTrustRootSync({
    cwd: options.cwd ?? process.cwd(),
    projectRootMarkers: options.projectRootMarkers,
  });
}

async function resolveLookupRoot(
  options: ProjectTrustLookupOptions,
): Promise<string> {
  if (options.projectRoot !== undefined) {
    return canonicalizePath(options.projectRoot);
  }
  return resolveProjectTrustRoot({
    cwd: options.cwd ?? process.cwd(),
    projectRootMarkers: options.projectRootMarkers,
  });
}

export function isProjectTrustedSync(
  options: ProjectTrustLookupOptions = {},
): boolean {
  const projectRoot = resolveLookupRootSync(options);
  return containsTrustedPath(readTrustedProjectsSync(options).trustedProjects, projectRoot);
}

export function resolveProjectTrustStateSync(
  options: ProjectTrustLookupOptions = {},
): ProjectTrust {
  return isProjectTrustedSync(options) ? "trusted" : "untrusted";
}

function mergeTrustedProject(
  file: TrustedProjectsFile,
  projectRoot: string,
  trustedAt: string,
): TrustedProjectsFile {
  const next = new Map<string, TrustedProjectEntry>();
  for (const entry of file.trustedProjects) {
    next.set(canonicalizePathSync(entry.path), {
      path: canonicalizePathSync(entry.path),
      trustedAt: entry.trustedAt,
    });
  }
  next.set(projectRoot, { path: projectRoot, trustedAt });
  return {
    version: 1,
    trustedProjects: [...next.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

async function writeTrustedProjectsFile(
  path: string,
  file: TrustedProjectsFile,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

async function withTrustedProjectsLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const startedAt = Date.now();
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  for (;;) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
          }) + "\n",
          "utf8",
        );
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        handle = null;
        throw error;
      }
      break;
    } catch (error) {
      if (isFileExistsError(error)) {
        if (await removeStaleTrustedProjectsLock(lockPath)) {
          continue;
        }
        if (Date.now() - startedAt > TRUSTED_PROJECTS_LOCK_TIMEOUT_MS) {
          throw new Error(
            `Timed out waiting for project trust lock at ${lockPath}. ` +
              `If no other AgenC process is accepting trust, remove the stale lock.`,
          );
        }
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, TRUSTED_PROJECTS_LOCK_POLL_MS),
        );
        continue;
      }
      throw error;
    }
  }

  try {
    return await fn();
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function withTrustedProjectsLockSync<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const startedAt = Date.now();
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
          }) + "\n",
          "utf8",
        );
      } catch (error) {
        try {
          closeSync(fd);
        } catch {
          // Best effort only.
        }
        fd = null;
        try {
          unlinkSync(lockPath);
        } catch {
          // Best effort only.
        }
        throw error;
      }
      break;
    } catch (error) {
      if (isFileExistsError(error)) {
        if (removeStaleTrustedProjectsLockSync(lockPath)) {
          continue;
        }
        if (Date.now() - startedAt > TRUSTED_PROJECTS_LOCK_TIMEOUT_MS) {
          throw new Error(
            `Timed out waiting for project trust lock at ${lockPath}. ` +
              `If no other AgenC process is accepting trust, remove the stale lock.`,
          );
        }
        sleepSync(TRUSTED_PROJECTS_LOCK_POLL_MS);
        continue;
      }
      throw error;
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best effort only.
      }
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Best effort only.
    }
  }
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function parseLockPid(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw);
    if (!isTrustRecord(parsed)) return null;
    const pid = parsed.pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
      ? pid
      : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { readonly code?: unknown }).code !== "ESRCH";
  }
}

async function removeStaleTrustedProjectsLock(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    return isFileNotFoundError(error);
  }
  const pid = parseLockPid(raw);
  if (pid === null || isProcessAlive(pid)) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    return isFileNotFoundError(error);
  }
}

function removeStaleTrustedProjectsLockSync(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    return isFileNotFoundError(error);
  }
  const pid = parseLockPid(raw);
  if (pid === null || isProcessAlive(pid)) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    return isFileNotFoundError(error);
  }
}

function writeTrustedProjectsFileSync(
  path: string,
  file: TrustedProjectsFile,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort only.
    }
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort only.
    }
    throw error;
  }
}

export async function trustProject(
  options: TrustProjectOptions = {},
): Promise<{ readonly projectRoot: string; readonly persisted: boolean }> {
  const projectRoot = await resolveLookupRoot(options);
  const path = trustedProjectsPath(options);
  await withTrustedProjectsLock(path, async () => {
    const current = await readTrustedProjects(options);
    await writeTrustedProjectsFile(
      path,
      mergeTrustedProject(
        current,
        projectRoot,
        (options.now ?? (() => new Date()))().toISOString(),
      ),
    );
  });
  return { projectRoot, persisted: true };
}

export function trustProjectSync(
  options: TrustProjectOptions = {},
): { readonly projectRoot: string; readonly persisted: boolean } {
  const projectRoot = resolveLookupRootSync(options);
  const path = trustedProjectsPath(options);
  withTrustedProjectsLockSync(path, () => {
    const current = readTrustedProjectsSync(options);
    writeTrustedProjectsFileSync(
      path,
      mergeTrustedProject(
        current,
        projectRoot,
        (options.now ?? (() => new Date()))().toISOString(),
      ),
    );
  });
  return { projectRoot, persisted: true };
}

export function checkHasProjectTrustAcceptedSync(
  options: ProjectTrustLookupOptions = {},
): boolean {
  return isProjectTrustedSync({
    ...options,
    env: options.env ?? process.env,
    cwd: options.projectRoot !== undefined
      ? options.cwd
      : options.cwd ?? process.env.AGENC_WORKSPACE ?? process.cwd(),
  });
}

export function __resetProjectTrustForTesting(): void {
  // Retained for tests that reset trust module state between temp homes.
}
