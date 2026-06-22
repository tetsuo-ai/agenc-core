/**
 * Ports the donor startup migration runner shape onto AgenC-owned config and
 * settings migrations.
 *
 * Donor sources at commit 0ca43335375beec6e58711b797d5b0c4bb5019b8:
 * - src/main.tsx
 * - src/migrations/resetProToOpusDefault.ts
 * - src/migrations/resetAutoModeOptInForDefaultOffer.ts
 * - src/migrations/migrateEnableAllProjectMcpServersToSettings.ts
 * - src/migrations/migrateLegacyOpusToCurrent.ts
 * - src/migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.ts
 * - src/migrations/migrateSonnet1mToSonnet45.ts
 * - src/migrations/migrateFennecToOpus.ts
 * - src/migrations/migrateOpusToOpus1m.ts
 * - src/migrations/migrateAutoUpdatesToSettings.ts
 * - src/migrations/migrateSonnet45ToSonnet46.ts
 * - src/migrations/migrateBypassPermissionsAcceptedToSettings.ts
 *
 * `migrateRawAgenCConfig` is intentionally side-effect free and safe for
 * `loadConfig()`. `runStartupConfigMigrations` performs settings-file writes
 * only from explicit startup call sites.
 */

import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { isRecord } from "../../utils/record.js";

export const CURRENT_CONFIG_MIGRATION_VERSION = 11;
export const CONFIG_MIGRATION_VERSION_KEY = "configMigrationVersion";

type JsonRecord = Record<string, unknown>;
type SettingsModule = typeof import("../../permissions/settings.js");
type SettingsReader = SettingsModule["readSettingsFileLenient"];
type SettingsPathResolver = SettingsModule["getSettingsFilePathForSource"];
type DiskEnv = NonNullable<Parameters<SettingsPathResolver>[1]>;

export interface ConfigStoreLike {
  current(): {
    readonly _unknown?: Readonly<Record<string, unknown>>;
    readonly project_root_markers?: readonly string[];
  };
}

export interface StartupConfigMigrationsOptions {
  readonly home?: string;
  readonly cwd?: string;
  readonly configStore?: ConfigStoreLike;
  readonly onWarn?: (message: string) => void;
}

export interface StartupConfigMigrationsResult {
  readonly wrote: boolean;
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

interface SettingsReadResult {
  readonly path: string;
  readonly exists: boolean;
  readonly value: JsonRecord;
}

interface MutableMigrationResult {
  wrote: boolean;
  readonly applied: string[];
  readonly skipped: string[];
}

const SETTINGS_MCP_KEYS = Object.freeze([
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
] as const);

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    );
  }
  return value;
}

function cloneRecord(value: Readonly<Record<string, unknown>>): JsonRecord {
  return cloneJsonValue(value) as JsonRecord;
}

function renameAlias(
  record: JsonRecord,
  alias: string,
  canonical: string,
): void {
  if (!hasOwn(record, alias)) return;
  if (!hasOwn(record, canonical)) {
    record[canonical] = record[alias];
  }
  delete record[alias];
}

function normalizeProviderValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.trim().toLowerCase() === "xai" ? "grok" : value;
}

function normalizeProfileConfig(profile: unknown): unknown {
  if (!isRecord(profile)) return profile;
  const out = cloneRecord(profile);
  renameAlias(out, "modelProvider", "model_provider");
  renameAlias(out, "provider", "model_provider");
  if (hasOwn(out, "model_provider")) {
    out.model_provider = normalizeProviderValue(out.model_provider);
  }
  return out;
}

function normalizeProfiles(rawProfiles: unknown): unknown {
  if (!isRecord(rawProfiles)) return rawProfiles;
  const profiles = cloneRecord(rawProfiles);
  for (const [name, profile] of Object.entries(profiles)) {
    profiles[name] = normalizeProfileConfig(profile);
  }
  return profiles;
}

function normalizeProviders(rawProviders: unknown): unknown {
  if (!isRecord(rawProviders)) return rawProviders;
  const providers = cloneRecord(rawProviders);
  if (hasOwn(providers, "xai")) {
    if (!hasOwn(providers, "grok")) {
      providers.grok = providers.xai;
    }
    delete providers.xai;
  }
  return providers;
}

export function migrateRawAgenCConfig(
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out = cloneRecord(raw);

  renameAlias(out, "modelProvider", "model_provider");
  renameAlias(out, "provider", "model_provider");
  if (hasOwn(out, "model_provider")) {
    out.model_provider = normalizeProviderValue(out.model_provider);
  }

  if (hasOwn(out, "replBridgeEnabled")) {
    if (!hasOwn(out, "remoteControlAtStartup")) {
      out.remoteControlAtStartup = Boolean(out.replBridgeEnabled);
    }
    delete out.replBridgeEnabled;
  }

  if (hasOwn(out, "profiles")) {
    out.profiles = normalizeProfiles(out.profiles);
  }
  if (hasOwn(out, "providers")) {
    out.providers = normalizeProviders(out.providers);
  }

  return out;
}

