/**
 * T11 Wave 1 — rule string parsing, matching, context composition.
 *
 * Port of the following AgenC modules:
 *   - `src/utils/permissions/permissionRuleParser.ts`
 *     (parseRuleString / serializeRuleValue + escape helpers)
 *   - `src/utils/permissions/permissions.ts`
 *     (flattening + matching + applyPermissionUpdate + context-level
 *     helpers — everything that does NOT touch disk)
 *
 * The classifier, hook, and denial-tracking paths are deferred to
 * Wave 2. This module intentionally stays pure (no fs, no globals) so
 * tests and settings.ts can compose it.
 *
 * @module
 */

import {
  PERMISSION_RULE_SOURCES,
  type PermissionBehavior,
  type PermissionRule,
  type PermissionRuleSource,
  type PermissionRuleValue,
  type PermissionUpdate,
  type PermissionUpdateDestination,
  type ToolPermissionContext,
  type ToolPermissionRulesBySource,
  deepFreeze,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Escape helpers (parens + backslash)
// ─────────────────────────────────────────────────────────────────────

/**
 * Escape rule content for storage. Backslashes escape first, then
 * parentheses — reversing the order breaks the roundtrip.
 */
export function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/**
 * Inverse of {@link escapeRuleContent}. Parens unescape first, then
 * backslashes.
 */
export function unescapeRuleContent(content: string): string {
  return content
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function findFirstUnescapedChar(str: string, char: string): number {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && str[j] === "\\"; j--) backslashes++;
      if (backslashes % 2 === 0) return i;
    }
  }
  return -1;
}

function findLastUnescapedChar(str: string, char: string): number {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === char) {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && str[j] === "\\"; j--) backslashes++;
      if (backslashes % 2 === 0) return i;
    }
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────────────
// parseRuleString / serializeRuleValue
// ─────────────────────────────────────────────────────────────────────

/**
 * Parse a permission-rule string into its components.
 *
 * Returns `null` when the input is empty or obviously malformed
 * (caller-decided).
 *
 * Grammar:
 *   rule      := toolName ( "(" content ")" )?
 *   content   := any char; `\(` and `\)` are escaped parens
 *
 * Shapes treated as whole-tool rules (no content):
 *   "Bash"     → { toolName: "Bash" }
 *   "Bash()"   → { toolName: "Bash" }
 *   "Bash(*)"  → { toolName: "Bash" }
 */
export function parseRuleString(raw: string): PermissionRuleValue | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const ruleString = raw;

  const openParenIndex = findFirstUnescapedChar(ruleString, "(");
  if (openParenIndex === -1) {
    return Object.freeze({ toolName: ruleString });
  }

  const closeParenIndex = findLastUnescapedChar(ruleString, ")");
  if (closeParenIndex === -1 || closeParenIndex <= openParenIndex) {
    return Object.freeze({ toolName: ruleString });
  }

  if (closeParenIndex !== ruleString.length - 1) {
    return Object.freeze({ toolName: ruleString });
  }

  const toolName = ruleString.substring(0, openParenIndex);
  const rawContent = ruleString.substring(openParenIndex + 1, closeParenIndex);

  if (!toolName) {
    return Object.freeze({ toolName: ruleString });
  }

  if (rawContent === "" || rawContent === "*") {
    return Object.freeze({ toolName });
  }

  return Object.freeze({
    toolName,
    ruleContent: unescapeRuleContent(rawContent),
  });
}

export function serializeRuleValue(rv: PermissionRuleValue): string {
  if (!rv.ruleContent) return rv.toolName;
  return `${rv.toolName}(${escapeRuleContent(rv.ruleContent)})`;
}

// ─────────────────────────────────────────────────────────────────────
// Rule matching
// ─────────────────────────────────────────────────────────────────────

export interface ToolLike {
  readonly name: string;
  readonly mcpInfo?: {
    readonly serverName?: string;
    readonly toolName?: string;
  };
}

/**
 * Shell-exec family: LIVE default shell is `exec_command`; legacy / TUI /
 * unattended names must collapse for deny/ask/allow rules (parity with
 * unattended-policy.ts TOOL_ALIASES).
 */
