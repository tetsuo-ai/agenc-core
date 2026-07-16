/**
 * AgenC scoped instruction rules.
 *
 * Uses stricter path handling and a small frontmatter grammar.
 *
 * Rule files live under:
 *   - `/etc/agenc/rules/*.md` for managed rules
 *   - `~/.agenc/rules/*.md` for user rules
 *   - `<project-dir>/.agenc/rules/*.md` for project-scoped rules
 *
 * Frontmatter is optional. With no `paths`/`globs` entries, a rule is
 * unconditional. With patterns, a rule is conditional and applies only
 * when the current trigger path matches.
 *
 * @module
 */

import type { BigIntStats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
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

import { normalizeExternalText } from "../_deps/file-read.js";
import {
  type InstructionFileIdentity,
  instructionFileIdentityKey,
  readInstructionFileSnapshot,
} from "../secure-instruction-file.js";

const RULES_DIRNAME = ".agenc";
const RULES_SUBDIR = "rules";
export const DEFAULT_MANAGED_RULES_DIR = "/etc/agenc/rules";
const MAX_RULE_FILES = 200;
const MAX_RULE_DEPTH = 3;
const MAX_RULE_BYTES = 512 * 1024;
const MAX_RULE_SCAN_ENTRIES = 2_000;
const MAX_RULE_SCAN_DIRECTORIES = 256;

export interface RuleDiscoveryLedger {
  scannedEntries: number;
  scannedDirectories: number;
  openedFiles: number;
  bytesRead: number;
  overflowed: boolean;
}

export type InstructionRuleType = "Managed" | "User" | "Project" | "Local";

export interface InstructionRuleFrontmatter {
  readonly paths: readonly string[];
  readonly globs: readonly string[];
  readonly alwaysApply: boolean;
  readonly description?: string;
  readonly extra: Readonly<Record<string, string>>;
}

export interface InstructionRule {
  readonly path: string;
  readonly type: InstructionRuleType;
  readonly content: string;
  readonly rawContent: string;
  readonly frontmatter: InstructionRuleFrontmatter;
  readonly conditional: boolean;
  readonly mtimeMs: number;
  readonly identity: InstructionFileIdentity;
  readonly sha256: string;
}

export interface RuleDirectorySnapshot {
  readonly path: string;
  readonly identity: InstructionFileIdentity;
}

export interface InstructionRuleDiscovery {
  readonly rules: readonly InstructionRule[];
  /** Every securely opened Markdown candidate, including filtered rules. */
  readonly files: readonly {
    readonly path: string;
    readonly identity: InstructionFileIdentity;
  }[];
  readonly directories: readonly RuleDirectorySnapshot[];
  /** An oversized tree is rejected in full and must never be cached. */
  readonly overflowed: boolean;
}

export interface DiscoverRulesOptions {
  readonly rulesDir: string;
  readonly type: InstructionRuleType;
  /**
   * Boundary all rule files must stay inside after realpath resolution.
   * Defaults to `rulesDir`.
   */
  readonly boundaryDir?: string;
  /**
   * Trigger file path. When provided, conditional rules are matched
   * against it. When absent, only unconditional rules are returned.
   */
  readonly targetPath?: string;
  /** Include unconditional rules. Default true. */
  readonly includeUnconditional?: boolean;
  /** Include conditional rules matching `targetPath`. Default true. */
  readonly includeConditional?: boolean;
  /** Internal compatibility mode: return conditional rules before target matching. */
  readonly includeUnmatchedConditional?: boolean;
  /** Shared envelope-wide resource ledger. */
  readonly resourceLedger?: RuleDiscoveryLedger;
}

interface ParsedRuleFile {
  readonly frontmatter: InstructionRuleFrontmatter;
  readonly body: string;
}

function emptyFrontmatter(): InstructionRuleFrontmatter {
  return {
    paths: [],
    globs: [],
    alwaysApply: false,
    extra: {},
  };
}

function splitInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  return withoutBrackets
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseBoolean(value: string): boolean {
  return /^(true|1|yes|on)$/i.test(value.trim());
}

export function parseRuleFile(raw: string): ParsedRuleFile {
  if (!raw.startsWith("---")) {
    return { frontmatter: emptyFrontmatter(), body: normalizeExternalText(raw).trim() };
  }

  const lines = raw.split("\n");
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) {
    return { frontmatter: emptyFrontmatter(), body: normalizeExternalText(raw).trim() };
  }

  const paths: string[] = [];
  const globs: string[] = [];
  const extra: Record<string, string> = {};
  let alwaysApply = false;
  let description: string | undefined;
  let activeList: "paths" | "globs" | null = null;

  for (const rawLine of lines.slice(1, closeIdx)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const listItem = line.match(/^-\s+(.+)$/);
    if (listItem && activeList !== null) {
      const value = listItem[1]!.trim().replace(/^["']|["']$/g, "");
      if (value.length > 0) {
        if (activeList === "paths") paths.push(value);
        else globs.push(value);
      }
      continue;
    }

    const colon = line.indexOf(":");
    if (colon <= 0) {
      activeList = null;
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    activeList = null;

    switch (key) {
      case "paths":
        paths.push(...splitInlineList(value));
        activeList = value.length === 0 ? "paths" : null;
        break;
      case "globs":
        globs.push(...splitInlineList(value));
        activeList = value.length === 0 ? "globs" : null;
        break;
      case "alwaysApply":
        alwaysApply = parseBoolean(value);
        break;
      case "description":
        description = value.replace(/^["']|["']$/g, "");
        break;
      default:
        extra[key] = value.replace(/^["']|["']$/g, "");
        break;
    }
  }

  const body = normalizeExternalText(lines.slice(closeIdx + 1).join("\n")).trim();
  return {
    frontmatter: {
      paths,
      globs,
      alwaysApply,
      ...(description !== undefined ? { description } : {}),
      extra,
    },
    body,
  };
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

async function hasSymlinkComponentBelowBoundary(
  boundary: string,
  candidate: string,
): Promise<boolean> {
  const rel = relative(resolve(boundary), resolve(candidate));
  if (rel === "") return false;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true;
  let current = resolve(boundary);
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    const stats = await lstat(current, { bigint: true });
    if (stats.isSymbolicLink()) return true;
  }
  return false;
}

function escapeRegex(input: string): string {
  return input.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.split(/[\\/]+/).join("/");
  let out = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        i += 1;
        if (normalized[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += escapeRegex(ch);
  }
  out += "$";
  return new RegExp(out);
}

function normalizePathForMatch(path: string): string {
  return path.split(/[\\/]+/).join("/");
}

function findScopedRulesRoot(rulePath: string): string | null {
  let current = dirname(rulePath);
  while (true) {
    if (
      basename(current) === RULES_SUBDIR &&
      basename(dirname(current)) === RULES_DIRNAME
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function matchBaseForRule(rulePath: string): string {
  const rulesRoot = findScopedRulesRoot(rulePath);
  if (rulesRoot !== null) {
    return dirname(dirname(rulesRoot));
  }

  const ruleBase = dirname(dirname(rulePath));
  return dirname(ruleBase);
}

export function ruleMatchesTarget(
  rulePath: string,
  frontmatter: InstructionRuleFrontmatter,
  targetPath: string,
): boolean {
  const projectBase = matchBaseForRule(rulePath);
  const absTarget = resolve(targetPath);
  const candidates = new Set<string>([
    normalizePathForMatch(absTarget),
    normalizePathForMatch(relative(projectBase, absTarget)),
    normalizePathForMatch(relative(dirname(rulePath), absTarget)),
    basename(absTarget),
  ]);

  for (const pathPattern of frontmatter.paths) {
    const normalizedPattern = normalizePathForMatch(pathPattern);
    for (const candidate of candidates) {
      if (candidate === normalizedPattern) return true;
      if (candidate.startsWith(`${normalizedPattern.replace(/\/+$/, "")}/`)) {
        return true;
      }
    }
  }

  for (const glob of frontmatter.globs) {
    const regex = globToRegExp(glob);
    for (const candidate of candidates) {
      if (regex.test(candidate)) return true;
    }
  }

  return false;
}

function isRuleConditional(frontmatter: InstructionRuleFrontmatter): boolean {
  return frontmatter.paths.length > 0 || frontmatter.globs.length > 0;
}

function directoryIdentity(stats: BigIntStats): InstructionFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

/**
 * Bounded, fail-closed rule-tree enumeration.
 *
 * Node's recursive readdir materializes the entire repository-controlled tree
 * before a caller can enforce limits. This walker consumes directory entries
 * incrementally, rejects symlinks, caps all entries (not only Markdown files),
 * and verifies every visited directory remained the same object for the whole
 * scan. Trees over the cap are rejected instead of returning a filesystem-order
 * dependent prefix.
 */
export async function scanInstructionRulePaths(opts: {
  readonly rulesDir: string;
  readonly boundaryDir?: string;
  readonly resourceLedger?: RuleDiscoveryLedger;
}): Promise<{
  readonly paths: readonly string[];
  readonly files: readonly RuleDirectorySnapshot[];
  readonly directories: readonly RuleDirectorySnapshot[];
  readonly overflowed: boolean;
}> {
  const rulesRoot = resolve(opts.rulesDir);
  const boundary = resolve(opts.boundaryDir ?? opts.rulesDir);
  const ledger = opts.resourceLedger ?? {
    scannedEntries: 0,
    scannedDirectories: 0,
    openedFiles: 0,
    bytesRead: 0,
    overflowed: false,
  };
  if (ledger.overflowed) {
    return { paths: [], files: [], directories: [], overflowed: true };
  }
  let canonicalBoundary: string;
  try {
    canonicalBoundary = await realpath(boundary);
    if (
      !isPathInside(rulesRoot, boundary) ||
      await hasSymlinkComponentBelowBoundary(boundary, rulesRoot)
    ) {
      return { paths: [], files: [], directories: [], overflowed: false };
    }
  } catch {
    return { paths: [], files: [], directories: [], overflowed: false };
  }

  try {
    const rootStats = await lstat(rulesRoot, { bigint: true });
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      return { paths: [], files: [], directories: [], overflowed: false };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { paths: [], files: [], directories: [], overflowed: false };
    }
    ledger.overflowed = true;
    return { paths: [], files: [], directories: [], overflowed: true };
  }

  const queue: Array<{ path: string; depth: number }> = [{ path: rulesRoot, depth: 0 }];
  const directories: RuleDirectorySnapshot[] = [];
  const paths: string[] = [];
  const files: RuleDirectorySnapshot[] = [];
  let scannedEntries = 0;

  try {
    while (queue.length > 0) {
      const current = queue.shift()!;
      ledger.scannedDirectories += 1;
      if (ledger.scannedDirectories > MAX_RULE_SCAN_DIRECTORIES) {
        ledger.overflowed = true;
        return { paths: [], files: [], directories: [], overflowed: true };
      }
      const before = await lstat(current.path, { bigint: true });
      if (before.isSymbolicLink() || !before.isDirectory()) {
        if (current.depth === 0) {
          return { paths: [], files: [], directories: [], overflowed: false };
        }
        continue;
      }
      const canonicalDirectory = await realpath(current.path);
      if (!isPathInside(canonicalDirectory, canonicalBoundary)) {
        if (current.depth === 0) {
          return { paths: [], files: [], directories: [], overflowed: false };
        }
        continue;
      }

      const entries: Array<{ name: string; path: string }> = [];
      const handle = await opendir(current.path, { bufferSize: 32 });
      for await (const entry of handle) {
        scannedEntries += 1;
        ledger.scannedEntries += 1;
        if (
          scannedEntries > MAX_RULE_SCAN_ENTRIES ||
          ledger.scannedEntries > MAX_RULE_SCAN_ENTRIES
        ) {
          ledger.overflowed = true;
          return { paths: [], files: [], directories: [], overflowed: true };
        }
        entries.push({ name: entry.name, path: join(current.path, entry.name) });
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      directories.push({ path: current.path, identity: directoryIdentity(before) });

      for (const entry of entries) {
        const stats = await lstat(entry.path, { bigint: true });
        if (stats.isSymbolicLink()) continue;
        if (stats.isDirectory()) {
          if (current.depth + 1 < MAX_RULE_DEPTH) {
            queue.push({ path: entry.path, depth: current.depth + 1 });
          }
          continue;
        }
        if (stats.isFile() && entry.name.endsWith(".md")) {
          paths.push(entry.path);
          files.push({ path: entry.path, identity: directoryIdentity(stats) });
        }
      }
    }

    // Detect directory replacement or mutation at any point during traversal.
    for (const directory of directories) {
      const after = await lstat(directory.path, { bigint: true });
      if (
        after.isSymbolicLink() ||
        !after.isDirectory() ||
        instructionFileIdentityKey(directoryIdentity(after)) !==
          instructionFileIdentityKey(directory.identity)
      ) {
        ledger.overflowed = true;
        return { paths: [], files: [], directories: [], overflowed: true };
      }
    }
  } catch {
    ledger.overflowed = true;
    return { paths: [], files: [], directories: [], overflowed: true };
  }

  if (files.length > MAX_RULE_FILES) {
    ledger.overflowed = true;
    return { paths: [], files, directories, overflowed: true };
  }

  return {
    paths: paths.sort((left, right) => left.localeCompare(right)),
    files,
    directories,
    overflowed: false,
  };
}

export async function discoverInstructionRules(
  opts: DiscoverRulesOptions,
): Promise<readonly InstructionRule[]> {
  return (await discoverInstructionRulesDetailed(opts)).rules;
}

export async function discoverInstructionRulesDetailed(
  opts: DiscoverRulesOptions,
): Promise<InstructionRuleDiscovery> {
  const includeUnconditional = opts.includeUnconditional ?? true;
  const includeConditional = opts.includeConditional ?? true;
  const boundary = opts.boundaryDir ?? opts.rulesDir;
  const scan = await scanInstructionRulePaths({
    rulesDir: opts.rulesDir,
    ...(opts.boundaryDir !== undefined ? { boundaryDir: opts.boundaryDir } : {}),
    ...(opts.resourceLedger !== undefined
      ? { resourceLedger: opts.resourceLedger }
      : {}),
  });
  if (scan.overflowed) {
    return { rules: [], files: scan.files, directories: scan.directories, overflowed: true };
  }

  const out: InstructionRule[] = [];
  const fileEvidence = new Map(
    scan.files.map((file) => [file.path, file] as const),
  );
  const ledger = opts.resourceLedger ?? {
    scannedEntries: 0,
    scannedDirectories: 0,
    openedFiles: 0,
    bytesRead: 0,
    overflowed: false,
  };
  for (const filePath of scan.paths) {
    if (ledger.openedFiles >= MAX_RULE_FILES || ledger.bytesRead >= MAX_RULE_BYTES) {
      ledger.overflowed = true;
      break;
    }
    ledger.openedFiles += 1;
    const read = await readInstructionFileSnapshot({
      requestedPath: filePath,
      boundaryRoot: boundary,
      workspaceRoot: boundary,
      sourceClass: "rule",
      maximumBytes: MAX_RULE_BYTES - ledger.bytesRead,
    });
    if (!read.ok) continue;
    fileEvidence.delete(filePath);
    fileEvidence.set(read.snapshot.canonicalPath, {
      path: read.snapshot.canonicalPath,
      identity: read.snapshot.identity,
    });
    const raw = read.snapshot.text;
    ledger.bytesRead += Buffer.byteLength(raw, "utf8");

    const parsed = parseRuleFile(raw);
    if (parsed.body.length === 0) continue;
    const hasConditions = isRuleConditional(parsed.frontmatter);
    const conditional = hasConditions && !parsed.frontmatter.alwaysApply;
    const unconditional = !conditional;
    const matches =
      hasConditions &&
      opts.targetPath !== undefined &&
      (opts.type !== "Project" ||
        isPathInside(resolve(opts.targetPath), resolve(boundary))) &&
      ruleMatchesTarget(filePath, parsed.frontmatter, opts.targetPath);

    if (unconditional) {
      if (!includeUnconditional) continue;
    } else {
      if (!includeConditional) continue;
      if (!matches && !opts.includeUnmatchedConditional) continue;
    }

    out.push({
      path: filePath,
      type: opts.type,
      content: parsed.body,
      rawContent: raw,
      frontmatter: parsed.frontmatter,
      conditional,
      mtimeMs: Number(read.snapshot.identity.mtimeNs) / 1_000_000,
      identity: read.snapshot.identity,
      sha256: read.snapshot.sha256,
    });
  }

  if (ledger.overflowed) {
    return {
      rules: [],
      files: [...fileEvidence.values()],
      directories: scan.directories,
      overflowed: true,
    };
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return {
    rules: out,
    files: [...fileEvidence.values()],
    directories: scan.directories,
    overflowed: false,
  };
}

export function projectRulesDir(dir: string): string {
  return join(dir, RULES_DIRNAME, RULES_SUBDIR);
}

export function userRulesDir(homeDir: string = homedir()): string {
  return join(homeDir, ".agenc", RULES_SUBDIR);
}

export function formatRulesBlock(rules: readonly InstructionRule[]): string {
  if (rules.length === 0) return "";
  return rules
    .map((rule) => {
      const matchLine =
        rule.frontmatter.paths.length > 0 || rule.frontmatter.globs.length > 0
          ? `\nmatch: ${[...rule.frontmatter.paths, ...rule.frontmatter.globs].join(", ")}`
          : "";
      return `--- ${rule.type.toLowerCase()} rule (${rule.path}) ---${matchLine}\n\n${rule.content}`;
    })
    .join("\n\n");
}
