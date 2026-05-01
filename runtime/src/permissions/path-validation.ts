/**
 * Ports upstream `src/utils/permissions/pathValidation.ts` onto AgenC's
 * permission primitives.
 *
 * Shape differences from upstream:
 *   - The live runtime stores working roots outside `ToolPermissionContext`,
 *     so callers pass `cwd` and optional extra working roots explicitly.
 *   - Rule matching maps upstream read/edit permission types onto AgenC's
 *     visible `FileRead`, `Read`, `Edit`, and `Write` tool names.
 *   - OS sandbox allowlist integration is not carried because AgenC's current
 *     sandbox layer is policy math only; executable sandbox enforcement lives
 *     in the tool/runtime boundary.
 */

import {
  lstatSync,
  realpathSync,
  readlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  getRuleByContentsForTool,
} from "./rules.js";
import type {
  PermissionDecisionReason,
  PermissionResult,
  PermissionRule,
  PermissionUpdate,
  ToolPermissionContext,
} from "./types.js";

const MAX_DIRS_TO_LIST = 5;
const GLOB_PATTERN_REGEX = /[*?[\]{}]/;
const WINDOWS_DRIVE_ROOT_REGEX = /^[A-Za-z]:\/?$/;
const WINDOWS_DRIVE_CHILD_REGEX = /^[A-Za-z]:\/[^/]+$/;
const MAX_PATH_LENGTH = 4096;

export type FileOperationType = "read" | "write" | "create";

export interface PathCheckResult {
  readonly allowed: boolean;
  readonly decisionReason?: PermissionDecisionReason;
}

export interface ResolvedPathCheckResult extends PathCheckResult {
  readonly resolvedPath: string;
  readonly suggestions?: readonly PermissionUpdate[];
}

export interface ValidatePathOptions {
  readonly extraWorkingDirectories?: readonly string[];
}

export interface ToolPathPermissionOptions {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly path: string;
  readonly cwd: string;
  readonly context: ToolPermissionContext;
  readonly operationType: FileOperationType;
  readonly extraWorkingDirectories?: readonly string[];
}

export function formatDirectoryList(directories: string[]): string {
  const dirCount = directories.length;
  if (dirCount <= MAX_DIRS_TO_LIST) {
    return directories.map((dir) => `'${dir}'`).join(", ");
  }
  const firstDirs = directories
    .slice(0, MAX_DIRS_TO_LIST)
    .map((dir) => `'${dir}'`)
    .join(", ");
  return `${firstDirs}, and ${dirCount - MAX_DIRS_TO_LIST} more`;
}

export function getGlobBaseDirectory(path: string): string {
  const globMatch = path.match(GLOB_PATTERN_REGEX);
  if (!globMatch || globMatch.index === undefined) {
    return path;
  }

  const beforeGlob = path.substring(0, globMatch.index);
  const lastSepIndex =
    process.platform === "win32"
      ? Math.max(beforeGlob.lastIndexOf("/"), beforeGlob.lastIndexOf("\\"))
      : beforeGlob.lastIndexOf("/");
  if (lastSepIndex === -1) return ".";
  return beforeGlob.substring(0, lastSepIndex) || "/";
}

export function expandTilde(path: string): string {
  if (
    path === "~" ||
    path.startsWith("~/") ||
    (process.platform === "win32" && path.startsWith("~\\"))
  ) {
    return homedir() + path.slice(1);
  }
  return path;
}

function containsPathTraversal(path: string): boolean {
  if (path.includes("\0") || /%2f|%5c|%00/i.test(path)) return true;
  return path.split(/[/\\]+/).some((segment) => segment === "..");
}

function containsVulnerableUncPath(path: string): boolean {
  return path.startsWith("\\\\") || path.startsWith("//");
}