export const SHELL_TOOL_FAMILY: readonly string[] = Object.freeze([
  "system.bash",
  "Bash",
  "bash",
  "exec_command",
  "desktop.bash",
  "shell",
  // TOOL-02: interactive continuation + kill are shell channels.
  "write_stdin",
  "kill_process",
  "PowerShell",
  "Monitor",
]);

/** TOOL-05: file-mutation family for deny/ask/allow collapse. */
export const FILE_MUTATION_TOOL_FAMILY: readonly string[] = Object.freeze([
  "Edit",
  "FileEdit",
  "MultiEdit",
  "Write",
  "FileWrite",
  "apply_patch",
]);

const TOOL_PERMISSION_ALIASES: ReadonlyMap<string, readonly string[]> =
  new Map<string, readonly string[]>([
    ["system.bash", SHELL_TOOL_FAMILY],
    ["FileRead", Object.freeze(["FileRead", "Read"] as const)],
    ["Edit", FILE_MUTATION_TOOL_FAMILY],
    ["Write", FILE_MUTATION_TOOL_FAMILY],
    ["MultiEdit", FILE_MUTATION_TOOL_FAMILY],
    ["apply_patch", FILE_MUTATION_TOOL_FAMILY],
    ["Grep", Object.freeze(["Grep", "system.grep"] as const)],
    ["Glob", Object.freeze(["Glob", "system.glob"] as const)],
  ]);

export function toolNameAliases(toolName: string): readonly string[] {
  const aliases = TOOL_PERMISSION_ALIASES.get(toolName);
  if (aliases !== undefined) return aliases;
  for (const values of TOOL_PERMISSION_ALIASES.values()) {
    if (values.includes(toolName)) return values;
  }
  return Object.freeze([toolName] as const);
}

/**
 * Parse an MCP-qualified tool name like `mcp__server__tool` into
 * structured parts. Returns null when the input is not MCP-shaped.
 */
function mcpInfoFromString(name: string): {
  serverName: string;
  toolName?: string;
} | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep === -1) {
    // `mcp__server` — server-level wildcard
    return rest ? { serverName: rest } : null;
  }
  const serverName = rest.slice(0, sep);
  const toolName = rest.slice(sep + 2);
  return { serverName, toolName: toolName || undefined };
}

/**
 * Check whether a rule matches an entire tool invocation. Whole-tool
 * rules have no `ruleContent`. Content-specific matching is performed
 * per tool by the tool's own `checkPermissions` (Wave 2).
 *
 * MCP server-level rules such as `mcp__foo` or `mcp__foo__*` match any
 * tool under the `foo` server.
 */
export function matchRule(
  rule: PermissionRule,
  tool: ToolLike,
  _toolInput?: Record<string, unknown>,
): boolean {
  if (rule.ruleValue.ruleContent !== undefined) return false;

  // Prefer MCP-structured name when present, otherwise fall back to
  // the plain `tool.name` (works for builtins and unprefixed MCP).
  const toolNameForMatch = tool.mcpInfo?.serverName
    ? tool.mcpInfo.toolName
      ? `mcp__${tool.mcpInfo.serverName}__${tool.mcpInfo.toolName}`
      : `mcp__${tool.mcpInfo.serverName}`
    : tool.name;

  if (toolNameAliases(toolNameForMatch).includes(rule.ruleValue.toolName)) {
    return true;
  }

  const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName);
  const toolInfo = mcpInfoFromString(toolNameForMatch);

  return (
    ruleInfo !== null &&
    toolInfo !== null &&
    (ruleInfo.toolName === undefined || ruleInfo.toolName === "*") &&
    ruleInfo.serverName === toolInfo.serverName
  );
}

// ─────────────────────────────────────────────────────────────────────
// Flatten rule collections from a context
// ─────────────────────────────────────────────────────────────────────

