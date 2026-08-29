/**
 * `agenc config` show/get/set/unset/validate/edit/path.
 */

import {
  editorForEnv,
  formatConfigSnapshot,
  getConfigFilePath,
  getConfigPath,
} from "../commands/config.js";
import {
  editCanonicalUserConfig,
  spawnConfigEditor,
  type ConfigEditorSpawner,
} from "../config/editor.js";
import {
  resolveAgencHome,
} from "../config/env.js";
import {
  cloneJsonValue,
  isPlainRecord,
  type JsonRecord,
} from "../config/json.js";
import {
  assertConfigPatchAuthority,
} from "../config/layer-authority.js";
import { parseToml } from "../config/loader.js";
import type { ConfigV2MigrationOptions } from "../config/migration.js";
import {
  CANONICAL_CONFIG_VERSION_KEY,
  assertNoRetiredConfigInputsForMutation,
  loadCanonicalConfig,
  type LayeredConfigRepositoryOptions,
} from "../config/repository.js";
import {
  validateAgenCConfigBlocks,
  validatePermissionsConfig,
  type AgenCConfig,
} from "../config/schema.js";
import { mutateCanonicalUserConfigSync } from "../config/update-sync.js";

export type { ConfigEditorSpawner } from "../config/editor.js";

export type AgenCConfigCliCommand =
  | { readonly kind: "show" }
  | { readonly kind: "get"; readonly key: string }
  | { readonly kind: "set"; readonly key: string; readonly value: string }
  | { readonly kind: "unset"; readonly key: string }
  | { readonly kind: "validate" }
  | { readonly kind: "edit" }
  | { readonly kind: "path" }
  | {
      readonly kind: "migrate";
      readonly action: "check" | "apply";
      readonly retireSharedSecureStorage: boolean;
      readonly confirmRetiredWritersStopped: boolean;
      readonly retiredSecureStorageAccount?: string;
    }
  | { readonly kind: "migrate"; readonly action: "rollback"; readonly id: string }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCConfigCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface AgenCConfigCliOptions {
  readonly agencHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly io?: AgenCConfigCliIo;
  readonly spawner?: ConfigEditorSpawner;
  readonly cwd?: string;
  readonly projectRoot?: string;
  readonly managedConfigPath?: string;
  readonly managedSettingsPath?: string;
  readonly globalStatePath?: string;
  readonly platformHome?: string;
}

const CONFIG_PATH_LIMITATION =
  "Dot paths split on '.'; use 'agenc config edit' for keys containing literal dots.";
const FORBIDDEN_CONFIG_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);
export function formatAgenCConfigCliHelpText(): string {
  return [
    "Usage: agenc config <command> [args]",
    "",
    "Commands:",
    "  show                         Print the effective config snapshot",
    "  get <dot.path>               Print one effective config value",
    "  set <dot.path> <value>       Write one value to config.toml",
    "  unset <dot.path>             Remove one value from config.toml",
    "  validate                     Validate config.toml and schema blocks",
    "  edit                         Open config.toml in the configured editor",
    "  path                         Print the config.toml path",
    "  migrate [check|apply] [--confirm-retired-writers-stopped] [--retire-shared-secure-storage] [--retired-secure-storage-account <name>]",
    "                               Plan or apply the explicit schema-v2 migration",
    "                               One-way credential cleanup requires the stopped-writer confirmation",
    "                               The destructive flag asserts no other/default home owns the old shared secure-storage record",
    "                               The account flag selects only a historical USER-bound secure-storage source",
    "  migrate rollback <id>        Roll back one journaled schema-v2 migration",
    "                               (never recreates deleted plaintext credentials)",
    "",
    "Values:",
    "  Values are parsed as TOML when possible: true, 123, [\"a\"], { enabled = true }.",
    "  Unquoted single-line text is stored as a string.",
    `  ${CONFIG_PATH_LIMITATION}`,
    "",
    "Examples:",
    "  agenc config show",
    "  agenc config get model",
    "  agenc config set approval_policy never",
    "  agenc config set plugins.enabled true",
    "  agenc config unset plugins.plugins.example.enabled",
    "  agenc config validate",
  ].join("\n");
}

