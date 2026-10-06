/**
 * Browser session manager: owns the dedicated Chromium child, the loopback
 * SSRF proxy, the CDP connection, and the tab registry for one runtime process.
 *
 * The browser launches lazily on the first action, all egress is forced through
 * the in-process proxy (no independent DNS/connections), a dedicated profile
 * lives under `<agencHome>/browser/profiles/<project-key>` (0700, never the
 * user's real profile), it shuts down after an idle period, and is force-killed
 * on process exit. The daemon calls {@link closeAllBrowserManagers} from its
 * cleanup registry.
 *
 * @module
 */

import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, linkSync, lstatSync,
  mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync,
  realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  BrowserLaunchCleanupError,
  CdpConnection,
  launchBrowser,
} from "./cdp.js";
import type { SandboxExecutionBrokerLike } from "../sandbox/execution-broker.js";
import { BrowserPage, BrowserActionError } from "./page.js";
import { BrowserProxy } from "./proxy.js";
import { BrowserExecutableError, resolveBrowserExecutable } from "./executable.js";
import { markEffectBoundaryNotCrossed } from "../tools/effect-boundary.js";
import type { BrowserPolicy } from "./config.js";
import type { HostLookup } from "./ssrf.js";
import {
  signalProcessTree,
  terminateProcessTreeAndWait,
} from "../utils/supervisedProcess.js";
import { resolveSessionTempRoot } from "../session/runtime-options.js";
import { resolveBrowserProfileProjectSync, resolveBrowserProjectRootSync } from "./profile-root.js";

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const MAX_TABS = 8;

/** All live managers in this process — closed together on daemon shutdown. */
const activeManagers = new Set<BrowserManager>();

/**
 * Shared profile directories (the persistent default or a configured
 * profile_dir) and the manager whose browser is launching or running on each.
 * Chromium allows one browser per profile: a second launch hands its command
 * line to the running one through the profile's SingletonLock and exits, which
 * the CDP pipe reports as closed. Every session of a daemon has its own
 * manager, so without this a second session could not use the browser while
 * the first one's was up (luna-mac F2).
 */
const sharedProfileHolders = new Map<string, BrowserManager>();
const privateProfileDirs = new Set<string>();
const cleanedTempRoots = new Set<string>();
const PRIVATE_PROFILE_NAME = /^agenc-browser-(?:child-)?[a-zA-Z0-9]{6}$/;
const PROFILE_MARKER = ".agenc-profile-owner";
const PROFILE_RECOVERY_MARKER = ".agenc-profile-recovery";
const processStartedAt = Math.round(Date.now() - process.uptime() * 1_000);
// Older, ungated launches can die between spawn(2) and recording the child's
// PID. During that interval absence of SingletonLock does not prove it idle.
const UNRECORDED_BROWSER_START_MS = 60_000;

interface ProfileOwnerMarker {
  readonly pid: number;
  readonly startedAt: number;
  readonly id: string;
  readonly browserPid?: number;
  readonly gated?: boolean;
}

function writeMarkerAtomically(path: string, marker: string, expected?: ProfileOwnerMarker): boolean {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let written = false;
  try {
    writeFileSync(fd, marker, "utf8");
    written = true;
  } finally {
    closeSync(fd);
    if (!written) unlinkSync(temporary);
  }
  try {
    if (expected !== undefined) {
      if (!markerIdentityMatches(path, expected)) return false;
      renameSync(temporary, path);
    } else linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    try { unlinkSync(temporary); } catch { /* The claim itself remains authoritative. */ }
  }
}

/** An exclusive claim protects the interval before Chromium writes its lock. */
function claimProfileMarker(dir: string, name = PROFILE_MARKER): string | undefined {
  const marker = JSON.stringify({
    pid: process.pid, startedAt: processStartedAt, id: randomUUID(),
    gated: process.platform !== "win32",
  });
  return writeMarkerAtomically(join(dir, name), marker) ? marker : undefined;
}

/** Serialize removal of a dead shared claim before creating a fresh one. */
function claimSharedProfileMarker(dir: string): string | undefined {
  const recoveryPath = join(dir, PROFILE_RECOVERY_MARKER);
  if (existsSync(recoveryPath)) {
    const staleRecovery = readProfileMarker(dir, PROFILE_RECOVERY_MARKER);
    if (staleRecovery === undefined ||
        !markerOwnerProvablyDead(dir, PROFILE_RECOVERY_MARKER, true, staleRecovery) ||
        !markerIdentityMatches(recoveryPath, staleRecovery?.owner)) return undefined;
    unlinkSync(recoveryPath);
  }
  const marker = claimProfileMarker(dir);
  if (marker !== undefined || !markerOwnerProvablyDead(dir, PROFILE_MARKER, true) ||
      unrecordedOrLiveBrowserMayStart(dir)) return marker;
  const recovery = claimProfileMarker(dir, PROFILE_RECOVERY_MARKER);
  if (recovery === undefined) return undefined;
  try {
    if (!markerOwnerProvablyDead(dir, PROFILE_MARKER, true) ||
        unrecordedOrLiveBrowserMayStart(dir)) return undefined;
    unlinkSync(join(dir, PROFILE_MARKER));
    return claimProfileMarker(dir);
  } finally {
    if (readFileSync(recoveryPath, "utf8") === recovery) unlinkSync(recoveryPath);
  }
}

