/**
 * Path validation helpers for AgenC's permission primitives.
 *
 * Shape notes:
 *   - The live runtime stores working roots outside `ToolPermissionContext`,
 *     so callers pass `cwd` and optional extra working roots explicitly.
 *   - Rule matching maps read/edit permission types onto AgenC's
 *     visible `FileRead`, `Read`, `Edit`, and `Write` tool names.
 *   - OS sandbox allowlist integration is not carried because AgenC's current
 *     sandbox layer is policy math only; executable sandbox enforcement lives
 *     in the tool/runtime boundary.
 */

import { lstatSync, realpathSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

import { getRuleByContentsForTool } from "./rules.js";
import { checkProtectedPathSafety } from "./protected-paths.js";
import { withSignedAllowedRoots } from "../agents/_deps/filesystem-args.js";
import { getSettingsRootPathForSource } from "../utils/settings/settings.js";
import {
  matchesSessionPlanFile,
  type SessionPlanFileAuthority,
} from "../planning/session-plan-authority.js";
import type {
  PermissionDecisionReason,
  PermissionResult,
  PermissionRule,
  PermissionRuleSource,
  PermissionUpdate,
  ToolPermissionContext,
} from "./types.js";

import {
  getAutoMemPath,
  getGlobalMemoryPath,
  hasAutoMemPathOverride,
  isAutoMemoryEnabled,
} from "../memory/paths.js";

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
  readonly planFileAuthority?: SessionPlanFileAuthority | null;
  /** Unresolved spellings (trailing dots, 8.3, relative names) for safety only. */
  readonly extraSafetyPaths?: readonly string[];
}

export interface ToolPathPermissionOptions {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly path: string;
  readonly cwd: string;
  readonly context: ToolPermissionContext;
  readonly operationType: FileOperationType;
  readonly extraWorkingDirectories?: readonly string[];
  readonly planFileAuthority?: SessionPlanFileAuthority | null;
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
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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

function uniquePaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (path.length > 0 && !out.includes(path)) out.push(path);
  }
  return out;
}

function getPathsForPermissionCheck(filePath: string): readonly string[] {
  const { resolvedPath } = safeResolvePath(filePath);
  const out = uniquePaths([
    filePath.normalize("NFC"),
    resolvedPath.normalize("NFC"),
  ]);

  try {
    const linkTarget = readlinkSync(filePath);
    const absoluteTarget = isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(filePath), linkTarget);
    const { resolvedPath: resolvedTarget } = safeResolvePath(absoluteTarget);
    const normalizedTarget = resolvedTarget.normalize("NFC");
    if (!out.includes(normalizedTarget)) out.push(normalizedTarget);
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
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(resolvedPath);
  const absoluteCandidates = pathsToCheck.filter((candidate) =>
    isAbsolute(candidate),
  );
  const toCheck =
    absoluteCandidates.length > 0 ? absoluteCandidates : pathsToCheck;
  const dirs = workingDirectories(cwd, context, extraWorkingDirectories);
  return toCheck.every((candidate) =>
    dirs.some((dir) => isPathInside(candidate, dir)),
  );
}

