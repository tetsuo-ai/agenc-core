import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
} from "node:path";

import {
  editorForEnv,
  formatConfigSnapshot,
  getConfigFilePath,
  getConfigPath,
} from "../commands/config.js";
import { readTextFile } from "../config/_deps/file-read.js";
import {
  applyEnvOverrides,
  resolveAgencHome,
  type EnvSnapshot,
} from "../config/env.js";
import {
  cloneJsonValue,
  cloneRecord,
  isPlainRecord,
  stableJson,
  type JsonRecord,
} from "../config/json.js";
import { loadConfig, parseToml } from "../config/loader.js";
import {
  CONFIG_FILE_VERSION_KEY,
  CURRENT_CONFIG_FILE_VERSION,
  runConfigFileMigrations,
  serializeConfigToml,
  type ConfigFileMigrationResult,
} from "../config/migrate.js";
import {
  normalizeAgenCKeyAliases,
  normalizeRawConfig,
  validateAgenCConfigBlocks,
  validatePermissionsConfig,
  type AgenCConfig,
} from "../config/schema.js";
import { migrateRawAgenCConfig } from "../state/migrations/config-migrations.js";

export type AgenCConfigCliCommand =
  | { readonly kind: "show" }
  | { readonly kind: "get"; readonly key: string }
  | { readonly kind: "set"; readonly key: string; readonly value: string }
  | { readonly kind: "unset"; readonly key: string }
  | { readonly kind: "validate" }
  | { readonly kind: "edit" }
  | { readonly kind: "path" }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCConfigCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface ConfigEditorSpawner {
  (command: string, args: readonly string[]): Promise<number>;
}

export interface AgenCConfigCliOptions {
  readonly agencHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly io?: AgenCConfigCliIo;
  readonly spawner?: ConfigEditorSpawner;
}

interface WritableConfigTarget {
  readonly path: string;
  readonly displayPath: string;
  readonly exists: boolean;
  readonly mode: number;
}

const DEFAULT_FILE_MODE = 0o600;
const CONFIG_PATH_LIMITATION =
  "Dot paths split on '.'; use 'agenc config edit' for keys containing literal dots.";
