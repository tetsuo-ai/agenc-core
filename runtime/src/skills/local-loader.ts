import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { load as loadYaml } from "js-yaml";

import type { AgenCConfig } from "../config/schema.js";
import { FileWatcher } from "../file-watcher/index.js";
import { discoverPluginSkillRootsWithProvenance } from "../plugins/loader.js";
import type { SessionServices } from "../session/session.js";
import type { SkillLoadOutcome } from "../session/turn-context.js";
import { substituteArguments } from "../tui/slash/argument-substitution.js";
import {
  parseBooleanFrontmatter,
  quoteProblematicValues,
} from "../utils/frontmatterParser.js";
import { isRecord } from "../utils/record.js";
import { getAgenCHomeDir } from "../utils/envUtils.js";
import {
  extractBundledSkillFiles,
  getBundledSkillDirectory,
} from "./bundled-extraction-registry.js";
import { getCurrentBundledSkillExtractionRoot } from "./bundled-root-authority.js";
import {
  createSkillChangeDetector,
  skillChangeDetector,
  type SkillChangeDetector,
} from "./change-detector.js";
import {
  parseSkillFrontmatterFields as parseCanonicalSkillFrontmatterFields,
} from "./loadSkillsDir.js";
import { isRepositoryControlledSkillSource } from "./repository-skill-boundary.js";

export type LocalSkillScope =
  | "user"
  | "project"
  | "plugin"
  | "managed"
  | "bundled"
  | "mcp";

export type LoadedFrom =
  | "skills"
  | "plugin"
  | "managed"
  | "bundled"
  | "mcp";

export type SkillSource =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "policySettings"
  | "plugin"
  | "bundled"
  | "mcp";

export type SkillExecutionContext = "inline" | "fork";

export interface LocalSkillMetadata {
  readonly name: string;
  readonly displayName?: string;
  readonly description: string;
  readonly hasUserSpecifiedDescription: boolean;
  readonly path: string;
  /** Canonical file path retained for project skill reads after scanning. */
  readonly projectRealPath?: string;
  readonly root: string;
  readonly scope: LocalSkillScope;
  readonly source: SkillSource;
  readonly loadedFrom: LoadedFrom;
  readonly aliases?: readonly string[];
  readonly allowedTools: readonly string[];
  readonly argumentHint?: string;
  readonly argNames?: readonly string[];
  /** Root of the owning plugin when the skill ships inside one. */
  readonly pluginRoot?: string;
  readonly pluginId?: string;
  readonly whenToUse?: string;
  readonly version?: string;
  readonly model?: string;
  readonly disableModelInvocation: boolean;
  readonly userInvocable: boolean;
  readonly hooks?: unknown;
  readonly context?: SkillExecutionContext;
  readonly agent?: string;
  readonly effort?: string;
  readonly shell?: "bash" | "powershell";
  readonly paths?: readonly string[];
  readonly contentLength: number;
  readonly bundled?: boolean;
}

export interface RenderedSkill {
  readonly skill: LocalSkillMetadata;
  readonly content: string;
}

export interface InvokedSkillRecord {
  readonly skillName: string;
  readonly skillPath: string;
  readonly content: string;
  readonly invokedAt: number;
  readonly agentId?: string;
  /** Owning session/conversation id. When absent, the record is scoped to
   *  the recording skills-service instance's default session key so
   *  single-session CLI paths keep working unchanged. */
  readonly sessionId?: string;
}

/** A skill root holding more SKILL.md files than the loader reads per root. */
export interface SkillRootTruncation {
  readonly root: string;
  /** SKILL.md files loaded from this root before the cap was reached. */
  readonly loadedCount: number;
  /** SKILL.md files found past the cap and left unloaded. */
  readonly droppedCount: number;
}

/** A SKILL.md that loaded (or was skipped) with a problem its author should see. */
export interface SkillLoadWarning {
  readonly path: string;
  readonly reason: string;
}

export interface LocalSkillsSnapshot {
  readonly skills: readonly LocalSkillMetadata[];
  readonly skillRoots: readonly string[];
  readonly pluginSkillRoots: readonly string[];
  readonly conditionalSkills: readonly LocalSkillMetadata[];
  readonly truncatedRoots: readonly SkillRootTruncation[];
  readonly warnings: readonly SkillLoadWarning[];
}

export interface LocalSkillsServiceOptions {
  readonly agencHome: string;
  readonly pluginStorageRoot: string;
  readonly workspaceRoot: string;
  /** Session/conversation id owning this skills-service instance. Used to
   *  scope invoked-skill tracking per session in the daemon; when absent,
   *  the instance uses a stable single-session default key. */
  readonly sessionId?: string;
  readonly config?: Pick<AgenCConfig, "plugins">;
  readonly fileWatcher?: FileWatcher;
  readonly skillChangeDetector?: SkillChangeDetector;
  readonly skillChangeEventSink?: Pick<SkillChangeDetector, "notify">;
  readonly watcherDebounceMs?: number;
  readonly watcherClearRuntimeCaches?: boolean;
  readonly watcherRunConfigChangeHooks?: boolean;
  readonly env?: Partial<
    Pick<NodeJS.ProcessEnv, "HOME" | "AGENC_MANAGED_HOME">
  >;
}

interface SkillRoot {
  readonly path: string;
  readonly scope: Exclude<LocalSkillScope, "bundled" | "mcp">;
  readonly source: Exclude<SkillSource, "bundled" | "mcp">;
  readonly loadedFrom: Exclude<LoadedFrom, "bundled" | "mcp">;
  /** Root of the owning plugin when this root ships inside one. */
  readonly pluginRoot?: string;
  readonly pluginId?: string;
}

interface LoadedSkillFile {
  readonly skill: LocalSkillMetadata;
  readonly filePath: string;
  /** Real path of the file, for deduplication across roots. */
  readonly identity: string | null;
}

interface SplitFrontmatter {
  readonly frontmatter: Record<string, unknown>;
  readonly markdown: string;
  /** Why the frontmatter fields were ignored, when they were. */
  readonly warning?: string;
}

interface BundledSkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly whenToUse?: string;
  readonly argumentHint?: string;
  readonly allowedTools?: readonly string[];
  readonly model?: string;
  readonly disableModelInvocation?: boolean;
  readonly userInvocable?: boolean;
  readonly context?: SkillExecutionContext;
  readonly agent?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly getPrompt: (args: string, skillDir: string) => Promise<string> | string;
}

const SKILL_FILE_NAME = "SKILL.md";
/**
 * Per-root ceiling on skills loaded from disk. The walk keeps counting past
 * it (`droppedCount`) so the snapshot can say what it skipped, but a dropped
 * skill is invisible to the listing, to ranking and to the Skill tool.
 *
 * 500 was set when a catalog meant a handful of hand-written skills. A shared
 * catalog is now the normal case: the machine this was measured on holds
 * 1,820 skills in `~/.agents/skills`, so 1,320 of them — including three of
 * the four that matched the work in a live 15-turn run — were dropped before
 * any ranking or budget logic could see them, in readdir order. The ceiling
 * stays, because it is what stops a pathological directory from being walked
 * forever, but it is now above a real installation rather than inside one.
 * The cost of the higher bound is a cold scan reading the frontmatter of each
 * file once (7.7 MB across those 1,820), behind the snapshot's change
 * detector; the listing budget, not this cap, is what bounds what the model
 * is shown.
 *
 * Overridable with `AGENC_MAX_SKILL_FILES_PER_ROOT` so an operator with an
 * unusual catalog can tune it, and so tests can exercise truncation without
 * writing thousands of files.
 */
const DEFAULT_MAX_SKILL_FILES = 5_000;

export function maxSkillFilesPerRoot(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.AGENC_MAX_SKILL_FILES_PER_ROOT);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_MAX_SKILL_FILES;
}
const MAX_SCAN_DEPTH = 12;
const MAX_ACTIVE_PATHS = 256;
const INVOKED_MAIN_AGENT_ID = "__main__";
const SKILL_LISTING_DEFAULT_CHAR_BUDGET = 8_000;
/**
 * Ceiling for the context-scaled listing. One percent of a 1M-token window
 * is 40,000 chars (about 10,000 tokens) in every request of every session,
 * measured on 2026-09-11 with 1,801 installed skills; the ranked listing plus
 * the per-request relevance reminder does the same job in a fraction of that.
 * `SLASH_COMMAND_TOOL_CHAR_BUDGET` still overrides both the scale and the cap.
 */
const SKILL_LISTING_MAX_CHAR_BUDGET = 12_000;
const SKILL_LISTING_DESC_MAX_CHARS = 250;
const SKILL_LISTING_CONTEXT_PERCENT = 0.01;
const CHARS_PER_TOKEN = 4;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  ".turbo",
  ".pnpm-store",
]);

// Invoked-skill tracking, keyed by `${sessionKey}\u0000${agentKey}` so
// concurrent daemon sessions do not leak invocations into each other's
// skill snapshots. `sessionKey` is the record's explicit sessionId when
// provided (the Skill tool stamps the conversation id), otherwise the
// recording skills-service instance's default key.
const invokedSkillsByScope = new Map<string, Map<string, InvokedSkillRecord>>();

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeExistingCandidate(path: string): string {
  return resolve(path);
}