function toolNamesForOperation(
  operationType: FileOperationType,
): readonly string[] {
  return operationType === "read" ? ["FileRead"] : ["Edit", "Write"];
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

export function matchPathRuleContent(
  ruleContent: string,
  filePath: string,
): boolean {
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

/**
 * The canonical form of a path whose ancestors exist, leaving anything that
 * cannot be resolved untouched. Rule prefixes and the paths they are matched
 * against must agree, or a symlinked source root hides every rule under it.
 */
function canonicalizeExistingPath(path: string): string {
  const { resolvedPath } = safeResolvePath(path);
  return resolvedPath;
}

function baseForRuleSource(source: PermissionRuleSource, cwd: string): string {
  if (
    source === "userSettings" ||
    source === "projectSettings" ||
    source === "localSettings" ||
    source === "flagSettings" ||
    source === "policySettings"
  ) {
    try {
      return getSettingsRootPathForSource(source);
    } catch {
      // Tests and early startup may lack a ConfigStore; fall through.
    }
  }
  if (source === "userSettings") return homedir();
  return resolve(cwd);
}

function resolvePathRulePattern(
  ruleContent: string,
  source: PermissionRuleSource,
  cwd: string,
): string {
  const expanded = expandTilde(ruleContent);
  if (
    isAbsolute(expanded) ||
    expanded.startsWith("~") ||
    containsVulnerableUncPath(expanded)
  ) {
    return expanded;
  }
  // A pattern with no literal directory component, such as `**` or `*.ts`,
  // names files anywhere rather than a subtree of one source root. Anchoring
  // it would silently narrow an all-path rule like FileRead(**) to the
  // settings root. `./**` is excluded from that: it states its directory.
  if (
    getGlobBaseDirectory(expanded) === "." &&
    !expanded.startsWith("./") &&
    !expanded.startsWith("../")
  ) {
    return expanded;
  }
  // Anchor the rule the same way targets are resolved. matchingRuleForPath
  // canonicalizes what it checks through realpath, so a lexically resolved
  // base describes the same tree under a different prefix whenever the source
  // root is reached through a symlink, and no rule ever matches. The
  // containment check still runs, on canonical paths for both sides, so a
  // rule cannot escape its source root.
  const base = canonicalizeExistingPath(baseForRuleSource(source, cwd));
  const resolved = resolve(base, expanded);
  const lexicalPrefix = getGlobBaseDirectory(resolved);
  const prefix = canonicalizeExistingPath(lexicalPrefix);
  if (!isPathInside(prefix, base)) {
    return expanded;
  }
  // Match on the canonical prefix, not the lexical one. Candidates arrive
  // canonicalized, so a pattern still describing the alias matches nothing.
  // An exact path has no glob suffix and becomes its own canonical form.
  return prefix + resolved.slice(lexicalPrefix.length);
}

function matchingRuleForPath(
  filePath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  behavior: "allow" | "ask" | "deny",
  cwd: string,
): PermissionRule | null {
  const pathsToCheck = getPathsForPermissionCheck(filePath);
  for (const toolName of toolNamesForOperation(operationType)) {
    const rules = getRuleByContentsForTool(context, toolName, behavior);
    for (const [content, rule] of rules) {
      const resolvedContent = resolvePathRulePattern(content, rule.source, cwd);
      if (
        pathsToCheck.some((candidate) =>
          matchPathRuleContent(resolvedContent, candidate),
        )
      ) {
        return rule;
      }
    }
  }
  return null;
}

function matchingRuleResult(
  filePath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  behavior: "allow" | "ask" | "deny",
  cwd: string,
): PathCheckResult | null {
  const rule = matchingRuleForPath(
    filePath,
    context,
    operationType,
    behavior,
    cwd,
  );
  if (rule === null) return null;
  return {
    allowed: behavior === "allow",
    decisionReason: { type: "rule", rule },
  };
}

function checkPathSafetyForAutoEdit(
  resolvedPath: string,
  precomputedPathsToCheck?: readonly string[],
  extraSafetyPaths?: readonly string[],
):
  | { readonly safe: true }
  | {
      readonly safe: false;
      readonly message: string;
      readonly classifierApprovable: boolean;
    } {
  return checkProtectedPathSafety(
    resolvedPath,
    uniquePaths([
      ...(precomputedPathsToCheck ?? getPathsForPermissionCheck(resolvedPath)),
      ...(extraSafetyPaths ?? []),
    ]),
  );
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

/** Use the existing memory capability only after resolving the path's symlinks. */
/**
 * Whether every path the permission check would inspect for `resolvedPath`
 * lies under a durable memory root. Match legacy file-tool authority: these
 * roots come from trusted settings, never tool input.
 */
function underDurableMemoryRoots(paths: readonly string[]): boolean {
  const roots = [getAutoMemPath(), getGlobalMemoryPath()];
  return paths.every((path) => roots.some((root) => isPathInside(path, root)));
}

/**
 * A write target the file tools may take under a durable memory root
 * (`$AGENC_HOME/memory/` or the project memory directory): auto memory is
 * on and no SDK override has moved the roots. The memory prompt points the
 * model at exactly these directories, and the permission layer already
 * admits them; the runtime sandbox check consults this so it agrees.
 */
export function isDurableMemoryWritePath(resolvedPath: string): boolean {
  if (!isAutoMemoryEnabled() || hasAutoMemPathOverride()) return false;
  return underDurableMemoryRoots(getPathsForPermissionCheck(resolvedPath));
}

function durableMemoryPathPermission(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  cwd: string,
  precomputedPathsToCheck?: readonly string[],
): PathCheckResult | null {
  if (
    !isAutoMemoryEnabled() ||
    (operationType !== "read" && hasAutoMemPathOverride())
  )
    return null;
  // An arbitrary SDK override gets no write carveout.
  const paths =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(resolvedPath);
  if (!underDurableMemoryRoots(paths)) return null;
  return (
    matchingRuleResult(resolvedPath, context, operationType, "ask", cwd) ?? {
      allowed: true,
      decisionReason: { type: "other", reason: "durable memory files" },
    }
  );
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

  const denyRule = matchingRuleResult(
    resolvedPath,
    context,
    operationType,
    "deny",
    cwd,
  );
  if (denyRule !== null) return denyRule;

  if (matchesSessionPlanFile(resolvedPath, options.planFileAuthority)) {
    return (
      matchingRuleResult(resolvedPath, context, operationType, "ask", cwd) ?? {
        allowed: true,
        decisionReason: { type: "other", reason: "owning session plan file" },
      }
    );
  }

  const memoryPermission = durableMemoryPathPermission(
    resolvedPath,
    context,
    operationType,
    cwd,
    precomputedPathsToCheck,
  );
  if (memoryPermission !== null) return memoryPermission;

  if (operationType !== "read") {
    const safetyCheck = checkPathSafetyForAutoEdit(
      resolvedPath,
      precomputedPathsToCheck,
      options.extraSafetyPaths,
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

  const askRule = matchingRuleResult(
    resolvedPath,
    context,
    operationType,
    "ask",
    cwd,
  );
  if (askRule !== null) return askRule;

  const allowRule = matchingRuleResult(
    resolvedPath,
    context,
    operationType,
    "allow",
    cwd,
  );
  if (allowRule !== null) return allowRule;

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
    const { resolvedPath } = safeResolvePath(absolutePath);
    const result = isPathAllowed(
      resolvedPath,
      toolPermissionContext,
      operationType,
      cwd,
      getPathsForPermissionCheck(absolutePath),
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
  const { resolvedPath } = safeResolvePath(absoluteBasePath);
  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    cwd,
    getPathsForPermissionCheck(absoluteBasePath),
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
  const { resolvedPath } = safeResolvePath(absolutePath);
  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    cwd,
    getPathsForPermissionCheck(absolutePath),
    {
      ...options,
      extraSafetyPaths: uniquePaths([
        ...(options.extraSafetyPaths ?? []),
        path,
        cleanPath,
      ]),
    },
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
    return [
      {
        type: "addRules",
        destination: "session",
        behavior: "allow",
        rules: [
          {
            toolName: "FileRead",
            ruleContent: `${dirname(resolvedPath)}${sep}**`,
          },
        ],
      },
    ];
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

function withTransientAllowedRoot(
  input: Record<string, unknown>,
  resolvedPath: string,
): Record<string, unknown> {
  return withSignedAllowedRoots(input, [dirname(resolvedPath)]);
}

export function checkToolPathPermission(
  opts: ToolPathPermissionOptions,
): PermissionResult {
  const result = validatePath(
    opts.path,
    opts.cwd,
    opts.context,
    opts.operationType,
    {
      extraWorkingDirectories: opts.extraWorkingDirectories,
      planFileAuthority: matchesSessionPlanFile(
        opts.path,
        opts.planFileAuthority,
        opts.cwd,
      )
        ? opts.planFileAuthority
        : null,
    },
  );
  // A file tool confines itself to the workspace root plus the signed roots
  // on its input; the permission layer widens that only when the user
  // approves a prompt (see the `ask` result below). An allow the layer
  // reaches on its own for a path outside the cwd, through `--add-dir`, an
  // allow rule, or bypassPermissions, therefore used to end in the tool's
  // own "Path is outside allowed directories" (observed: Edit on
  // /etc/nginx/nginx.conf under --dangerously-bypass-approvals-and-sandbox
  // with --add-dir /). Hand the tool the same directory an approval would.
  const inputForAllow = (): Record<string, unknown> =>
    isPathInside(result.resolvedPath, resolve(opts.cwd))
      ? opts.input
      : withTransientAllowedRoot(opts.input, result.resolvedPath);
  if (result.allowed) {
    return {
      behavior: "allow",
      updatedInput: inputForAllow(),
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

  // Mirror the bash short-circuit at permissions/bash.ts:431 ("hadDeny"
  // guard): in --dangerously-bypass-approvals-and-sandbox / bypassPermissions mode the user has explicitly
  // opted out of approval gating, so filesystem-touching tools (Read, Glob,
  // FileRead, ...) must not surface the working-dir prompt. Without this,
  // `agenc --dangerously-bypass-approvals-and-sandbox` was half-bypassing — Bash and Grep auto-approved while
  // Read/Glob still prompted, breaking GAP-TEST-* scenarios 11/13/35.
  //
  // SECURITY: this bypass runs AFTER validatePath, so a path-specific
  // Deny(...) rule (handled above) and the safety gates surfaced as a
  // "safetyCheck" decisionReason (the shared protected-path classifier and
  // dangerous-removal checks in isPathAllowed/checkPathSafetyForAutoEdit) are
  // still honored. These are exactly the two bypass-immune categories the
  // evaluator enforces at permissions/evaluator.ts (step 1d deny, step 1g
  // safetyCheck); everything else (workingDir/ask) is auto-allowed under
  // bypass.
  if (
    opts.context.mode === "bypassPermissions" &&
    decisionReason?.type !== "safetyCheck" &&
    !(
      decisionReason?.type === "rule" &&
      decisionReason.rule.ruleBehavior === "ask" &&
      matchesSessionPlanFile(opts.path, opts.planFileAuthority, opts.cwd)
    )
  ) {
    return {
      behavior: "allow",
      updatedInput: inputForAllow(),
      decisionReason: { type: "mode", mode: "bypassPermissions" },
    };
  }

  const updatedInput =
    decisionReason?.type === "workingDir"
      ? withTransientAllowedRoot(opts.input, result.resolvedPath)
      : opts.input;

  return {
    behavior: "ask",
    message: `AgenC requested permissions to ${verb} ${opts.path} with ${opts.toolName}, but you haven't granted it yet.`,
    updatedInput,
    decisionReason,
    suggestions: buildSuggestions(
      result.resolvedPath,
      opts.operationType,
      opts.context,
    ),
    blockedPath: result.resolvedPath,
  };
}
