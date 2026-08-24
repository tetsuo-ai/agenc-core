/** Canonical permission projection and persistence over layered config.toml. */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readStrictConfigLayer, type ConfigScope } from "../config/repository.js";
import { ConfigStore } from "../config/store.js";
import {
  isValidPermissionMode,
  type AgenCConfig,
  type PermissionsConfig,
} from "../config/schema.js";
import { findProjectRootSync } from "../session/session-store.js";
import {
  getSettingsForSource as getCanonicalSettingsForSource,
  type RuntimeSettingsPatch,
  type RuntimeSettingsSnapshot,
  updateSettingsForSource as updateCanonicalSettingsForSource,
} from "../utils/settings/settings.js";
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
  deepFreeze,
  isUserAddressablePermissionMode,
  type EditablePermissionRuleSource,
  type PermissionBehavior,
  type PermissionMode,
  type PermissionRule,
  type PermissionRuleSource,
  type PermissionRuleValue,
  type PermissionUpdate,
  type ToolPermissionContext,
} from "./types.js";
import { isAutoModeGateEnabled } from "./permission-mode.js";
import type { ProviderEnvironment } from "../llm/provider-options.js";

// ─────────────────────────────────────────────────────────────────────
// Re-exports so callers can `import { SETTING_SOURCES, EDITABLE_SOURCES } from "./settings.js"`
// ─────────────────────────────────────────────────────────────────────

export { SETTING_SOURCES, EDITABLE_SOURCES };

// ─────────────────────────────────────────────────────────────────────
// Canonical permission snapshot
// ─────────────────────────────────────────────────────────────────────

export type PermissionSettingsSnapshot = RuntimeSettingsSnapshot;

// ─────────────────────────────────────────────────────────────────────
// Path resolution
// ─────────────────────────────────────────────────────────────────────

export interface DiskEnv {
  /** Canonical AgenC home, not the platform home directory. */
  readonly home?: string;
  /** Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Active strict layered repository snapshot. */
  readonly configStore?: ConfigStore;
  /** Override the managed config.toml path. */
  readonly managedConfigPath?: string;
}

function resolveCwd(env: DiskEnv | undefined): string {
  return env?.cwd ?? process.cwd();
}

function resolveProjectRoot(
  env: DiskEnv | undefined,
  configStore?: ConfigStore,
): string {
  const cwd = resolveCwd(env);
  if (configStore) return configStore.projectRoot;
  const found = findProjectRootSync(cwd);
  return found ? found.rootDir : cwd;
}

async function withCanonicalStore(env?: DiskEnv): Promise<DiskEnv> {
  if (env?.configStore) return env;
  const cwd = resolveCwd(env);
  const configStore = new ConfigStore({
    ...(env?.home !== undefined ? { home: env.home } : {}),
    cwd,
    projectRoot: resolveProjectRoot(env),
    ...(env?.managedConfigPath !== undefined
      ? { managedConfigPath: env.managedConfigPath }
      : {}),
    env: env?.home === undefined
      ? process.env
      : { ...process.env, AGENC_HOME: env.home },
  });
  await configStore.reload();
  return { ...env, cwd, configStore };
}

/**
 * Return the canonical TOML layer path for a source, or `null` when the
 * source is in-memory-only or no managed layer was resolved.
 */