function rootKey(root: SkillRoot): string {
  return `${root.scope}:${root.loadedFrom}:${root.path}`;
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function getFileIdentity(filePath: string): Promise<string | null> {
  try {
    return await realpath(filePath);
  } catch {
    return null;
  }
}

function normalizeDisplayPath(path: string): string {
  return process.platform === "win32" ? path.replace(/\\/g, "/") : path;
}

/** Walk from the workspace through its nearest git root, excluding HOME. */
async function projectSkillDirs(
  workspaceRoot: string,
  home?: string,
): Promise<string[]> {
  const workspace = (await getFileIdentity(workspaceRoot)) ?? resolve(workspaceRoot);
  const ancestors: string[] = [];
  const homeResolved = home
    ? (await getFileIdentity(home)) ?? resolve(home)
    : null;
  let current = workspace;
  let foundGitRoot = false;
  while (true) {
    if (homeResolved !== null && current === homeResolved) break;
    ancestors.push(current);
    try {
      const gitMarker = await lstat(join(current, ".git"));
      if (gitMarker.isDirectory() || gitMarker.isFile()) {
        foundGitRoot = true;
        break;
      }
    } catch {
      // Keep looking for a git root within the home boundary.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const projectDirs = foundGitRoot ? ancestors : ancestors.slice(0, 1);
  return projectDirs.flatMap((dir) => [
    join(dir, ".agents", "skills"),
    join(dir, ".agenc", "skills"),
  ]);
}

const warnedUnsafeProjectRoots = new Set<string>();
const WORLD_WRITABLE_PROJECT_ROOT_WARNING = "skipped world-writable project skill root";
const WORLD_WRITABLE_PROJECT_LINK_WARNING = "skipped world-writable project skill symlink target";

async function projectSkillPathIsSafe(path: string, allowMissing = false): Promise<boolean> {
  if (process.platform === "win32") return true;
  for (const component of [dirname(dirname(path)), dirname(path), path]) {
    try {
      if (((await stat(component)).mode & 0o002) !== 0) return false;
    } catch (error) {
      if (allowMissing && isRecord(error) &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
      return false;
    }
  }
  return true;
}

/** Device and inode of the file a safety check approved. */
interface CheckedFile {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * The identity of a project skill file at its recorded real path, or null when
 * that path is no longer a regular file in a safe location. A read compares
 * what it opened with this identity and refuses any other file.
 */
async function checkedProjectSkillFile(path: string): Promise<CheckedFile | null> {
  let checked: CheckedFile;
  try {
    // lstat: a link here is refused, never resolved to its target's identity.
    const stats = await lstat(path, { bigint: true });
    if (!stats.isFile()) return null;
    checked = { dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  }
  // A recorded real path may later be replaced by a link. Reject it rather
  // than following the replacement to a different file.
  if ((await getFileIdentity(path)) !== path || !(await projectSkillPathIsSafe(path))) return null;
  return checked;
}

/** Check every directory that can let another user replace a project root. */
async function projectSkillRootIsSafe(
  root: string,
  warnings?: SkillLoadWarning[],
): Promise<boolean> {
  if (process.platform === "win32") return true;
  // Missing components stay eligible for watches until they are created.
  const lexicalSafe = await projectSkillPathIsSafe(root, true);
  const realRoot = lexicalSafe ? await getFileIdentity(root) : null;
  if (!lexicalSafe || (realRoot !== null &&
    realRoot !== resolve(root) && !(await projectSkillPathIsSafe(realRoot)))) {
    // Missing roots are watch candidates, but have no skill to warn about.
    if (await pathIsDirectory(root)) {
      if (warnings && !warnings.some((warning) =>
        warning.path === root && warning.reason === WORLD_WRITABLE_PROJECT_ROOT_WARNING
      )) {
        warnings.push({ path: root, reason: WORLD_WRITABLE_PROJECT_ROOT_WARNING });
      }
      if (!warnedUnsafeProjectRoots.has(root)) {
        warnedUnsafeProjectRoots.add(root);
        console.warn(`Skills: ${WORLD_WRITABLE_PROJECT_ROOT_WARNING}: ${root}`);
      }
    }
    return false;
  }
  return true;
}

async function localSkillRootCandidates(
  options: LocalSkillsServiceOptions,
): Promise<SkillRoot[]> {
  const home = options.env?.HOME ?? homedir();
  const agencHome = normalizeExistingCandidate(options.agencHome);
  const workspaceRoot = normalizeExistingCandidate(options.workspaceRoot);

  const roots: SkillRoot[] = [];

  for (const path of await projectSkillDirs(workspaceRoot, home)) {
    roots.push({
      path,
      scope: "project",
      source: "projectSettings",
      loadedFrom: "skills",
    });
  }

  roots.push({
    path: join(agencHome, "skills"),
    scope: "user",
    source: "userSettings",
    loadedFrom: "skills",
  });

  if (home.length > 0) {
    roots.push({
      path: join(home, ".agents", "skills"),
      scope: "user",
      source: "userSettings",
      loadedFrom: "skills",
    });
  }
  const managedHome = options.env?.AGENC_MANAGED_HOME;
  if (managedHome && managedHome.length > 0) {
    roots.push({
      path: join(managedHome, ".agenc", "skills"),
      scope: "managed",
      source: "policySettings",
      loadedFrom: "managed",
    });
  }

  return roots;
}

async function discoverSkillRootsWithWarnings(
  options: LocalSkillsServiceOptions,
  discoveredSkillRoots: readonly string[],
  warnings: SkillLoadWarning[],
): Promise<readonly SkillRoot[]> {
  const pluginStorageRoot = normalizeExistingCandidate(
    options.pluginStorageRoot,
  );
  const workspaceRoot = normalizeExistingCandidate(options.workspaceRoot);
  const roots = await localSkillRootCandidates(options);

  for (const path of discoveredSkillRoots) {
    const normalized = normalizeExistingCandidate(path);
    const workspaceRelative = relative(workspaceRoot, normalized);
    if (
      workspaceRelative.length === 0 ||
      workspaceRelative.startsWith("..") ||
      isAbsolute(workspaceRelative)
    ) {
      continue;
    }
    roots.push({
      path: normalized,
      scope: "project",
      source: "projectSettings",
      loadedFrom: "skills",
    });
  }

  const pluginRoots = await discoverPluginSkillRootsWithProvenance({
    pluginStorageRoot,
    workspaceRoot,
    config: options.config,
  });
  roots.push(
    ...pluginRoots.map((root) => ({
      path: root.path,
      scope: "plugin" as const,
      source: root.contentProvenance === "repository-controlled"
        ? "projectSettings" as const
        : "plugin" as const,
      loadedFrom: "plugin" as const,
      pluginRoot: root.pluginRoot,
      pluginId: root.pluginId,
    })),
  );

  const deduped = new Map<string, SkillRoot>();
  for (const root of roots) {
    const normalized = {
      ...root,
      path: normalizeExistingCandidate(root.path),
    };
    if (normalized.scope === "project" && !(await projectSkillRootIsSafe(normalized.path, warnings))) {
      continue;
    }
    if (!(await pathIsDirectory(normalized.path))) continue;
    deduped.set(rootKey(normalized), normalized);
  }
  return [...deduped.values()];
}

export async function discoverSkillRoots(
  options: LocalSkillsServiceOptions,
  discoveredSkillRoots: readonly string[] = [],
): Promise<readonly SkillRoot[]> {
  return discoverSkillRootsWithWarnings(options, discoveredSkillRoots, []);
}

export async function discoverSkillWatchRoots(
  options: LocalSkillsServiceOptions,
): Promise<readonly string[]> {
  const pluginStorageRoot = normalizeExistingCandidate(
    options.pluginStorageRoot,
  );
  const workspaceRoot = normalizeExistingCandidate(options.workspaceRoot);
  const localRoots = await localSkillRootCandidates(options);
  const safeLocalRoots = await Promise.all(localRoots.map(async (root) =>
    root.scope !== "project" || await projectSkillRootIsSafe(root.path)
      ? root.path
      : null
  ));
  const roots = [
    ...safeLocalRoots.filter((path): path is string => path !== null),
    ...(await discoverPluginSkillRootsWithProvenance({
      pluginStorageRoot,
      workspaceRoot,
      config: options.config,
    })).map((root) => root.path),
  ];
  return unique(roots.map(normalizeExistingCandidate)).sort((a, b) =>
    a.localeCompare(b),
  );
}

async function readDirEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

interface ScannedSkillFile {
  /** Path as reached from the root; names the skill. */
  readonly path: string;
  /**
   * Real path of the file, derived from the real path of its directory. The
   * walk only records regular files, never links, so this equals
   * realpath(path) without a syscall per file.
   */
  readonly identity: string;
}

/** A top-level directory of a root with no SKILL.md anywhere below it. */
interface EmptySkillDirectory {
  readonly path: string;
  /** A markdown file it does hold, when the file was probably misnamed. */
  readonly markdownFile?: string;
}

interface SkillFileScan {
  readonly files: readonly ScannedSkillFile[];
  readonly droppedCount: number;
  readonly rootRealPath: string;
  readonly unsafeRoot?: boolean;
  readonly emptyDirectories: readonly EmptySkillDirectory[];
  readonly warnings: readonly SkillLoadWarning[];
}

interface ScanFrame {
  readonly path: string;
  readonly realPath: string;
  readonly depth: number;
  /** The root's direct child this frame sits under; null for the root. */
  readonly top: string | null;
}

interface PendingLink {
  readonly path: string;
  readonly depth: number;
  readonly top: string | null;
}

/** Directory reads in flight per root; the threadpool does the rest. */
const SCAN_CONCURRENCY = 32;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function byPath<T extends { readonly path: string }>(a: T, b: T): number {
  return a.path.localeCompare(b.path);
}

/**
 * Every SKILL.md under a root, down to MAX_SCAN_DEPTH directory levels,
 * skipping SKIP_DIRS and never loading a SKILL.md that is itself a link.
 *
 * The walk used to take one directory at a time: realpath, then readdir,
 * then the next, so 2,950 directories of a 1,822-skill catalog cost 128 ms
 * of serialized round trips to the threadpool. It now reads a whole level
 * with bounded concurrency, and derives each directory's real path from its
 * parent's, calling realpath only for symbolic links. Symlinked directories
 * wait until every directory reachable without one has been walked, so a
 * directory reached both ways keeps its own name instead of the link's.
 * Files past the per-root cap are counted, shallowest and then
 * alphabetically first loaded, the same way on every scan.
 */
async function findSkillFiles(root: SkillRoot): Promise<SkillFileScan> {
  const maxFiles = maxSkillFilesPerRoot();
  const rootRealPath = (await getFileIdentity(root.path)) ?? resolve(root.path);
  const visited = new Set<string>([rootRealPath]);
  const loaded: Array<ScannedSkillFile & { readonly depth: number }> = [];
  let droppedCount = 0;
  const pendingLinks: PendingLink[] = [];
  const topLevel: string[] = [];
  const topsWithSkills = new Set<string>();
  const topMarkdown = new Map<string, string>();
  const warnings: SkillLoadWarning[] = [];
  // A project root may have changed since discovery. Validate the real path
  // that the scan will actually read.
  if (root.scope === "project" && !(await projectSkillPathIsSafe(rootRealPath))) {
    return {
      files: [], droppedCount: 0, rootRealPath, unsafeRoot: true, emptyDirectories: [],
      warnings: [{ path: root.path, reason: WORLD_WRITABLE_PROJECT_ROOT_WARNING }],
    };
  }

  const walk = async (start: readonly ScanFrame[], oneLevel = false): Promise<ScanFrame[]> => {
    let level = start;
    while (level.length > 0) {
      const listings = await mapWithConcurrency(
        level,
        SCAN_CONCURRENCY,
        (frame) => readDirEntries(root.scope === "project" ? frame.realPath : frame.path),
      );
      const found: Array<ScannedSkillFile & { readonly depth: number }> = [];
      const next: ScanFrame[] = [];
      level.forEach((frame, index) => {
        if (frame.depth === 1) topLevel.push(frame.path);
        for (const entry of listings[index]!) {
          const path = join(frame.path, entry.name);
          if (entry.isFile()) {
            // Files directly in the root are never skills (leaf roots are
            // handled by the caller).
            if (frame.top === null) continue;
            if (isSkillFile(entry.name)) {
              found.push({ path, identity: join(frame.realPath, entry.name), depth: frame.depth });
              topsWithSkills.add(frame.top);
            } else if (
              frame.depth === 1 &&
              !topMarkdown.has(frame.top) &&
              entry.name.toLowerCase().endsWith(".md")
            ) {
              topMarkdown.set(frame.top, entry.name);
            }
            continue;
          }
          if (frame.depth >= MAX_SCAN_DEPTH || SKIP_DIRS.has(entry.name)) continue;
          const top = frame.top ?? path;
          if (entry.isDirectory()) {
            const realPath = join(frame.realPath, entry.name);
            if (visited.has(realPath)) continue;
            visited.add(realPath);
            next.push({ path, realPath, depth: frame.depth + 1, top });
          } else if (entry.isSymbolicLink()) {
            pendingLinks.push({ path, depth: frame.depth + 1, top });
          }
        }
      });
      // A later symlink can lead to a shallower file than one already found.
      // Keep the best candidates across both walks before applying the cap.
      for (const file of found) loaded.push(file);
      loaded.sort((a, b) => a.depth - b.depth || byPath(a, b));
      droppedCount += Math.max(0, loaded.length - maxFiles);
      loaded.length = Math.min(loaded.length, maxFiles);
      if (oneLevel) return next;
      level = next;
    }
    return [];
  };

  await walk([{ path: root.path, realPath: rootRealPath, depth: 0, top: null }]);
  const pendingDirectories: ScanFrame[] = [];
  while (pendingLinks.length > 0 || pendingDirectories.length > 0) {
    pendingLinks.sort((a, b) => a.depth - b.depth || byPath(a, b));
    pendingDirectories.sort((a, b) => a.depth - b.depth || byPath(a, b));
    const depth = Math.min(
      pendingLinks[0]?.depth ?? Infinity,
      pendingDirectories[0]?.depth ?? Infinity,
    );
    let directoryCount = 0;
    while (pendingDirectories[directoryCount]?.depth === depth) directoryCount++;
    pendingDirectories.push(...await walk(pendingDirectories.splice(0, directoryCount), true));
    let linkCount = 0;
    while (pendingLinks[linkCount]?.depth === depth) linkCount++;
    const links = pendingLinks.splice(0, linkCount);
    const targets = await mapWithConcurrency(
      links,
      SCAN_CONCURRENCY,
      async (link): Promise<ScanFrame | null> => {
        const realPath = await getFileIdentity(link.path);
        if (realPath === null || !(await pathIsDirectory(realPath))) return null;
        if (root.scope === "project" && !(await projectSkillPathIsSafe(realPath))) {
          warnings.push({ path: link.path, reason: WORLD_WRITABLE_PROJECT_LINK_WARNING });
          return null;
        }
        return { path: link.path, realPath, depth: link.depth, top: link.top };
      },
    );
    const frames: ScanFrame[] = [];
    for (const target of targets) {
      if (target === null || visited.has(target.realPath)) continue;
      visited.add(target.realPath);
      frames.push(target);
    }
    pendingDirectories.push(...await walk(frames, true));
  }
  return {
    files: loaded.toSorted(byPath),
    droppedCount,
    rootRealPath,
    warnings,
    // Hidden directories (.system, .cache) hold support files by convention.
    emptyDirectories: topLevel
      .filter((dir) => !topsWithSkills.has(dir) && !basename(dir).startsWith("."))
      .sort((a, b) => a.localeCompare(b))
      .map((dir) => {
        const markdownFile = topMarkdown.get(dir);
        return markdownFile === undefined ? { path: dir } : { path: dir, markdownFile };
      }),
  };
}

/**
 * Read a SKILL.md without following a link at its last component, and only
 * when the opened descriptor is a regular file (null otherwise). A project
 * skill is read through a real path that passed the safety check, with the
 * identity that check saw: the open can still reach another file where
 * O_NOFOLLOW does not exist (Windows) or through a folder swapped above the
 * file, and such a file is refused.
 */
async function readRegularFileNoFollow(
  path: string,
  checked?: CheckedFile,
): Promise<Buffer | null> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return null;
    if (checked !== undefined && (opened.dev !== checked.dev || opened.ino !== checked.ino)) {
      return null;
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function isSkillFile(fileName: string): boolean {
  return fileName.toLowerCase() === "skill.md";
}

function buildNamespace(targetDir: string, baseDir: string): string {
  const rel = relative(baseDir, targetDir);
  if (!rel || rel === ".") return "";
  if (rel.startsWith("..") || isAbsolute(rel)) return "";
  return rel
    .split(sep)
    .filter((part) => part.length > 0)
    .join(":");
}

function skillNameForSkillFile(filePath: string, baseDir: string): string {
  const skillDirectory = dirname(filePath);
  const parentOfSkillDir = dirname(skillDirectory);
  const commandBaseName = basename(skillDirectory);
  const namespace = buildNamespace(parentOfSkillDir, baseDir);
  return namespace ? `${namespace}:${commandBaseName}` : commandBaseName;
}

function implicitAliasesForSkillName(name: string): readonly string[] {
  if (!name.startsWith(".")) return [];
  const leaf = name.split(":").pop() ?? "";
  return /^[A-Za-z][A-Za-z0-9_:-]*$/u.test(leaf) ? [leaf] : [];
}

function opensMultilineFlowCollection(value: string): boolean {
  if (value[0] !== "{" && value[0] !== "[") return false;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote !== null) {
      if (quote === '"' && char === "\\") index++;
      else if (char === quote) {
        if (quote === "'" && value[index + 1] === "'") index++;
        else quote = null;
      }
      continue;
    }
    if (char === "#" && (index === 0 || /[ \t]/u.test(value[index - 1]!))) break;
    if (char === "'" || char === '"') quote = char;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
  return depth > 0;
}

/** A top-level true flag survives YAML recovery or invalid sibling fields. */
function hasRawDisableModelInvocation(yamlText: string): boolean {
  const lines = yamlText.split(/\r?\n/u);
  const mappingParents: number[] = [];
  let blockScalarIndent: number | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = /^[ \t]*/u.exec(line)?.[0].length ?? 0;
    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = null;
    }
    while (mappingParents.length > 0 && indent <= mappingParents[mappingParents.length - 1]!) {
      mappingParents.pop();
    }
    const match = /^[ \t]*([^#\s][^:]*?)[ \t]*:[ \t]*(.*)$/u.exec(line);
    if (match === null) continue;
    const rawValue = (match[2] ?? "").trim();
    const scopedValue = rawValue.replace(/^&[^\s,{}\[\]]+(?:[ \t]+|$)/u, "");
    if (/^[|>](?:[+-][1-9]?|[1-9][+-]?)?(?:[ \t]+#.*)?$/u.test(scopedValue)) {
      blockScalarIndent = indent;
      continue;
    }
    if (
      scopedValue === "" || scopedValue.startsWith("#") ||
      opensMultilineFlowCollection(scopedValue)
    ) {
      mappingParents.push(indent);
      continue;
    }
    if (mappingParents.length > 0 || match[1]?.toLowerCase() !== "disable-model-invocation") continue;
    const quoted = /^(['"])(.*)\1(?:[ \t]+#.*)?$/u.exec(rawValue);
    const value = quoted?.[2] ?? rawValue;
    if (parseBooleanFrontmatter(value)) return true;
  }
  return false;
}

function splitFrontmatter(raw: string): SplitFrontmatter {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, markdown: raw };
  }
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?([\s\S]*)$/u.exec(raw);
  if (!match) return { frontmatter: {}, markdown: raw };
  const yamlText = match[1] ?? "";
  const rawFlag = hasRawDisableModelInvocation(yamlText);
  // The line scan only stands in for the YAML parser. When the text parses as
  // it is, the parsed flag is the answer: a scan that took a nested or
  // quoted key for a top-level one hid skills whose frontmatter said false.
  // It is consulted only when the strict parse failed, where recovery can
  // turn `true # reason` into a string or drop every field.
  let modelProof = false;
  let parsed: unknown;
  try {
    parsed = loadYaml(yamlText);
  } catch (error) {
    modelProof = rawFlag;
    // The canonical parser (utils/frontmatterParser.ts), which commands and
    // MCP skills go through, quotes values holding YAML indicators and parses
    // again: `description: Settle tasks in AUTONOMOUS mode: prompt-free` is
    // not strict YAML but is a perfectly clear SKILL.md. Without the same
    // second chance here every field of such a file was dropped, including
    // disable-model-invocation.
    try {
      parsed = loadYaml(quoteProblematicValues(yamlText));
    } catch {
      const detail =
        (error instanceof Error ? error.message : String(error)).split("\n")[0] ??
        "";
      return {
        frontmatter: modelProof ? { "disable-model-invocation": true } : {},
        markdown: match[2] ?? raw,
        warning: modelProof
          ? `frontmatter is not valid YAML (${detail}); its fields were ignored, except disable-model-invocation: true, which still keeps the model from loading it`
          : `frontmatter is not valid YAML (${detail}); its fields were ignored`,
      };
    }
  }
  if (parsed === null || parsed === undefined) {
    return {
      frontmatter: modelProof ? { "disable-model-invocation": true } : {},
      markdown: match[2] ?? "",
    };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      frontmatter: modelProof ? { "disable-model-invocation": true } : {},
      markdown: match[2] ?? "",
      warning: "frontmatter is not a YAML mapping; its fields were ignored",
    };
  }
  return {
    frontmatter: modelProof
      ? { ...(parsed as Record<string, unknown>), "disable-model-invocation": true }
      : parsed as Record<string, unknown>,
    markdown: match[2] ?? "",
  };
}

function coerceString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(coerceString)
      .filter((entry): entry is string => entry !== undefined && entry.length > 0);
  }
  const str = coerceString(value);
  if (!str) return [];
  return str
    .split(/[\n,]/u)
    .flatMap((part) => part.trim().split(/\s+/u))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseSkillPaths(value: unknown): string[] | undefined {
  const patterns = splitList(value)
    .map((pattern) => (pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern))
    .filter((pattern) => pattern.length > 0);
  if (patterns.length === 0 || patterns.every((pattern) => pattern === "**")) {
    return undefined;
  }
  return patterns;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * What one SKILL.md contributes to its metadata, whichever root it is read
 * through: the parsed frontmatter, the parse problem if any, the first
 * non-blank body line (all the description fallback reads) and the body
 * length (for token estimates). The body itself is only read on render.
 */
interface ParsedSkillFile {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly warning?: string;
  readonly leadLine: string;
  readonly markdownLength: number;
}

/**
 * Parsed SKILL.md files for the whole process, keyed by path and verified
 * against the content hash on every scan. A 1,822-skill catalog is otherwise
 * YAML-parsed in full (7.7 MB) by every
 * session the daemon opens, by every /skills and every watcher reload,
 * although an edit touches one file. Model aliases and
 * other settings-dependent fields are derived from the cached frontmatter on
 * every build, never cached themselves.
 */
const PARSED_SKILL_FILE_CACHE_LIMIT = 10_000;
const parsedSkillFiles = new Map<
  string,
  { readonly contentHash: string; readonly parsed: ParsedSkillFile }
>();
let skillFileParseCount = 0;

/** SKILL.md files read and parsed by this process; for tests. */
export function skillFileParseCountForTest(): number {
  return skillFileParseCount;
}

/** Longest lead line kept; the description fallback uses at most 100. */
const LEAD_LINE_MAX_CHARS = 512;

function firstNonBlankLine(markdown: string): string {
  for (const line of markdown.split("\n")) {
    if (line.trim().length > 0) return line.trim().slice(0, LEAD_LINE_MAX_CHARS);
  }
  return "";
}

/**
 * A copy of a parsed value whose strings no longer point into the file
 * text. V8 keeps substrings as views of their parent, so caching the YAML
 * output as parsed kept every SKILL.md alive in full: 12.6 MB retained for
 * the audited catalog against 1.5 MB for detached copies. Dates and other
 * non-plain values are kept as they are.
 */
function detachStrings<T>(value: T): T {
  if (typeof value === "string") return JSON.parse(JSON.stringify(value)) as T;
  if (Array.isArray(value)) return value.map(detachStrings) as T;
  if (value !== null && typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // defineProperty, so a "__proto__" key stays a plain field.
      Object.defineProperty(copy, key, {
        value: detachStrings(entry),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy as T;
  }
  return value;
}

async function readParsedSkillFile(
  filePath: string,
  warnings: SkillLoadWarning[],
  readPath = filePath,
  checked?: CheckedFile,
): Promise<ParsedSkillFile | null> {
  let bytes: Buffer;
  try {
    const read = await readRegularFileNoFollow(readPath, checked);
    if (read === null) return null;
    bytes = read;
  } catch (error) {
    warnings.push({
      path: filePath,
      reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const cached = parsedSkillFiles.get(filePath);
  if (cached !== undefined && cached.contentHash === contentHash) {
    parsedSkillFiles.delete(filePath);
    parsedSkillFiles.set(filePath, cached);
    return cached.parsed;
  }
  const raw = bytes.toString("utf8");
  skillFileParseCount += 1;
  const { frontmatter, markdown, warning } = splitFrontmatter(raw);
  const parsed: ParsedSkillFile = {
    frontmatter: Object.freeze(detachStrings(frontmatter)),
    ...(warning !== undefined ? { warning: detachStrings(warning) } : {}),
    leadLine: detachStrings(firstNonBlankLine(markdown)),
    markdownLength: markdown.length,
  };
  parsedSkillFiles.delete(filePath);
  parsedSkillFiles.set(filePath, { contentHash, parsed });
  while (parsedSkillFiles.size > PARSED_SKILL_FILE_CACHE_LIMIT) {
    const oldest = parsedSkillFiles.keys().next().value;
    if (oldest === undefined) break;
    parsedSkillFiles.delete(oldest);
  }
  return parsed;
}

async function loadSkillFile(
  file: ScannedSkillFile | { readonly path: string; readonly identity: string | null },
  root: SkillRoot,
  warnings: SkillLoadWarning[],
): Promise<LoadedSkillFile | null> {
  const filePath = file.path;
  let readPath = filePath;
  let checked: CheckedFile | undefined;
  if (root.scope === "project") {
    const checkedFile = file.identity === null ? null : await checkedProjectSkillFile(file.identity);
    if (file.identity === null || checkedFile === null) {
      warnings.push({ path: filePath, reason: "skipped unsafe project skill path" });
      return null;
    }
    readPath = file.identity;
    checked = checkedFile;
  }
  const parsedFile = await readParsedSkillFile(filePath, warnings, readPath, checked);
  if (parsedFile === null) return null;
  const { frontmatter, warning } = parsedFile;
  if (warning !== undefined) warnings.push({ path: filePath, reason: warning });
  const skillName = skillNameForSkillFile(filePath, root.path);
  if (skillName.length === 0) return null;
  const canonicalFields = parseCanonicalSkillFrontmatterFields(
    // The canonical parser's input type is mutable; it only reads.
    frontmatter as Record<string, unknown>,
    parsedFile.leadLine,
    skillName,
    "Skill",
  );
  // The description is what the model matches a request against; a heading
  // borrowed from the body ("Tech Debt Analysis") rarely says when to use
  // the skill. A frontmatter warning already explains a missing one.
  if (!canonicalFields.hasUserSpecifiedDescription && warning === undefined) {
    warnings.push({
      path: filePath,
      reason: "no description in frontmatter",
    });
  }
  const {
    argumentNames,
    executionContext,
    effort,
    ...sharedFields
  } = canonicalFields;
  const paths = parseSkillPaths(frontmatter.paths);
  const parsed = {
    ...sharedFields,
    ...(argumentNames.length > 0 ? { argNames: argumentNames } : {}),
    ...(executionContext !== undefined ? { context: executionContext } : {}),
    ...(effort !== undefined ? { effort: String(effort) } : {}),
    ...(paths ? { paths } : {}),
  } satisfies Omit<
    LocalSkillMetadata,
    "name" | "path" | "root" | "scope" | "source" | "loadedFrom" | "contentLength"
  >;
  const repositoryControlled = isRepositoryControlledSkillSource(root.source);
  const safeParsed = (() => {
    if (!repositoryControlled) return parsed;
    const {
      model: _model,
      hooks: _hooks,
      context: _context,
      agent: _agent,
      effort: _effort,
      shell: _shell,
      ...guidanceFields
    } = parsed;
    return { ...guidanceFields, allowedTools: [] };
  })();

  const skill: LocalSkillMetadata = {
    ...safeParsed,
    name: skillName,
    path: filePath,
    ...(root.scope === "project" ? { projectRealPath: readPath } : {}),
    root: root.path,
    scope: root.scope,
    source: root.source,
    loadedFrom: root.loadedFrom,
    ...(root.pluginRoot !== undefined
      ? { pluginRoot: root.pluginRoot }
      : {}),
    ...(root.pluginId !== undefined ? { pluginId: root.pluginId } : {}),
    contentLength: parsedFile.markdownLength,
    ...(() => {
      const aliases = implicitAliasesForSkillName(skillName);
      return aliases.length > 0 ? { aliases } : {};
    })(),
  };

  return { skill, filePath, identity: file.identity };
}

interface LoadedSkillRoot {
  readonly skills: readonly LoadedSkillFile[];
  readonly droppedCount: number;
  readonly warnings: readonly SkillLoadWarning[];
}

async function loadSkillsFromRoot(root: SkillRoot): Promise<LoadedSkillRoot> {
  const scan = await findSkillFiles(root);
  const files: Array<{ readonly path: string; readonly identity: string | null }> =
    [...scan.files];
  // A root can BE one skill: plugin manifests may declare each skill
  // dir individually (skills: ["./skills/flash-board"]), so the root
  // itself carries the SKILL.md instead of holding child skill dirs.
  let leafRoot = false;
  if (files.length === 0 && !scan.unsafeRoot) {
    const leaf = join(root.path, SKILL_FILE_NAME);
    try {
      const stats = await lstat(leaf);
      if (stats.isFile()) {
        files.push({ path: leaf, identity: await getFileIdentity(leaf) });
        leafRoot = true;
      }
    } catch {
      // Genuinely empty root.
    }
  }
  const warnings: SkillLoadWarning[] = [...scan.warnings];
  // A directory in a user, project or managed root with no SKILL.md is a
  // skill that failed to install (the audited catalog had one holding only
  // CLAUDE.md). Plugin layouts are the plugin author's to choose, and a
  // leaf root's subdirectories are that skill's own files.
  if (root.scope !== "plugin" && !leafRoot) {
    for (const dir of scan.emptyDirectories) {
      warnings.push({
        path: dir.path,
        reason:
          "no SKILL.md in this directory or below it, so nothing here was loaded as a skill" +
          (dir.markdownFile !== undefined
            ? ` (it holds ${dir.markdownFile}; a skill is read from a file named SKILL.md)`
            : ""),
      });
    }
  }
  const loaded = await Promise.all(
    files.map((file) => loadSkillFile(file, root, warnings)),
  );
  return {
    skills: loaded.filter((entry): entry is LoadedSkillFile => entry !== null),
    droppedCount: scan.droppedCount,
    // Files finish loading in any order; report them in path order.
    warnings: warnings.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function dedupeSkillsByRealPath(
  entries: readonly LoadedSkillFile[],
): readonly LoadedSkillFile[] {
  const seen = new Set<string>();
  const out: LoadedSkillFile[] = [];
  for (const entry of entries) {
    const identity = entry.identity;
    if (identity === null) {
      out.push(entry);
      continue;
    }
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(entry);
  }
  return out;
}

function bundledSkillRoot(name: string): string {
  return getBundledSkillDirectory(
    getCurrentBundledSkillExtractionRoot(),
    name,
  );
}

function bundledSkillMetadata(definition: BundledSkillDefinition): LocalSkillMetadata {
  const root = bundledSkillRoot(definition.name);
  return {
    name: definition.name,
    description: definition.description,
    hasUserSpecifiedDescription: true,
    path: join(root, SKILL_FILE_NAME),
    root,
    scope: "bundled",
    source: "bundled",
    loadedFrom: "bundled",
    ...(definition.aliases ? { aliases: definition.aliases } : {}),
    allowedTools: definition.allowedTools ?? [],
    ...(definition.argumentHint ? { argumentHint: definition.argumentHint } : {}),
    ...(definition.whenToUse ? { whenToUse: definition.whenToUse } : {}),
    ...(definition.model ? { model: definition.model } : {}),
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable: definition.userInvocable ?? true,
    ...(definition.context ? { context: definition.context } : {}),
    ...(definition.agent ? { agent: definition.agent } : {}),
    contentLength: 0,
    bundled: true,
  };
}

async function renderBundledSkill(
  skill: LocalSkillMetadata,
  args: string | undefined,
): Promise<RenderedSkill | null> {
  const definition = BUNDLED_SKILLS.find(
    (candidate) =>
      candidate.name === skill.name || candidate.aliases?.includes(skill.name),
  );
  if (!definition) return null;
  const extractionRoot = getCurrentBundledSkillExtractionRoot();
  const root = getBundledSkillDirectory(extractionRoot, definition.name);
  const extractedRoot =
    definition.files === undefined
      ? root
      : await extractBundledSkillFiles(
          extractionRoot,
          definition.name,
          definition.files,
        );
  let content = await definition.getPrompt(args ?? "", root);
  if (
    extractedRoot !== null &&
    definition.files &&
    Object.keys(definition.files).length > 0
  ) {
    content = `Base directory for this skill: ${root}\n\n${content}`;
  }
  return { skill: { ...skill, root, path: join(root, SKILL_FILE_NAME) }, content };
}

export async function loadLocalSkillsSnapshot(
  options: LocalSkillsServiceOptions,
  activePaths: readonly string[] = [],
  discoveredSkillRoots: readonly string[] = [],
): Promise<LocalSkillsSnapshot> {
  const warnings: SkillLoadWarning[] = [];
  const roots = await discoverSkillRootsWithWarnings(options, discoveredSkillRoots, warnings);
  const loadedNested = await Promise.all(roots.map(loadSkillsFromRoot));
  const deduped = dedupeSkillsByRealPath(
    loadedNested.flatMap((loaded) => loaded.skills),
  );
  const truncatedRoots = loadedNested.flatMap((loaded, index) =>
    loaded.droppedCount > 0
      ? [{
        root: roots[index]!.path,
        loadedCount: loaded.skills.length,
        droppedCount: loaded.droppedCount,
      }]
      : [],
  );
  warnings.push(...loadedNested.flatMap((loaded) => loaded.warnings));

  const allFileSkills = deduped.map((entry) => entry.skill);
  const unconditional: LocalSkillMetadata[] = [];
  const conditional: LocalSkillMetadata[] = [];
  for (const skill of allFileSkills) {
    if (skill.paths && skill.paths.length > 0 && !pathsActivateSkill(skill, activePaths, options.workspaceRoot)) {
      conditional.push(skill);
    } else {
      unconditional.push(skill);
    }
  }

  const bundled = BUNDLED_SKILLS.map(bundledSkillMetadata);
  const active = keepOneSkillPerName([...bundled, ...unconditional]);
  // A path-gated skill that loses to an active skill of the same name could
  // never load, even once its paths match; one that wins takes over when
  // it activates, so only the losers are dropped.
  const activeByName = new Map(active.kept.map((skill) => [skill.name, skill]));
  const gated = keepOneSkillPerName(conditional);
  const gatedKept: LocalSkillMetadata[] = [];
  const gatedShadowed: ShadowedSkill[] = [];
  for (const skill of gated.kept) {
    const winner = activeByName.get(skill.name);
    if (winner !== undefined && compareSkillPrecedence(winner, skill) < 0) {
      gatedShadowed.push({ skill, by: winner });
    } else {
      gatedKept.push(skill);
    }
  }
  const allWarnings = [
    ...warnings,
    ...[...active.shadowed, ...gated.shadowed, ...gatedShadowed].map(
      shadowWarning,
    ),
  ];

  return {
    skills: active.kept.sort(byNameThenPath),
    conditionalSkills: gatedKept.sort(byNameThenPath),
    skillRoots: unique(roots.map((root) => root.path)).sort((a, b) =>
      a.localeCompare(b)
    ),
    pluginSkillRoots: unique(
      roots.filter((root) => root.scope === "plugin").map((root) => root.path),
    ).sort((a, b) => a.localeCompare(b)),
    truncatedRoots,
    warnings: allWarnings,
  };
}

function byNameThenPath(a: LocalSkillMetadata, b: LocalSkillMetadata): number {
  return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
}

/**
 * Which of two same-named skills the listing, `/skills` and the Skill tool
 * use. Managed policy first, then the user's own skills ($AGENC_HOME before
 * the shared ~/.agents catalog), then repository skills (the root nearest
 * the files being worked on first, `.agenc` before `.agents` in one
 * directory), then plugins, then AgenC's built-ins. A repository cannot
 * replace a skill the user installed for themselves, which matches the
 * upstream rule (managed > personal > project), and a local skill still
 * overrides a built-in, as the bundled-skill listing already did.
 *
 * Before this order was explicit the first skill by path won, so the
 * result depended on where the home directory and the checkout happened
 * to sort, and both copies were listed while only one could ever load.
 */
const SKILL_PRECEDENCE_TIER: Readonly<Record<LocalSkillScope, number>> = {
  managed: 0,
  user: 1,
  project: 2,
  plugin: 3,
  mcp: 4,
  bundled: 5,
};

function sharedCatalogRoot(root: string): number {
  return root.endsWith(SHARED_AGENTS_SKILLS_SUFFIX) ? 1 : 0;
}

export function compareSkillPrecedence(
  a: LocalSkillMetadata,
  b: LocalSkillMetadata,
): number {
  const byTier = SKILL_PRECEDENCE_TIER[a.scope] - SKILL_PRECEDENCE_TIER[b.scope];
  if (byTier !== 0) return byTier;
  if (a.scope === "project") {
    const byDepth = b.root.split(sep).length - a.root.split(sep).length;
    if (byDepth !== 0) return byDepth;
  }
  return (
    sharedCatalogRoot(a.root) - sharedCatalogRoot(b.root) ||
    a.path.localeCompare(b.path)
  );
}

interface ShadowedSkill {
  readonly skill: LocalSkillMetadata;
  readonly by: LocalSkillMetadata;
}

function keepOneSkillPerName(skills: readonly LocalSkillMetadata[]): {
  readonly kept: LocalSkillMetadata[];
  readonly shadowed: ShadowedSkill[];
} {
  const winners = new Map<string, LocalSkillMetadata>();
  for (const skill of skills) {
    const current = winners.get(skill.name);
    if (current === undefined || compareSkillPrecedence(skill, current) < 0) {
      winners.set(skill.name, skill);
    }
  }
  const shadowed: ShadowedSkill[] = [];
  for (const skill of skills) {
    const winner = winners.get(skill.name)!;
    if (winner !== skill) shadowed.push({ skill, by: winner });
  }
  return { kept: [...winners.values()], shadowed };
}

function shadowWarning({ skill, by }: ShadowedSkill): SkillLoadWarning {
  if (skill.loadedFrom === "bundled") {
    return {
      path: by.path,
      reason: `replaces the built-in skill "${skill.name}"; the built-in one is not listed or loadable`,
    };
  }
  return {
    path: skill.path,
    reason: `not loaded: ${by.path} defines a skill with the same name ("${skill.name}") and takes precedence`,
  };
}

function pathsActivateSkill(
  skill: LocalSkillMetadata,
  paths: readonly string[],
  cwd: string,
): boolean {
  if (!skill.paths || skill.paths.length === 0) return true;
  if (paths.length === 0) return false;
  return paths.some((path) => {
    const rel = isAbsolute(path) ? relative(cwd, path) : path;
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
    return skill.paths!.some((pattern) => pathMatchesPattern(rel, pattern));
  });
}

function pathMatchesPattern(path: string, pattern: string): boolean {
  const normalizedPath = path.split(sep).join("/");
  const normalizedPattern = pattern.split(sep).join("/");
  if (normalizedPattern === normalizedPath) return true;
  if (!normalizedPattern.includes("*")) {
    return normalizedPath.startsWith(`${normalizedPattern}/`);
  }
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  if (normalizedPattern.endsWith("/*")) {
    const prefix = normalizedPattern.slice(0, -2);
    const rest = normalizedPath.slice(prefix.length + 1);
    return normalizedPath.startsWith(`${prefix}/`) && !rest.includes("/");
  }
  const regex = new RegExp(
    `^${normalizedPattern
      .split("*")
      .map(escapeRegExp)
      .join(".*")}$`,
  );
  return regex.test(normalizedPath);
}

async function loadSkillContent(
  options: LocalSkillsServiceOptions,
  skill: LocalSkillMetadata,
  args: string | undefined,
  sessionId: string,
): Promise<RenderedSkill | null> {
  if (skill.loadedFrom === "bundled") {
    return renderBundledSkill(skill, args);
  }
  let raw: string;
  let readPath = skill.path;
  let checked: CheckedFile | undefined;
  if (skill.scope === "project") {
    const realPath = skill.projectRealPath;
    const checkedFile = realPath === undefined ? null : await checkedProjectSkillFile(realPath);
    if (realPath === undefined || checkedFile === null) {
      throw new Error(`Project skill is no longer in a safe location: ${skill.path}`);
    }
    readPath = realPath;
    checked = checkedFile;
  }
  try {
    const read = await readRegularFileNoFollow(readPath, checked);
    if (read === null) return null;
    raw = read.toString("utf8");
  } catch {
    return null;
  }
  const { markdown } = splitFrontmatter(raw);
  const baseDir = dirname(skill.path);
  let content = `Base directory for this skill: ${baseDir}\n\n${markdown}`;
  content = substituteArguments(content, args, true, skill.argNames ?? []);
  const skillDir = normalizeDisplayPath(baseDir);
  content = content
    .replace(/\$\{AGENC_SKILL_DIR\}/gu, skillDir)
    .replace(/\$\{AGENC_SESSION_ID\}/gu, sessionId);
  // Plugin-shipped skills may address sibling assets (scripts, prompts)
  // through their plugin root; without this the literal placeholder
  // reaches the model and every such path breaks.
  if (skill.pluginRoot !== undefined) {
    content = content.replace(
      /\$\{AGENC_PLUGIN_ROOT\}/gu,
      normalizeDisplayPath(skill.pluginRoot),
    );
  }
  void options;
  return { skill, content };
}

function normalizeSkillName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

function snapshotFindSkill(
  snapshot: LocalSkillsSnapshot,
  name: string,
): LocalSkillMetadata | undefined {
  const normalized = normalizeSkillName(name);
  // A skill's own name wins over another skill's alias, as in findCommand.
  return (
    snapshot.skills.find((skill) => skill.name === normalized) ??
    snapshot.skills.find((skill) => skill.aliases?.includes(normalized))
  );
}

export interface SkillListingEntry {
  readonly name: string;
  readonly description?: string;
  readonly whenToUse?: string;
  readonly disableModelInvocation?: boolean;
  readonly loadedFrom?: string;
  readonly scope?: string;
  readonly root?: string;
  readonly pluginId?: string;
}

const SKILL_LISTING_SCOPE_RANK: Readonly<Record<string, number>> = {
  project: 0,
  managed: 1,
  user: 2,
  plugin: 3,
  mcp: 4,
};
const SHARED_AGENTS_SKILLS_SUFFIX = `${sep}${join(".agents", "skills")}`;

/**
 * Order in which skills compete for the listing budget: the workspace's own
 * skills first, then managed and user skills, then plugins. Within the user
 * scope, `~/.agents/skills` is the catalog installed for every agent on the
 * machine and can hold thousands of entries, so the user's AgenC-specific
 * skills under $AGENC_HOME/skills go first.
 */
function skillListingRank(skill: SkillListingEntry): number {
  const scopeRank = SKILL_LISTING_SCOPE_RANK[skill.scope ?? ""] ?? 5;
  const sharedCatalog =
    skill.scope === "user" &&
    skill.root?.endsWith(SHARED_AGENTS_SKILLS_SUFFIX) === true;
  return scopeRank * 2 + (sharedCatalog ? 1 : 0);
}

function formatHiddenSkillsLine(count: number): string {
  return `- ...and ${count} more skill${count === 1 ? "" : "s"} not shown; ask the user to run /skills <search> to find one`;
}

/**
 * Words too common to say anything about which skill fits a request, mostly
 * the grammar of an instruction ("write", "create", "set up"). How common a
 * word is among the installed skills is weighed separately, per catalog,
 * below; "module" and "project" are left to that weighing, which measured
 * better than listing them here.
 */
const SKILL_MATCH_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "are", "was",
  "not", "but", "all", "any", "can", "has", "have", "how", "its", "let",
  "make", "made", "new", "now", "one", "out", "run", "see", "use", "using",
  "add", "into", "from", "when", "what", "where", "which", "will", "would",
  "please", "should", "then", "them", "they", "there", "here", "just", "like",
  "file", "files", "code", "line", "lines",
  "write", "create", "set", "get", "need", "want", "help", "some", "about",
  "also", "our", "these", "those", "via", "etc", "thing", "things", "stuff",
  "something", "repo", "codebase",
]);

/**
 * A light suffix strip so "tests", "testing" and "tested" meet "test", and
 * "policies" meets "policy". Applied to request words and skill words alike,
 * so the stems only need to agree with each other, not be real words.
 */
function stemTerm(word: string): string {
  let stem = word;
  if (stem.length > 4 && stem.endsWith("ies")) stem = `${stem.slice(0, -3)}y`;
  else if (stem.length > 5 && stem.endsWith("ing")) stem = stem.slice(0, -3);
  else if (stem.length > 4 && stem.endsWith("ed")) stem = stem.slice(0, -2);
  else if (
    stem.length > 3 &&
    stem.endsWith("s") &&
    !stem.endsWith("ss") &&
    !stem.endsWith("us") &&
    !stem.endsWith("is")
  ) {
    stem = stem.slice(0, -1);
  }
  return stem.length > 4 && stem.endsWith("e") ? stem.slice(0, -1) : stem;
}

/** Stemmed content words of free text: a request or a skill description. */
function matchTerms(
  text: string,
  stopwords: ReadonlySet<string> = SKILL_MATCH_STOPWORDS,
): Set<string> {
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#.]+/u)) {
    const token = raw.replace(/^[.]+|[.]+$/gu, "");
    if (token.length < 3 || stopwords.has(token)) continue;
    terms.add(stemTerm(token));
    // "next.js" and "package.json" also mean "next" and "json".
    if (token.includes(".")) {
      for (const part of token.split(".")) {
        if (part.length >= 3 && !stopwords.has(part)) terms.add(stemTerm(part));
      }
    }
  }
  return terms;
}

/** Content words of the current request, stemmed and de-duplicated. */
function requestMatchTokens(request: string | null | undefined): readonly string[] {
  if (typeof request !== "string" || request.length === 0) return [];
  return [...matchTerms(request)];
}

const EMPTY_STOPWORDS: ReadonlySet<string> = new Set();

interface IndexedSkill {
  /** Stemmed parts of the skill name and its plugin id. */
  readonly nameTerms: ReadonlySet<string>;
  readonly nameParts: readonly string[];
  /** Stemmed words of the description and when_to_use. */
  readonly textTerms: ReadonlySet<string>;
}

/**
 * Per-skill match index, built once per metadata object. Snapshot entries
 * are the same objects until the snapshot is rebuilt, so a human turn over a
 * 1,822-skill catalog does set lookups instead of lowercasing and scanning
 * every description again.
 */
const skillMatchIndex = new WeakMap<SkillListingEntry, IndexedSkill>();

function indexedSkill(skill: SkillListingEntry): IndexedSkill {
  let entry = skillMatchIndex.get(skill);
  if (entry === undefined) {
    const parts = [
      ...new Set(
        `${skill.name} ${skill.pluginId ?? ""}`
          .toLowerCase()
          .split(/[^a-z0-9]+/u)
          .filter((part) => part.length > 0)
          .map(stemTerm),
      ),
    ];
    entry = {
      nameTerms: new Set(parts),
      nameParts: parts,
      // Descriptions keep every content word; only the request drops the
      // instruction words.
      textTerms: matchTerms(
        `${skill.description ?? ""} ${skill.whenToUse ?? ""}`,
        EMPTY_STOPWORDS,
      ),
    };
    skillMatchIndex.set(skill, entry);
  }
  return entry;
}

/** Cap so one long description cannot outweigh a real name match. */
const SKILL_DESCRIPTION_MATCH_CAP = 6;
const NAME_MATCH_WEIGHT = 3;
const NAME_PREFIX_MATCH_WEIGHT = 1.5;
const DESCRIPTION_MATCH_WEIGHT = 1;
/** Share of the best score a relevance-block line needs to be shown. */
const RELEVANCE_BLOCK_FLOOR = 0.3;

/**
 * How well each skill answers the current request. A name match counts most:
 * a skill called `generating-unit-tests` is what "write unit tests" wants,
 * and its description only corroborates that. Each word is weighed by how
 * rare it is in this catalog (inverse document frequency): "vercel" or
 * "dockerfile" picks out a few skills, "service" or "deploy" appears in
 * hundreds and says little. A name part that starts with the word, or that
 * the word starts with ("docker" / "dockerfile"), is a partial match.
 */
function skillRelevanceScores(
  skills: readonly SkillListingEntry[],
  terms: readonly string[],
): number[] {
  if (terms.length === 0) return skills.map(() => 0);
  const indexed = skills.map(indexedSkill);
  const count = indexed.length;
  const weights = terms.map((term) => {
    let documents = 0;
    for (const entry of indexed) {
      if (entry.nameTerms.has(term) || entry.textTerms.has(term)) documents += 1;
    }
    return Math.log(1 + count / (1 + documents));
  });
  return indexed.map((entry) => {
    let score = 0;
    let fromDescription = 0;
    terms.forEach((term, index) => {
      const weight = weights[index]!;
      if (entry.nameTerms.has(term)) {
        score += NAME_MATCH_WEIGHT * weight;
      } else if (
        term.length >= 4 &&
        entry.nameParts.some(
          (part) => part.length >= 4 && (part.startsWith(term) || term.startsWith(part)),
        )
      ) {
        score += NAME_PREFIX_MATCH_WEIGHT * weight;
      }
      if (
        fromDescription < SKILL_DESCRIPTION_MATCH_CAP &&
        entry.textTerms.has(term)
      ) {
        score += DESCRIPTION_MATCH_WEIGHT * weight;
        fromDescription += 1;
      }
    });
    return score;
  });
}

/** What a listing pass decided, for the operator-facing diagnostic. */
export interface SkillListingStats {
  /** Skills offered to the listing (already excludes non-invocable ones). */
  readonly invocable: number;
  /** Skills whose full line fit the budget. */
  readonly listed: number;
  /** Skills the budget had no room for. */
  readonly hidden: number;
  readonly budgetChars: number;
  readonly usedChars: number;
  /** True when the request reordered the listing. */
  readonly ranked: boolean;
}

export function formatSkillListingWithinBudget(
  skills: readonly SkillListingEntry[],
  contextWindowTokens?: number,
  request?: string | null,
): string {
  return buildSkillListingWithinBudget(skills, contextWindowTokens, request)
    .listing;
}

export function buildSkillListingWithinBudget(
  skills: readonly SkillListingEntry[],
  contextWindowTokens?: number,
  request?: string | null,
): {
  readonly listing: string;
  readonly stats: SkillListingStats;
  /** Names of the skills whose lines made it into the listing. */
  readonly listedNames: readonly string[];
} {
  const commands = skills.filter((skill) => !skill.disableModelInvocation);
  const tokensForStats = requestMatchTokens(request);
  const emptyStats = (budgetChars: number): SkillListingStats => ({
    invocable: commands.length,
    listed: 0,
    hidden: commands.length,
    budgetChars,
    usedChars: 0,
    ranked: false,
  });
  if (commands.length === 0) {
    return {
      listing: "",
      stats: emptyStats(getListingCharBudget(contextWindowTokens)),
      listedNames: [],
    };
  }
  const budget = getListingCharBudget(contextWindowTokens);
  // Every line is at least "- <name>: ", so a catalog whose names alone
  // overflow the budget cannot fit; skip formatting 1,800 lines to learn it.
  const shortestTotal =
    commands.reduce((sum, skill) => sum + skill.name.length + 4, 0) +
    commands.length - 1;
  const fullLines =
    shortestTotal <= budget ? commands.map(formatSkillListingLine) : null;
  const fullTotal =
    fullLines === null
      ? Number.POSITIVE_INFINITY
      : fullLines.reduce((sum, line) => sum + line.length, 0) + fullLines.length - 1;
  if (fullLines !== null && fullTotal <= budget) {
    return {
      listing: fullLines.join("\n"),
      stats: {
        invocable: commands.length,
        listed: commands.length,
        hidden: 0,
        budgetChars: budget,
        usedChars: fullTotal,
        ranked: false,
      },
      listedNames: commands.map((skill) => skill.name),
    };
  }

  // Over budget: bundled skills always stay (they describe the runtime's own
  // surfaces), then full lines in rank order until the budget is spent. A
  // description the model can match to a task beats a bare name it cannot,
  // so the skills that do not fit are counted in one closing line instead
  // of being listed by name.
  const bundled = commands.filter((skill) => skill.loadedFrom === "bundled");
  // Over budget, insertion order inside a scope is alphabetical, so a large
  // shared catalog fills the whole listing with whatever sorts first. Live
  // measurement on a machine with 1,823 installed skills: 101 fit, the list
  // stopped at "apollo-core-workflow-a", and every skill matching the work at
  // hand — canvas-design, frontend-design, generating-unit-tests,
  // javascript-typescript — was never shown, which is why 15 turns of exactly
  // that work produced zero Skill invocations. What the request is about now
  // decides who gets the space; scope rank breaks ties, as before.
  const relevance = skillRelevanceScores(commands, tokensForStats);
  const rest = commands
    .map((skill, index) => ({
      skill,
      index,
      rank: skillListingRank(skill),
      relevance: relevance[index]!,
    }))
    .filter((entry) => entry.skill.loadedFrom !== "bundled")
    .sort(
      (a, b) =>
        b.relevance - a.relevance || a.rank - b.rank || a.index - b.index,
    )
    .map((entry) => entry.skill);
  const lines = bundled.map(formatSkillListingLine);
  const listedNames = bundled.map((skill) => skill.name);
  let used = lines.reduce((sum, line) => sum + line.length + 1, 0);
  const reserve = formatHiddenSkillsLine(rest.length).length + 1;
  let shown = 0;
  for (const skill of rest) {
    const line = formatSkillListingLine(skill);
    // The first ranked skill is always listed, even under a budget smaller
    // than one line, so the listing never degrades to a bare count.
    if (shown > 0 && used + line.length + reserve > budget) break;
    lines.push(line);
    listedNames.push(skill.name);
    used += line.length + 1;
    shown += 1;
  }
  const hidden = rest.length - shown;
  if (hidden > 0) lines.push(formatHiddenSkillsLine(hidden));
  const listing = lines.join("\n");
  return {
    listing,
    stats: {
      invocable: commands.length,
      listed: bundled.length + shown,
      hidden,
      budgetChars: budget,
      usedChars: listing.length,
      ranked: tokensForStats.length > 0,
    },
    listedNames,
  };
}

/**
 * The skills a request is about that are not yet in front of the model:
 * relevance-ranked lines for up to `limit` invocable skills outside
 * `exclude`, or nothing when the request carries no matchable words.
 */
export function rankSkillsForRequest(
  skills: readonly SkillListingEntry[],
  request: string | null | undefined,
  exclude: ReadonlySet<string>,
  limit: number,
): { readonly lines: readonly string[]; readonly names: readonly string[] } {
  const tokens = requestMatchTokens(request);
  if (tokens.length === 0 || limit <= 0) return { lines: [], names: [] };
  // An explicit plugin mention must identify its member skills even when an
  // older retained listing already showed those skills without their owner.
  const mentionedPlugins = new Set(
    [...(request ?? "").matchAll(/(?:^|[\s(])@([a-z0-9][a-z0-9:_-]*)/giu)]
      .map((match) => match[1]!.toLowerCase()),
  );
  // Word weights come from the whole catalog, not just the candidates.
  const relevance = skillRelevanceScores(skills, tokens);
  const candidates = skills
    .map((skill, index) => ({
      skill,
      index,
      rank: skillListingRank(skill),
      relevance: relevance[index]!,
    }))
    .filter((entry) => entry.relevance > 0 && !entry.skill.disableModelInvocation && (
      !exclude.has(entry.skill.name) ||
      (entry.skill.pluginId !== undefined &&
        mentionedPlugins.has(entry.skill.pluginId.toLowerCase()))
    ));
  const best = candidates.reduce((top, entry) => Math.max(top, entry.relevance), 0);
  const ranked = candidates
    // A line that matched only a word the best candidates also matched,
    // and nothing rarer, is noise the model has to read on every turn.
    .filter((entry) => entry.relevance >= RELEVANCE_BLOCK_FLOOR * best)
    .sort(
      (a, b) =>
        b.relevance - a.relevance || a.rank - b.rank || a.index - b.index,
    )
    .slice(0, limit);
  return {
    lines: ranked.map((entry) => formatSkillListingLine(entry.skill)),
    names: ranked.map((entry) => entry.skill.name),
  };
}

function getListingCharBudget(contextWindowTokens?: number): number {
  const envBudget = Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET);
  if (Number.isFinite(envBudget) && envBudget > 0) return envBudget;
  if (contextWindowTokens && Number.isFinite(contextWindowTokens)) {
    return Math.min(
      SKILL_LISTING_MAX_CHAR_BUDGET,
      Math.floor(
        contextWindowTokens * CHARS_PER_TOKEN * SKILL_LISTING_CONTEXT_PERCENT,
      ),
    );
  }
  return SKILL_LISTING_DEFAULT_CHAR_BUDGET;
}

function getSkillListingDescription(
  skill: {
    readonly description?: string;
    readonly whenToUse?: string;
    readonly loadedFrom?: string;
    readonly pluginId?: string;
  },
): string {
  const raw = skill.whenToUse
    ? `${skill.description} - ${skill.whenToUse}`
    : skill.description ?? "";
  const sanitized = sanitizeSkillListingMetadata(raw);
  const description =
    skill.loadedFrom === "mcp" && sanitized.length > 0
      ? `[untrusted MCP metadata] ${sanitized}`
      : sanitized;
  const owner = skill.pluginId === undefined
    ? ""
    : `[plugin: ${truncate(sanitizeSkillListingMetadata(skill.pluginId), 96)}] `;
  return `${owner}${truncate(description, SKILL_LISTING_DESC_MAX_CHARS)}`;
}

function formatSkillListingLine(
  skill: {
    readonly name: string;
    readonly description?: string;
    readonly whenToUse?: string;
    readonly loadedFrom?: string;
    readonly pluginId?: string;
  },
): string {
  return `- ${skill.name}: ${getSkillListingDescription(skill)}`;
}

const SKILL_LISTING_UNTRUSTED_MARKER = "[untrusted MCP metadata]";
const SKILL_LISTING_SYSTEM_REMINDER_TAG_RE =
  /<\s*\/?\s*system-reminder\b[^>]*>/giu;
const SKILL_LISTING_HIDDEN_TEXT_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu;

function sanitizeSkillListingMetadata(value: string): string {
  return value
    .replace(
      SKILL_LISTING_SYSTEM_REMINDER_TAG_RE,
      "<neutralized-system-reminder-tag>",
    )
    .split(SKILL_LISTING_UNTRUSTED_MARKER)
    .join("[neutralized untrusted MCP metadata marker]")
    .replace(SKILL_LISTING_HIDDEN_TEXT_RE, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  if (maxLength === 1) return "…";
  return `${value.slice(0, maxLength - 1)}…`;
}

function invokedSkillsScopeKey(sessionKey: string, agentId?: string): string {
  return `${sessionKey}\u0000${agentId ?? INVOKED_MAIN_AGENT_ID}`;
}

function recordInvokedSkillInScope(
  sessionKey: string,
  record: InvokedSkillRecord,
): void {
  const key = invokedSkillsScopeKey(sessionKey, record.agentId);
  let skills = invokedSkillsByScope.get(key);
  if (!skills) {
    skills = new Map<string, InvokedSkillRecord>();
    invokedSkillsByScope.set(key, skills);
  }
  skills.set(record.skillName, record);
}

function getInvokedSkillsForScopes(
  sessionKeys: readonly string[],
  agentId?: string,
): ReadonlyMap<string, InvokedSkillRecord> {
  const merged = new Map<string, InvokedSkillRecord>();
  for (const sessionKey of sessionKeys) {
    const skills = invokedSkillsByScope.get(
      invokedSkillsScopeKey(sessionKey, agentId),
    );
    if (!skills) continue;
    for (const [name, record] of skills) merged.set(name, record);
  }
  return merged;
}

function clearInvokedSkillsForScopes(
  sessionKeys: readonly string[],
  agentId?: string,
): void {
  for (const sessionKey of sessionKeys) {
    invokedSkillsByScope.delete(invokedSkillsScopeKey(sessionKey, agentId));
  }
}

export function clearInvokedSkills(): void {
  invokedSkillsByScope.clear();
}

function extractActivePaths(input: unknown, fsArg: unknown): string[] {
  const values: unknown[] = [];
  if (Array.isArray(input)) values.push(...input);
  if (Array.isArray(fsArg)) values.push(...fsArg);
  if (input && typeof input === "object") {
    const candidate = input as {
      paths?: unknown;
      filePaths?: unknown;
      touchedPaths?: unknown;
      path?: unknown;
    };
    values.push(candidate.path, candidate.paths, candidate.filePaths, candidate.touchedPaths);
  }
  if (fsArg && typeof fsArg === "object") {
    const candidate = fsArg as {
      paths?: unknown;
      filePaths?: unknown;
      touchedPaths?: unknown;
      path?: unknown;
    };
    values.push(candidate.path, candidate.paths, candidate.filePaths, candidate.touchedPaths);
  }
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function createLocalSkillsServices(
  options: LocalSkillsServiceOptions,
): Pick<
  SessionServices,
  "skillsManager" | "pluginsManager" | "skillsWatcher"
> {
  let cache: {
    readonly key: string;
    readonly value: Promise<LocalSkillsSnapshot>;
  } | null = null;
  let lastPluginConfig: Pick<AgenCConfig, "plugins"> | undefined =
    options.config;
  let watchedPluginConfigKey = pluginWatchKey(options.config);
  const activePaths = new Set<string>();
  const discoveredSkillRoots = new Set<string>();
  let watcherStarted = false;
  // Touched paths only feed `paths:`-gated skills and are part of the
  // snapshot cache key, so the set is bounded: once full, the oldest path
  // makes room for the newest.
  const rememberActivePath = (path: string): boolean => {
    if (activePaths.has(path)) return false;
    activePaths.add(path);
    while (activePaths.size > MAX_ACTIVE_PATHS) {
      const oldest = activePaths.values().next().value;
      if (oldest === undefined) break;
      activePaths.delete(oldest);
    }
    return true;
  };
  // Session scoping for invoked-skill tracking. Records stamped with an
  // explicit sessionId (the Skill tool stamps the conversation id) land in
  // that session's scope; unstamped records use this instance's default
  // key so single-session CLI paths keep the pre-session behavior. Reads
  // without an explicit sessionId cover every scope this instance has
  // recorded into — instances are created per session in the daemon, so
  // another session's records never appear here.
  const defaultInvokedSkillsSessionKey =
    options.sessionId?.trim() || INVOKED_MAIN_AGENT_ID;
  const invokedSkillsSessionKeys = new Set<string>([
    defaultInvokedSkillsSessionKey,
  ]);
  const recordInvokedSkill = (record: InvokedSkillRecord): void => {
    const sessionKey =
      record.sessionId?.trim() || defaultInvokedSkillsSessionKey;
    invokedSkillsSessionKeys.add(sessionKey);
    recordInvokedSkillInScope(sessionKey, record);
  };
  const getInvokedSkillsForAgent = (
    agentId?: string,
    sessionId?: string,
  ): ReadonlyMap<string, InvokedSkillRecord> => {
    const sessionKeys = sessionId?.trim()
      ? [sessionId.trim()]
      : [...invokedSkillsSessionKeys];
    return getInvokedSkillsForScopes(sessionKeys, agentId);
  };
  const clearInvokedSkillsForAgent = (
    agentId?: string,
    sessionId?: string,
  ): void => {
    const sessionKeys = sessionId?.trim()
      ? [sessionId.trim()]
      : [...invokedSkillsSessionKeys];
    clearInvokedSkillsForScopes(sessionKeys, agentId);
  };
  const detector = options.skillChangeDetector ?? createSkillChangeDetector();
  const eventSink = options.skillChangeEventSink ?? skillChangeDetector;
  const load = (
    config?: Pick<AgenCConfig, "plugins">,
  ): Promise<LocalSkillsSnapshot> => {
    const effectiveOptions = config === undefined ? options : { ...options, config };
    const key = skillSnapshotCacheKey(
      effectiveOptions.config,
      activePaths,
      discoveredSkillRoots,
    );
    if (cache?.key !== key) {
      cache = {
        key,
        value: loadLocalSkillsSnapshot(
          effectiveOptions,
          [...activePaths],
          [...discoveredSkillRoots],
        ),
      };
    }
    return cache.value;
  };
  const clear = () => {
    cache = null;
  };
  const snapshotHasConditionalSkills = async (): Promise<boolean> => {
    if (cache === null) return true;
    try {
      return (await cache.value).conditionalSkills.length > 0;
    } catch {
      return true;
    }
  };
  const startWatcher = () => {
    if (watcherStarted) return Promise.resolve();
    watcherStarted = true;
    watchedPluginConfigKey = pluginWatchKey(lastPluginConfig);
    return detector.initialize({
      fileWatcher: options.fileWatcher,
      getWatchRoots: async () => {
        return discoverSkillWatchRoots({
          ...options,
          config: lastPluginConfig,
        });
      },
      onReload: clear,
      ...(detector !== eventSink ? { forwardTo: eventSink } : {}),
      ...(options.watcherDebounceMs !== undefined
        ? { debounceMs: options.watcherDebounceMs }
        : {}),
      ...(options.watcherClearRuntimeCaches !== undefined
        ? { clearRuntimeCaches: options.watcherClearRuntimeCaches }
        : {}),
      ...(options.watcherRunConfigChangeHooks !== undefined
        ? { runConfigChangeHooks: options.watcherRunConfigChangeHooks }
        : {}),
    }).catch(() => {
      watcherStarted = false;
    });
  };
  const restartWatcherIfPluginConfigChanged = async () => {
    if (!watcherStarted) return;
    const nextKey = pluginWatchKey(lastPluginConfig);
    if (nextKey === watchedPluginConfigKey) return;
    await detector.dispose();
    watcherStarted = false;
    await startWatcher();
  };

  const skillsManager = {
    async skillsForConfig(
      input: AgenCConfig | unknown,
      fsArg: unknown,
    ): Promise<SkillLoadOutcome> {
      for (const path of extractActivePaths(input, fsArg)) {
        rememberActivePath(path);
      }
      const nextPluginConfig = pluginConfigView(input);
      if (nextPluginConfig !== undefined) {
        lastPluginConfig = nextPluginConfig;
      }
      await restartWatcherIfPluginConfigChanged();
      const snapshot = await load(lastPluginConfig);
      return {
        invokedSkills: [...getInvokedSkillsForAgent().keys()],
        availableSkills: snapshot.skills,
        ...(snapshot.truncatedRoots.length > 0
          ? { truncatedSkillRoots: snapshot.truncatedRoots }
          : {}),
        ...(snapshot.warnings.length > 0
          ? { skillLoadWarnings: snapshot.warnings }
          : {}),
      };
    },
    async resolveSkill(name: string): Promise<LocalSkillMetadata | null> {
      const snapshot = await load(lastPluginConfig);
      return snapshotFindSkill(snapshot, name) ?? null;
    },
    async renderSkill(opts: {
      readonly name: string;
      readonly args?: string;
      readonly sessionId?: string;
    }): Promise<RenderedSkill | null> {
      const snapshot = await load(lastPluginConfig);
      const skill = snapshotFindSkill(snapshot, opts.name);
      if (!skill) return null;
      return loadSkillContent(
        options,
        skill,
        opts.args,
        opts.sessionId ?? "",
      );
    },
    recordInvokedSkill,
    getInvokedSkillsForAgent,
    clearInvokedSkillsForAgent,
    clearSkillCaches: clear,
    async discoverSkillDirsForPaths(paths: readonly string[]): Promise<readonly string[]> {
      const touchedPaths = paths.map((path) =>
        isAbsolute(path)
          ? resolve(path)
          : resolve(options.workspaceRoot, path),
      );
      const dirs = await discoverDynamicSkillDirsForPaths(
        touchedPaths,
        options.workspaceRoot,
      );
      let changed = false;
      for (const dir of dirs) {
        if (discoveredSkillRoots.has(dir)) continue;
        discoveredSkillRoots.add(dir);
        changed = true;
      }
      // Touched paths can only activate `paths:`-gated skills. Recording
      // one invalidates the snapshot, and the reload walks every skill root
      // again before the next model request, so record them only while such
      // skills exist (or before the first load, which happens anyway).
      if (await snapshotHasConditionalSkills()) {
        for (const path of touchedPaths) {
          if (rememberActivePath(path)) changed = true;
        }
      }
      if (changed) clear();
      return dirs;
    },
  };

  return {
    skillsManager,
    pluginsManager: {
      async pluginsForConfig(config) {
        const pluginSkillRoots = await discoverPluginSkillRootsWithProvenance({
          pluginStorageRoot: options.pluginStorageRoot,
          workspaceRoot: options.workspaceRoot,
          config: pluginConfigView(config),
        });
        return {
          effectiveSkillRoots: () => pluginSkillRoots.map((root) => root.path),
        };
      },
    },
    skillsWatcher: {
      start: () => {
        return startWatcher();
      },
      stop: async () => {
        watcherStarted = false;
        await detector.dispose();
      },
    },
  };
}

/**
 * The watch roots depend on the plugin section alone (plugin discovery reads
 * nothing else). The whole session config used to be the key, so changing
 * the model or a permission rule tore the watcher down and registered every
 * root again.
 */
function pluginWatchKey(config: Pick<AgenCConfig, "plugins"> | undefined): string {
  return JSON.stringify(config?.plugins ?? null);
}

function skillSnapshotCacheKey(
  config: Pick<AgenCConfig, "plugins"> | undefined,
  activePaths: ReadonlySet<string>,
  discoveredSkillRoots: ReadonlySet<string>,
): string {
  return JSON.stringify({
    plugins: config?.plugins ?? null,
    activePaths: [...activePaths].sort(),
    discoveredSkillRoots: [...discoveredSkillRoots].sort(),
  });
}

function pluginConfigView(
  config: unknown,
): Pick<AgenCConfig, "plugins"> | undefined {
  return isRecord(config)
    ? config as Pick<AgenCConfig, "plugins">
    : undefined;
}

export async function discoverDynamicSkillDirsForPaths(
  filePaths: readonly string[],
  cwd: string,
): Promise<readonly string[]> {
  const resolvedCwd = resolve(cwd);
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const filePath of filePaths) {
    let current = dirname(isAbsolute(filePath) ? filePath : resolve(cwd, filePath));
    while (current.startsWith(`${resolvedCwd}${sep}`)) {
      for (const rootName of [".agenc", ".agents"]) {
        const skillDir = join(current, rootName, "skills");
        if (seen.has(skillDir)) continue;
        seen.add(skillDir);
        if (await pathIsDirectory(skillDir) && await projectSkillRootIsSafe(skillDir)) {
          dirs.push(skillDir);
        }
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return dirs.sort((a, b) => b.split(sep).length - a.split(sep).length);
}

function getLoopMaintenancePrompt(): string {
  return `Scheduled maintenance loop iteration.

If .agenc/loop.md exists, read it and follow it.
Otherwise, if ~/.agenc/loop.md exists, read it and follow it.
Otherwise:
- continue any unfinished work from the conversation
- tend to the current branch's pull request: review comments, failed CI runs, merge conflicts
- run cleanup passes such as bug hunts or simplification when nothing else is pending

Do not start new initiatives outside that scope. Irreversible actions such as pushing or deleting only proceed when they continue something the transcript already authorized.`;
}

function buildLoopPrompt(args: string): string {
  const trimmed = args.trim();
  const maintenance = getLoopMaintenancePrompt();
  return `# Loop: Scheduled AgenC Work

The user invoked /loop${trimmed ? ` with: ${trimmed}` : ""}.

Use the CronCreate, CronDelete, and CronList tools where scheduling is needed.

## Behavior

- If the user supplied a fixed interval, convert it to the nearest practical cron schedule and create a non-durable recurring job.
- If the user supplied a prompt without a fixed interval, perform the work now, choose the next delay between 1 minute and 1 hour, and create one non-recurring follow-up job.
- If no prompt was supplied, use this maintenance prompt:

--- BEGIN MAINTENANCE PROMPT ---
${maintenance}
--- END MAINTENANCE PROMPT ---

After scheduling, briefly confirm the schedule and returned job id.`;
}

const SIMPLIFY_PROMPT = `# Simplify: Code Review and Cleanup

Review all changed files for reuse, quality, and efficiency. Fix any issues found.

## Phase 1: Identify Changes

Run \`git diff\` (or \`git diff HEAD\` if there are staged changes) to see what changed. If there are no git changes, review the most recently modified files that the user mentioned or that you edited earlier in this conversation.

## Phase 2: Launch Three Review Agents in Parallel

Use the spawn_agent tool to launch all three agents concurrently in a single message. Pass each agent the full diff so it has complete context.

1. Code reuse review: find existing utilities and helpers that should replace newly written code.
2. Code quality review: find redundant state, copy-paste, leaky abstractions, stringly typed code, and unnecessary comments.
3. Efficiency review: find repeated work, missed concurrency, hot-path bloat, recurring no-op updates, and unbounded data structures.

## Phase 3: Fix Issues

Wait for all three agents to complete. Aggregate their findings and fix each valid issue directly. If a finding is false positive or not worth addressing, note it and move on.`;

function buildBatchPrompt(args: string): string {
  const instruction = args.trim();
  if (!instruction) {
    return `Provide an instruction describing the batch change you want to make.

Examples:
  /batch migrate from react to vue
  /batch replace all uses of lodash with native equivalents
  /batch add type annotations to all untyped function parameters`;
  }
  return `# Batch: Parallel Work Orchestration

You are orchestrating a large, parallelizable change across this codebase.

## User Instruction

${instruction}

## Phase 1: Research and Plan

Enter plan mode, understand the scope, and decompose the work into independent units that can be implemented in isolated git worktrees. Include the files/directories each unit owns and an end-to-end verification recipe.

## Phase 2: Spawn Workers

After the plan is approved, spawn one background runner per work unit using the spawn_agent tool. Each runner prompt must include the overall goal, its owned files, local conventions, the verification recipe, and instructions to test, commit, push, and report the PR URL.

## Phase 3: Track Progress

Maintain a status table for each runner and update it as results arrive.`;
}

function buildDebugPrompt(args: string): string {
  const debugLogPath = join(getAgenCHomeDir(), "debug.log");
  return `# Debug Skill

Help the user debug the current AgenC session.

## Session Debug Log

The default debug log path is: \`${debugLogPath}\`

If the log does not exist, tell the user how to reproduce with debug logging enabled, then inspect the next generated log. Grep for ERROR and WARN lines, stack traces, failed tool calls, provider errors, MCP failures, and permission denials.

## Issue Description

${args || "The user did not describe a specific issue. Read available logs and summarize notable errors, warnings, or failures."}

## Settings

Settings are normally in:
- user: ~/.agenc/config.toml
- project: .agenc/config.toml
- local: .agenc/config.local.toml

Explain findings in plain language and suggest concrete fixes.`;
}

function buildUpdateConfigPrompt(): string {
  return `# Update AgenC Configuration

Help the user create or edit AgenC configuration.

## Config Locations

Choose the file based on scope:

| File | Scope | Git | Use For |
|---|---|---|---|
| \`~/.agenc/config.toml\` | Global | N/A | Personal defaults |
| \`.agenc/config.toml\` | Project | Commit | Team-wide config |
| \`.agenc/config.local.toml\` | Project | Gitignored | Personal overrides |

Config loads from defaults, then user, project, local, and environment overrides.

## Common Settings

\`\`\`toml
model = "gpt-5.4"
provider = "openai"

[permissions]
defaultMode = "default"
allow = ["FileRead", "Skill(simplify)"]
deny = ["system.bash(rm -rf:*)"]
ask = ["Write(/etc/*)"]

[tools]
webSearchMode = "auto"

[hooks]
# See docs/architecture/guides/testing-patterns.md and config schema docs.
\`\`\`

Read the existing config before editing. Preserve unrelated keys and comments where practical.`;
}

function buildKeybindingsPrompt(): string {
  return `# Keybindings Skill

Create or modify canonical \`~/.agenc/config.toml\` to customize AgenC keyboard shortcuts under \`tui.keybindings\`.

Always read the existing config first. Preserve unrelated settings and merge changes with existing keybinding blocks.

## File Format

\`\`\`toml
[tui]
keybindings = [
  { context = "Chat", bindings = { "ctrl+e" = "chat:externalEditor", "shift+tab" = "chat:cycleMode" } },
  { context = "Global", unbind = ["ctrl+t"] },
]
\`\`\`

Use \`unbind\` for explicit removals because TOML has no null value. The canonical schema rejects unknown contexts, actions, fields, malformed chords, and conflicting aliases.`;
}

function buildBrowserPrompt(args: string): string {
  return `# AgenC Browser Automation

Inspect, test, or debug a web UI with the runtime's Browser tool.

## User Request

${args || "No specific URL or flow was supplied. Ask the user for the URL or app flow to test."}

## Workflow

1. The Browser tool is deferred: load it with system.searchTools and the query \`select:Browser\`, then load the browser-automation skill with the Skill tool; it explains the snapshot, act, re-snapshot loop the tool expects.
2. Start or locate the local dev server. Private and loopback addresses are blocked by the Browser tool's SSRF policy unless \`[browser].allow_private_network\` is enabled.
3. Navigate the target flow by ref from the latest snapshot. Capture screenshots for visual regressions when useful.
4. Report exact failures, console errors, network errors, and UI mismatches.

Do not rely on a visual guess when a snapshot, screenshot, or browser console check can verify the result.`;
}

function buildSchedulePrompt(args: string): string {
  return `# Schedule AgenC Agents

Help the user schedule, update, list, or run local AgenC scheduled agent jobs.

If the user specifically means AgenC Desktop Routines, discover the authenticated desktop_routine_* tools with system.searchTools and use those to operate the app's actual Routine records. If those tools are unavailable, explain that Desktop Routine management is unavailable in this session; do not silently create a Cron job instead. Preserve revision checks and ordinary approvals; read-only/plan sessions may inspect but must not change or run Routines.

For conversation-local scheduling rather than Desktop Routines, use CronCreate, CronList, and CronDelete. If the user asks for remote cloud-hosted agents, explain that this local runtime does not provide remote cloud scheduling.

## User Request

${args || "Ask the user what they want to schedule: create, list, update, or run."}

For Cron create/update requests, collect the cron expression, prompt, timezone, durability, and whether the job should recur before calling the cron tool.`;
}

function buildApiPrompt(args: string): string {
  return `# AgenC API Guidance

Help the user build against AgenC runtime APIs or the configured model provider APIs.

## User Request

${args || "Ask which API surface and language they are using."}

Prefer live local source and official provider docs. For provider-specific behavior, use the official docs for the selected provider and adapt examples to AgenC's provider configuration.`;
}

function buildLedgerWalletCliPrompt(args: string): string {
  return `# Ledger Wallet CLI

Use Ledger's official \`wallet-cli\` for USB hardware-wallet operations.

## Required setup flow

1. Call \`ledger_wallet_cli_status\` before any shell probe.
2. If it is missing, call \`install_ledger_wallet_cli\`. Its mandatory approval dialog is the user's confirmation. Never install through npm/Bun/pnpm/yarn and never download before approval.
3. After installation, call \`ledger_wallet_cli_status\` again and use the exact executable path it returns.
4. Never treat the unrelated \`ledger\`, \`hledger\`, or \`solana\` binaries as substitutes.

The managed installer checks \`@ledgerhq/wallet-cli@latest\` on every approved install, verifies the platform package's sha512 integrity, and stores it under AgenC home.

## Operation rules

- With no specific task, start with \`session view --output human\`.
- Supported wallet networks are Bitcoin, Ethereum, and Solana.
- Read-only examples: \`session view\`, \`balances <label>\`, \`operations <label>\`, \`swap quote ...\`, \`swap status ...\`, \`assets token ...\`, \`earn yields\`, and \`earn positions <label>\`.
- Device examples: \`account discover <network>\`, \`receive <label>\`, \`genuine-check\`, \`send ...\`, \`swap execute ...\`, \`earn deposit ...\`, \`earn withdraw ...\`, and \`ring ...\`.
- Run device commands sequentially. Do not impose a timeout while wallet-cli is waiting for physical confirmation.
- Before send, swap execution, deposit, withdrawal, or destructive key-ring work, make the destination, account, asset, amount, network, and fees unambiguous. The agent proposes; the human approves on the Ledger.
- Never place a Ledger password or seed phrase in a command, transcript, environment assignment, or prompt. Ask the user to load passwords from their OS credential store outside AgenC. Do not request, construct, or run credential-store commands.
- Do not claim a submitted transaction is confirmed on-chain.

## User request

${args.trim() || "Inspect the current Ledger Wallet CLI session safely."}`;
}

const VERIFY_FILES = {
  "examples/cli.md": `# CLI Verification

Run the relevant command, capture stdout/stderr, and verify the behavior the user asked for. Include the exact command and result in your summary.`,
  "examples/server.md": `# Server Verification

Start the server, make a request against the affected endpoint or UI route, and verify status, response body, and logs.`,
};

const BUNDLED_SKILLS: readonly BundledSkillDefinition[] = [
  {
    name: "update-config",
    description: "Create or edit AgenC configuration files.",
    argumentHint: "[setting request]",
    allowedTools: ["FileRead", "Write", "Edit", "MultiEdit"],
    getPrompt: () => buildUpdateConfigPrompt(),
  },
  {
    name: "keybindings",
    aliases: ["keybindings-help"],
    description: "Create or modify AgenC TUI keybindings.",
    argumentHint: "[binding request]",
    allowedTools: ["FileRead", "Write", "Edit", "MultiEdit"],
    getPrompt: () => buildKeybindingsPrompt(),
  },
  {
    name: "debug",
    description: "Enable or inspect debug information for the current AgenC session.",
    argumentHint: "[issue description]",
    allowedTools: ["FileRead", "Grep", "Glob"],
    disableModelInvocation: true,
    getPrompt: (args) => buildDebugPrompt(args),
  },
  {
    name: "simplify",
    description: "Review changed code for reuse, quality, and efficiency, then fix issues.",
    argumentHint: "[additional focus]",
    getPrompt: (args) =>
      args.trim()
        ? `${SIMPLIFY_PROMPT}\n\n## Additional Focus\n\n${args.trim()}`
        : SIMPLIFY_PROMPT,
  },
  {
    name: "batch",
    description:
      "Research and plan a large-scale change, then execute it in parallel across isolated worktree agents.",
    whenToUse:
      "Use for sweeping mechanical migrations, refactors, or bulk edits that can be decomposed into independent units.",
    argumentHint: "<instruction>",
    disableModelInvocation: true,
    getPrompt: (args) => buildBatchPrompt(args),
  },
  {
    name: "loop",
    description:
      "Run a prompt on a fixed interval or dynamically reschedule it in the current AgenC session.",
    whenToUse:
      "Use when the user wants to poll for status, babysit a workflow, or keep re-running a prompt.",
    argumentHint: "[interval] [prompt]",
    getPrompt: (args) => buildLoopPrompt(args),
  },
  {
    name: "agenc-in-browser",
    description:
      "Inspect, test, or debug a web UI with the runtime's Browser tool.",
    argumentHint: "[url or flow]",
    getPrompt: (args) => buildBrowserPrompt(args),
  },
  {
    name: "schedule-agents",
    aliases: ["schedule-remote-agents"],
    description: "Schedule, list, or run AgenC cron-style agent jobs.",
    argumentHint: "[schedule request]",
    getPrompt: (args) => buildSchedulePrompt(args),
  },
  {
    name: "agenc-api",
    description: "Use AgenC runtime APIs or configured provider APIs correctly.",
    argumentHint: "[api task]",
    getPrompt: (args) => buildApiPrompt(args),
  },
  {
    name: "ledger-wallet-cli",
    description:
      "Use Ledger's official wallet-cli, including safe missing-binary detection and approved latest-version installation.",
    whenToUse:
      "Use whenever the user means a Ledger hardware wallet, wallet-cli, Ledger device accounts, balances, receive/send, swaps, earn, genuine-check, or Ledger Key Ring.",
    argumentHint: "[Ledger wallet task]",
    allowedTools: [
      "ledger_wallet_cli_status",
      "install_ledger_wallet_cli",
      "exec_command",
    ],
    getPrompt: (args) => buildLedgerWalletCliPrompt(args),
  },
  {
    name: "verify",
    description: "Plan and run a concrete verification pass for CLI, server, or UI changes.",
    argumentHint: "[thing to verify]",
    files: VERIFY_FILES,
    getPrompt: (args) => `# Verify

Design and run a concrete verification pass.

## Target

${args || "The user did not specify a target. Infer the changed surface from git diff and recent context."}

Use the reference files in this skill directory for CLI and server verification examples. Prefer direct commands, browser automation, assertions, and logs over a purely visual inspection.`,
  },
];
