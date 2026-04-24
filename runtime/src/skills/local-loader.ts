import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { AgenCConfig } from "../config/index.js";
import type { SessionServices } from "../session/session.js";
import type { SkillLoadOutcome } from "../session/turn-context.js";

export type LocalSkillScope = "user" | "project" | "plugin";

export interface LocalSkillMetadata {
  readonly name: string;
  readonly description?: string;
  readonly path: string;
  readonly root: string;
  readonly scope: LocalSkillScope;
}

export interface LocalSkillsSnapshot {
  readonly skills: readonly LocalSkillMetadata[];
  readonly skillRoots: readonly string[];
  readonly pluginSkillRoots: readonly string[];
}

export interface LocalSkillsServiceOptions {
  readonly agencHome: string;
  readonly workspaceRoot: string;
  readonly env?: Partial<Pick<NodeJS.ProcessEnv, "HOME" | "CODEX_HOME">>;
}

interface SkillRoot {
  readonly path: string;
  readonly scope: LocalSkillScope;
}

const SKILL_FILE_NAME = "SKILL.md";
const MAX_SKILL_FILES = 250;
const MAX_SCAN_DEPTH = 4;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
]);

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeExistingCandidate(path: string): string {
  return resolve(path);
}

function rootKey(root: SkillRoot): string {
  return `${root.scope}:${root.path}`;
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

async function collectPluginSkillRoots(
  baseDir: string,
): Promise<readonly string[]> {
  if (!(await pathIsDirectory(baseDir))) return [];
  const roots: string[] = [];
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const candidate = join(baseDir, entry.name, "skills");
    if (await pathIsDirectory(candidate)) {
      roots.push(normalizeExistingCandidate(candidate));
    }
  }
  return roots;
}

export async function discoverSkillRoots(
  options: LocalSkillsServiceOptions,
): Promise<readonly SkillRoot[]> {
  const home = options.env?.HOME;
  const codexHome = options.env?.CODEX_HOME ?? (home ? join(home, ".codex") : "");
  const agencHome = normalizeExistingCandidate(options.agencHome);
  const workspaceRoot = normalizeExistingCandidate(options.workspaceRoot);

  const roots: SkillRoot[] = [
    { path: join(workspaceRoot, ".agents", "skills"), scope: "project" },
    { path: join(workspaceRoot, ".codex", "skills"), scope: "project" },
    { path: join(workspaceRoot, ".agenc", "skills"), scope: "project" },
    { path: join(agencHome, "skills"), scope: "user" },
  ];

  if (codexHome.length > 0) {
    roots.push({ path: join(codexHome, "skills"), scope: "user" });
  }

  const pluginRoots = [
    ...(await collectPluginSkillRoots(join(agencHome, "plugins"))),
    ...(await collectPluginSkillRoots(join(workspaceRoot, ".agents", "plugins"))),
  ];
  roots.push(...pluginRoots.map((path) => ({ path, scope: "plugin" as const })));

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

async function findSkillFiles(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];

  while (queue.length > 0 && out.length < MAX_SKILL_FILES) {
    const frame = queue.shift()!;
    let entries;
    try {
      entries = await readdir(frame.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (out.length >= MAX_SKILL_FILES) break;
      const next = join(frame.path, entry.name);
      if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
        out.push(next);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (frame.depth + 1 > MAX_SCAN_DEPTH) continue;
      queue.push({ path: next, depth: frame.depth + 1 });
    }
  }

  return out;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatter(raw: string): Record<string, string> {
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = raw.slice(3, end).split(/\r?\n/u);
  const out: Record<string, string> = {};
  for (const line of block) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u.exec(line);
    if (!match) continue;
    out[match[1]!.trim()] = unquote(match[2] ?? "");
  }
  return out;
}

function descriptionFromMarkdown(raw: string): string | undefined {
  const end = raw.startsWith("---") ? raw.indexOf("\n---", 3) : -1;
  const withoutFrontmatter = end === -1 ? raw : raw.slice(end + 4);
  for (const line of withoutFrontmatter.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    return trimmed.slice(0, 240);
  }
  return undefined;
}

function fallbackSkillName(filePath: string): string {
  const parent = basename(dirname(filePath));
  return parent === "skills" ? basename(dirname(dirname(filePath))) : parent;
}

async function loadSkillMetadata(
  filePath: string,
  root: SkillRoot,
): Promise<LocalSkillMetadata | null> {
  if (!isAbsolute(filePath) || !filePath.split(sep).includes("skills")) {
    return null;
  }
  if (!(await pathIsFile(filePath))) return null;
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(raw);
  const name = (frontmatter.name ?? fallbackSkillName(filePath)).trim();
  if (name.length === 0) return null;
  const description =
    frontmatter.description?.trim() || descriptionFromMarkdown(raw);

  return {
    name,
    ...(description ? { description } : {}),
    path: filePath,
    root: root.path,
    scope: root.scope,
  };
}

export async function loadLocalSkillsSnapshot(
  options: LocalSkillsServiceOptions,
): Promise<LocalSkillsSnapshot> {
  const roots = await discoverSkillRoots(options);
  const skills: LocalSkillMetadata[] = [];

  for (const root of roots) {
    const files = await findSkillFiles(root.path);
    for (const file of files) {
      const skill = await loadSkillMetadata(file, root);
      if (skill) skills.push(skill);
    }
  }

  const deduped = new Map<string, LocalSkillMetadata>();
  for (const skill of skills) {
    deduped.set(`${skill.name}:${skill.path}`, skill);
  }

  const sortedSkills = [...deduped.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );

  return {
    skills: sortedSkills,
    skillRoots: unique(roots.map((root) => root.path)).sort((a, b) =>
      a.localeCompare(b),
    ),
    pluginSkillRoots: unique(
      roots.filter((root) => root.scope === "plugin").map((root) => root.path),
    ).sort((a, b) => a.localeCompare(b)),
  };
}

export function createLocalSkillsServices(
  options: LocalSkillsServiceOptions,
): Pick<
  SessionServices,
  "skillsManager" | "pluginsManager" | "skillsWatcher"
> {
  let cache: Promise<LocalSkillsSnapshot> | null = null;
  const load = (): Promise<LocalSkillsSnapshot> => {
    cache ??= loadLocalSkillsSnapshot(options);
    return cache;
  };
  const clear = () => {
    cache = null;
  };

  return {
    skillsManager: {
      async skillsForConfig(_input: AgenCConfig | unknown): Promise<SkillLoadOutcome> {
        const snapshot = await load();
        return {
          invokedSkills: snapshot.skills.map((skill) => skill.name),
          availableSkills: snapshot.skills,
        };
      },
    },
    pluginsManager: {
      async pluginsForConfig() {
        const snapshot = await load();
        return {
          effectiveSkillRoots: () => snapshot.pluginSkillRoots,
        };
      },
    },
    skillsWatcher: {
      start: clear,
    },
  };
}