function processStartedAtMs(pid: number): number | undefined {
  if (pid === process.pid) return processStartedAt;
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  try {
    const output = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout: 5_000,
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    }).trim();
    const startedAt = Date.parse(output);
    return Number.isFinite(startedAt) ? startedAt : undefined;
  } catch {
    return undefined;
  }
}

function readProfileMarker(dir: string, name: string): { owner?: ProfileOwnerMarker; modifiedAt: number } | undefined {
  const path = join(dir, name);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    const owner: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof owner !== "object" || owner === null) return { modifiedAt: info.mtimeMs };
    const { pid, startedAt } = owner as { pid?: unknown; startedAt?: unknown };
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 ||
        typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) {
      return { modifiedAt: info.mtimeMs };
    }
    return { owner: owner as ProfileOwnerMarker, modifiedAt: info.mtimeMs };
  } catch (error) {
    if (error instanceof SyntaxError) {
      try { return { modifiedAt: lstatSync(path).mtimeMs }; } catch { return undefined; }
    }
    return undefined;
  }
}

function markerIdentityMatches(path: string, expected: ProfileOwnerMarker | undefined): boolean {
  if (expected === undefined || typeof expected.id !== "string" || expected.id.length === 0) return false;
  const current = readProfileMarker(dirname(path), basename(path))?.owner;
  return current !== undefined && current.id === expected.id &&
    current.pid === expected.pid && current.startedAt === expected.startedAt;
}

