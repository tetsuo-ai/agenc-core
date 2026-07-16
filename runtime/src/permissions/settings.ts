/**
 * T11 Wave 1 — disk-facing glue for permission rules.
 *
 * Settings sources + JSON file paths:
 *
 *   userSettings    ~/.agenc/settings.json
 *   projectSettings <projectRoot>/.agenc/settings.json
 *   localSettings   <projectRoot>/.agenc/settings.local.json
 *   flagSettings    CLI-provided (--settings-file <path>)
 *   policySettings  /etc/agenc/managed-settings.json
 *                   (or $AGENC_MANAGED_SETTINGS)
 *
 * JSON shape:
 *   {
 *     "permissions": {
 *       "allow": ["Bash(git commit:*)", "Read"],
 *       "deny":  ["Bash(rm -rf:*)"],
 *       "ask":   ["Bash(npm publish:*)"],
 *       "additionalDirectories": ["/abs/path"],
 *       "defaultMode": "acceptEdits",
 *       "disableBypassPermissionsMode": "disable"
 *     },
 *     "disableAutoMode": "disable"
 *   }
 *
 * Invariants:
 *   - Every disk read routes through `utils/file-read::readTextFile`
 *     (I-80 LF normalization + I-81 UTF-8 BOM strip).
 *   - Reading settings for append uses a lenient parser: if the JSON
 *     fails a stricter schema check elsewhere, we still preserve
 *     existing permission rules so a bad `hooks` block doesn't wipe
 *     unrelated permission edits.
 *   - Writes are atomic (write to `.tmp` then `rename`).
 *
 * @module
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ConfigStore } from "../config/store.js";
import type { AgenCConfig } from "../config/schema.js";
import { findProjectRootSync } from "../session/session-store.js";
import { readTextFile } from "./_deps/file-read.js";
import { applyToolApprovalConfigToPermissionContext } from "./tool-approval.js";
import {
  applyPermissionRulesToPermissionContext,
  applyPermissionUpdate,
  clearAllRulesFromSource,
  parseRuleString,
  serializeRuleValue,
  setRulesForSource,
} from "./rules.js";
import {
  EDITABLE_SOURCES,
  PERMISSION_BEHAVIORS,
  PERMISSION_RULE_SOURCES,
  SETTING_SOURCES,
  createEmptyToolPermissionContext,
  isUserAddressablePermissionMode,
  type EditablePermissionRuleSource,
  type PermissionBehavior,
  type PermissionMode,
  type PermissionRule,
  type PermissionRuleSource,
  type PermissionRuleValue,
  type ToolPermissionContext,
} from "./types.js";
import { isAutoModeGateEnabled } from "./permission-mode.js";

// ─────────────────────────────────────────────────────────────────────
// Re-exports so callers can `import { SETTING_SOURCES, EDITABLE_SOURCES } from "./settings.js"`
// ─────────────────────────────────────────────────────────────────────

export { SETTING_SOURCES, EDITABLE_SOURCES };

// ─────────────────────────────────────────────────────────────────────
// Settings JSON shape
// ─────────────────────────────────────────────────────────────────────

export interface SettingsPermissionsBlock {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
  readonly additionalDirectories?: readonly string[];
  readonly defaultMode?: string;
  readonly disableBypassPermissionsMode?: "disable" | "enable";
  readonly disableAutoMode?: "disable" | "enable";
  readonly allowManagedPermissionRulesOnly?: boolean;
  readonly [k: string]: unknown;
}

export interface SettingsJson {
  readonly permissions?: SettingsPermissionsBlock;
  readonly disableAutoMode?: "disable" | "enable";
  readonly [k: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────
// Path resolution
// ─────────────────────────────────────────────────────────────────────

export interface DiskEnv {
  /** Defaults to `process.env.HOME`. */
  readonly home?: string;
  /** Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Optional config store (used for `--settings-file` path etc.). */
  readonly configStore?: ConfigStore;
  /** Full path to a --settings-file. */
  readonly flagSettingsPath?: string;
  /** Override the managed-settings path. */
  readonly managedSettingsPath?: string;
}

function resolveHome(env: DiskEnv | undefined): string {
  if (env?.home) return env.home;
  const h = process.env.HOME;
  if (!h) {
    throw new Error("HOME unset and no env.home provided");
  }
  return h;
}

function resolveCwd(env: DiskEnv | undefined): string {
  return env?.cwd ?? process.cwd();
}