function flattenRules(
  bucket: ToolPermissionRulesBySource,
  behavior: PermissionBehavior,
): PermissionRule[] {
  const out: PermissionRule[] = [];
  for (const source of PERMISSION_RULE_SOURCES) {
    const strings = bucket[source];
    if (!strings) continue;
    for (const s of strings) {
      const parsed = parseRuleString(s);
      if (!parsed) continue;
      out.push({ source, ruleBehavior: behavior, ruleValue: parsed });
    }
  }
  return out;
}

export function getAllowRules(ctx: ToolPermissionContext): PermissionRule[] {
  return flattenRules(ctx.alwaysAllowRules, "allow");
}

export function getDenyRules(ctx: ToolPermissionContext): PermissionRule[] {
  return flattenRules(ctx.alwaysDenyRules, "deny");
}

export function getAskRules(ctx: ToolPermissionContext): PermissionRule[] {
  return flattenRules(ctx.alwaysAskRules, "ask");
}

// ─────────────────────────────────────────────────────────────────────
// First-matching rule lookup
// ─────────────────────────────────────────────────────────────────────

function toolLikeFromName(toolName: string): ToolLike {
  return { name: toolName };
}

export function toolAlwaysAllowedRule(
  ctx: ToolPermissionContext,
  toolName: string,
  _toolInput?: Record<string, unknown>,
): PermissionRule | null {
  const tool = toolLikeFromName(toolName);
  return getAllowRules(ctx).find((r) => matchRule(r, tool)) ?? null;
}

export function getDenyRuleForTool(
  ctx: ToolPermissionContext,
  toolName: string,
  _toolInput?: Record<string, unknown>,
): PermissionRule | null {
  const tool = toolLikeFromName(toolName);
  return getDenyRules(ctx).find((r) => matchRule(r, tool)) ?? null;
}

export function getAskRuleForTool(
  ctx: ToolPermissionContext,
  toolName: string,
  _toolInput?: Record<string, unknown>,
): PermissionRule | null {
  const tool = toolLikeFromName(toolName);
  return getAskRules(ctx).find((r) => matchRule(r, tool)) ?? null;
}

/**
 * Map rule-content → rule for every content-qualified rule against a
 * given tool name and behavior. Used by tool-specific content-rule
 * checks (e.g. Bash subcommand matching).
 */
export function getRuleByContentsForTool(
  ctx: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  const out = new Map<string, PermissionRule>();
  let rules: PermissionRule[];
  switch (behavior) {
    case "allow":
      rules = getAllowRules(ctx);
      break;
    case "deny":
      rules = getDenyRules(ctx);
      break;
    case "ask":
      rules = getAskRules(ctx);
      break;
  }
  for (const rule of rules) {
    if (
      toolNameAliases(toolName).includes(rule.ruleValue.toolName) &&
      rule.ruleValue.ruleContent !== undefined &&
      rule.ruleBehavior === behavior
    ) {
      out.set(rule.ruleValue.ruleContent, rule);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Content-rule matching
// ─────────────────────────────────────────────────────────────────────

const ESCAPED_STAR_PLACEHOLDER = "\x00ESCAPED_STAR\x00";
const ESCAPED_BACKSLASH_PLACEHOLDER = "\x00ESCAPED_BACKSLASH\x00";
const ESCAPED_STAR_PLACEHOLDER_RE = new RegExp(
  ESCAPED_STAR_PLACEHOLDER,
  "g",
);
const ESCAPED_BACKSLASH_PLACEHOLDER_RE = new RegExp(
  ESCAPED_BACKSLASH_PLACEHOLDER,
  "g",
);

export interface ContentRuleMatchHints {
  readonly prefix?: string | null;
  readonly firstWord?: string | null;
}

function hasContentWildcards(pattern: string): boolean {
  if (pattern.endsWith(":*")) return false;
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] !== "*") continue;
    let backslashCount = 0;
    let j = i - 1;
    while (j >= 0 && pattern[j] === "\\") {
      backslashCount += 1;
      j -= 1;
    }
    if (backslashCount % 2 === 0) return true;
  }
  return false;
}