function readConfigMigrationVersion(settings: JsonRecord): number {
  const raw = settings[CONFIG_MIGRATION_VERSION_KEY];
  const numeric =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : 0;
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function markConfigMigrationVersion(settings: JsonRecord): void {
  settings[CONFIG_MIGRATION_VERSION_KEY] = CURRENT_CONFIG_MIGRATION_VERSION;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function didChange(before: JsonRecord, after: JsonRecord): boolean {
  return stableJson(before) !== stableJson(after);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

async function readSettingsRecord(params: {
  readonly label: string;
  readonly path: string | null;
  readonly readSettingsFileLenient: SettingsReader;
  readonly onWarn: (message: string) => void;
}): Promise<SettingsReadResult | null> {
  if (params.path === null) {
    params.onWarn(
      `[agenc:config-migrations] skipped ${params.label}: settings path unavailable`,
    );
    return null;
  }
  const exists = existsSync(params.path);
  if (!exists) {
    return { path: params.path, exists: false, value: {} };
  }
  const parsed = await params.readSettingsFileLenient(params.path);
  if (parsed === null) {
    params.onWarn(
      `[agenc:config-migrations] skipped ${params.label}: invalid JSON at ${params.path}`,
    );
    return null;
  }
  return {
    path: params.path,
    exists: true,
    value: cloneRecord(parsed),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mergeStringArrays(
  existing: unknown,
  additions: unknown,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [...stringArray(existing), ...stringArray(additions)]) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function addWorkspaceAcceptance(
  settings: JsonRecord,
  workspacePath: string,
): void {
  const existing = stringArray(settings.bypassPermissionsModeAcceptedIn);
  if (!existing.includes(workspacePath)) {
    settings.bypassPermissionsModeAcceptedIn = [...existing, workspacePath];
  } else if (Array.isArray(settings.bypassPermissionsModeAcceptedIn)) {
    settings.bypassPermissionsModeAcceptedIn = existing;
  }
}

function hasLegacyBypassInConfig(configStore: ConfigStoreLike | undefined): boolean {
  const unknown = configStore?.current()._unknown;
  return Boolean(
    unknown &&
      typeof unknown === "object" &&
      unknown.bypassPermissionsModeAccepted === true,
  );
}

async function runUserSettingsMigrations(params: {
  readonly path: string | null;
  readonly readSettingsFileLenient: SettingsReader;
  readonly configStore?: ConfigStoreLike;
  readonly cwd?: string;
  readonly onWarn: (message: string) => void;
  readonly result: MutableMigrationResult;
}): Promise<void> {
  const read = await readSettingsRecord({
    label: "user settings migrations",
    path: params.path,
    readSettingsFileLenient: params.readSettingsFileLenient,
    onWarn: params.onWarn,
  });
  if (read === null) {
    params.result.skipped.push("userSettings");
    return;
  }

  const original = cloneRecord(read.value);
  if (readConfigMigrationVersion(read.value) >= CURRENT_CONFIG_MIGRATION_VERSION) {
    params.result.skipped.push("userSettings:current");
    return;
  }

  const legacyBypass =
    read.value.bypassPermissionsModeAccepted === true ||
    hasLegacyBypassInConfig(params.configStore);
  const workspacePath =
    typeof params.cwd === "string" && params.cwd.trim().length > 0
      ? pathResolve(params.cwd)
      : undefined;

  if (legacyBypass && workspacePath === undefined) {
    params.onWarn(
      "[agenc:config-migrations] skipped bypass permission acceptance migration: workspace unavailable",
    );
    params.result.skipped.push("userSettings:bypassPermissionsModeAccepted");
    return;
  }

  if (legacyBypass && workspacePath !== undefined) {
    addWorkspaceAcceptance(read.value, workspacePath);
    delete read.value.bypassPermissionsModeAccepted;
    params.result.applied.push("userSettings:bypassPermissionsModeAccepted");
  } else if (hasOwn(read.value, "bypassPermissionsModeAccepted")) {
    delete read.value.bypassPermissionsModeAccepted;
    params.result.applied.push("userSettings:bypassPermissionsModeAccepted");
  }

  if (!read.exists && !didChange(original, read.value)) return;
  markConfigMigrationVersion(read.value);
  try {
    writeJsonAtomic(read.path, read.value);
    params.result.wrote = true;
  } catch (error) {
    params.onWarn(
      `[agenc:config-migrations] failed to write ${read.path}: ${String(error)}`,
    );
    params.result.skipped.push("userSettings:write-failed");
  }
}

function hasProjectMcpLegacyKeys(projectSettings: JsonRecord): boolean {
  return SETTINGS_MCP_KEYS.some((key) => hasOwn(projectSettings, key));
}

function applyProjectMcpSettings(
  localSettings: JsonRecord,
  projectSettings: JsonRecord,
): JsonRecord {
  const next = cloneRecord(localSettings);
  if (
    hasOwn(projectSettings, "enableAllProjectMcpServers") &&
    !hasOwn(next, "enableAllProjectMcpServers")
  ) {
    next.enableAllProjectMcpServers = Boolean(
      projectSettings.enableAllProjectMcpServers,
    );
  }
  if (hasOwn(projectSettings, "enabledMcpjsonServers")) {
    next.enabledMcpjsonServers = mergeStringArrays(
      next.enabledMcpjsonServers,
      projectSettings.enabledMcpjsonServers,
    );
  }
  if (hasOwn(projectSettings, "disabledMcpjsonServers")) {
    next.disabledMcpjsonServers = mergeStringArrays(
      next.disabledMcpjsonServers,
      projectSettings.disabledMcpjsonServers,
    );
  }
  return next;
}

function removeProjectMcpSettings(projectSettings: JsonRecord): JsonRecord {
  const next = cloneRecord(projectSettings);
  for (const key of SETTINGS_MCP_KEYS) {
    delete next[key];
  }
  return next;
}

async function runProjectSettingsMigrations(params: {
  readonly projectPath: string | null;
  readonly localPath: string | null;
  readonly readSettingsFileLenient: SettingsReader;
  readonly onWarn: (message: string) => void;
  readonly result: MutableMigrationResult;
}): Promise<void> {
  const local = await readSettingsRecord({
    label: "local settings migrations",
    path: params.localPath,
    readSettingsFileLenient: params.readSettingsFileLenient,
    onWarn: params.onWarn,
  });
  if (local === null) {
    params.result.skipped.push("localSettings");
    return;
  }

  if (readConfigMigrationVersion(local.value) >= CURRENT_CONFIG_MIGRATION_VERSION) {
    params.result.skipped.push("localSettings:current");
    return;
  }

  const project = await readSettingsRecord({
    label: "project settings migrations",
    path: params.projectPath,
    readSettingsFileLenient: params.readSettingsFileLenient,
    onWarn: params.onWarn,
  });
  if (project === null) {
    params.result.skipped.push("projectSettings");
    return;
  }

  const localOriginal = cloneRecord(local.value);
  const hasMcpLegacy = hasProjectMcpLegacyKeys(project.value);

  if (!hasMcpLegacy) {
    if (!local.exists && !didChange(localOriginal, local.value)) return;
    markConfigMigrationVersion(local.value);
    try {
      writeJsonAtomic(local.path, local.value);
      params.result.wrote = true;
    } catch (error) {
      params.onWarn(
        `[agenc:config-migrations] failed to write ${local.path}: ${String(error)}`,
      );
      params.result.skipped.push("localSettings:write-failed");
    }
    return;
  }

  const localWithMcp = applyProjectMcpSettings(local.value, project.value);
  const projectCleaned = removeProjectMcpSettings(project.value);

  try {
    if (didChange(local.value, localWithMcp) || local.exists) {
      writeJsonAtomic(local.path, localWithMcp);
      params.result.wrote = true;
    }
    writeJsonAtomic(project.path, projectCleaned);
    params.result.wrote = true;
    markConfigMigrationVersion(localWithMcp);
    writeJsonAtomic(local.path, localWithMcp);
    params.result.wrote = true;
    params.result.applied.push("localSettings:mcpProjectApprovals");
  } catch (error) {
    params.onWarn(
      `[agenc:config-migrations] failed to migrate MCP project approvals: ${String(error)}`,
    );
    params.result.skipped.push("localSettings:mcpProjectApprovals");
  }
}

function buildDiskEnv(
  opts: StartupConfigMigrationsOptions,
): DiskEnv {
  return {
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.configStore !== undefined
      ? { configStore: opts.configStore as DiskEnv["configStore"] }
      : {}),
  };
}

export async function runStartupConfigMigrations(
  opts: StartupConfigMigrationsOptions = {},
): Promise<StartupConfigMigrationsResult> {
  const onWarn = opts.onWarn ?? ((message: string) => console.warn(message));
  const result: MutableMigrationResult = {
    wrote: false,
    applied: [],
    skipped: [],
  };

  let settings: SettingsModule;
  try {
    settings = await import("../../permissions/settings.js");
  } catch (error) {
    onWarn(
      `[agenc:config-migrations] failed to load settings migration helpers: ${String(error)}`,
    );
    return Object.freeze(result);
  }

  let userPath: string | null;
  let projectPath: string | null;
  let localPath: string | null;
  try {
    const diskEnv = buildDiskEnv(opts);
    userPath = settings.getSettingsFilePathForSource("userSettings", diskEnv);
    projectPath = settings.getSettingsFilePathForSource(
      "projectSettings",
      diskEnv,
    );
    localPath = settings.getSettingsFilePathForSource("localSettings", diskEnv);
  } catch (error) {
    onWarn(
      `[agenc:config-migrations] failed to resolve settings paths: ${String(error)}`,
    );
    return Object.freeze(result);
  }

  await runUserSettingsMigrations({
    path: userPath,
    readSettingsFileLenient: settings.readSettingsFileLenient,
    configStore: opts.configStore,
    cwd: opts.cwd,
    onWarn,
    result,
  });
  await runProjectSettingsMigrations({
    projectPath,
    localPath,
    readSettingsFileLenient: settings.readSettingsFileLenient,
    onWarn,
    result,
  });

  return Object.freeze({
    wrote: result.wrote,
    applied: Object.freeze([...result.applied]),
    skipped: Object.freeze([...result.skipped]),
  });
}