function markerOwnerProvablyDead(
  dir: string, name = PROFILE_MARKER, oldIncomplete = false,
  marker = readProfileMarker(dir, name),
): boolean {
  if (marker === undefined) return false;
  if (marker.owner === undefined) {
    return oldIncomplete && Date.now() - marker.modifiedAt >= UNRECORDED_BROWSER_START_MS;
  }
  const { pid, startedAt } = marker.owner;
  try {
    process.kill(pid, 0);
    const observedStart = processStartedAtMs(pid);
    // A live, unrelated process may have reused the numeric PID. If the OS
    // cannot give us its start time, retain the claim rather than guess.
    return observedStart !== undefined && observedStart > startedAt + 2_000;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function unrecordedOrLiveBrowserMayStart(dir: string): boolean {
  const marker = readProfileMarker(dir, PROFILE_MARKER);
  if (marker === undefined) return true;
  const browserPid = marker.owner?.browserPid;
  if (typeof browserPid === "number" && Number.isSafeInteger(browserPid) && browserPid > 0) {
    try {
      process.kill(browserPid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
    }
  }
  // A gated launch cannot exec Chromium until its PID is in this marker. If
  // the owner died before that update, the gate pipe closes without launch.
  if (browserPid === undefined && marker.owner?.gated === true) return false;
  return browserPid === undefined && Date.now() - marker.modifiedAt < UNRECORDED_BROWSER_START_MS;
}

/**
 * Whether a live Chromium, possibly in another process, holds `profileDir`.
 * On POSIX, Chromium keeps a SingletonLock symlink to "<host>-<pid>" in the
 * profile while it runs. A lock this host cannot prove stale counts as held,
 * which costs only the persistent profile for that launch. Windows keeps no
 * such link, so there only this process's own holders are known.
 */
function sharedProfileHeldElsewhere(profileDir: string, unreadableIsHeld = false): boolean {
  let target: string;
  try {
    target = readlinkSync(join(profileDir, "SingletonLock"));
  } catch (error) {
    return unreadableIsHeld && (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  const separator = target.lastIndexOf("-");
  const pid = Number(target.slice(separator + 1));
  if (separator <= 0 || !Number.isSafeInteger(pid) || pid <= 0) return true;
  if (target.slice(0, separator) !== hostname()) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Clear profiles orphaned by an earlier daemon before creating a new one. */
function cleanStalePrivateProfiles(root: string, sharedProfile?: string): void {
  if (cleanedTempRoots.has(root)) return;
  // Windows has no Chromium SingletonLock symlink to establish that another
  // daemon's private profile is idle.
  if (process.platform === "win32") return;
  for (const name of readdirSync(root)) {
    if (!PRIVATE_PROFILE_NAME.test(name)) continue;
    const path = join(root, name);
    if (path === sharedProfile) continue;
    if (privateProfileDirs.has(path)) continue;
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) continue;
    if ((info.mode & 0o077) !== 0) continue;
    if (!markerOwnerProvablyDead(path) || unrecordedOrLiveBrowserMayStart(path) ||
        sharedProfileHeldElsewhere(path, true)) continue;
    rmSync(path, { recursive: true, force: true });
  }
  cleanedTempRoots.add(root);
}

function isWithin(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (!/^\.\.(?:[\\/]|$)/.test(suffix) && !isAbsolute(suffix));
}

const MAC_ACL_PERMISSIONS = new Set([
  "read", "write", "execute", "delete", "append", "readattr", "writeattr",
  "readextattr", "writeextattr", "readsecurity", "writesecurity", "chown",
  "list", "search", "add_file", "add_subdirectory", "delete_child",
  "read_data", "write_data", "append_data",
  // Inheritance flags, not rights; they appear on folders in shared locations.
  "file_inherit", "directory_inherit", "limit_inherit", "only_inherit",
]);
/** Inspect every component in one ls invocation; unknown output refuses storage. */
function verifyMacAcls(paths: readonly string[], runner: (paths: readonly string[]) => string): void {
  if (paths.some((path) => path.includes("\n") || path.includes("\r"))) {
    throw new Error("browser profile path cannot be parsed by ls");
  }
  const output = runner(paths);
  const pending = new Set(paths);
  let current: string | undefined;
  let aclExpected = false;
  let aclSeen = false;
  for (const line of output.trimEnd().split("\n")) {
    const header = paths.find((path) => line.endsWith(` ${path}`) &&
      /^d[rwxstST-]{9}[+@ ]?\s+\d+\s+/.test(line));
    if (header !== undefined) {
      if (current !== undefined && aclExpected && !aclSeen) throw new Error("unparsed browser profile ACL");
      if (!pending.delete(header)) throw new Error("duplicate browser profile ACL path");
      current = header;
      aclExpected = line.slice(0, line.indexOf(" ")).includes("+");
      aclSeen = false;
      continue;
    }
    const entry = /^\s+\d+:\s+(.+?)\s+(allow|deny)\s+([a-z_,]+)$/.exec(line);
    if (current === undefined || entry === null) throw new Error("unparsed browser profile ACL");
    aclSeen = true;
    const permissions = entry[3]!.split(",");
    if (permissions.some((permission) => !MAC_ACL_PERMISSIONS.has(permission))) {
      throw new Error("unknown browser profile ACL permission");
    }
    // The owner's rights come from the mode bits; an allow entry only ever
    // grants someone else access, even just to read stored logins.
    if (entry[2] === "allow") {
      throw new Error(`browser profile ACL grants access to another principal: ${current}`);
    }
  }
  if (current !== undefined && aclExpected && !aclSeen) throw new Error("unparsed browser profile ACL");
  if (pending.size !== 0) throw new Error("missing browser profile ACL path");
}

/** Node lstat reports Windows junctions as symbolic links; never follow one. */
function ensurePrivateProfileDirectory(path: string, platform: NodeJS.Platform, tighten = true): boolean {
  let created = false;
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`browser profile path is not a regular directory: ${path}`);
  }
  if (platform === "win32") {
    // The default ACL of the current user's profile folder protects this
    // contained chain; Node reports junctions and other reparse links here.
    return created;
  }
  const uid = process.getuid?.();
  if (uid === undefined || info.uid !== uid) {
    throw new Error(`browser profile directory is not owned by this user: ${path}`);
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error(`browser profile directory is writable by another user: ${path}`);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== info.dev || opened.ino !== info.ino ||
        opened.uid !== uid) {
      throw new Error(`browser profile directory changed during validation: ${path}`);
    }
    if (tighten && (opened.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
  return created;
}

function ensurePersistentProjectProfile(
  home: string, key: string, platform: NodeJS.Platform,
  userHomeOverride?: string, lsRunner?: (paths: readonly string[]) => string,
): { readonly path: string; readonly created: boolean } {
  const userHome = userHomeOverride ?? (platform === "win32" ? process.env.USERPROFILE : userInfo().homedir);
  if (userHome === undefined || userHome === "") throw new Error("cannot identify current user's home");
  const canonicalUserHome = realpathSync.native(userHome);
  // A fresh AGENC_HOME may not exist yet. Create it privately; the checks
  // below then judge the real path it resolved to.
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  const canonicalHome = realpathSync.native(home);
  if (!isWithin(canonicalUserHome, canonicalHome)) {
    throw new Error("browser profile home is outside the current user's home");
  }
  // A canonical home may have been named through /var, /tmp, or another
  // symlink. Validate only the real path inside the user's real home.
  const path = join(canonicalHome, "browser", "profiles", key);
  const suffix = relative(canonicalUserHome, path);
  const components = [canonicalUserHome];
  for (const part of suffix.split(/[\\/]/).filter(Boolean)) {
    components.push(join(components.at(-1)!, part));
  }
  if (platform === "win32") {
    const lexicalHome = resolve(home);
    if (!isWithin(canonicalUserHome, lexicalHome)) {
      throw new Error("browser profile home is outside the current user's profile folder");
    }
    let lexical = canonicalUserHome;
    for (const part of relative(canonicalUserHome, lexicalHome).split(/[\\/]/).filter(Boolean)) {
      lexical = join(lexical, part);
      if (lstatSync(lexical).isSymbolicLink()) {
        throw new Error(`browser profile path is a link or junction: ${lexical}`);
      }
    }
  }
  let created = false;
  for (const component of components) {
    const made = ensurePrivateProfileDirectory(component, platform,
      component !== canonicalUserHome && isWithin(canonicalHome, component));
    if (component === path) created = made;
  }
  if (platform === "darwin") {
    verifyMacAcls(components, lsRunner ?? ((paths) => execFileSync("/bin/ls", ["-lde", ...paths], {
      encoding: "utf8", timeout: 5_000,
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    })));
  }
  return { path, created };
}

/**
 * A refusal made before any page was touched: the named tab does not exist,
 * or no new tab may be opened. Branded as no effect because a bare error from
 * this mutating tool is filed as an unknown outcome and blocks every later
 * side-effecting call until /resolve.
 */
function refusedBeforePageAction(message: string): BrowserActionError {
  return markEffectBoundaryNotCrossed(new BrowserActionError(message), {
    evidenceRef: "tool:Browser:refused-before-page-action",
    evidenceMaterial: message,
  });
}

/** Graceful shutdown hook for the daemon cleanup registry. */
export async function closeAllBrowserManagers(): Promise<void> {
  const managers = [...activeManagers];
  const results = await Promise.allSettled(
    managers.map((manager) => manager.closeAll()),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, "browser manager shutdown failed");
  }
}

export interface BrowserManagerOptions {
  readonly agencHome?: string;
  /** Canonical browser project root for the session's initial workspace. */
  readonly projectRoot?: string;
  /** Session root markers used by trust and workspace transition recomputes. */
  readonly projectRootMarkers?: readonly string[];
  /** Current markers from the same live config snapshot used by trust. */
  readonly projectRootMarkersProvider?: () => readonly string[] | undefined;
  /** Notify this manager when that snapshot is published on reload. */
  readonly subscribeProjectRootMarkers?: (listener: () => void) => () => void;
  /** Test seam for Windows reparse-point validation. */
  readonly profileValidationPlatform?: NodeJS.Platform;
  /** Test seam for the OS-owned user profile path. */
  readonly profileValidationUserHome?: string;
  /** Test seam for a single macOS ACL inspection of the entire chain. */
  readonly profileValidationLs?: (paths: readonly string[]) => string;
  readonly policy: BrowserPolicy;
  /** Authenticated session boundary for the Chromium process. */
  readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
  /** Test seam: overrides DNS resolution inside the proxy's SSRF checks. */
  readonly lookup?: HostLookup;
  /** Test seam: overrides idle shutdown delay. */
  readonly idleShutdownMs?: number;
}

export interface TabDescriptor {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

interface TabEntry {
  readonly id: number;
  readonly page: BrowserPage;
}

interface BrowserBoundary {
  child: ChildProcess | undefined;
  proxy: BrowserProxy | undefined;
  readonly label: string;
}

interface RetainedBrowserBoundary {
  readonly boundary: BrowserBoundary;
  failure: Error;
}

export class BrowserManager {
  readonly #options: BrowserManagerOptions;
  #child: ChildProcess | undefined;
  #connection: CdpConnection | undefined;
  #proxy: BrowserProxy | undefined;
  #tabs: TabEntry[] = [];
  #activeTabId = 0;
  #nextTabId = 1;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #launching: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #processCleanup: Promise<void> | undefined;
  #retainedBoundaries: RetainedBrowserBoundary[] = [];
  #shutdownGeneration = 0;
  #launchAuthorityCwd: string | undefined;
  readonly #initialAuthorityCwd: string | undefined;
  readonly #initialProjectRoot: string;
  #tempProfileDir: string | undefined;
  #sharedProfileDir: string | undefined;
  #sharedProfileMarker: string | undefined;
  #profilePathWarningLogged = false;
  #launchedProfileIdentity: string | undefined;
  #profileConfigGeneration = 0;
  #cachedProfileProject: {
    readonly generation: number;
    readonly cwd: string | undefined;
    readonly project: { readonly root: string; readonly lexicalRoot: string; readonly trustRootMismatch: boolean };
  } | undefined;
  readonly #unsubscribeProjectRootMarkers: (() => void) | undefined;
  readonly #exitListener = (): void => {
    this.#killNow();
  };

  constructor(options: BrowserManagerOptions) {
    this.#options = options;
    this.#initialAuthorityCwd = options.sandboxExecutionBroker?.cwd;
    this.#initialProjectRoot = options.projectRoot ?? resolveBrowserProjectRootSync(
      this.#initialAuthorityCwd ?? process.cwd(),
      options.projectRootMarkers,
    );
    this.#unsubscribeProjectRootMarkers = options.subscribeProjectRootMarkers?.(() => {
      void this.closeIfProfileKeyChanged().catch((error: unknown) => {
        console.error(`[Browser] Failed to close browser after profile key change: ${String(error)}`);
      });
    });
  }

  #profileProject(): { readonly root: string; readonly lexicalRoot: string; readonly trustRootMismatch: boolean } {
    const cwd = this.#options.sandboxExecutionBroker?.cwd;
    const cached = this.#cachedProfileProject;
    if (cached?.generation === this.#profileConfigGeneration && cached.cwd === cwd) return cached.project;
    const project = cwd === undefined
      ? { root: this.#initialProjectRoot, lexicalRoot: this.#initialProjectRoot, trustRootMismatch: false }
      : resolveBrowserProfileProjectSync(
        cwd,
        this.#options.projectRootMarkersProvider?.() ?? this.#options.projectRootMarkers,
      );
    this.#cachedProfileProject = { generation: this.#profileConfigGeneration, cwd, project };
    return project;
  }

  #identityFor(project: { readonly root: string; readonly lexicalRoot: string }): string {
    return JSON.stringify([this.#options.policy.profileDir ?? null, project.lexicalRoot, project.root]);
  }

  #profileIdentity(): string {
    return this.#identityFor(this.#profileProject());
  }

  #validateProjectProfile(root: string): { readonly path: string; readonly created: boolean } {
    return ensurePersistentProjectProfile(
      this.#options.agencHome!, createHash("sha256").update(root).digest("hex").slice(0, 24),
      this.#options.profileValidationPlatform ?? process.platform,
      this.#options.profileValidationUserHome,
      this.#options.profileValidationLs,
    );
  }

  #warnProfileFallback(error: unknown): void {
    if (this.#profilePathWarningLogged) return;
    console.warn(`[Browser] Refusing persistent browser profile; using a private temporary profile: ${String(error)}`);
    this.#profilePathWarningLogged = true;
  }

  /** Reload publication closes a browser before it can reuse an obsolete profile key. */
  closeIfProfileKeyChanged(): Promise<void> {
    this.#profileConfigGeneration += 1;
    if (this.#launchedProfileIdentity !== undefined &&
        this.#launchedProfileIdentity !== this.#profileIdentity()) {
      return this.closeAll();
    }
    // A reload is also the next chance to catch a changed home or ACL while
    // the browser is running. Ordinary actions reuse this generation's result.
    if (this.#options.policy.profileDir === undefined &&
        this.#options.agencHome !== undefined && this.#sharedProfileDir !== undefined) {
      try {
        if (this.#validateProjectProfile(this.#profileProject().root).path !== this.#sharedProfileDir) {
          return this.closeAll();
        }
      } catch (error) {
        this.#warnProfileFallback(error);
        return this.closeAll();
      }
    }
    return Promise.resolve();
  }

  async dispose(): Promise<void> {
    this.#unsubscribeProjectRootMarkers?.();
    await this.closeAll();
  }

  get running(): boolean {
    return this.#connection !== undefined && !this.#connection.closed;
  }

  /**
   * Resolve the profile dir and ensure it exists (0700). The fallback uses
   * `mkdtempSync` rather than a predictable `<tmpdir>/agenc-browser-<pid>-<ts>`
   * path: on a shared host that predictable name lets a local attacker
   * pre-create (or symlink) the directory so Chromium reuses an
   * attacker-readable profile. `mkdtempSync` always creates a fresh,
   * unpredictable 0700 directory and never reuses an existing one.
   */
  #ensureProfileDir(): string {
    const tempRoot = resolveSessionTempRoot();
    const project = this.#profileProject();
    this.#launchedProfileIdentity = this.#identityFor(project);
    let shared = this.#options.policy.profileDir;
    cleanStalePrivateProfiles(tempRoot, shared);
    // Child sessions get an ephemeral profile. Sharing the root session's
    // persistent cookies/storage across independently sandboxed browser
    // processes would silently collapse their authority boundary.
    if ((this.#options.sandboxExecutionBroker?.forkDepth ?? 0) > 0) {
      if (this.#tempProfileDir === undefined) {
        return this.#createPrivateProfile(tempRoot, "agenc-browser-child-");
      }
      return this.#tempProfileDir;
    }
    if (shared !== undefined || this.#options.agencHome !== undefined) {
      let usable = !project.trustRootMismatch || shared !== undefined;
      if (shared === undefined && this.#options.agencHome !== undefined) {
        try {
          if (project.trustRootMismatch) {
            throw new Error("lexical trust root differs from the realpath workspace root");
          }
          const persistent = this.#validateProjectProfile(project.root);
          shared = persistent.path;
          if (persistent.created &&
              existsSync(join(this.#options.agencHome, "browser", "profile"))) {
            console.info("[Browser] Existing legacy browser profile left unused; created a project profile.");
          }
        } catch (error) {
          usable = false;
          this.#warnProfileFallback(error);
        }
      } else {
        mkdirSync(shared!, { recursive: true, mode: 0o700 });
      }
      if (usable && shared !== undefined && this.#claimSharedProfile(shared)) return shared;
      // Another session's browser holds the shared profile. Chromium would
      // hand this launch to it and exit, so this browser gets its own fresh
      // profile instead: nothing is shared with the other session, and the
      // directory is removed when this browser closes.
    }
    if (this.#tempProfileDir === undefined) {
      return this.#createPrivateProfile(tempRoot, "agenc-browser-");
    }
    return this.#tempProfileDir;
  }

  #createPrivateProfile(root: string, prefix: string): string {
    const dir = mkdtempSync(join(root, prefix));
    if (claimProfileMarker(dir) === undefined) {
      throw new Error("new private browser profile already has an owner");
    }
    this.#tempProfileDir = dir;
    privateProfileDirs.add(dir);
    return dir;
  }

  /**
   * Hold `dir` for this manager's next browser, unless a browser of another
   * manager in this process, or a live Chromium anywhere on this host, holds
   * it. The claim covers the launch window before Chromium writes its own
   * SingletonLock and lasts until this browser is torn down; from then on
   * that lock protects a browser that is still exiting.
   */
  #claimSharedProfile(dir: string): boolean {
    const holder = sharedProfileHolders.get(dir);
    if (holder !== undefined && holder !== this) return false;
    if (holder === undefined) {
      if (sharedProfileHeldElsewhere(dir)) return false;
      const marker = claimSharedProfileMarker(dir);
      if (marker === undefined) return false;
      this.#sharedProfileMarker = marker;
    }
    sharedProfileHolders.set(dir, this);
    this.#sharedProfileDir = dir;
    return true;
  }

  #releaseSharedProfile(): void {
    const dir = this.#sharedProfileDir;
    const marker = this.#sharedProfileMarker;
    if (dir !== undefined && marker !== undefined) {
      const path = join(dir, PROFILE_MARKER);
      try {
        if (readFileSync(path, "utf8") === marker) unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.#sharedProfileDir = undefined;
    this.#sharedProfileMarker = undefined;
    if (dir !== undefined && sharedProfileHolders.get(dir) === this) {
      sharedProfileHolders.delete(dir);
    }
  }

  #recordBrowserPid(dir: string, child: ChildProcess): void {
    if (child.pid === undefined) return;
    const path = join(dir, PROFILE_MARKER);
    const marker = readFileSync(path, "utf8");
    if (dir === this.#sharedProfileDir && marker !== this.#sharedProfileMarker) {
      throw new Error("browser profile claim changed before child identity was recorded");
    }
    const owner = JSON.parse(marker) as ProfileOwnerMarker;
    if (owner.pid !== process.pid || owner.startedAt !== processStartedAt) {
      throw new Error("browser profile owner changed before child identity was recorded");
    }
    const updated = JSON.stringify({ ...owner, browserPid: child.pid });
    if (!writeMarkerAtomically(path, updated, owner)) {
      throw new Error("browser profile claim changed before child identity was recorded");
    }
    if (dir === this.#sharedProfileDir) this.#sharedProfileMarker = updated;
  }

  async #ensureLaunched(): Promise<void> {
    const requestGeneration = this.#shutdownGeneration;
    while (true) {
      if (requestGeneration !== this.#shutdownGeneration) {
        throw new BrowserActionError("browser launch was interrupted by shutdown");
      }
      if (this.#closing !== undefined) {
        await this.#closing;
        continue;
      }
      await this.#awaitProcessCleanup();
      const brokerCwd = this.#options.sandboxExecutionBroker?.cwd;
      if (
        this.running &&
        brokerCwd !== undefined &&
        this.#launchAuthorityCwd !== brokerCwd
      ) {
        await this.closeAll();
        continue;
      }
      if (this.running && this.#launchedProfileIdentity !== this.#profileIdentity()) {
        await this.closeAll();
        continue;
      }
      if (this.running) {
        this.#touchIdle();
        return;
      }
      if (this.#launching !== undefined) {
        await this.#launching;
        continue;
      }
      const generation = this.#shutdownGeneration;
      const launching = this.#launch(generation);
      this.#launching = launching;
      try {
        await launching;
      } finally {
        if (this.#launching === launching) this.#launching = undefined;
      }
    }
  }

  async #launch(generation: number): Promise<void> {
    const authorityCwd = this.#options.sandboxExecutionBroker?.cwd;
    const proxy = new BrowserProxy({
      policy: { allowPrivateNetwork: this.#options.policy.allowPrivateNetwork },
      ...(this.#options.lookup !== undefined
        ? { lookup: this.#options.lookup }
        : {}),
    });
    const proxyPort = await proxy.start();

    // Everything after the proxy is listening must stop it on failure, or the
    // loopback listener leaks (and every retried action leaks another). This
    // includes profile-dir creation, which can throw on a bad profile_dir.
    let launched;
    try {
      const executablePath = resolveBrowserExecutable(
        this.#options.policy.executablePath,
      );
      const userDataDir = this.#ensureProfileDir();
      launched = await launchBrowser({
        executablePath,
        userDataDir,
        headless: this.#options.policy.headless,
        noSandbox: this.#options.policy.noSandbox,
        proxyPort,
        onSpawn: (child) => this.#recordBrowserPid(userDataDir, child),
        ...(this.#options.sandboxExecutionBroker !== undefined
          ? { sandboxExecutionBroker: this.#options.sandboxExecutionBroker }
          : {}),
      });
    } catch (err) {
      this.#launchedProfileIdentity = undefined;
      const boundary: BrowserBoundary = {
        child: undefined,
        proxy,
        label: "failed browser launch",
      };
      let managerCleanupError: Error | undefined;
      try {
        await this.#cleanupOwnedBoundary(
          boundary, !(err instanceof BrowserLaunchCleanupError),
        );
      } catch (cleanupError) {
        managerCleanupError = toError(cleanupError);
      }
      if (err instanceof BrowserLaunchCleanupError) {
        // launchBrowser already attempted verified teardown. Do not silently
        // retry that failed process boundary from an ordinary action: transfer
        // ownership, poison the manager, and leave retry authority to closeAll.
        boundary.child = err.child;
        this.#retainBoundary(
          boundary,
          managerCleanupError === undefined
            ? err.cleanupError
            : new AggregateError(
                [err.cleanupError, managerCleanupError],
                "failed browser launch boundary cleanup remains incomplete",
              ),
        );
      }
      if (managerCleanupError !== undefined) {
        throw new AggregateError(
          [err, managerCleanupError],
          "browser launch cleanup failed",
        );
      }
      if (err instanceof BrowserExecutableError) {
        // Resolution failed before the profile directory or any browser process
        // existed, and this attempt's loopback proxy is already stopped. Only this
        // branded error proves no effect; a launch or CDP failure stays unknown.
        markEffectBoundaryNotCrossed(err, {
          evidenceRef: "tool:Browser:launch-executable-not-found",
          evidenceMaterial: JSON.stringify({
            stage: "executable_resolution",
            browserSpawned: false,
            proxyStopped: true,
            code: err.code,
            message: err.message,
          }),
        });
      }
      throw err;
    }

    if (
      generation !== this.#shutdownGeneration ||
      authorityCwd !== this.#options.sandboxExecutionBroker?.cwd
    ) {
      launched.connection.close();
      await this.#cleanupOwnedBoundary({
        child: launched.child,
        proxy,
        label: "stale browser launch",
      });
      return;
    }

    this.#proxy = proxy;
    this.#child = launched.child;
    this.#connection = launched.connection;
    this.#launchAuthorityCwd = authorityCwd;
    this.#tabs = [];
    this.#activeTabId = 0;
    launched.child.once("exit", () => {
      if (this.#child === launched.child) {
        const stoppedProxy = this.#teardownState();
        this.#trackUnexpectedCleanup({
          child: launched.child,
          proxy: stoppedProxy,
          label: "browser after unexpected exit",
        });
      }
    });
    process.once("exit", this.#exitListener);
    activeManagers.add(this);
    this.#touchIdle();
  }

  #touchIdle(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    const delay = this.#options.idleShutdownMs ?? IDLE_SHUTDOWN_MS;
    this.#idleTimer = setTimeout(() => {
      void this.closeAll();
    }, delay);
    this.#idleTimer.unref?.();
  }

  async #createTab(url: string, signal?: AbortSignal): Promise<TabEntry> {
    const connection = this.#connection;
    const proxy = this.#proxy;
    if (connection === undefined || proxy === undefined) {
      throw new BrowserActionError("browser is not running");
    }
    if (this.#tabs.length >= MAX_TABS) {
      throw refusedBeforePageAction(
        `too many open tabs (max ${MAX_TABS}). Close one first.`,
      );
    }
    const sendOptions = signal === undefined ? {} : { signal };
    const created = await connection.send(
      "Target.createTarget", { url: "about:blank" }, undefined, sendOptions,
    );
    const targetId = created.targetId as string;
    const attached = await connection.send(
      "Target.attachToTarget", { targetId, flatten: true }, undefined, sendOptions,
    );
    const sessionId = attached.sessionId as string;
    const page = new BrowserPage({
      connection,
      targetId,
      sessionId,
      navigationTimeoutMs: this.#options.policy.navigationTimeoutMs,
      blockReporter: (host) => proxy.takeBlockReason(host),
    });
    const entry: TabEntry = { id: this.#nextTabId++, page };
    this.#tabs.push(entry);
    this.#activeTabId = entry.id;
    // Own the attached target before any initialization/navigation can fail.
    // Its error page remains inspectable and the next navigate reuses it.
    await page.init(signal);
    if (url !== "about:blank" && url !== "") {
      await page.navigate(url, signal);
    }
    return entry;
  }

  /** The tab `tabId` names, or the active tab; refused before any page action. */
  #tabById(tabId: number | undefined): TabEntry {
    const id = tabId ?? this.#activeTabId;
    const entry = this.#tabs.find((tab) => tab.id === id);
    if (entry !== undefined) return entry;
    if (this.#tabs.length === 0) {
      throw refusedBeforePageAction(
        tabId === undefined
          ? "no open tabs. Use the navigate action to open a page first."
          : `no tab with id ${tabId}: no tab is open yet. Navigate without tab_id to open the first one.`,
      );
    }
    throw refusedBeforePageAction(
      `no tab with id ${id}. Use the tabs action to list open tabs.`,
    );
  }

  /** Navigate the active tab (creating one if needed) or `tabId`. */
  async navigate(
    url: string,
    tabId?: number,
    signal?: AbortSignal,
  ): Promise<BrowserPage> {
    if (this.#tabs.length === 0 && tabId === undefined) {
      await this.#ensureLaunched();
      this.#touchIdle();
      const entry = await this.#createTab(url, signal);
      return entry.page;
    }
    const entry = this.#tabById(tabId);
    await this.#ensureLaunched();
    if (!this.#tabs.includes(entry)) {
      throw new BrowserActionError("tab closed during browser launch");
    }
    this.#touchIdle();
    this.#activeTabId = entry.id;
    await entry.page.navigate(url, signal);
    return entry.page;
  }

  /** Open a new tab, optionally navigating it. */
  async newTab(url?: string, signal?: AbortSignal): Promise<TabDescriptor> {
    await this.#ensureLaunched();
    this.#touchIdle();
    const entry = await this.#createTab(url ?? "about:blank", signal);
    const info = await entry.page.info(signal);
    return { id: entry.id, url: info.url, title: info.title, active: true };
  }

  /** Get the page for an action; throws when there are no tabs. */
  async page(tabId?: number): Promise<BrowserPage> {
    const entry = this.#tabById(tabId);
    await this.#ensureLaunched();
    if (!this.#tabs.includes(entry)) {
      throw new BrowserActionError("tab closed during browser launch");
    }
    this.#touchIdle();
    this.#activeTabId = entry.id;
    return entry.page;
  }

  async listTabs(signal?: AbortSignal): Promise<TabDescriptor[]> {
    if (!this.running) return [];
    this.#touchIdle();
    const out: TabDescriptor[] = [];
    for (const entry of this.#tabs) {
      const info = await entry.page.info(signal);
      out.push({
        id: entry.id,
        url: info.url,
        title: info.title,
        active: entry.id === this.#activeTabId,
      });
    }
    return out;
  }

  async closeTab(tabId: number): Promise<void> {
    const connection = this.#connection;
    if (connection === undefined) return;
    const entry = this.#tabById(tabId);
    entry.page.dispose();
    await connection
      .send("Target.closeTarget", { targetId: entry.page.targetId })
      .catch(() => {});
    this.#tabs = this.#tabs.filter((tab) => tab.id !== entry.id);
    if (this.#activeTabId === entry.id) {
      this.#activeTabId = this.#tabs.at(-1)?.id ?? 0;
    }
    this.#touchIdle();
  }

  selectTab(tabId: number): void {
    const entry = this.#tabById(tabId);
    this.#activeTabId = entry.id;
    this.#touchIdle();
  }

  #teardownState(): BrowserProxy | undefined {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    for (const entry of this.#tabs) entry.page.dispose();
    this.#tabs = [];
    this.#activeTabId = 0;
    this.#connection?.close();
    this.#connection = undefined;
    this.#child = undefined;
    this.#launchAuthorityCwd = undefined;
    this.#launchedProfileIdentity = undefined;
    const proxy = this.#proxy;
    this.#proxy = undefined;
    activeManagers.delete(this);
    process.removeListener("exit", this.#exitListener);
    return proxy;
  }

  #killNow(): void {
    const child = this.#child;
    const proxy = this.#teardownState();
    void proxy?.stop();
    if (child !== undefined) {
      signalProcessTree(child, "SIGKILL");
    }
    for (const { boundary } of this.#retainedBoundaries) {
      if (boundary.child !== undefined) {
        signalProcessTree(boundary.child, "SIGKILL");
      }
      void boundary.proxy?.stop();
    }
  }

  /** Graceful, bounded shutdown of the platform-owned process scope. */
  closeAll(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#shutdownGeneration += 1;
    let closing!: Promise<void>;
    closing = this.#closeAllOnce().finally(() => {
      if (this.#closing === closing) this.#closing = undefined;
    });
    this.#closing = closing;
    return closing;
  }

  async #closeAllOnce(): Promise<void> {
    const errors: unknown[] = [];
    // A launch racing shutdown assigns #child only when it finishes; without
    // awaiting it here, a browser started mid-shutdown would survive cleanup
    // (and re-arm its idle timer) after closeAll already returned.
    const launching = this.#launching;
    if (launching !== undefined) {
      try {
        await launching;
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.#processCleanup !== undefined) await this.#processCleanup;
    try {
      await this.#retryRetainedBoundaries();
    } catch (error) {
      errors.push(error);
    }
    const child = this.#child;
    const proxy = this.#teardownState();
    try {
      await this.#cleanupOwnedBoundary({ child, proxy, label: "browser" });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "browser shutdown failed");
    }
  }

  async #awaitProcessCleanup(): Promise<void> {
    if (this.#processCleanup !== undefined) await this.#processCleanup;
    if (this.#retainedBoundaries.length === 1) {
      throw this.#retainedBoundaries[0]!.failure;
    }
    if (this.#retainedBoundaries.length > 1) {
      throw new AggregateError(
        this.#retainedBoundaries.map(({ failure }) => failure),
        "browser boundary cleanup remains incomplete",
      );
    }
  }

  #trackUnexpectedCleanup(boundary: BrowserBoundary): void {
    // Keep daemon shutdown aware of this manager until its orphan-resistant
    // cleanup has settled, even though the CDP state is already torn down.
    activeManagers.add(this);
    let tracked!: Promise<void>;
    tracked = this.#cleanupOwnedBoundary(boundary)
      .catch(() => {
        // #cleanupOwnedBoundary retains the failed ownership record. The next
        // action observes that poison; an explicit close retries it.
      })
      .finally(() => {
        if (this.#processCleanup === tracked) this.#processCleanup = undefined;
        if (
          this.#retainedBoundaries.length === 0 &&
          this.#child === undefined
        ) {
          activeManagers.delete(this);
        }
      });
    this.#processCleanup = tracked;
  }

  async #cleanupOwnedBoundary(
    boundary: BrowserBoundary,
    releaseClaim = true,
  ): Promise<void> {
    const errors: unknown[] = [];
    if (boundary.child !== undefined) {
      try {
        await terminateProcessTreeAndWait(boundary.child, {
          label: boundary.label,
        });
        boundary.child = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
    if (boundary.proxy !== undefined) {
      try {
        await boundary.proxy.stop();
        boundary.proxy = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
    if (
      releaseClaim && boundary.child === undefined &&
      !this.#retainedBoundaries.some(
        ({ boundary: retained }) => retained.child !== undefined,
      )
    ) {
      try {
        this.#cleanupTempProfile();
      } catch (error) {
        errors.push(error);
      }
      try {
        this.#releaseSharedProfile();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 0) return;
    const failure = errors.length === 1
      ? toError(errors[0])
      : new AggregateError(errors, `${boundary.label} cleanup failed`);
    this.#retainBoundary(boundary, failure);
    throw failure;
  }

  #retainBoundary(boundary: BrowserBoundary, failure: Error): void {
    const retained = this.#retainedBoundaries.find(
      (candidate) => candidate.boundary === boundary,
    );
    if (retained !== undefined) retained.failure = failure;
    else this.#retainedBoundaries.push({ boundary, failure });
    activeManagers.add(this);
  }

  async #retryRetainedBoundaries(): Promise<void> {
    const failures: unknown[] = [];
    for (const retained of [...this.#retainedBoundaries]) {
      try {
        await this.#cleanupOwnedBoundary(retained.boundary);
        const index = this.#retainedBoundaries.indexOf(retained);
        if (index >= 0) this.#retainedBoundaries.splice(index, 1);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "browser boundary retry failed");
    }
  }

  #cleanupTempProfile(): void {
    if (this.#tempProfileDir !== undefined) {
      rmSync(this.#tempProfileDir, { recursive: true, force: true });
      privateProfileDirs.delete(this.#tempProfileDir);
      this.#tempProfileDir = undefined;
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