function matchWildcardContentPattern(
  pattern: string,
  candidate: string,
): boolean {
  let processed = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i]!;
    if (char === "\\" && i + 1 < pattern.length) {
      const nextChar = pattern[i + 1]!;
      if (nextChar === "*") {
        processed += ESCAPED_STAR_PLACEHOLDER;
        i += 2;
        continue;
      }
      if (nextChar === "\\") {
        processed += ESCAPED_BACKSLASH_PLACEHOLDER;
        i += 2;
        continue;
      }
    }
    processed += char;
    i += 1;
  }

  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&");
  let regexPattern = escaped
    .replace(/\*/g, ".*")
    .replace(ESCAPED_STAR_PLACEHOLDER_RE, "\\*")
    .replace(ESCAPED_BACKSLASH_PLACEHOLDER_RE, "\\\\");

  const unescapedStarCount = (processed.match(/\*/g) ?? []).length;
  if (regexPattern.endsWith(" .*") && unescapedStarCount === 1) {
    regexPattern = `${regexPattern.slice(0, -3)}( .*)?`;
  }

  return new RegExp(`^${regexPattern}$`, "s").test(candidate);
}

export function matchContentRule(
  ruleContent: string | undefined,
  candidate: string,
  hints: ContentRuleMatchHints = {},
): boolean {
  if (ruleContent === undefined) return true;

  if (ruleContent.endsWith(":*")) {
    const rulePrefix = ruleContent.slice(0, -2);
    if (rulePrefix === "") return false;
    return (
      candidate === rulePrefix ||
      candidate.startsWith(`${rulePrefix} `) ||
      hints.prefix === rulePrefix ||
      hints.firstWord === rulePrefix
    );
  }

  if (
    hasContentWildcards(ruleContent) ||
    ruleContent.includes("\\*") ||
    ruleContent.includes("\\\\")
  ) {
    return matchWildcardContentPattern(ruleContent, candidate);
  }

  return ruleContent === candidate;
}