export function parseAgenCConfigCliArgs(
  argv: readonly string[],
): AgenCConfigCliCommand | null {
  if (argv[0] !== "config") return null;
  const action = argv[1];
  if (action === undefined || isHelpArg(action)) {
    return { kind: "help", text: formatAgenCConfigCliHelpText() };
  }
  const rest = argv.slice(2);
  if (rest.length === 1 && isHelpArg(rest[0]!)) {
    return { kind: "help", text: formatAgenCConfigCliHelpText() };
  }

  switch (action) {
    case "show":
      return noArgs(action, rest) ?? { kind: "show" };
    case "get": {
      const key = rest[0]?.trim();
      if (key === undefined || key.length === 0) {
        return { kind: "error", message: "config get requires a dot path" };
      }
      if (rest.length !== 1) {
        return { kind: "error", message: "config get accepts exactly one dot path" };
      }
      return { kind: "get", key };
    }
    case "set": {
      const key = rest[0]?.trim();
      if (key === undefined || key.length === 0) {
        return { kind: "error", message: "config set requires a dot path" };
      }
      if (rest.length < 2) {
        return { kind: "error", message: "config set requires a value" };
      }
      return { kind: "set", key, value: rest.slice(1).join(" ") };
    }
    case "unset": {
      const key = rest[0]?.trim();
      if (key === undefined || key.length === 0) {
        return { kind: "error", message: "config unset requires a dot path" };
      }
      if (rest.length !== 1) {
        return { kind: "error", message: "config unset accepts exactly one dot path" };
      }
      return { kind: "unset", key };
    }
    case "validate":
      return noArgs(action, rest) ?? { kind: "validate" };
    case "edit":
      return noArgs(action, rest) ?? { kind: "edit" };
    case "path":
      return noArgs(action, rest) ?? { kind: "path" };
    case "migrate": {
      const migrationAction = rest[0] ?? "check";
      if (migrationAction === "check" || migrationAction === "apply") {
        const flags = rest.slice(1);
        let retireSharedSecureStorage = false;
        let confirmRetiredWritersStopped = false;
        let retiredSecureStorageAccount: string | undefined;
        for (let index = 0; index < flags.length; index += 1) {
          const flag = flags[index];
          if (flag === "--retire-shared-secure-storage") {
            if (retireSharedSecureStorage) {
              return { kind: "error", message: `${flag} may be specified only once` };
            }
            retireSharedSecureStorage = true;
            continue;
          }
          if (flag === "--confirm-retired-writers-stopped") {
            if (confirmRetiredWritersStopped) {
              return { kind: "error", message: `${flag} may be specified only once` };
            }
            confirmRetiredWritersStopped = true;
            continue;
          }
          if (flag === "--retired-secure-storage-account") {
            const value = flags[index + 1]?.trim();
            if (
              retiredSecureStorageAccount !== undefined ||
              value === undefined ||
              value.length === 0 ||
              value.startsWith("--")
            ) {
              return {
                kind: "error",
                message: `${flag} requires exactly one account name and may be specified only once`,
              };
            }
            retiredSecureStorageAccount = value;
            index += 1;
            continue;
          }
          return {
            kind: "error",
            message:
              `config migrate ${migrationAction} accepts only --confirm-retired-writers-stopped, --retire-shared-secure-storage, and --retired-secure-storage-account <name>`,
          };
        }
        return {
          kind: "migrate",
          action: migrationAction,
          retireSharedSecureStorage,
          confirmRetiredWritersStopped,
          ...(retiredSecureStorageAccount !== undefined
            ? { retiredSecureStorageAccount }
            : {}),
        };
      }
      if (migrationAction === "rollback") {
        const id = rest[1]?.trim();
        if (!id || rest.length !== 2) {
          return { kind: "error", message: "config migrate rollback requires exactly one migration id" };
        }
        return { kind: "migrate", action: "rollback", id };
      }
      return { kind: "error", message: `unknown config migrate action: ${migrationAction}` };
    }
    default:
      return { kind: "error", message: `unknown config command: ${action}` };
  }
}

