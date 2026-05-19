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

import { readdir, readFile, realpath, stat } from "node:fs/promises";
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

const RULES_DIRNAME = ".agenc";
const RULES_SUBDIR = "rules";
export const DEFAULT_MANAGED_RULES_DIR = "/etc/agenc/rules";
const MAX_RULE_FILES = 200;
const MAX_RULE_DEPTH = 3;
const MAX_RULE_BYTES = 512 * 1024;

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
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

async function realpathInside(path: string, boundary: string): Promise<boolean> {
  try {
    const [realCandidate, realBoundary] = await Promise.all([
      realpath(path),
      realpath(boundary),
    ]);
    return isPathInside(realCandidate, realBoundary);
  } catch {
    return false;
  }
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

export function ruleMatchesTarget(
  rulePath: string,
  frontmatter: InstructionRuleFrontmatter,
  targetPath: string,
): boolean {
  const ruleBase = dirname(dirname(rulePath)); // <dir>/.agenc/rules/file.md -> <dir>/.agenc
  const projectBase = dirname(ruleBase);
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

export async function discoverInstructionRules(
  opts: DiscoverRulesOptions,
): Promise<readonly InstructionRule[]> {
  const includeUnconditional = opts.includeUnconditional ?? true;
  const includeConditional = opts.includeConditional ?? true;
  const boundary = opts.boundaryDir ?? opts.rulesDir;
  let entries: string[];
  try {
    entries = await readdir(opts.rulesDir, { recursive: true });
  } catch {
    return [];
  }

  const mdFiles = entries
    .filter((rel) => {
      if (!rel.endsWith(".md")) return false;
      const depth = rel.split(sep).length - 1;
      if (depth >= MAX_RULE_DEPTH) return false;
      return true;
    })
    .slice(0, MAX_RULE_FILES);

  const out: InstructionRule[] = [];
  let bytesRead = 0;
  for (const rel of mdFiles) {
    const filePath = join(opts.rulesDir, rel);
    if (!(await realpathInside(filePath, boundary))) continue;
    let raw: string;
    let st;
    try {
      st = await stat(filePath);
      if (!st.isFile()) continue;
      raw = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    bytesRead += Buffer.byteLength(raw, "utf8");
    if (bytesRead > MAX_RULE_BYTES) break;

    const parsed = parseRuleFile(raw);
    if (parsed.body.length === 0) continue;
    const conditional = isRuleConditional(parsed.frontmatter);
    const unconditional = parsed.frontmatter.alwaysApply || !conditional;
    const matches =
      conditional &&
      opts.targetPath !== undefined &&
      ruleMatchesTarget(filePath, parsed.frontmatter, opts.targetPath);

    if (!includeUnconditional && unconditional) continue;
    if (!includeConditional && conditional) continue;
    if (!unconditional && !matches) continue;

    out.push({
      path: filePath,
      type: opts.type,
      content: parsed.body,
      rawContent: raw,
      frontmatter: parsed.frontmatter,
      conditional,
      mtimeMs: st.mtimeMs,
    });
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
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