export function findMatchingContentRule(
  rules: ReadonlyMap<string, PermissionRule>,
  candidate: string,
  hints: ContentRuleMatchHints = {},
): PermissionRule | null {
  for (const [content, rule] of rules) {
    if (matchContentRule(content, candidate, hints)) return rule;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// spawn_agent(agentType) helpers
// ─────────────────────────────────────────────────────────────────────

export function getDenyRuleForAgent(
  ctx: ToolPermissionContext,
  agentType: string,
  agentToolName = "spawn_agent",
): PermissionRule | null {
  return (
    getDenyRules(ctx).find(
      (r) =>
        r.ruleValue.toolName === agentToolName &&
        r.ruleValue.ruleContent === agentType,
    ) ?? null
  );
}

export function filterDeniedAgents<T extends { readonly agentType: string }>(
  ctx: ToolPermissionContext,
  candidates: readonly T[],
  agentToolName = "spawn_agent",
): T[] {
  const denied = new Set<string>();
  for (const r of getDenyRules(ctx)) {
    if (
      r.ruleValue.toolName === agentToolName &&
      r.ruleValue.ruleContent !== undefined
    ) {
      denied.add(r.ruleValue.ruleContent);
    }
  }
  return candidates.filter((c) => !denied.has(c.agentType));
}

// ─────────────────────────────────────────────────────────────────────
// Update application
// ─────────────────────────────────────────────────────────────────────

function bucketKeyForBehavior(
  behavior: PermissionBehavior,
): "alwaysAllowRules" | "alwaysDenyRules" | "alwaysAskRules" {
  switch (behavior) {
    case "allow":
      return "alwaysAllowRules";
    case "deny":
      return "alwaysDenyRules";
    case "ask":
      return "alwaysAskRules";
  }
}

function writeBucket(
  ctx: ToolPermissionContext,
  bucketKey: "alwaysAllowRules" | "alwaysDenyRules" | "alwaysAskRules",
  destination: PermissionUpdateDestination,
  ruleStrings: readonly string[],
): ToolPermissionContext {
  const oldBucket: ToolPermissionRulesBySource = ctx[bucketKey];
  // Preserve a stable key order and replace / set the destination bucket.
  const nextBucket: Record<string, readonly string[]> = {};
  for (const source of PERMISSION_RULE_SOURCES) {
    if (source === destination) continue;
    const prev = oldBucket[source];
    if (prev) nextBucket[source] = prev;
  }
  nextBucket[destination] = Object.freeze([...ruleStrings]);
  return deepFreeze({ ...ctx, [bucketKey]: nextBucket }) as ToolPermissionContext;
}

/**
 * Apply a single `PermissionUpdate`. Returns a new, deeply frozen
 * context. Input update is treated as readonly — destinations not
 * mentioned are carried over verbatim.
 */
export function applyPermissionUpdate(
  ctx: ToolPermissionContext,
  update: PermissionUpdate,
): ToolPermissionContext {
  switch (update.type) {
    case "setMode": {
      return deepFreeze({ ...ctx, mode: update.mode }) as ToolPermissionContext;
    }
    case "addRules": {
      const bucketKey = bucketKeyForBehavior(update.behavior);
      const existing = ctx[bucketKey][update.destination] ?? [];
      const adds = update.rules.map(serializeRuleValue);
      return writeBucket(ctx, bucketKey, update.destination, [
        ...existing,
        ...adds,
      ]);
    }
    case "replaceRules": {
      const bucketKey = bucketKeyForBehavior(update.behavior);
      const next = update.rules.map(serializeRuleValue);
      return writeBucket(ctx, bucketKey, update.destination, next);
    }
    case "removeRules": {
      const bucketKey = bucketKeyForBehavior(update.behavior);
      const existing = ctx[bucketKey][update.destination] ?? [];
      const toRemove = new Set(update.rules.map(serializeRuleValue));
      const kept = existing.filter((r) => !toRemove.has(r));
      return writeBucket(ctx, bucketKey, update.destination, kept);
    }
    case "addDirectories": {
      const next = new Map(ctx.additionalWorkingDirectories);
      for (const dir of update.directories) {
        next.set(dir, {
          path: dir,
          source: update.destination as PermissionRuleSource,
        });
      }
      return deepFreeze({
        ...ctx,
        additionalWorkingDirectories: next,
      }) as ToolPermissionContext;
    }
    case "removeDirectories": {
      const next = new Map(ctx.additionalWorkingDirectories);
      for (const dir of update.directories) next.delete(dir);
      return deepFreeze({
        ...ctx,
        additionalWorkingDirectories: next,
      }) as ToolPermissionContext;
    }
    default: {
      // Exhaustiveness check — in practice the discriminated union
      // above covers every case. Defensive: return the context
      // unchanged rather than throwing.
      const _exhaustive: never = update;
      void _exhaustive;
      return ctx;
    }
  }
}

export function applyPermissionUpdates(
  ctx: ToolPermissionContext,
  updates: readonly PermissionUpdate[],
): ToolPermissionContext {
  let out = ctx;
  for (const u of updates) out = applyPermissionUpdate(out, u);
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Bulk apply: rules[] → context updates
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert a flat list of rules into `PermissionUpdate` items grouped
 * by source × behavior. When `updateType === "replaceRules"`, every
 * source × behavior pair that appears in `rules` emits a replace
 * update; when emitting replaceRules for a source that is NOT present
 * in the rule list, callers should drive a separate
 * `clearAllRulesFromSource` pass first (settings.ts does this).
 */
export function convertRulesToUpdates(
  rules: readonly PermissionRule[],
  updateType: "addRules" | "replaceRules",
): PermissionUpdate[] {
  const grouped = new Map<string, PermissionRuleValue[]>();
  for (const r of rules) {
    if (!isPermissionUpdateDestination(r.source)) continue;
    const key = `${r.source}:${r.ruleBehavior}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(r.ruleValue);
    else grouped.set(key, [r.ruleValue]);
  }
  const updates: PermissionUpdate[] = [];
  for (const [key, values] of grouped) {
    const sepIdx = key.indexOf(":");
    const source = key.slice(0, sepIdx) as PermissionUpdateDestination;
    const behavior = key.slice(sepIdx + 1) as PermissionBehavior;
    updates.push({
      type: updateType,
      destination: source,
      rules: Object.freeze([...values]),
      behavior,
    });
  }
  return updates;
}

/**
 * Low-level: install a rule-string list into a context bucket for a
 * given source × behavior, regardless of whether that source is a
 * valid `PermissionUpdateDestination`. Used by settings.ts to keep
 * rules from read-only sources (`policySettings`, `flagSettings`) in
 * sync with disk.
 */
export function setRulesForSource(
  ctx: ToolPermissionContext,
  source: PermissionRuleSource,
  behavior: PermissionBehavior,
  ruleStrings: readonly string[],
): ToolPermissionContext {
  const bucketKey = bucketKeyForBehavior(behavior);
  const oldBucket: ToolPermissionRulesBySource = ctx[bucketKey];
  const nextBucket: Record<string, readonly string[]> = {};
  for (const s of PERMISSION_RULE_SOURCES) {
    if (s === source) continue;
    const prev = oldBucket[s];
    if (prev) nextBucket[s] = prev;
  }
  nextBucket[source] = Object.freeze([...ruleStrings]);
  return deepFreeze({ ...ctx, [bucketKey]: nextBucket }) as ToolPermissionContext;
}

/**
 * Additive rule application — typical startup path. Existing rules
 * are preserved; new rules are appended. Use
 * {@link syncPermissionRulesFromDisk} (in settings.ts) for the
 * replacement-on-reload path.
 *
 * Rules with a source that is not a `PermissionUpdateDestination`
 * (`policySettings`, `flagSettings`, `command`) are installed via
 * {@link setRulesForSource} so managed/flag/command rules survive the
 * conversion.
 */
export function applyPermissionRulesToPermissionContext(
  ctx: ToolPermissionContext,
  rules: readonly PermissionRule[],
): ToolPermissionContext {
  // Split by whether the source is a valid update destination.
  const destinationOk: PermissionRule[] = [];
  // source × behavior → list of rule strings
  const directInstall = new Map<string, string[]>();
  for (const rule of rules) {
    if (isPermissionUpdateDestination(rule.source)) {
      destinationOk.push(rule);
    } else {
      const key = `${rule.source}:${rule.ruleBehavior}`;
      const bucket = directInstall.get(key);
      const str = serializeRuleValue(rule.ruleValue);
      if (bucket) bucket.push(str);
      else directInstall.set(key, [str]);
    }
  }

  const updates = convertRulesToUpdates(destinationOk, "addRules");
  let out = applyPermissionUpdates(ctx, updates);

  // Now handle read-only sources by direct bucket write. We append
  // to any pre-existing strings for the same source × behavior so
  // repeated `applyPermissionRulesToPermissionContext` calls stay
  // additive (match AgenC semantics).
  for (const [key, strings] of directInstall) {
    const sepIdx = key.indexOf(":");
    const source = key.slice(0, sepIdx) as PermissionRuleSource;
    const behavior = key.slice(sepIdx + 1) as PermissionBehavior;
    const bucketKey = bucketKeyForBehavior(behavior);
    const existing = out[bucketKey][source] ?? [];
    out = setRulesForSource(out, source, behavior, [...existing, ...strings]);
  }

  return out;
}

/**
 * Remove every rule originating from a single source across all three
 * behaviors. Used by settings-sync to guarantee that deleting a rule
 * on disk drops it from the in-memory context as well.
 */
export function clearAllRulesFromSource(
  ctx: ToolPermissionContext,
  source: PermissionUpdateDestination,
): ToolPermissionContext {
  let out = ctx;
  for (const behavior of ["allow", "deny", "ask"] as const) {
    out = applyPermissionUpdate(out, {
      type: "replaceRules",
      destination: source,
      rules: [],
      behavior,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Destination helpers
// ─────────────────────────────────────────────────────────────────────

export function isPermissionUpdateDestination(
  source: PermissionRuleSource,
): source is PermissionUpdateDestination {
  return (
    source === "userSettings" ||
    source === "projectSettings" ||
    source === "localSettings" ||
    source === "session" ||
    source === "cliArg"
  );
}