export async function runAgenCConfigCli(
  command: AgenCConfigCliCommand,
  options: AgenCConfigCliOptions = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const env = options.env ?? process.env;

  try {
    if (command.kind === "migrate") {
      return await runConfigMigrate(command, options, io);
    }
    const agencHome = options.agencHome ?? resolveAgencHome(env);
    const repositoryOptions: LayeredConfigRepositoryOptions = {
      env: options.agencHome === undefined ? env : { ...env, AGENC_HOME: agencHome },
      cwd: options.cwd,
      projectRoot: options.projectRoot,
      managedConfigPath: options.managedConfigPath,
    };
    switch (command.kind) {
      case "help":
        io.stdout.write(`${command.text}\n`);
        return 0;
      case "error":
        io.stderr.write(`agenc: ${command.message}\n`);
        io.stderr.write(`${formatAgenCConfigCliHelpText()}\n`);
        return 1;
      case "path":
        io.stdout.write(`${getConfigFilePath(agencHome)}\n`);
        return 0;
      case "show":
        return await runConfigShow(repositoryOptions, io);
      case "get":
        return await runConfigGet(command.key, repositoryOptions, io);
      case "validate":
        return await runConfigValidate(repositoryOptions, io);
      case "set": {
        await assertNoRetiredConfigInputsForMutation(repositoryOptions);
        return await runConfigSet(command.key, command.value, agencHome, io);
      }
      case "unset": {
        await assertNoRetiredConfigInputsForMutation(repositoryOptions);
        return await runConfigUnset(command.key, agencHome, io);
      }
      case "edit": {
        await assertNoRetiredConfigInputsForMutation(repositoryOptions);
        return await runConfigEdit(
          agencHome,
          env,
          options.spawner ?? spawnConfigEditor,
          io,
        );
      }
    }
  } catch (error) {
    io.stderr.write(`agenc: ${errorMessage(error)}\n`);
    return 1;
  }
}