function normalizeSlashes(path: string): string {
  return path.replace(/[\\/]+/g, "/");
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = normalize(candidate).normalize("NFC");
  const normalizedRoot = normalize(root).normalize("NFC");
  if (normalizedCandidate === normalizedRoot) return true;
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function resolveExistingAncestor(filePath: string): {
  readonly resolvedPath: string;
  readonly isCanonical: boolean;
} {
  const absolute = resolve(filePath);
  try {
    const stats = lstatSync(absolute);
    if (stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice()) {
      return { resolvedPath: absolute, isCanonical: false };
    }
    return { resolvedPath: realpathSync(absolute), isCanonical: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return { resolvedPath: absolute, isCanonical: false };
    }
  }

  const segments: string[] = [];
  let current = absolute;
  while (true) {
    segments.unshift(current.split(/[\\/]/).pop() ?? "");
    const parent = dirname(current);
    if (parent === current) {
      return { resolvedPath: absolute, isCanonical: false };
    }
    current = parent;
    try {
      const parentReal = realpathSync(current);
      return {
        resolvedPath: resolve(parentReal, ...segments),
        isCanonical: false,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        return { resolvedPath: absolute, isCanonical: false };
      }
    }
  }
}

function safeResolvePath(filePath: string): {
  readonly resolvedPath: string;
  readonly isCanonical: boolean;
} {
  return resolveExistingAncestor(filePath);
}

function getPathsForPermissionCheck(filePath: string): readonly string[] {
  const { resolvedPath } = safeResolvePath(filePath);
  const out = [resolvedPath.normalize("NFC")];

  try {
    const linkTarget = readlinkSync(filePath);
    const absoluteTarget = isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(filePath), linkTarget);
    const { resolvedPath: resolvedTarget } = safeResolvePath(absoluteTarget);
    if (!out.includes(resolvedTarget)) out.push(resolvedTarget.normalize("NFC"));
  } catch {
    // Non-symlink and unreadable symlink cases fall back to the resolved path.
  }

  return out;
}

function workingDirectories(
  cwd: string,
  context: ToolPermissionContext,
  extraWorkingDirectories: readonly string[] | undefined,
): readonly string[] {
  const dirs = new Set<string>();
  dirs.add(resolve(cwd));
  for (const entry of context.additionalWorkingDirectories.values()) {
    if (entry.path.length > 0) dirs.add(resolve(entry.path));
  }
  for (const entry of extraWorkingDirectories ?? []) {
    if (entry.length > 0) dirs.add(resolve(entry));
  }
  return [...dirs];
}

function pathInAllowedWorkingPath(
  resolvedPath: string,
  context: ToolPermissionContext,
  cwd: string,
  precomputedPathsToCheck?: readonly string[],
  extraWorkingDirectories?: readonly string[],
): boolean {
  const pathsToCheck = precomputedPathsToCheck ?? getPathsForPermissionCheck(resolvedPath);
  const dirs = workingDirectories(cwd, context, extraWorkingDirectories);
  return pathsToCheck.every((candidate) =>
    dirs.some((dir) => isPathInside(candidate, dir)),
  );
}

function toolNamesForOperation(
  operationType: FileOperationType,
): readonly string[] {
  return operationType === "read"
    ? ["FileRead", "Read"]
    : ["Edit", "Write"];
}

function wildcardPatternToRegExp(pattern: string): RegExp {
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        body += ".*";
        i++;
      } else {
        body += "[^/\\\\]*";
      }
      continue;
    }
    if (char === "?") {
      body += "[^/\\\\]";
      continue;
    }
    body += char.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
  }
  return new RegExp(`^${body}$`);
}

function matchPathRuleContent(ruleContent: string, filePath: string): boolean {
  const expandedRule = normalizeSlashes(expandTilde(ruleContent));
  const expandedPath = normalizeSlashes(filePath);
  if (expandedRule === expandedPath) return true;
  if (expandedRule.endsWith("/**")) {
    const root = expandedRule.slice(0, -3).replace(/\/$/, "");
    return expandedPath === root || expandedPath.startsWith(`${root}/`);
  }
  if (GLOB_PATTERN_REGEX.test(expandedRule)) {
    return wildcardPatternToRegExp(expandedRule).test(expandedPath);
  }
  return false;
}

function matchingRuleForPath(
  filePath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  behavior: "allow" | "ask" | "deny",
): PermissionRule | null {
  const pathsToCheck = getPathsForPermissionCheck(filePath);
  for (const toolName of toolNamesForOperation(operationType)) {
    const rules = getRuleByContentsForTool(context, toolName, behavior);
    for (const [content, rule] of rules) {
      if (
        pathsToCheck.some((candidate) =>
          matchPathRuleContent(content, candidate),
        )
      ) {
        return rule;
      }
    }
  }
  return null;
}

function isProtectedRuntimePath(resolvedPath: string): string | null {
  const normalizedPath = normalizeSlashes(resolvedPath);
  const segments = normalizedPath.split("/");
  if (segments.includes(".git")) return ".git paths require manual approval";
  if (segments.includes(".agenc")) return ".agenc paths require manual approval";
  if (segments.includes(".agents")) return ".agents paths require manual approval";
  return null;
}