function resolveProjectRoot(
  env: DiskEnv | undefined,
  configStore?: ConfigStore,
): string {
  const cwd = resolveCwd(env);
  const markers = configStore?.current().project_root_markers;
  const found = findProjectRootSync(
    cwd,
    markers && markers.length > 0 ? markers : undefined,
  );
  return found ? found.rootDir : cwd;
}

/**
 * Return the JSON file path for a given source, or `null` when this
 * source has no on-disk file (e.g. in-memory-only sources).
 */
export function getSettingsFilePathForSource(
  source: PermissionRuleSource,
  env?: DiskEnv,
): string | null {
  const configStore = env?.configStore;
  switch (source) {
    case "userSettings": {
      const home = resolveHome(env);
      return join(home, ".agenc", "settings.json");
    }
    case "projectSettings": {
      const root = resolveProjectRoot(env, configStore);
      return join(root, ".agenc", "settings.json");
    }
    case "localSettings": {
      const root = resolveProjectRoot(env, configStore);
      return join(root, ".agenc", "settings.local.json");
    }
    case "flagSettings": {
      return env?.flagSettingsPath ?? null;
    }
    case "policySettings": {
      if (env?.managedSettingsPath) return env.managedSettingsPath;
      const fromEnv = process.env.AGENC_MANAGED_SETTINGS;
      if (fromEnv) return fromEnv;
      return "/etc/agenc/managed-settings.json";
    }
    case "cliArg":
    case "command":
    case "session":
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// JSON parse (lenient)
// ─────────────────────────────────────────────────────────────────────

function safeParseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Lenient settings reader — returns `null` when the file is missing
 * or unparseable. Never throws. Does NOT perform schema validation so
 * an invalid `hooks` block cannot clobber a permission edit.
 *
 * Uses {@link readTextFile} so every read respects I-80 (line-ending
 * normalization) and I-81 (BOM strip).
 */
export async function readSettingsFileLenient(
  path: string,
): Promise<SettingsJson | null> {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = await readTextFile(path);
  } catch {
    return null;
  }
  if (raw.trim() === "") return {};
  const parsed = safeParseJSON(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as SettingsJson;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Enabled sources
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns the list of setting sources the runtime should consult,
 * derived from the active config. Policy and flag settings are always
 * included (matching AgenC behavior). Pass the config store so
 * consumers do not depend on any process-global.
 */
export function getEnabledSettingSources(
  configStore?: ConfigStore,
): PermissionRuleSource[] {
  // Today AgenC has no per-source opt-out knob; mirror AgenC's
  // "all settings sources enabled" default. When such a knob is added
  // to AgenCConfig, it should be read here.
  void configStore;
  const out: PermissionRuleSource[] = [];
  for (const s of SETTING_SOURCES) out.push(s);
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// settings JSON → rules[]
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert a parsed settings blob into flat `PermissionRule[]`. The
 * `source` field is stamped on every emitted rule so downstream code
 * (e.g. `syncPermissionRulesFromDisk`) knows which disk file the rule
 * came from.
 */
export function settingsJsonToRules(
  json: SettingsJson | null,
  source: PermissionRuleSource,
): PermissionRule[] {
  if (!json || !json.permissions) return [];
  const rules: PermissionRule[] = [];
  for (const behavior of PERMISSION_BEHAVIORS) {
    const list = json.permissions[behavior];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== "string") continue;
      const parsed = parseRuleString(raw);
      if (!parsed) continue;
      rules.push({ source, ruleBehavior: behavior, ruleValue: parsed });
    }
  }
  return rules;
}

// ─────────────────────────────────────────────────────────────────────
// Policy gate
// ─────────────────────────────────────────────────────────────────────

export function shouldAllowManagedPermissionRulesOnly(
  policySettings: SettingsJson | null | undefined,
): boolean {
  return policySettings?.permissions?.allowManagedPermissionRulesOnly === true;
}

// ─────────────────────────────────────────────────────────────────────
// Load all rules from disk
// ─────────────────────────────────────────────────────────────────────

/**
 * Walk every on-disk settings source in priority order and return a
 * single flat `PermissionRule[]`. When managed-settings has
 * `allowManagedPermissionRulesOnly=true`, only the `policySettings`
 * source is consulted.
 */
export async function loadAllPermissionRulesFromDisk(
  env?: DiskEnv,
): Promise<PermissionRule[]> {
  // Pre-load policy so we can honor the managed-only gate.
  const policyPath = getSettingsFilePathForSource("policySettings", env);
  const policyJson = policyPath
    ? await readSettingsFileLenient(policyPath)
    : null;

  if (shouldAllowManagedPermissionRulesOnly(policyJson)) {
    return settingsJsonToRules(policyJson, "policySettings");
  }

  const rules: PermissionRule[] = [];
  for (const source of getEnabledSettingSources(env?.configStore)) {
    const path = getSettingsFilePathForSource(source, env);
    if (!path) continue;
    const json =
      source === "policySettings"
        ? policyJson
        : await readSettingsFileLenient(path);
    rules.push(...settingsJsonToRules(json, source));
  }
  return rules;
}

export function filterRepositoryControlledPermissionGrants(
  rules: readonly PermissionRule[],
): PermissionRule[] {
  return rules.filter(
    (rule) =>
      rule.ruleBehavior !== "allow" ||
      (rule.source !== "projectSettings" && rule.source !== "localSettings"),
  );
}

/**
 * @deprecated Project path trust never turns repository settings into an
 * authority channel. Kept as a source-compatible alias for callers migrating
 * from the old path-trust policy.
 */
export function filterRulesForProjectTrust(
  rules: readonly PermissionRule[],
  _projectTrust?: "trusted" | "untrusted",
): PermissionRule[] {
  return filterRepositoryControlledPermissionGrants(rules);
}

// ─────────────────────────────────────────────────────────────────────
// Sync (replacement-on-change)
// ─────────────────────────────────────────────────────────────────────

/**
 * Re-read every disk-origin source and replace (not merge) the
 * context's rules for that source. Without this, deleting a rule
 * from a settings file would leave the rule orphaned in memory
 * because `convertRulesToUpdates` only produces replaceRules for
 * source×behavior pairs that have rules.
 */
export async function syncPermissionRulesFromDisk(
  ctx: ToolPermissionContext,
  env?: DiskEnv,
): Promise<ToolPermissionContext> {
  let out = ctx;
  const rules = filterRepositoryControlledPermissionGrants(
    await loadAllPermissionRulesFromDisk(env),
  );

  // Clear the three editable disk-origin sources before re-apply so
  // deletes on disk propagate into memory. `flagSettings` and
  // `policySettings` are not valid PermissionUpdateDestination values
  // (they cannot be written to via PermissionUpdate), so we clear
  // them via a direct rule-bucket scrub below instead.
  for (const source of EDITABLE_SOURCES) {
    out = clearAllRulesFromSource(out, source);
  }

  // Scrub policySettings + flagSettings rule buckets directly so a
  // freshly-read disk state replaces them too. We write empty arrays
  // for each behavior on those sources, then let
  // `applyPermissionRulesToPermissionContext` re-install them.
  for (const src of ["policySettings", "flagSettings"] as const) {
    for (const behavior of PERMISSION_BEHAVIORS) {
      out = setRulesForSource(out, src, behavior, []);
    }
  }

  // Re-apply the freshly-loaded rules.
  out = applyPermissionRulesToPermissionContext(out, rules);
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Atomic write
// ─────────────────────────────────────────────────────────────────────

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

// ─────────────────────────────────────────────────────────────────────
// Add / delete rules
// ─────────────────────────────────────────────────────────────────────

export interface AddPermissionRulesOpts {
  readonly destination: EditablePermissionRuleSource;
  readonly behavior: PermissionBehavior;
  readonly rules: readonly PermissionRuleValue[];
  readonly env?: DiskEnv;
}

/**
 * Persist `rules` to the JSON settings file for `destination`,
 * deduping against existing entries (roundtrip-normalized). When
 * `allowManagedPermissionRulesOnly` is set, this function is a no-op
 * and returns false.
 */
export async function addPermissionRulesToSettings(
  opts: AddPermissionRulesOpts,
): Promise<boolean> {
  const { destination, behavior, rules, env } = opts;
  if (rules.length === 0) return true;
  if (
    behavior === "allow" &&
    (destination === "projectSettings" || destination === "localSettings")
  ) {
    // Repository files are mutable inputs, not approval records. Persisting an
    // allow rule here would let a later checkout edit impersonate the operator.
    return false;
  }

  // Policy gate short-circuit.
  const policyPath = getSettingsFilePathForSource("policySettings", env);
  const policyJson = policyPath
    ? await readSettingsFileLenient(policyPath)
    : null;
  if (shouldAllowManagedPermissionRulesOnly(policyJson)) return false;

  const path = getSettingsFilePathForSource(destination, env);
  if (!path) return false;

  const current =
    (await readSettingsFileLenient(path)) ?? ({} as SettingsJson);
  const permissions = (current.permissions ?? {}) as SettingsPermissionsBlock;
  const existingList =
    (permissions[behavior] as readonly string[] | undefined) ?? [];
  const ruleStrings = rules.map(serializeRuleValue);

  const normalizedExisting = new Set(
    existingList.map((raw) => {
      const parsed = parseRuleString(raw);
      return parsed ? serializeRuleValue(parsed) : raw;
    }),
  );
  const additions = ruleStrings.filter((r) => !normalizedExisting.has(r));
  if (additions.length === 0) return true;

  const nextPermissions: SettingsPermissionsBlock = {
    ...permissions,
    [behavior]: [...existingList, ...additions],
  };
  const next: SettingsJson = { ...current, permissions: nextPermissions };
  writeJsonAtomic(path, next);
  return true;
}

export interface DeletePermissionRuleOpts {
  readonly destination: EditablePermissionRuleSource;
  readonly rule: PermissionRule;
  readonly env?: DiskEnv;
}

export async function deletePermissionRule(
  opts: DeletePermissionRuleOpts,
): Promise<boolean> {
  const { destination, rule, env } = opts;
  const path = getSettingsFilePathForSource(destination, env);
  if (!path) return false;
  const current = await readSettingsFileLenient(path);
  if (!current || !current.permissions) return false;

  const list =
    (current.permissions[rule.ruleBehavior] as readonly string[] | undefined) ??
    [];
  const target = serializeRuleValue(rule.ruleValue);

  const normalizedTarget = target;
  const filtered = list.filter((raw) => {
    const parsed = parseRuleString(raw);
    const normalized = parsed ? serializeRuleValue(parsed) : raw;
    return normalized !== normalizedTarget;
  });
  if (filtered.length === list.length) return false;

  const nextPermissions: SettingsPermissionsBlock = {
    ...current.permissions,
    [rule.ruleBehavior]: filtered,
  };
  const next: SettingsJson = { ...current, permissions: nextPermissions };
  writeJsonAtomic(path, next);
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// bypassPermissions consent persistence
// ─────────────────────────────────────────────────────────────────────

export interface RecordBypassPermissionsAcceptanceOpts {
  /**
   * Absolute path to the workspace directory the operator has consented
   * to activate `bypassPermissions` mode in. Appended (deduped) to the
   * user settings file's top-level `bypassPermissionsModeAcceptedIn`
   * array so follow-up sessions opened against the same directory skip
   * the consent prompt.
   */
  readonly workspacePath: string;
  readonly env?: DiskEnv;
}

/**
 * Persist explicit operator consent for `bypassPermissions` mode to the
 * user settings file (`~/.agenc/settings.json`). Returns `true` when the
 * file was written (including the no-op case where the workspace was
 * already listed) and `false` when the target path is unavailable. The
 * session-level mirror of this list lives on
 * `ToolPermissionContext.bypassPermissionsAcceptedIn` and is updated by
 * the `/permissions accept-bypass` command separately.
 */
export async function recordBypassPermissionsAcceptance(
  opts: RecordBypassPermissionsAcceptanceOpts,
): Promise<boolean> {
  const { workspacePath, env } = opts;
  const path = getSettingsFilePathForSource("userSettings", env);
  if (!path) return false;

  const current =
    (await readSettingsFileLenient(path)) ?? ({} as SettingsJson);
  const existingRaw = (current as { bypassPermissionsModeAcceptedIn?: unknown })
    .bypassPermissionsModeAcceptedIn;
  const existing = Array.isArray(existingRaw)
    ? (existingRaw.filter((v): v is string => typeof v === "string"))
    : [];
  if (existing.includes(workspacePath)) {
    // Already recorded — nothing to write, but still treat as success.
    return true;
  }
  const next: SettingsJson = {
    ...current,
    bypassPermissionsModeAcceptedIn: [...existing, workspacePath],
  } as SettingsJson;
  writeJsonAtomic(path, next);
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────

/**
 * Parse one or more `--allow-tool`/`--deny-tool`/`--ask-tool` CLI
 * argument values into a flat list of rule strings. Supports comma-
 * and whitespace-separated values; parentheses are respected so
 * `"Bash(git commit:*), Read"` parses into two rule strings.
 */
export function parseToolListFromCLI(
  tools: readonly string[],
): PermissionRule[] {
  if (!tools || tools.length === 0) return [];
  const stringRules: string[] = [];
  for (const toolString of tools) {
    if (!toolString) continue;
    let current = "";
    let inParens = false;
    for (const ch of toolString) {
      if (ch === "(") {
        inParens = true;
        current += ch;
      } else if (ch === ")") {
        inParens = false;
        current += ch;
      } else if (ch === "," && !inParens) {
        if (current.trim()) stringRules.push(current.trim());
        current = "";
      } else if (ch === " " && !inParens) {
        if (current.trim()) stringRules.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) stringRules.push(current.trim());
  }

  const rules: PermissionRule[] = [];
  for (const raw of stringRules) {
    const parsed = parseRuleString(raw);
    if (!parsed) continue;
    rules.push({
      source: "cliArg",
      ruleBehavior: "allow", // caller overwrites per-flag
      ruleValue: parsed,
    });
  }
  return rules;
}

/**
 * Parse the `--base-tools` flag. Only whitespace/comma splitting is
 * performed — unknown tool names are passed through verbatim.
 */
export function parseBaseToolsFromCLI(
  baseTools: readonly string[],
): PermissionRule[] {
  // Same grammar as allowlist parsing today; we keep the separate
  // helper so callers can map base-tool semantics differently in the
  // future.
  return parseToolListFromCLI(baseTools);
}

// ─────────────────────────────────────────────────────────────────────
// Initial permission mode
// ─────────────────────────────────────────────────────────────────────

export interface InitialPermissionModeInput {
  /** Raw CLI `--permission-mode` value, if present. */
  readonly permissionModeCli?: string;
  /** `--dangerously-bypass-approvals-and-sandbox` flag (runtime alias
   * for `--dangerously-skip-permissions`). */
  readonly dangerouslySkipPermissions?: boolean;
  /** Resolved `policySettings` blob (for disableBypassPermissionsMode). */
  readonly policySettings?: SettingsJson | null;
  /** Resolved `userSettings.permissions.defaultMode`. */
  readonly userDefaultMode?: string;
  /** Effective auto-mode availability after settings resolution. */
  readonly isAutoModeAvailable?: boolean;
  /** Live circuit-breaker state for auto mode. */
  readonly isAutoModeGateEnabled?: boolean;
}

export interface InitialPermissionModeResult {
  readonly mode: PermissionMode;
  readonly notification?: string;
}

/**
 * Resolve the initial permission mode from CLI flags, user settings,
 * and policy constraints. Precedence (highest → lowest):
 *
 *   1. `--dangerously-bypass-approvals-and-sandbox` → bypassPermissions
 *   2. `--permission-mode <mode>`
 *   3. `settings.permissions.defaultMode`
 *
 * If the resolved mode is `bypassPermissions` and policy disables it,
 * the mode falls back to `"default"` and a `notification` string is
 * returned explaining why.
 */
export function initialPermissionModeFromCLI(
  input: InitialPermissionModeInput,
): InitialPermissionModeResult {
  const disableBypass =
    input.policySettings?.permissions?.disableBypassPermissionsMode ===
    "disable";
  const autoModeDisabled = input.isAutoModeAvailable === false;
  const autoModeGateEnabled = input.isAutoModeGateEnabled !== false;

  const ordered: PermissionMode[] = [];
  if (input.dangerouslySkipPermissions) ordered.push("bypassPermissions");
  if (
    input.permissionModeCli &&
    isUserAddressablePermissionMode(input.permissionModeCli)
  ) {
    ordered.push(input.permissionModeCli);
  }
  if (
    input.userDefaultMode &&
    isUserAddressablePermissionMode(input.userDefaultMode)
  ) {
    ordered.push(input.userDefaultMode);
  }

  let notification: string | undefined;
  for (const mode of ordered) {
    if (mode === "bypassPermissions" && disableBypass) {
      notification = "Bypass permissions mode was disabled by settings";
      continue;
    }
    if (mode === "auto" && autoModeDisabled) {
      notification = "Auto mode was disabled by settings";
      continue;
    }
    if (mode === "auto" && !autoModeGateEnabled) {
      notification = "Auto mode is unavailable because the live gate is closed";
      continue;
    }
    return { mode, notification };
  }

  return { mode: "default", notification };
}

function getAutoModeDisableSetting(
  json: SettingsJson | null,
): "disable" | "enable" | null {
  if (!json) return null;
  const permissionValue = json.permissions?.disableAutoMode;
  if (permissionValue === "disable" || permissionValue === "enable") {
    return permissionValue;
  }
  const rootValue = json.disableAutoMode;
  if (rootValue === "disable" || rootValue === "enable") {
    return rootValue;
  }
  return null;
}

async function loadModeSettingsInputs(
  env?: DiskEnv,
): Promise<{
  readonly policySettings: SettingsJson | null;
  readonly defaultMode?: string;
  readonly autoModeDisabled: boolean;
}> {
  const sources: readonly PermissionRuleSource[] = [
    "userSettings",
    "projectSettings",
    "localSettings",
    "flagSettings",
    "policySettings",
  ];

  let defaultMode: string | undefined;
  let authoritativeAutoModeDisabled = false;
  let repositoryAutoModeRestricted = false;
  let policySettings: SettingsJson | null = null;

  for (const source of sources) {
    const path = getSettingsFilePathForSource(source, env);
    if (!path) continue;
    const json = await readSettingsFileLenient(path);
    if (json === null) continue;
    if (source === "policySettings") {
      policySettings = json;
    }
    const repositoryControlled =
      source === "projectSettings" || source === "localSettings";
    if (
      !repositoryControlled &&
      typeof json.permissions?.defaultMode === "string" &&
      json.permissions.defaultMode.length > 0
    ) {
      defaultMode = json.permissions.defaultMode;
    }
    const autoSetting = getAutoModeDisableSetting(json);
    if (autoSetting !== null) {
      // Repository settings may tighten execution by disabling auto mode, but
      // cannot enable it or undo an authoritative source's restriction.
      if (repositoryControlled) {
        repositoryAutoModeRestricted ||= autoSetting === "disable";
      } else {
        authoritativeAutoModeDisabled = autoSetting === "disable";
      }
    }
  }

  return {
    policySettings,
    defaultMode,
    autoModeDisabled:
      authoritativeAutoModeDisabled || repositoryAutoModeRestricted,
  };
}

// ─────────────────────────────────────────────────────────────────────
// initializeToolPermissionContext
// ─────────────────────────────────────────────────────────────────────

export interface InitializeToolPermissionContextOpts {
  readonly env?: DiskEnv;
  readonly permissionMode?: PermissionMode;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly projectTrust?: "trusted" | "untrusted";
  /** Parsed `--allow-tool` values (plain rule strings). */
  readonly cliAllows?: readonly string[];
  /** Parsed `--deny-tool` values. */
  readonly cliDenies?: readonly string[];
  /** Parsed `--ask-tool` values. */
  readonly cliAsks?: readonly string[];
  /** Directories passed via `--add-dir`. */
  readonly addDirs?: readonly string[];
}

export interface InitializeToolPermissionContextResult {
  readonly toolPermissionContext: ToolPermissionContext;
  readonly warnings: readonly string[];
}

/**
 * Compose a `ToolPermissionContext` from disk settings + CLI flags.
 * Pure async: no globals touched, so tests can pass synthetic `env`
 * and `configStore` values.
 */
export async function initializeToolPermissionContext(
  opts: InitializeToolPermissionContextOpts = {},
): Promise<InitializeToolPermissionContextResult> {
  const warnings: string[] = [];
  const untrustedProject = opts.projectTrust === "untrusted";
  const { policySettings, defaultMode, autoModeDisabled } =
    await loadModeSettingsInputs(opts.env);

  const { mode: resolvedMode, notification } = initialPermissionModeFromCLI({
    permissionModeCli: opts.permissionMode,
    dangerouslySkipPermissions: opts.allowDangerouslySkipPermissions,
    policySettings,
    userDefaultMode: defaultMode,
    isAutoModeAvailable: !autoModeDisabled,
    isAutoModeGateEnabled: isAutoModeGateEnabled(),
  });
  if (notification) {
    warnings.push(notification);
  }

  let effectiveMode: PermissionMode = resolvedMode;
  if (
    untrustedProject &&
    effectiveMode === "bypassPermissions" &&
    opts.allowDangerouslySkipPermissions !== true
  ) {
    effectiveMode = "default";
    warnings.push(
      "Bypass permissions mode requires project trust; using default mode",
    );
  }

  const isBypassPermissionsModeAvailable =
    (effectiveMode === "bypassPermissions" ||
      opts.allowDangerouslySkipPermissions === true) &&
    policySettings?.permissions?.disableBypassPermissionsMode !== "disable";

  // Parse CLI rule flags.
  const cliAllowRules = parseToolListFromCLI(opts.cliAllows ?? []).map(
    (r) => ({ ...r, ruleBehavior: "allow" as const }),
  );
  const cliDenyRules = parseToolListFromCLI(opts.cliDenies ?? []).map((r) => ({
    ...r,
    ruleBehavior: "deny" as const,
  }));
  const cliAskRules = parseToolListFromCLI(opts.cliAsks ?? []).map((r) => ({
    ...r,
    ruleBehavior: "ask" as const,
  }));

  // Empty starting context.
  let ctx: ToolPermissionContext = createEmptyToolPermissionContext({
    mode: effectiveMode,
    isBypassPermissionsModeAvailable,
    isAutoModeAvailable: !autoModeDisabled,
  });

  // Apply CLI rules first (they carry the lowest persistence weight
  // but are immediately visible in-memory).
  ctx = applyPermissionRulesToPermissionContext(ctx, [
    ...cliAllowRules,
    ...cliDenyRules,
    ...cliAskRules,
  ]);

  // Then pull disk rules.
  const rawDiskRules = await loadAllPermissionRulesFromDisk(opts.env);
  const diskRules = filterRepositoryControlledPermissionGrants(rawDiskRules);
  const ignoredGrantCount = rawDiskRules.length - diskRules.length;
  if (ignoredGrantCount > 0) {
    warnings.push(
      `Ignored ${ignoredGrantCount} repository-controlled permission allow ${ignoredGrantCount === 1 ? "rule" : "rules"}; project/local settings may restrict but cannot grant capabilities`,
    );
  }
  ctx = applyPermissionRulesToPermissionContext(ctx, diskRules);

  // Apply the config snapshot's permissions overlay after disk rules. The
  // ConfigStore block is transient for this session, so it uses the
  // session source instead of pretending to be an on-disk settings file.
  ctx = applyToolApprovalConfigToPermissionContext(
    ctx,
    opts.env?.configStore?.current().permissions,
    "session",
  );

  // Add --add-dir directories.
  if (opts.addDirs && opts.addDirs.length > 0) {
    const cwd = opts.env?.cwd ?? process.cwd();
    const absoluteDirs: string[] = [];
    for (const d of opts.addDirs) {
      const abs = isAbsolute(d) ? d : resolve(cwd, d);
      if (!existsSync(abs)) {
        warnings.push(`--add-dir path does not exist: ${abs}`);
        continue;
      }
      absoluteDirs.push(abs);
    }
    if (absoluteDirs.length > 0) {
      ctx = applyPermissionUpdate(ctx, {
        type: "addDirectories",
        destination: "cliArg",
        directories: absoluteDirs,
      });
    }
  }

  // Merge settings.permissions.additionalDirectories (user settings).
  const userPath = getSettingsFilePathForSource("userSettings", opts.env);
  const userJson = userPath ? await readSettingsFileLenient(userPath) : null;
  const settingsDirs = collectSettingsDirs(userJson);
  if (settingsDirs.length > 0) {
    ctx = applyPermissionUpdate(ctx, {
      type: "addDirectories",
      destination: "userSettings",
      directories: settingsDirs,
    });
  }

  return { toolPermissionContext: ctx, warnings };
}

function collectSettingsDirs(json: SettingsJson | null): string[] {
  const list = json?.permissions?.additionalDirectories;
  if (!Array.isArray(list)) return [];
  return list.filter((d): d is string => typeof d === "string" && d.length > 0);
}

// ─────────────────────────────────────────────────────────────────────
// Light helpers useful to downstream Wave 2 modules
// ─────────────────────────────────────────────────────────────────────

export function getConfigFromStore(
  configStore?: ConfigStore,
): AgenCConfig | null {
  return configStore ? configStore.current() : null;
}

export function listEditableSources(): readonly EditablePermissionRuleSource[] {
  return EDITABLE_SOURCES;
}

export function listAllRuleSources(): readonly PermissionRuleSource[] {
  return PERMISSION_RULE_SOURCES;
}
