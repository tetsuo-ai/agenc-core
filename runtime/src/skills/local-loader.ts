import {
  readdir,
  readFile,
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

export interface LocalSkillsSnapshot {
  readonly skills: readonly LocalSkillMetadata[];
  readonly skillRoots: readonly string[];
  readonly pluginSkillRoots: readonly string[];
  readonly conditionalSkills: readonly LocalSkillMetadata[];
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
}

interface SkillWithContent {
  readonly skill: LocalSkillMetadata;
  readonly content: string;
  readonly filePath: string;
}

interface SplitFrontmatter {
  readonly frontmatter: Record<string, unknown>;
  readonly markdown: string;
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
const MAX_SKILL_FILES = 500;
const MAX_SCAN_DEPTH = 12;
const INVOKED_MAIN_AGENT_ID = "__main__";
const SKILL_LISTING_DEFAULT_CHAR_BUDGET = 8_000;
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

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
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

function projectDirsUpToHome(
  workspaceRoot: string,
  home?: string,
): string[] {
  const dirs: string[] = [];
  const homeResolved = home ? resolve(home) : null;
  let current = resolve(workspaceRoot);
  while (true) {
    if (homeResolved !== null && current === homeResolved) break;
    dirs.push(join(current, ".agents", "skills"));
    dirs.push(join(current, ".agenc", "skills"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function localSkillRootCandidates(
  options: LocalSkillsServiceOptions,
): SkillRoot[] {
  const home = options.env?.HOME ?? homedir();
  const agencHome = normalizeExistingCandidate(options.agencHome);
  const workspaceRoot = normalizeExistingCandidate(options.workspaceRoot);

  const roots: SkillRoot[] = [];

  for (const path of projectDirsUpToHome(workspaceRoot, home)) {
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

export async function discoverSkillRoots(
  options: LocalSkillsServiceOptions,
  discoveredSkillRoots: readonly string[] = [],
): Promise<readonly SkillRoot[]> {
  const pluginStorageRoot = normalizeExistingCandidate(
    options.pluginStorageRoot,
  );
  const workspaceRoot = normalizeExistingCandidate(options.workspaceRoot);
  const roots = localSkillRootCandidates(options);

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
    })),
  );

  const deduped = new Map<string, SkillRoot>();
  for (const root of roots) {
    const normalized = {
      ...root,
      path: normalizeExistingCandidate(root.path),
    };
    if (!(await pathIsDirectory(normalized.path))) continue;
    deduped.set(rootKey(normalized), normalized);
  }
  return [...deduped.values()];
}

export async function discoverSkillWatchRoots(
  options: LocalSkillsServiceOptions,
): Promise<readonly string[]> {
  const pluginStorageRoot = normalizeExistingCandidate(
    options.pluginStorageRoot,
  );
  const workspaceRoot = normalizeExistingCandidate(options.workspaceRoot);
  const roots = [
    ...localSkillRootCandidates(options).map((root) => root.path),
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

async function isDirectoryEntry(path: string, isSymlink: boolean): Promise<boolean> {
  if (!isSymlink) return true;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function findSkillFiles(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  const topLevelEntries = await readDirEntries(root);
  const queue: Array<{ path: string; depth: number }> = [];

  for (const entry of topLevelEntries) {
    if (out.length >= MAX_SKILL_FILES) break;
    const next = join(root, entry.name);
    if (
      (entry.isDirectory() || entry.isSymbolicLink()) &&
      !SKIP_DIRS.has(entry.name) &&
      (await isDirectoryEntry(next, entry.isSymbolicLink()))
    ) {
      queue.push({ path: next, depth: 1 });
    }
  }

  const visitedDirs = new Set<string>();
  while (queue.length > 0 && out.length < MAX_SKILL_FILES) {
    const frame = queue.shift()!;
    const dirId = await getFileIdentity(frame.path);
    if (dirId && visitedDirs.has(dirId)) continue;
    if (dirId) visitedDirs.add(dirId);

    const entries = await readDirEntries(frame.path);
    for (const entry of entries) {
      if (out.length >= MAX_SKILL_FILES) break;
      const next = join(frame.path, entry.name);
      if (entry.isFile() && isSkillFile(next)) {
        out.push(next);
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (frame.depth + 1 > MAX_SCAN_DEPTH) continue;
      if (!(await isDirectoryEntry(next, entry.isSymbolicLink()))) continue;
      queue.push({ path: next, depth: frame.depth + 1 });
    }
  }

  return out.sort((a, b) => a.localeCompare(b));
}

function isSkillFile(filePath: string): boolean {
  return basename(filePath).toLowerCase() === "skill.md";
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

function splitFrontmatter(raw: string): SplitFrontmatter {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, markdown: raw };
  }
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?([\s\S]*)$/u.exec(raw);
  if (!match) return { frontmatter: {}, markdown: raw };
  try {
    const parsed = loadYaml(match[1] ?? "");
    return {
      frontmatter:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {},
      markdown: match[2] ?? "",
    };
  } catch {
    return { frontmatter: {}, markdown: match[2] ?? raw };
  }
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

async function loadSkillFile(
  filePath: string,
  root: SkillRoot,
): Promise<SkillWithContent | null> {
  if (!(await pathIsFile(filePath))) return null;
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const { frontmatter, markdown } = splitFrontmatter(raw);
  const skillName = skillNameForSkillFile(filePath, root.path);
  if (skillName.length === 0) return null;
  const canonicalFields = parseCanonicalSkillFrontmatterFields(
    frontmatter,
    markdown,
    skillName,
    "Skill",
  );
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
    root: root.path,
    scope: root.scope,
    source: root.source,
    loadedFrom: root.loadedFrom,
    ...(root.pluginRoot !== undefined
      ? { pluginRoot: root.pluginRoot }
      : {}),
    contentLength: markdown.length,
    ...(() => {
      const aliases = implicitAliasesForSkillName(skillName);
      return aliases.length > 0 ? { aliases } : {};
    })(),
  };

  return { skill, content: markdown, filePath };
}

async function loadSkillsFromRoot(root: SkillRoot): Promise<readonly SkillWithContent[]> {
  const files = [...(await findSkillFiles(root.path))];
  // A root can BE one skill: plugin manifests may declare each skill
  // dir individually (skills: ["./skills/flash-board"]), so the root
  // itself carries the SKILL.md instead of holding child skill dirs.
  if (files.length === 0) {
    const leaf = join(root.path, SKILL_FILE_NAME);
    try {
      const stats = await stat(leaf);
      if (stats.isFile()) files.push(leaf);
    } catch {
      // Genuinely empty root.
    }
  }
  const loaded = await Promise.all(files.map((file) => loadSkillFile(file, root)));
  return loaded.filter((entry): entry is SkillWithContent => entry !== null);
}

async function dedupeSkillsByRealPath(
  entries: readonly SkillWithContent[],
): Promise<readonly SkillWithContent[]> {
  const identities = await Promise.all(
    entries.map((entry) => getFileIdentity(entry.filePath)),
  );
  const seen = new Set<string>();
  const out: SkillWithContent[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const identity = identities[i];
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
  const roots = await discoverSkillRoots(options, discoveredSkillRoots);
  const loadedNested = await Promise.all(roots.map(loadSkillsFromRoot));
  const deduped = await dedupeSkillsByRealPath(loadedNested.flat());

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
  const discoveredRoots = new Set(
    discoveredSkillRoots.map(normalizeExistingCandidate),
  );
  const sortedSkills = [...bundled, ...unconditional].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    if (discoveredRoots.has(a.root) && discoveredRoots.has(b.root)) {
      const byDepth = b.root.split(sep).length - a.root.split(sep).length;
      if (byDepth !== 0) return byDepth;
    }
    return a.path.localeCompare(b.path);
  });

  return {
    skills: sortedSkills,
    conditionalSkills: conditional.sort((a, b) => a.name.localeCompare(b.name)),
    skillRoots: unique(roots.map((root) => root.path)).sort((a, b) =>
      a.localeCompare(b)
    ),
    pluginSkillRoots: unique(
      roots.filter((root) => root.scope === "plugin").map((root) => root.path),
    ).sort((a, b) => a.localeCompare(b)),
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
  try {
    raw = await readFile(skill.path, "utf8");
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
  return snapshot.skills.find(
    (skill) => skill.name === normalized || skill.aliases?.includes(normalized),
  );
}

export function formatSkillListingWithinBudget(
  skills: readonly {
    readonly name: string;
    readonly description?: string;
    readonly whenToUse?: string;
    readonly disableModelInvocation?: boolean;
    readonly loadedFrom?: string;
  }[],
  contextWindowTokens?: number,
): string {
  const commands = skills.filter((skill) => !skill.disableModelInvocation);
  if (commands.length === 0) return "";
  const budget = getListingCharBudget(contextWindowTokens);
  const fullEntries = commands.map((skill) => ({
    skill,
    full: formatSkillListingLine(skill),
  }));
  const fullTotal =
    fullEntries.reduce((sum, entry) => sum + entry.full.length, 0) +
    fullEntries.length -
    1;
  if (fullTotal <= budget) {
    return fullEntries.map((entry) => entry.full).join("\n");
  }

  const bundledNames = new Set(
    commands.filter((skill) => skill.loadedFrom === "bundled").map((skill) => skill.name),
  );
  const bundledChars = fullEntries.reduce(
    (sum, entry) => sum + (bundledNames.has(entry.skill.name) ? entry.full.length + 1 : 0),
    0,
  );
  const rest = commands.filter((skill) => !bundledNames.has(skill.name));
  if (rest.length === 0) return fullEntries.map((entry) => entry.full).join("\n");
  const remaining = Math.max(0, budget - bundledChars);
  const overhead =
    rest.reduce((sum, skill) => sum + skill.name.length + 4, 0) + rest.length - 1;
  const maxDescLength = Math.floor((remaining - overhead) / rest.length);
  if (maxDescLength < 20) {
    return commands
      .map((skill) =>
        bundledNames.has(skill.name) ? formatSkillListingLine(skill) : `- ${skill.name}`,
      )
      .join("\n");
  }
  return commands
    .map((skill) => {
      if (bundledNames.has(skill.name)) return formatSkillListingLine(skill);
      const description = getSkillListingDescription(skill);
      return `- ${skill.name}: ${truncate(description, maxDescLength)}`;
    })
    .join("\n");
}

function getListingCharBudget(contextWindowTokens?: number): number {
  const envBudget = Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET);
  if (Number.isFinite(envBudget) && envBudget > 0) return envBudget;
  if (contextWindowTokens && Number.isFinite(contextWindowTokens)) {
    return Math.floor(
      contextWindowTokens * CHARS_PER_TOKEN * SKILL_LISTING_CONTEXT_PERCENT,
    );
  }
  return SKILL_LISTING_DEFAULT_CHAR_BUDGET;
}

function getSkillListingDescription(
  skill: {
    readonly description?: string;
    readonly whenToUse?: string;
    readonly loadedFrom?: string;
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
  return truncate(description, SKILL_LISTING_DESC_MAX_CHARS);
}

function formatSkillListingLine(
  skill: {
    readonly name: string;
    readonly description?: string;
    readonly whenToUse?: string;
    readonly loadedFrom?: string;
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
  let watchedPluginConfigKey = JSON.stringify(options.config ?? null);
  let activePaths = new Set<string>();
  let discoveredSkillRoots = new Set<string>();
  let watcherStarted = false;
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
  const startWatcher = () => {
    if (watcherStarted) return Promise.resolve();
    watcherStarted = true;
    watchedPluginConfigKey = JSON.stringify(lastPluginConfig ?? null);
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
    const nextKey = JSON.stringify(lastPluginConfig ?? null);
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
        activePaths.add(path);
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
      for (const path of touchedPaths) {
        if (activePaths.has(path)) continue;
        activePaths.add(path);
        changed = true;
      }
      for (const dir of dirs) {
        if (discoveredSkillRoots.has(dir)) continue;
        discoveredSkillRoots.add(dir);
        changed = true;
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
        if (await pathIsDirectory(skillDir)) dirs.push(skillDir);
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

Use browser automation to inspect, test, or debug a web UI.

## User Request

${args || "No specific URL or flow was supplied. Ask the user for the URL or app flow to test."}

## Workflow

1. Start or locate the local dev server.
2. Use Playwright/browser tooling to navigate the target flow.
3. Capture screenshots for visual regressions when useful.
4. Report exact failures, console errors, network errors, and UI mismatches.

Do not rely on a visual guess when a DOM assertion, screenshot, or browser console check can verify the result.`;
}

function buildSchedulePrompt(args: string): string {
  return `# Schedule AgenC Agents

Help the user schedule, update, list, or run local AgenC scheduled agent jobs.

Use CronCreate, CronList, and CronDelete. If the user asks for remote cloud-hosted agents, explain that this local runtime only has the local cron surface available.

## User Request

${args || "Ask the user what they want to schedule: create, list, update, or run."}

For create/update requests, collect the cron expression, prompt, timezone, durability, and whether the job should recur before calling the cron tool.`;
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
    description: "Use browser automation to inspect, test, or debug a web UI.",
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