function checkPathSafetyForAutoEdit(
  resolvedPath: string,
  precomputedPathsToCheck?: readonly string[],
): { readonly safe: true } | {
  readonly safe: false;
  readonly message: string;
  readonly classifierApprovable: boolean;
} {
  const pathsToCheck = precomputedPathsToCheck ?? getPathsForPermissionCheck(resolvedPath);
  for (const pathToCheck of pathsToCheck) {
    const protectedReason = isProtectedRuntimePath(pathToCheck);
    if (protectedReason !== null) {
      return {
        safe: false,
        message: protectedReason,
        classifierApprovable: false,
      };
    }
    const slashPath = normalizeSlashes(pathToCheck);
    if (/\.\.\./.test(slashPath) || /:[^/\\]/.test(slashPath.replace(/^[A-Za-z]:/, ""))) {
      return {
        safe: false,
        message: "Suspicious path syntax requires manual approval",
        classifierApprovable: false,
      };
    }
  }
  return { safe: true };
}

export function isDangerousRemovalPath(resolvedPath: string): boolean {
  const forwardSlashed = normalizeSlashes(resolvedPath);
  if (forwardSlashed === "*" || forwardSlashed.endsWith("/*")) {
    return true;
  }

  const normalizedPath =
    forwardSlashed === "/" ? forwardSlashed : forwardSlashed.replace(/\/$/, "");
  if (normalizedPath === "/") return true;
  if (WINDOWS_DRIVE_ROOT_REGEX.test(normalizedPath)) return true;

  const normalizedHome = normalizeSlashes(homedir());
  if (normalizedPath === normalizedHome) return true;

  if (dirname(normalizedPath) === "/") return true;
  if (WINDOWS_DRIVE_CHILD_REGEX.test(normalizedPath)) return true;

  return false;
}

export function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  cwd = process.cwd(),
  precomputedPathsToCheck?: readonly string[],
  options: ValidatePathOptions = {},
): PathCheckResult {
  const permissionOperation = operationType === "read" ? "read" : "write";

  const denyRule = matchingRuleForPath(
    resolvedPath,
    context,
    operationType,
    "deny",
  );
  if (denyRule !== null) {
    return {
      allowed: false,
      decisionReason: { type: "rule", rule: denyRule },
    };
  }

  if (operationType !== "read") {
    const safetyCheck = checkPathSafetyForAutoEdit(
      resolvedPath,
      precomputedPathsToCheck,
    );
    if (!safetyCheck.safe) {
      return {
        allowed: false,
        decisionReason: {
          type: "safetyCheck",
          reason: safetyCheck.message,
          classifierApprovable: safetyCheck.classifierApprovable,
        },
      };
    }
  }

  const isInWorkingDir = pathInAllowedWorkingPath(
    resolvedPath,
    context,
    cwd,
    precomputedPathsToCheck,
    options.extraWorkingDirectories,
  );
  if (isInWorkingDir) {
    if (operationType === "read" || context.mode === "acceptEdits") {
      return {
        allowed: true,
        decisionReason: {
          type: "mode",
          mode: context.mode,
        },
      };
    }
  }

  const askRule = matchingRuleForPath(
    resolvedPath,
    context,
    operationType,
    "ask",
  );
  if (askRule !== null) {
    return {
      allowed: false,
      decisionReason: { type: "rule", rule: askRule },
    };
  }

  const allowRule = matchingRuleForPath(
    resolvedPath,
    context,
    operationType,
    "allow",
  );
  if (allowRule !== null) {
    return {
      allowed: true,
      decisionReason: { type: "rule", rule: allowRule },
    };
  }

  return {
    allowed: false,
    decisionReason: {
      type: "workingDir",
      reason: `Path is outside allowed working directories for ${permissionOperation}`,
    },
  };
}