function isHelpArg(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

function noArgs(
  command: string,
  rest: readonly string[],
): AgenCConfigCliCommand | null {
  if (rest.length === 0) return null;
  return {
    kind: "error",
    message: `config ${command} accepts no arguments`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runConfigMigrate(
  command: Extract<AgenCConfigCliCommand, { readonly kind: "migrate" }>,
  options: AgenCConfigCliOptions,
  io: AgenCConfigCliIo,
): Promise<number> {
  const {
    applyConfigV2Migration,
    checkConfigV2Migration,
    rollbackConfigV2Migration,
  } = await import("../config/migration.js");
  const migrationOptions: ConfigV2MigrationOptions = {
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.agencHome !== undefined ? { home: options.agencHome } : {}),
    ...(options.platformHome !== undefined
      ? { platformHome: options.platformHome }
      : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
    ...(options.managedConfigPath !== undefined
      ? { managedConfigPath: options.managedConfigPath }
      : {}),
    ...(options.managedSettingsPath !== undefined
      ? { managedSettingsPath: options.managedSettingsPath }
      : {}),
    ...(options.globalStatePath !== undefined
      ? { globalStatePath: options.globalStatePath }
      : {}),
    ...(command.action !== "rollback" && command.retireSharedSecureStorage
      ? { retireSharedSecureStorage: true }
      : {}),
    ...(command.action !== "rollback" && command.confirmRetiredWritersStopped
      ? { confirmRetiredWritersStopped: true }
      : {}),
    ...(command.action !== "rollback" && command.retiredSecureStorageAccount !== undefined
      ? { retiredSecureStorageAccount: command.retiredSecureStorageAccount }
      : {}),
  };
  if (command.action === "rollback") {
    const rolledBack = await rollbackConfigV2Migration(command.id, migrationOptions);
    io.stdout.write(
      `Rolled back config migration ${rolledBack.id}; restored ${rolledBack.restored} file(s).\n` +
        (rolledBack.credentialsPreserved
          ? "Native secure storage credentials were preserved; deleted plaintext credential inputs were not recreated.\n"
          : "") +
        `Journal: ${rolledBack.journalPath}\n`,
    );
    return 0;
  }

  const plan = await checkConfigV2Migration(migrationOptions);
  const credentialSanitizations =
    (plan.credentialMigration === undefined ? 0 : 1) +
    (plan.retiredAuthMigration?.descriptor.fileActions.length ?? 0);
  io.stdout.write(
    `Config migration ${plan.id}: ${plan.writes.length} write(s), ` +
      `${plan.archivePaths.length} retired-source archive(s), ` +
      `${credentialSanitizations} one-way credential sanitization(s), ` +
      `${plan.conflicts.length} conflict(s).\n`,
  );
  if (credentialSanitizations > 0) {
    io.stdout.write(
      "Credential migration writes the native secure storage first, then deletes each retired plaintext source or rewrites auth.json metadata-only; rollback will not recreate secret fields.\n",
    );
  }
  if (plan.requiresRetiredWriterQuiescence) {
    io.stdout.write(
      "One-way credential cleanup requires every retired AgenC writer to remain stopped from check through apply.\n",
    );
  }
  if (
    plan.secureStorageNamespaceMigration?.sourceDisposition === "retain-shared"
  ) {
    io.stdout.write(
      "The old unscoped native secure storage is shared with the default and possibly other relocated homes, so it will be copied but retained. Stop older AgenC processes and rerun check/apply with --retire-shared-secure-storage only after confirming no other home still owns that record.\n",
    );
  } else if (
    plan.secureStorageNamespaceMigration?.sourceDisposition ===
      "delete-shared-confirmed"
  ) {
    io.stdout.write(
      "Shared native secure storage retirement was explicitly confirmed; all older AgenC processes must remain stopped until apply completes.\n",
    );
  } else if (
    plan.secureStorageNamespaceMigration?.sourceDisposition ===
      "rewrite-in-place"
  ) {
    io.stdout.write(
      "The Windows DPAPI file uses a retired USER-derived entropy identity and will be atomically re-encrypted in place for the stable OS account. All older AgenC processes must remain stopped until apply completes.\n",
    );
  }
  for (const conflict of plan.conflicts) {
    io.stderr.write(
      `conflict [${conflict.scope}] ${conflict.sourcePath}` +
        `${conflict.field ? `:${conflict.field}` : ""}: ${conflict.reason}\n`,
    );
  }
  if (plan.conflicts.length > 0) {
    io.stderr.write("agenc: migration is fail-closed; no files were changed.\n");
    return 1;
  }
  if (command.action === "check") {
    io.stdout.write("Migration check complete; no files were changed.\n");
    return 0;
  }
  if (
    plan.requiresRetiredWriterQuiescence &&
    !plan.retiredWriterQuiescenceConfirmed
  ) {
    io.stderr.write(
      "agenc: apply refused; stop every retired AgenC process, rerun check, then apply with --confirm-retired-writers-stopped.\n",
    );
    return 1;
  }
  const applied = await applyConfigV2Migration(plan);
  io.stdout.write(
    `Applied config migration ${applied.id}: ${applied.writes} write(s), ` +
      `${applied.archives} archived retired source(s), ` +
      `${applied.credentialSourcesSanitized} retired plaintext credential source(s) deleted or rewritten metadata-only.\n` +
      `Journal: ${applied.journalPath}\n`,
  );
  return 0;
}

async function runConfigShow(
  repositoryOptions: LayeredConfigRepositoryOptions,
  io: AgenCConfigCliIo,
): Promise<number> {
  const loaded = await loadEffectiveConfigForCli(repositoryOptions, io);
  try {
    validateLoadedConfigForCli(loaded.config);
  } catch (error) {
    io.stderr.write(`agenc: config is invalid: ${errorMessage(error)}\n`);
    return 1;
  }
  io.stdout.write(`${formatConfigSnapshot(loaded.config)}\n`);
  return 0;
}

async function runConfigGet(
  key: string,
  repositoryOptions: LayeredConfigRepositoryOptions,
  io: AgenCConfigCliIo,
): Promise<number> {
  assertReadableConfigPath(key);
  const loaded = await loadEffectiveConfigForCli(repositoryOptions, io);
  try {
    validateLoadedConfigForCli(loaded.config);
  } catch (error) {
    io.stderr.write(`agenc: config is invalid: ${errorMessage(error)}\n`);
    return 1;
  }
  io.stdout.write(`${getConfigPath(loaded.config, key)}\n`);
  return 0;
}

async function runConfigValidate(
  repositoryOptions: LayeredConfigRepositoryOptions,
  io: AgenCConfigCliIo,
): Promise<number> {
  const warnings: string[] = [];
  const captureWarn = (message: string): void => {
    warnings.push(message);
    io.stderr.write(`${message}\n`);
  };
  const loaded = await loadCanonicalConfig({
    ...repositoryOptions,
    onWarn: captureWarn,
  });
  const config = loaded.config;
  try {
    validateLoadedConfigForCli(config);
  } catch (error) {
    io.stderr.write(
      `agenc: config validation failed: ${errorMessage(error)}\n`,
    );
    return 1;
  }
  if (warnings.length > 0) {
    io.stderr.write(
      `agenc: config validation produced ${warnings.length} warning(s) — see above. Treating as failure.\n`,
    );
    return 1;
  }
  io.stdout.write(
    `Config valid: ${loaded.sources.length} layer(s), home ${loaded.home.path}\n`,
  );
  return 0;
}

async function loadEffectiveConfigForCli(
  repositoryOptions: LayeredConfigRepositoryOptions,
  io: AgenCConfigCliIo,
): Promise<{
  readonly config: AgenCConfig;
}> {
  const onWarn = (message: string): void => {
    io.stderr.write(`${message}\n`);
  };
  const loaded = await loadCanonicalConfig({
    ...repositoryOptions,
    onWarn,
  });
  return {
    config: loaded.config,
  };
}

async function runConfigSet(
  key: string,
  rawValue: string,
  agencHome: string,
  io: AgenCConfigCliIo,
): Promise<number> {
  const segments = parseEditablePath(key);
  assertEditableConfigPath(segments);
  const value = parseConfigSetValue(rawValue);
  assertConfigPatchAuthority("user", { [segments[0]!]: value });
  const path = getConfigFilePath(agencHome);
  mutateCanonicalUserConfigSync(path, (raw) => {
    setNestedValue(raw, segments, value);
  });
  io.stdout.write(`Set ${key} in ${path}\n`);
  return 0;
}

async function runConfigUnset(
  key: string,
  agencHome: string,
  io: AgenCConfigCliIo,
): Promise<number> {
  const segments = parseEditablePath(key);
  assertEditableConfigPath(segments);
  const path = getConfigFilePath(agencHome);
  let removed = false;
  mutateCanonicalUserConfigSync(path, (raw) => {
    removed = deleteNestedValue(raw, segments);
  });
  if (!removed) {
    io.stdout.write(`not set: ${key}\n`);
    return 0;
  }
  io.stdout.write(`Unset ${key} in ${path}\n`);
  return 0;
}

async function runConfigEdit(
  agencHome: string,
  env: NodeJS.ProcessEnv,
  spawner: ConfigEditorSpawner,
  io: AgenCConfigCliIo,
): Promise<number> {
  const path = getConfigFilePath(agencHome);
  const result = await editCanonicalUserConfig({
    path,
    editor: editorForEnv(env),
    spawner,
  });
  if (result.exitCode !== 0) {
    io.stderr.write(`agenc: editor "${result.editorCommand}" exited with code ${result.exitCode}. File path: ${path}\n`);
    return 1;
  }
  io.stdout.write(`Edited ${path}\n`);
  return 0;
}

function validateLoadedConfigForCli(config: AgenCConfig): void {
  const validated = validateAgenCConfigBlocks(config);
  validatePermissionsConfig(validated.permissions);
}

function parseEditablePath(key: string): readonly string[] {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new Error("config path cannot be empty");
  }
  const segments = trimmed.split(".");
  if (segments.some((segment) => segment.trim().length === 0)) {
    throw new Error(`config path cannot contain empty segments: ${key}`);
  }
  return segments.map((segment) => segment.trim());
}

function assertEditableConfigPath(segments: readonly string[]): void {
  if (
    segments[0] === CANONICAL_CONFIG_VERSION_KEY ||
    segments[0] === "configVersion"
  ) {
    throw new Error(`${CANONICAL_CONFIG_VERSION_KEY} is managed by AgenC`);
  }
  assertNoForbiddenPathSegments(segments);
}

function assertReadableConfigPath(key: string): void {
  assertNoForbiddenPathSegments(parseEditablePath(key));
}

function assertNoForbiddenPathSegments(segments: readonly string[]): void {
  const forbidden = segments.find((segment) =>
    FORBIDDEN_CONFIG_PATH_SEGMENTS.has(segment)
  );
  if (forbidden !== undefined) {
    throw new Error(`config path segment is not allowed: ${forbidden}`);
  }
}

function parseConfigSetValue(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    throw new Error("config set requires a non-empty value");
  }
  try {
    const parsed = parseToml(`__value = ${trimmed}\n`) as Record<string, unknown>;
    return cloneJsonValue(parsed.__value);
  } catch (error) {
    if (looksLikeStructuredTomlValue(trimmed)) {
      throw new Error(`invalid TOML value: ${errorMessage(error)}`);
    }
  }
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error("implicit string values must be single-line");
  }
  return trimmed;
}