const FORBIDDEN_CONFIG_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);
const UNSAFE_MIGRATION_SKIPS = new Set([
  "toml:read-failed",
  "toml:invalid",
  "toml:duplicate-keys",
  "toml:future-version",
  "toml:unsupported",
  "toml:write-failed",
  "json:read-failed",
  "json:invalid",
  "json:not-object",
  "json:unsupported",
  "json:write-failed",
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
    "",
    "Values:",
    "  Values are parsed as TOML when possible: true, 123, [\"a\"], { enabled = true }.",
    "  Unquoted single-line text is stored as a string.",
    `  ${CONFIG_PATH_LIMITATION}`,
    "",
    "Examples:",
    "  agenc config show",
    "  agenc config get model",
    "  agenc config set permissions.default_mode never",
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
  const agencHome = options.agencHome ?? resolveAgencHome(env);

  try {
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
        return await runConfigShow(agencHome, env, io);
      case "get":
        return await runConfigGet(command.key, agencHome, env, io);
      case "validate":
        return await runConfigValidate(agencHome, env, io);
      case "set":
        return await runConfigSet(command.key, command.value, agencHome, io);
      case "unset":
        return await runConfigUnset(command.key, agencHome, io);
      case "edit":
        return await runConfigEdit(
          agencHome,
          env,
          options.spawner ?? defaultSpawnEditor,
          io,
        );
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

async function runConfigShow(
  agencHome: string,
  env: EnvSnapshot,
  io: AgenCConfigCliIo,
): Promise<number> {
  await runConfigMigrationForRead(agencHome, io);
  const loaded = await loadEffectiveConfigForCli(agencHome, env, io);
  if (loaded.parseError !== undefined) {
    io.stderr.write(`agenc: config is invalid: ${loaded.parseError}\n`);
    return 1;
  }
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
  agencHome: string,
  env: EnvSnapshot,
  io: AgenCConfigCliIo,
): Promise<number> {
  assertReadableConfigPath(key);
  await runConfigMigrationForRead(agencHome, io);
  const loaded = await loadEffectiveConfigForCli(agencHome, env, io);
  if (loaded.parseError !== undefined) {
    io.stderr.write(`agenc: config is invalid: ${loaded.parseError}\n`);
    return 1;
  }
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
  agencHome: string,
  env: EnvSnapshot,
  io: AgenCConfigCliIo,
): Promise<number> {
  await runConfigMigrationForRead(agencHome, io);
  // Round-2 M-NEW5: previously `runConfigValidate` only returned
  // non-zero on parse failures, ignoring warnings emitted during
  // schema validation. A config with unknown keys, deprecated fields,
  // or invalid value coercions would print warnings to stderr but
  // still exit 0 — making `agenc config validate` lie about validity.
  // Capture warnings via the onWarn channel and fail the command if
  // any fired.
  const warnings: string[] = [];
  const captureWarn = (message: string): void => {
    warnings.push(message);
    io.stderr.write(`${message}\n`);
  };
  const loaded = await loadConfig({ home: agencHome, onWarn: captureWarn });
  const config = applyEnvOverrides(loaded.config, env, captureWarn);
  if (loaded.parseError !== undefined) {
    io.stderr.write(
      `agenc: config validation failed: ${loaded.parseError}\n`,
    );
    return 1;
  }
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
  io.stdout.write(`Config valid: ${loaded.path}\n`);
  return 0;
}

async function loadEffectiveConfigForCli(
  agencHome: string,
  env: EnvSnapshot,
  io: AgenCConfigCliIo,
): Promise<{
  readonly config: AgenCConfig;
  readonly path: string;
  readonly parseError?: string;
}> {
  const onWarn = (message: string): void => {
    io.stderr.write(`${message}\n`);
  };
  const loaded = await loadConfig({
    home: agencHome,
    onWarn,
  });
  return {
    config: applyEnvOverrides(loaded.config, env, onWarn),
    path: loaded.path,
    ...(loaded.parseError !== undefined ? { parseError: loaded.parseError } : {}),
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
  const target = await prepareConfigEditTarget(agencHome, io);
  const raw = target.exists ? await readConfigTomlRaw(target.path) : {};
  const next = prepareRawConfigForWrite(raw);
  setNestedValue(next, segments, value);
  await validateAndWriteConfig(next, target);
  io.stdout.write(`Set ${key} in ${target.displayPath}\n`);
  return 0;
}

async function runConfigUnset(
  key: string,
  agencHome: string,
  io: AgenCConfigCliIo,
): Promise<number> {
  const segments = parseEditablePath(key);
  assertEditableConfigPath(segments);
  const target = await prepareConfigEditTarget(agencHome, io);
  if (!target.exists) {
    io.stdout.write(`not set: ${key}\n`);
    return 0;
  }
  const raw = await readConfigTomlRaw(target.path);
  const next = prepareRawConfigForWrite(raw);
  if (!deleteNestedValue(next, segments)) {
    io.stdout.write(`not set: ${key}\n`);
    return 0;
  }
  await validateAndWriteConfig(next, target);
  io.stdout.write(`Unset ${key} in ${target.displayPath}\n`);
  return 0;
}

async function runConfigEdit(
  agencHome: string,
  env: NodeJS.ProcessEnv,
  spawner: ConfigEditorSpawner,
  io: AgenCConfigCliIo,
): Promise<number> {
  await prepareConfigEditTarget(agencHome, io);
  const path = getConfigFilePath(agencHome);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const editor = parseEditorCommand(editorForEnv(env));
  const code = await spawner(editor.command, [...editor.args, path]);
  if (code !== 0) {
    io.stderr.write(`agenc: editor "${editor.command}" exited with code ${code}. File path: ${path}\n`);
    return 1;
  }
  io.stdout.write(`Edited ${path}\n`);
  return 0;
}

const defaultSpawnEditor: ConfigEditorSpawner = (command, args) =>
  new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], { stdio: "inherit" });
      child.on("exit", (code) => resolve(code ?? 0));
      child.on("error", () => resolve(127));
    } catch {
      resolve(127);
    }
  });

function parseEditorCommand(raw: string): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const parts = splitCommandLine(raw);
  const command = parts[0]?.trim();
  if (command === undefined || command.length === 0) {
    throw new Error("EDITOR resolved to an empty command");
  }
  return {
    command,
    args: parts.slice(1),
  };
}

function splitCommandLine(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  const push = (): void => {
    if (current.length > 0) {
      args.push(current);
      current = "";
    }
  };

  for (const char of raw.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      push();
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote !== null) {
    throw new Error("EDITOR contains an unterminated quote");
  }
  push();
  return args;
}

async function runConfigMigrationForRead(
  agencHome: string,
  io: AgenCConfigCliIo,
): Promise<void> {
  const configPath = getConfigFilePath(agencHome);
  const initialTarget = await resolveWritableConfigTarget(configPath);
  const migrationResult = await runConfigFileMigrations({
    home: agencHome,
    configTomlPath: initialTarget.path,
    parseToml,
    onWarn: (message) => io.stderr.write(`${message}\n`),
  });
  const target = await resolveWritableConfigTarget(configPath);
  await assertMigrationAllowsEdit({
    result: migrationResult,
    tomlExists: target.exists,
    jsonExists: await pathIsFile(join(agencHome, "config.json")),
  });
}