export function validateGlobPattern(
  cleanPath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
  options: ValidatePathOptions = {},
): ResolvedPathCheckResult {
  if (containsPathTraversal(cleanPath)) {
    const absolutePath = isAbsolute(cleanPath)
      ? cleanPath
      : resolve(cwd, cleanPath);
    const { resolvedPath, isCanonical } = safeResolvePath(absolutePath);
    const result = isPathAllowed(
      resolvedPath,
      toolPermissionContext,
      operationType,
      cwd,
      isCanonical ? [resolvedPath] : undefined,
      options,
    );
    return {
      allowed: result.allowed,
      resolvedPath,
      decisionReason: result.decisionReason,
    };
  }

  const basePath = getGlobBaseDirectory(cleanPath);
  const absoluteBasePath = isAbsolute(basePath)
    ? basePath
    : resolve(cwd, basePath);
  const { resolvedPath, isCanonical } = safeResolvePath(absoluteBasePath);
  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    cwd,
    isCanonical ? [resolvedPath] : undefined,
    options,
  );
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  };
}

export function validatePath(
  path: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
  options: ValidatePathOptions = {},
): ResolvedPathCheckResult {
  const cleanPath = expandTilde(path.replace(/^['"]|['"]$/g, ""));

  if (containsVulnerableUncPath(cleanPath)) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: "other",
        reason: "UNC network paths require manual approval",
      },
    };
  }

  if (cleanPath.startsWith("~")) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: "other",
        reason:
          "Tilde expansion variants (~user, ~+, ~-) in paths require manual approval",
      },
    };
  }

  if (
    cleanPath.includes("$") ||
    cleanPath.includes("%") ||
    cleanPath.startsWith("=")
  ) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: "other",
        reason: "Shell expansion syntax in paths requires manual approval",
      },
    };
  }

  if (resolve(cwd, cleanPath).length > MAX_PATH_LENGTH) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: "other",
        reason: "Path exceeds maximum length",
      },
    };
  }

  if (GLOB_PATTERN_REGEX.test(cleanPath)) {
    if (operationType === "write" || operationType === "create") {
      return {
        allowed: false,
        resolvedPath: cleanPath,
        decisionReason: {
          type: "other",
          reason:
            "Glob patterns are not allowed in write operations. Please specify an exact file path.",
        },
      };
    }
    return validateGlobPattern(
      cleanPath,
      cwd,
      toolPermissionContext,
      operationType,
      options,
    );
  }

  const absolutePath = isAbsolute(cleanPath)
    ? cleanPath
    : resolve(cwd, cleanPath);
  const { resolvedPath, isCanonical } = safeResolvePath(absolutePath);
  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    cwd,
    isCanonical ? [resolvedPath] : undefined,
    options,
  );
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  };
}

function permissionVerb(operationType: FileOperationType): "read" | "write" {
  return operationType === "read" ? "read" : "write";
}

function buildSuggestions(
  resolvedPath: string,
  operationType: FileOperationType,
  context: ToolPermissionContext,
): readonly PermissionUpdate[] {
  const shouldSuggestAcceptEdits =
    context.mode === "default" || context.mode === "plan";
  if (operationType === "read") {
    return [{
      type: "addRules",
      destination: "session",
      behavior: "allow",
      rules: [{
        toolName: "FileRead",
        ruleContent: `${dirname(resolvedPath)}${sep}**`,
      }],
    }];
  }
  const suggestions: PermissionUpdate[] = [];
  if (shouldSuggestAcceptEdits) {
    suggestions.push({
      type: "setMode",
      destination: "session",
      mode: "acceptEdits",
    });
  }
  suggestions.push({
    type: "addDirectories",
    destination: "session",
    directories: [dirname(resolvedPath)],
  });
  return suggestions;
}

export function checkToolPathPermission(
  opts: ToolPathPermissionOptions,
): PermissionResult {
  const result = validatePath(
    opts.path,
    opts.cwd,
    opts.context,
    opts.operationType,
    { extraWorkingDirectories: opts.extraWorkingDirectories },
  );
  if (result.allowed) {
    return {
      behavior: "allow",
      updatedInput: opts.input,
      decisionReason: result.decisionReason,
    };
  }

  const verb = permissionVerb(opts.operationType);
  const decisionReason = result.decisionReason;
  if (
    decisionReason?.type === "rule" &&
    decisionReason.rule.ruleBehavior === "deny"
  ) {
    return {
      behavior: "deny",
      message: `Permission to ${verb} ${opts.path} has been denied.`,
      decisionReason,
    };
  }

  return {
    behavior: "ask",
    message: `AgenC requested permissions to ${verb} ${opts.path} with ${opts.toolName}, but you haven't granted it yet.`,
    decisionReason,
    suggestions: buildSuggestions(result.resolvedPath, opts.operationType, opts.context),
    blockedPath: result.resolvedPath,
  };
}