export function getSettingsFilePathForSource(
  source: PermissionRuleSource,
  env?: DiskEnv,
): string | null {
  const configStore = env?.configStore;
  switch (source) {
    case "userSettings": {
      if (configStore) return configStore.homeContext.configTomlPath;
      return env?.home ? join(env.home, "config.toml") : null;
    }
    case "projectSettings": {
      const root = resolveProjectRoot(env, configStore);
      return join(root, ".agenc", "config.toml");
    }
    case "localSettings": {
      const root = resolveProjectRoot(env, configStore);
      return join(root, ".agenc", "config.local.toml");
    }
    case "flagSettings": {
      return env?.configStore?.sources("flag")[0]?.path ?? null;
    }
    case "policySettings": {
      if (env?.managedConfigPath) return env.managedConfigPath;
      return env?.configStore?.sources("managed").at(-1)?.path ?? null;
    }
    case "cliArg":
    case "command":
    case "session":
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Canonical projection
// ─────────────────────────────────────────────────────────────────────

function settingsFromConfig(config: AgenCConfig): PermissionSettingsSnapshot {
  return config as PermissionSettingsSnapshot;
}

function scopeForSource(source: PermissionRuleSource): ConfigScope | null {
  switch (source) {
    case "userSettings": return "user";
    case "projectSettings": return "project";
    case "localSettings": return "local";
    case "flagSettings": return "flag";
    case "policySettings": return "managed";
    case "cliArg":
    case "command":
    case "session":
      return null;
  }
}

function mergeSourceSettings(
  values: readonly PermissionSettingsSnapshot[],
): PermissionSettingsSnapshot | null {
  if (values.length === 0) return null;
  const out: Record<string, unknown> = {};
  let permissions: Record<string, unknown> = {};
  for (const value of values) {
    const rawPermissions = value.permissions as Record<string, unknown> | undefined;
    if (rawPermissions) {
      const previous = permissions;
      permissions = { ...permissions, ...rawPermissions };
      for (const behavior of ["allow", "deny", "ask", "additionalDirectories"] as const) {
        const incoming = rawPermissions[behavior];
        if (!Array.isArray(incoming)) continue;
        const existing = Array.isArray(previous[behavior])
          ? previous[behavior] as unknown[]
          : [];
        permissions[behavior] = [...new Set([...existing, ...incoming])];
      }
    }
    Object.assign(out, value);
  }
  if (Object.keys(permissions).length > 0) out.permissions = permissions;
  return out as PermissionSettingsSnapshot;
}

function settingsForSource(
  source: PermissionRuleSource,
  env?: DiskEnv,
): PermissionSettingsSnapshot | null {
  const scope = scopeForSource(source);
  if (scope === null) return null;
  const layers = env?.configStore?.sources(scope);
  if (layers) {
    return mergeSourceSettings(layers.map((layer) => settingsFromConfig(layer.config)));
  }
  return getCanonicalSettingsForSource(source as Parameters<typeof getCanonicalSettingsForSource>[0]);
}

/** Read one explicit strict TOML layer for migration/diagnostic tooling. */
export async function readCanonicalPermissionConfig(
  path: string,
  scope: ConfigScope,
): Promise<PermissionSettingsSnapshot | null> {
  const layer = await readStrictConfigLayer(path, scope, "permission config");
  return layer ? settingsFromConfig(layer.config) : null;
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
  // "all canonical config sources enabled" default. When such a knob is added
  // to AgenCConfig, it should be read here.
  void configStore;
  const out: PermissionRuleSource[] = [];
  for (const s of SETTING_SOURCES) out.push(s);
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// canonical permission projection → rules[]
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert a canonical permission projection into flat `PermissionRule[]`. The
 * `source` field is stamped on every emitted rule so downstream code
 * (e.g. `syncPermissionRulesFromConfig`) knows which canonical layer the rule
 * came from.
 */
export function permissionSettingsToRules(
  json: Pick<PermissionSettingsSnapshot, "permissions"> | null,
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
  policySettings: PermissionSettingsSnapshot | null | undefined,
): boolean {
  return policySettings?.allowManagedPermissionRulesOnly === true;
}

// ─────────────────────────────────────────────────────────────────────
// Load all rules from disk
// ─────────────────────────────────────────────────────────────────────

/**
 * Walk every canonical config source in priority order and return a
 * single flat `PermissionRule[]`. When managed TOML has
 * `allowManagedPermissionRulesOnly=true`, only the `policySettings`
 * source is consulted.
 */
export interface PermissionRulesSnapshot {
  readonly rules: readonly PermissionRule[];
  readonly directories: readonly {
    readonly path: string;
    readonly source: PermissionRuleSource;
  }[];
  readonly managedOnly: boolean;
  readonly bypassPermissionsModeDisabled: boolean;
  readonly disableAutoMode: boolean;
}

/**
 * Load the complete canonical permission policy once. Consumers that need
 * both the rules and policy flags must use this snapshot instead of re-reading
 * individual config sources and deriving a second policy decision.
 */
export async function loadPermissionRulesSnapshot(
  env?: DiskEnv,
): Promise<PermissionRulesSnapshot> {
  const canonicalEnv = await withCanonicalStore(env);
  const policyJson = settingsForSource("policySettings", canonicalEnv);
  const managedOnly = shouldAllowManagedPermissionRulesOnly(policyJson);

  let bypassPermissionsModeDisabled = false;
  let disableAutoMode = false;
  const directories = new Map<
    string,
    { readonly path: string; readonly source: PermissionRuleSource }
  >();

  const notePolicyFlags = (json: PermissionSettingsSnapshot | null): void => {
    bypassPermissionsModeDisabled ||=
      json?.permissions?.bypassPermissionsMode === "disable";
    disableAutoMode ||= getAutoModeDisableSetting(json) === "disable";
  };
  notePolicyFlags(policyJson);

  const noteDirectories = (
    json: PermissionSettingsSnapshot | null,
    source: PermissionRuleSource,
  ): void => {
    if (source === "projectSettings" || source === "localSettings") return;
    for (const path of json?.permissions?.additionalDirectories ?? []) {
      if (typeof path === "string" && path.length > 0) {
        directories.set(path, Object.freeze({ path, source }));
      }
    }
  };

  if (managedOnly) {
    noteDirectories(policyJson, "policySettings");
    return {
      rules: permissionSettingsToRules(policyJson, "policySettings"),
      directories: Object.freeze([...directories.values()]),
      managedOnly,
      bypassPermissionsModeDisabled,
      disableAutoMode,
    };
  }

  const rules: PermissionRule[] = [];
  for (const source of getEnabledSettingSources(canonicalEnv.configStore)) {
    const json =
      source === "policySettings"
        ? policyJson
        : settingsForSource(source, canonicalEnv);
    if (json === null) continue;
    notePolicyFlags(json);
    noteDirectories(json, source);
    rules.push(...permissionSettingsToRules(json, source));
  }
  return {
    rules,
    directories: Object.freeze([...directories.values()]),
    managedOnly,
    bypassPermissionsModeDisabled,
    disableAutoMode,
  };
}

export async function loadAllPermissionRulesFromConfig(
  env?: DiskEnv,
): Promise<PermissionRule[]> {
  return [...(await loadPermissionRulesSnapshot(env)).rules];
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

// ─────────────────────────────────────────────────────────────────────
// Sync (replacement-on-change)
// ─────────────────────────────────────────────────────────────────────

/**
 * Re-read every disk-origin source and replace (not merge) the
 * context's rules for that source. Without this, deleting a rule
 * from config.toml would leave the rule orphaned in memory
 * because `convertRulesToUpdates` only produces replaceRules for
 * source×behavior pairs that have rules.
 */
export async function syncPermissionRulesFromConfig(
  ctx: ToolPermissionContext,
  env?: DiskEnv,
): Promise<ToolPermissionContext> {
  return applyPermissionRulesSnapshot(
    ctx,
    await loadPermissionRulesSnapshot(env),
  );
}

/**
 * Apply a previously loaded snapshot to the current context. This pure half of
 * the reload operation lets UI subscribers perform I/O before entering a
 * state-updater callback, then apply the result to the freshest state rather
 * than overwriting a concurrent mode change with a stale context.
 */
export function applyPermissionRulesSnapshot(
  ctx: ToolPermissionContext,
  snapshot: PermissionRulesSnapshot,
): ToolPermissionContext {
  let out = ctx;
  const rules = filterRepositoryControlledPermissionGrants(
    snapshot.rules,
  );

  // Clear the three editable disk-origin sources before re-apply so
  // deletes on disk propagate into memory. `flagSettings` and
  // `policySettings` are not valid PermissionUpdateDestination values
  // (they cannot be written to via PermissionUpdate), so we clear
  // them via a direct rule-bucket scrub below instead.
  for (const source of EDITABLE_SOURCES) {
    out = clearAllRulesFromSource(out, source);
  }

  if (snapshot.managedOnly) {
    // Managed-only means policy is the sole rule authority. Session/CLI rule
    // buckets must not survive a settings reload and silently bypass policy.
    out = clearAllRulesFromSource(out, "cliArg");
    out = clearAllRulesFromSource(out, "session");
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

  // Replace directory grants with the same source-aware snapshot. Repository
  // layers may restrict execution but cannot grant new filesystem roots.
  const clearedDirectorySources = new Set<PermissionRuleSource>([
    ...SETTING_SOURCES,
    ...(snapshot.managedOnly
      ? (["cliArg", "session"] as const)
      : []),
  ]);
  const additionalWorkingDirectories = new Map(
    [...out.additionalWorkingDirectories].filter(
      ([, entry]) => !clearedDirectorySources.has(entry.source),
    ),
  );
  for (const directory of snapshot.directories) {
    additionalWorkingDirectories.set(directory.path, directory);
  }
  return deepFreeze({
    ...out,
    additionalWorkingDirectories,
  }) as ToolPermissionContext;
}

// ─────────────────────────────────────────────────────────────────────
// Canonical persistence
// ─────────────────────────────────────────────────────────────────────

function editableDestination(
  destination: PermissionUpdate["destination"],
): destination is EditablePermissionRuleSource {
  return (EDITABLE_SOURCES as readonly string[]).includes(destination);
}

/**
 * Sole disk-persistence entrypoint for permission updates. In-memory-only
 * destinations are treated as successful no-ops. Repository-controlled
 * settings may tighten policy (deny/ask/remove), but cannot create durable
 * capabilities (allow/default-mode/additional-directory).
 */
export async function persistPermissionUpdateToConfig(
  update: PermissionUpdate,
  env?: DiskEnv,
): Promise<boolean> {
  if (!editableDestination(update.destination)) return true;

  const repositoryControlled =
    update.destination === "projectSettings" ||
    update.destination === "localSettings";
  const createsCapability =
    update.type === "setMode" ||
    update.type === "addDirectories" ||
    ((update.type === "addRules" || update.type === "replaceRules") &&
      update.behavior === "allow");
  if (repositoryControlled && createsCapability) return false;

  const canonicalEnv = await withCanonicalStore(env);
  const policyJson = settingsForSource("policySettings", canonicalEnv);
  if (shouldAllowManagedPermissionRulesOnly(policyJson)) return false;

  const current = settingsForSource(update.destination, canonicalEnv) ?? ({} as PermissionSettingsSnapshot);
  const permissions = current.permissions ?? {};
  let nextPermissions: PermissionsConfig;
  let changed = false;

  const normalizeRule = (raw: string): string => {
    const parsed = parseRuleString(raw);
    return parsed ? serializeRuleValue(parsed) : raw;
  };

  switch (update.type) {
    case "addRules": {
      if (update.rules.length === 0) return true;
      const existing = permissions[update.behavior] ?? [];
      const normalizedExisting = new Set(existing.map(normalizeRule));
      const additions = update.rules
        .map(serializeRuleValue)
        .filter((rule) => !normalizedExisting.has(rule));
      if (additions.length === 0) return true;
      nextPermissions = {
        ...permissions,
        [update.behavior]: [...existing, ...additions],
      };
      changed = true;
      break;
    }
    case "removeRules": {
      const existing = permissions[update.behavior] ?? [];
      const removals = new Set(update.rules.map(serializeRuleValue));
      const filtered = existing.filter(
        (rule) => !removals.has(normalizeRule(rule)),
      );
      if (filtered.length === existing.length) return false;
      nextPermissions = {
        ...permissions,
        [update.behavior]: filtered,
      };
      changed = true;
      break;
    }
    case "replaceRules": {
      const replacements = update.rules.map(serializeRuleValue);
      const existing = permissions[update.behavior] ?? [];
      if (
        existing.length === replacements.length &&
        existing.every((rule, index) =>
          normalizeRule(rule) === replacements[index]
        )
      ) {
        return true;
      }
      nextPermissions = {
        ...permissions,
        [update.behavior]: replacements,
      };
      changed = true;
      break;
    }
    case "addDirectories": {
      const existing = permissions.additionalDirectories ?? [];
      const known = new Set(existing);
      const additions = update.directories.filter((dir) => !known.has(dir));
      if (additions.length === 0) return true;
      nextPermissions = {
        ...permissions,
        additionalDirectories: [...existing, ...additions],
      };
      changed = true;
      break;
    }
    case "removeDirectories": {
      const existing = permissions.additionalDirectories ?? [];
      const removals = new Set(update.directories);
      const filtered = existing.filter((dir) => !removals.has(dir));
      if (filtered.length === existing.length) return false;
      nextPermissions = {
        ...permissions,
        additionalDirectories: filtered,
      };
      changed = true;
      break;
    }
    case "setMode": {
      if (
        !isUserAddressablePermissionMode(update.mode) ||
        !isValidPermissionMode(update.mode)
      ) return false;
      if (permissions.defaultMode === update.mode) return true;
      nextPermissions = { ...permissions, defaultMode: update.mode };
      changed = true;
      break;
    }
  }

  if (!changed) return true;
  const result = await updateCanonicalSettingsForSource(update.destination, {
    permissions: nextPermissions,
  } satisfies RuntimeSettingsPatch, canonicalEnv.configStore);
  return result.error === null;
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
 * Persist `rules` to canonical config.toml for `destination`,
 * deduping against existing entries (roundtrip-normalized). When
 * `allowManagedPermissionRulesOnly` is set, this function is a no-op
 * and returns false.
 */
export async function addPermissionRulesToConfig(
  opts: AddPermissionRulesOpts,
): Promise<boolean> {
  return persistPermissionUpdateToConfig(
    {
      type: "addRules",
      destination: opts.destination,
      behavior: opts.behavior,
      rules: opts.rules,
    },
    opts.env,
  );
}

export interface DeletePermissionRuleOpts {
  readonly destination: EditablePermissionRuleSource;
  readonly rule: PermissionRule;
  readonly env?: DiskEnv;
}

export async function deletePermissionRule(
  opts: DeletePermissionRuleOpts,
): Promise<boolean> {
  return persistPermissionUpdateToConfig(
    {
      type: "removeRules",
      destination: opts.destination,
      behavior: opts.rule.ruleBehavior,
      rules: [opts.rule.ruleValue],
    },
    opts.env,
  );
}

// ─────────────────────────────────────────────────────────────────────
// bypassPermissions consent persistence
// ─────────────────────────────────────────────────────────────────────

export interface RecordBypassPermissionsAcceptanceOpts {
  /**
   * Absolute path to the workspace directory the operator has consented
   * to activate `bypassPermissions` mode in. Appended (deduped) to the
   * canonical user state `bypassPermissionsModeAcceptedIn`
   * array so follow-up sessions opened against the same directory skip
   * the consent prompt.
   */
  readonly workspacePath: string;
  readonly env?: DiskEnv;
}

/**
 * Persist explicit operator consent for `bypassPermissions` mode to canonical
 * user state. Returns `true` on success, including an idempotent no-op. The
 * session-level mirror of this list lives on
 * `ToolPermissionContext.bypassPermissionsAcceptedIn` and is updated by
 * the `/permissions accept-bypass` command separately.
 */
export async function recordBypassPermissionsAcceptance(
  opts: RecordBypassPermissionsAcceptanceOpts,
): Promise<boolean> {
  const { workspacePath, env } = opts;
  const canonicalEnv = await withCanonicalStore(env);
  const current = settingsForSource("userSettings", canonicalEnv) ??
    ({} as PermissionSettingsSnapshot);
  const existingRaw = (current as { bypassPermissionsModeAcceptedIn?: unknown })
    .bypassPermissionsModeAcceptedIn;
  const existing = Array.isArray(existingRaw)
    ? (existingRaw.filter((v): v is string => typeof v === "string"))
    : [];
  if (existing.includes(workspacePath)) {
    // Already recorded — nothing to write, but still treat as success.
    return true;
  }
  const result = await updateCanonicalSettingsForSource("userSettings", {
    bypassPermissionsModeAcceptedIn: [...existing, workspacePath],
  } satisfies RuntimeSettingsPatch, canonicalEnv.configStore);
  return result.error === null;
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
export function parseToolRuleStringsFromCLI(
  tools: readonly string[],
): string[] {
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
  return stringRules;
}

export function parseToolListFromCLI(
  tools: readonly string[],
): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const raw of parseToolRuleStringsFromCLI(tools)) {
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
  /** Resolved managed policy (for permissions.bypassPermissionsMode). */
  readonly policySettings?: PermissionSettingsSnapshot | null;
  /** Resolved user `config.toml` `permissions.defaultMode`. */
  readonly userDefaultMode?: string;
  /** Effective auto-mode availability after config resolution. */
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
 *   3. user `config.toml` `permissions.defaultMode`
 *
 * If the resolved mode is `bypassPermissions` and policy disables it,
 * the mode falls back to `"default"` and a `notification` string is
 * returned explaining why.
 */
export function initialPermissionModeFromCLI(
  input: InitialPermissionModeInput,
): InitialPermissionModeResult {
  const disableBypass =
    input.policySettings?.permissions?.bypassPermissionsMode ===
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
      notification = "Bypass permissions mode was disabled by configuration";
      continue;
    }
    if (mode === "auto" && autoModeDisabled) {
      notification = "Auto mode was disabled by configuration";
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
  json: PermissionSettingsSnapshot | null,
): "disable" | null {
  if (!json) return null;
  const rootValue = json.disableAutoMode;
  if (rootValue === "disable") {
    return rootValue;
  }
  return null;
}

async function loadModeSettingsInputs(
  env?: DiskEnv,
): Promise<{
  readonly policySettings: PermissionSettingsSnapshot | null;
  readonly defaultMode?: string;
  readonly autoModeDisabled: boolean;
  readonly bypassPermissionsModePolicy?: "allow" | "disable";
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
  let bypassPermissionsModePolicy: "allow" | "disable" | undefined;
  let policySettings: PermissionSettingsSnapshot | null = null;

  for (const source of sources) {
    const json = settingsForSource(source, env);
    if (json === null) continue;
    if (source === "policySettings") {
      policySettings = json;
    }
    const repositoryControlled =
      source === "projectSettings" || source === "localSettings";
    if (
      !repositoryControlled &&
      (json.permissions?.bypassPermissionsMode === "allow" ||
        json.permissions?.bypassPermissionsMode === "disable")
    ) {
      bypassPermissionsModePolicy = json.permissions.bypassPermissionsMode;
    }
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
    ...(bypassPermissionsModePolicy !== undefined
      ? { bypassPermissionsModePolicy }
      : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// initializeToolPermissionContext
// ─────────────────────────────────────────────────────────────────────

export interface InitializeToolPermissionContextOpts {
  readonly env?: DiskEnv;
  /** Immutable provider environment captured at the session ingress. */
  readonly providerEnvironment?: ProviderEnvironment;
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
 * Compose a `ToolPermissionContext` from canonical config + CLI flags.
 * Pure async: no globals touched, so tests can pass synthetic `env`
 * and `configStore` values.
 */
export async function initializeToolPermissionContext(
  opts: InitializeToolPermissionContextOpts = {},
): Promise<InitializeToolPermissionContextResult> {
  const canonicalEnv = await withCanonicalStore(opts.env);
  const warnings: string[] = [];
  const untrustedProject = opts.projectTrust === "untrusted";
  const {
    policySettings,
    defaultMode,
    autoModeDisabled,
    bypassPermissionsModePolicy,
  } = await loadModeSettingsInputs(canonicalEnv);

  const { mode: resolvedMode, notification } = initialPermissionModeFromCLI({
    permissionModeCli: opts.permissionMode,
    dangerouslySkipPermissions: opts.allowDangerouslySkipPermissions,
    policySettings,
    userDefaultMode: defaultMode,
    isAutoModeAvailable: !autoModeDisabled,
    isAutoModeGateEnabled: isAutoModeGateEnabled(opts.providerEnvironment),
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
      opts.allowDangerouslySkipPermissions === true ||
      bypassPermissionsModePolicy === "allow") &&
    bypassPermissionsModePolicy !== "disable";

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

  // Then apply one source-aware canonical snapshot. Reusing the flattened
  // ConfigStore projection here would erase provenance and could reintroduce
  // lower-priority grants after a managed-only policy filtered them out.
  const permissionSnapshot = await loadPermissionRulesSnapshot(canonicalEnv);
  const canonicalRules = filterRepositoryControlledPermissionGrants(
    permissionSnapshot.rules,
  );
  const ignoredGrantCount =
    permissionSnapshot.rules.length - canonicalRules.length +
    (canonicalEnv.configStore?.ignored().filter(
      (item) =>
        (item.scope === "project" || item.scope === "local") &&
        item.key === "permissions.allow",
    ).length ?? 0);
  if (ignoredGrantCount > 0) {
    warnings.push(
      `Ignored ${ignoredGrantCount} repository-controlled permission allow ${ignoredGrantCount === 1 ? "rule" : "rules"}; project/local settings may restrict but cannot grant capabilities`,
    );
  }
  ctx = applyPermissionRulesSnapshot(ctx, permissionSnapshot);

  // Add --add-dir directories.
  if (permissionSnapshot.managedOnly && (opts.addDirs?.length ?? 0) > 0) {
    warnings.push(
      "Ignored --add-dir because managed policy allows only managed permission rules",
    );
  } else if (opts.addDirs && opts.addDirs.length > 0) {
    const cwd = canonicalEnv.cwd ?? process.cwd();
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

  return { toolPermissionContext: ctx, warnings };
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