async function prepareConfigEditTarget(
  agencHome: string,
  io: AgenCConfigCliIo,
): Promise<WritableConfigTarget> {
  const configPath = getConfigFilePath(agencHome);
  const initialTarget = await resolveWritableConfigTarget(configPath);
  const migrationResult = await runConfigFileMigrations({
    home: agencHome,
    configTomlPath: initialTarget.path,
    parseToml,
    onWarn: (message) => io.stderr.write(`${message}\n`),
  });
  const target = await resolveWritableConfigTarget(configPath);
  await assertMigrationAllowsEdit({
    result: migrationResult,
    tomlExists: target.exists,
    jsonExists: await pathIsFile(join(agencHome, "config.json")),
  });
  return target;
}

async function assertMigrationAllowsEdit(params: {
  readonly result: ConfigFileMigrationResult;
  readonly tomlExists: boolean;
  readonly jsonExists: boolean;
}): Promise<void> {
  const unsafeSkip = params.result.skipped.find((skip) =>
    UNSAFE_MIGRATION_SKIPS.has(skip)
  );
  if (unsafeSkip !== undefined) {
    throw new Error(
      `cannot edit config.toml after skipped config migration (${unsafeSkip})`,
    );
  }
  if (!params.tomlExists && params.jsonExists) {
    throw new Error(
      "cannot edit config.toml because config.json could not be migrated safely",
    );
  }
}

async function resolveWritableConfigTarget(
  configPath: string,
): Promise<WritableConfigTarget> {
  let linkInfo;
  try {
    linkInfo = await lstat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path: configPath,
        displayPath: configPath,
        exists: false,
        mode: DEFAULT_FILE_MODE,
      };
    }
    throw error;
  }

  const path = linkInfo.isSymbolicLink()
    ? await resolveExistingSymlinkTarget(configPath)
    : configPath;
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`config path is not a file: ${configPath}`);
  }
  return {
    path,
    displayPath: configPath,
    exists: true,
    mode: modeOrDefault(info.mode & 0o777),
  };
}

async function resolveExistingSymlinkTarget(configPath: string): Promise<string> {
  try {
    return await realpath(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`config symlink target does not exist: ${configPath}`);
    }
    throw error;
  }
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function modeOrDefault(mode: number): number {
  return mode > 0 ? mode : DEFAULT_FILE_MODE;
}

async function readConfigTomlRaw(path: string): Promise<JsonRecord> {
  const text = await readTextFile(path);
  let sawDuplicateKey = false;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text, {
      onDuplicateKey: () => {
        sawDuplicateKey = true;
      },
    }) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`invalid TOML at ${path}: ${errorMessage(error)}`);
  }
  if (sawDuplicateKey) {
    throw new Error(`cannot edit ${path}: duplicate TOML keys must be resolved first`);
  }
  return cloneRecord(parsed);
}

function prepareRawConfigForWrite(raw: Readonly<Record<string, unknown>>): JsonRecord {
  const aliased = normalizeAgenCKeyAliases(cloneRecord(raw));
  const migrated = migrateRawAgenCConfig(aliased);
  migrated[CONFIG_FILE_VERSION_KEY] = CURRENT_CONFIG_FILE_VERSION;
  return migrated;
}

async function validateAndWriteConfig(
  raw: JsonRecord,
  target: WritableConfigTarget,
): Promise<void> {
  validateRawConfigForCli(raw);
  const serialized = serializeConfigToml(raw);
  const parsed = parseToml(serialized) as Record<string, unknown>;
  if (stableJson(parsed) !== stableJson(raw)) {
    throw new Error("serialized config.toml did not round-trip");
  }
  await writeTextAtomic(target.path, serialized, target.mode);
}

function validateRawConfigForCli(raw: Readonly<Record<string, unknown>>): void {
  const validated = validateAgenCConfigBlocks(normalizeRawConfig(cloneRecord(raw)));
  validatePermissionsConfig(validated.permissions);
}

function validateLoadedConfigForCli(config: AgenCConfig): void {
  const validated = validateAgenCConfigBlocks(config);
  validatePermissionsConfig(validated.permissions);
}

async function writeTextAtomic(
  path: string,
  text: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(dirname(path), ".agenc-config-"));
  const tempPath = join(tempDir, basename(path));
  try {
    await writeFile(tempPath, text, {
      encoding: "utf8",
      mode: modeOrDefault(mode),
    });
    await rename(tempPath, path);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
  if (segments[0] === CONFIG_FILE_VERSION_KEY) {
    throw new Error(`${CONFIG_FILE_VERSION_KEY} is managed by AgenC`);
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