function looksLikeStructuredTomlValue(value: string): boolean {
  const first = value[0];
  return first === "[" || first === "{" || first === "\"" || first === "'";
}

function setNestedValue(
  root: JsonRecord,
  segments: readonly string[],
  value: unknown,
): void {
  let cur = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const next = cur[segment];
    if (next === undefined) {
      const created: JsonRecord = {};
      cur[segment] = created;
      cur = created;
      continue;
    }
    if (!isPlainRecord(next)) {
      throw new Error(
        `cannot set ${segments.join(".")}: ${segments.slice(0, i + 1).join(".")} is not an object`,
      );
    }
    cur = next;
  }
  cur[segments[segments.length - 1]!] = cloneJsonValue(value);
}

function deleteNestedValue(
  root: JsonRecord,
  segments: readonly string[],
): boolean {
  const stack: Array<{ readonly parent: JsonRecord; readonly key: string }> = [];
  let cur: JsonRecord = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const next = cur[segment];
    if (!isPlainRecord(next)) return false;
    stack.push({ parent: cur, key: segment });
    cur = next;
  }
  const leaf = segments[segments.length - 1]!;
  if (!Object.prototype.hasOwnProperty.call(cur, leaf)) return false;
  delete cur[leaf];

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i]!;
    const value = entry.parent[entry.key];
    if (isPlainRecord(value) && Object.keys(value).length === 0) {
      delete entry.parent[entry.key];
    } else {
      break;
    }
  }
  return true;
}
