import {
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve as pathResolve } from "node:path";

import { migrateRawAgenCConfig } from "../state/migrations/config-migrations.js";
import { readTextFile } from "./_deps/file-read.js";
import { resolveAgencHome } from "./env.js";
import {
  cloneRecord,
  isPlainRecord,
  stableJson,
  type JsonRecord,
} from "./json.js";
import { normalizeAgenCKeyAliases } from "./schema.js";

export const CURRENT_CONFIG_FILE_VERSION = 1;
export const CONFIG_FILE_VERSION_KEY = "configVersion";

export type ConfigMigrationSource = "toml" | "json";

export interface ConfigFileMigrationResult {
  readonly migrated: boolean;
  readonly wrote: boolean;
  readonly backupCreated: boolean;
  readonly skipped: readonly string[];
  readonly source?: ConfigMigrationSource;
  readonly backupPath?: string;
}

export type ConfigTomlParser = (
  src: string,
  options?: { readonly onDuplicateKey?: () => void },
) => Record<string, unknown>;

export interface ConfigFileMigrationOptions {
  readonly home?: string;
  readonly configTomlPath?: string;
  readonly onWarn?: (message: string) => void;
  readonly parseToml: ConfigTomlParser;
}

interface FileState {
  readonly exists: boolean;
  readonly mode: number;
}

interface MutableMigrationResult {
  migrated: boolean;
  wrote: boolean;
  backupCreated: boolean;
  readonly skipped: string[];
  source?: ConfigMigrationSource;
  backupPath?: string;
}

const DEFAULT_FILE_MODE = 0o600;

function resultFrom(mutable: MutableMigrationResult): ConfigFileMigrationResult {
  return Object.freeze({
    migrated: mutable.migrated,
    wrote: mutable.wrote,
    backupCreated: mutable.backupCreated,
    skipped: Object.freeze([...mutable.skipped]),
    ...(mutable.source !== undefined ? { source: mutable.source } : {}),
    ...(mutable.backupPath !== undefined ? { backupPath: mutable.backupPath } : {}),
  });
}

function createResult(): MutableMigrationResult {
  return {
    migrated: false,
    wrote: false,
    backupCreated: false,
    skipped: [],
  };
}

async function fileState(path: string): Promise<FileState> {
  try {
    const info = await stat(path);
    return {
      exists: info.isFile(),
      mode: info.mode & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, mode: DEFAULT_FILE_MODE };
    }
    throw error;
  }
}

function backupPathFor(path: string): string {
  return `${path}.bak-cf12`;
}

function modeOrDefault(mode: number): number {
  return mode > 0 ? mode : DEFAULT_FILE_MODE;
}

async function createBackupIfMissing(
  sourcePath: string,
  sourceMode: number,
): Promise<{ readonly created: boolean; readonly path: string }> {
  const backupPath = backupPathFor(sourcePath);
  const bytes = await readFile(sourcePath);
  try {
    await writeFile(backupPath, bytes, {
      flag: "wx",
      mode: modeOrDefault(sourceMode),
    });
    return { created: true, path: backupPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { created: false, path: backupPath };
    }
    throw error;
  }
}

async function writeFileAtomic(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  const tmp = `${path}.tmp-cf12-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  try {
    await writeFile(tmp, contents, {
      encoding: "utf8",
      mode: modeOrDefault(mode),
    });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseVersion(value: unknown): number | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number.parseInt(value.trim(), 10)
        : undefined;
  return numeric !== undefined &&
    Number.isSafeInteger(numeric) &&
    numeric > 0
    ? numeric
    : undefined;
}

function prepareRawConfigForDisk(raw: Readonly<Record<string, unknown>>): JsonRecord {
  assertTomlWritable(raw, "config");
  const aliased = normalizeAgenCKeyAliases(cloneRecord(raw));
  const migrated = migrateRawAgenCConfig(aliased);
  migrated[CONFIG_FILE_VERSION_KEY] = CURRENT_CONFIG_FILE_VERSION;
  assertTomlWritable(migrated, "config");
  return migrated;
}

function assertTomlWritable(value: unknown, path: string): void {
  if (value === null || value === undefined) {
    throw new Error(`${path} cannot be represented in TOML`);
  }
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be a finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertTomlWritable(item, `${path}.${index}`));
    return;
  }
  if (isPlainRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertTomlWritable(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} has unsupported value type ${typeof value}`);
}

function quoteTomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

function quoteTomlKey(key: string): string {
  return quoteTomlString(key);
}

function tableName(path: readonly string[]): string {
  return path.map(quoteTomlKey).join(".");
}

function serializeInlineValue(value: unknown): string {
  if (typeof value === "string") return quoteTomlString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeInlineValue(item)).join(", ")}]`;
  }
  if (isPlainRecord(value)) {
    const parts = Object.keys(value)
      .sort()
      .map((key) => `${quoteTomlKey(key)} = ${serializeInlineValue(value[key])}`);
    return `{ ${parts.join(", ")} }`;
  }
  throw new Error(`unsupported TOML value: ${String(value)}`);
}

function serializeRecordBody(record: JsonRecord): {
  readonly fields: string[];
  readonly tables: Array<readonly [string, JsonRecord]>;
} {
  const fields: string[] = [];
  const tables: Array<readonly [string, JsonRecord]> = [];
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (isPlainRecord(value)) {
      tables.push([key, value]);
    } else {
      fields.push(`${quoteTomlKey(key)} = ${serializeInlineValue(value)}`);
    }
  }
  return { fields, tables };
}

export function serializeConfigToml(raw: Readonly<Record<string, unknown>>): string {
  const lines: string[] = [];

  function writeTable(path: readonly string[], record: JsonRecord): void {
    const { fields, tables } = serializeRecordBody(record);
    if (path.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(`[${tableName(path)}]`);
    }
    lines.push(...fields);
    for (const [key, value] of tables) {
      writeTable([...path, key], value);
    }
  }

  writeTable([], cloneRecord(raw));
  return `${lines.join("\n").trim()}\n`;
}

function parseSerializedToml(
  serialized: string,
  expected: JsonRecord,
  parseToml: ConfigTomlParser,
): void {
  const parsed = parseToml(serialized);
  if (stableJson(parsed) !== stableJson(expected)) {
    throw new Error("serialized TOML did not round-trip");
  }
}

function shouldSkipFutureVersion(
  raw: Readonly<Record<string, unknown>>,
): boolean {
  const version = parseVersion(raw[CONFIG_FILE_VERSION_KEY]);
  return version !== undefined && version > CURRENT_CONFIG_FILE_VERSION;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

async function migrateTomlConfig(params: {
  readonly path: string;
  readonly state: FileState;
  readonly parseToml: ConfigTomlParser;
  readonly onWarn: (message: string) => void;
  readonly result: MutableMigrationResult;
}): Promise<void> {
  params.result.source = "toml";
  let rawText: string;
  try {
    rawText = await readTextFile(params.path);
  } catch (error) {
    params.onWarn(
      `[agenc:config-migration] skipped config.toml migration: failed to read ${params.path}: ${String(error)}`,
    );
    params.result.skipped.push("toml:read-failed");
    return;
  }

  let parsed: Record<string, unknown>;
  let sawDuplicateKey = false;
  try {
    parsed = params.parseToml(rawText, {
      onDuplicateKey: () => {
        sawDuplicateKey = true;
      },
    });
  } catch (error) {
    params.onWarn(
      `[agenc:config-migration] skipped config.toml migration: invalid TOML at ${params.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    params.result.skipped.push("toml:invalid");
    return;
  }
  if (sawDuplicateKey) {
    params.result.skipped.push("toml:duplicate-keys");
    return;
  }

  if (shouldSkipFutureVersion(parsed)) {
    params.onWarn(
      `[agenc:config-migration] skipped config.toml migration: ${CONFIG_FILE_VERSION_KEY} is newer than this runtime`,
    );
    params.result.skipped.push("toml:future-version");
    return;
  }

  let migrated: JsonRecord;
  let serialized: string;
  try {
    migrated = prepareRawConfigForDisk(parsed);
    if (stableJson(parsed) === stableJson(migrated)) {
      params.result.skipped.push("toml:current");
      return;
    }
    serialized = serializeConfigToml(migrated);
    parseSerializedToml(serialized, migrated, params.parseToml);
  } catch (error) {
    params.onWarn(
      `[agenc:config-migration] skipped config.toml migration: ${String(error)}`,
    );
    params.result.skipped.push("toml:unsupported");
    return;
  }

  try {
    const backup = await createBackupIfMissing(params.path, params.state.mode);
    params.result.backupCreated = backup.created;
    params.result.backupPath = backup.path;
    await writeFileAtomic(params.path, serialized, params.state.mode);
    params.result.migrated = true;
    params.result.wrote = true;
  } catch (error) {
    params.onWarn(
      `[agenc:config-migration] skipped config.toml migration: failed to write ${params.path}: ${String(error)}`,
    );
    params.result.skipped.push("toml:write-failed");
  }
}

async function migrateJsonConfig(params: {
  readonly jsonPath: string;
  readonly tomlPath: string;
  readonly state: FileState;
  readonly parseToml: ConfigTomlParser;
  readonly onWarn: (message: string) => void;
  readonly result: MutableMigrationResult;
}): Promise<void> {
  params.result.source = "json";
  let rawText: string;
  try {
    rawText = stripBom(await readTextFile(params.jsonPath));
  } catch (error) {
    params.onWarn(
      `[agenc:config-migration] skipped config.json migration: failed to read ${params.jsonPath}: ${String(error)}`,
    );
    params.result.skipped.push("json:read-failed");
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    params.onWarn(
      `[agenc:config-migration] skipped config.json migration: invalid JSON at ${params.jsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    params.result.skipped.push("json:invalid");
    return;
  }
  if (!isPlainRecord(parsed)) {
    params.onWarn(
      `[agenc:config-migration] skipped config.json migration: expected top-level object`,
    );
    params.result.skipped.push("json:not-object");
    return;
  }

  // Mirror the TOML path's version-skew guard: a config.json written by a newer
  // runtime must NOT be migrated by an older one, because prepareRawConfigForDisk
  // unconditionally stamps CURRENT_CONFIG_FILE_VERSION — silently downgrading the
  // version and rewriting under an old schema/migration regime.
  if (shouldSkipFutureVersion(parsed)) {
    params.onWarn(
      `[agenc:config-migration] skipped config.json migration: ${CONFIG_FILE_VERSION_KEY} is newer than this runtime`,
    );
    params.result.skipped.push("json:future-version");
    return;
  }

  let migrated: JsonRecord;
  let serialized: string;
  try {
    migrated = prepareRawConfigForDisk(parsed);
    serialized = serializeConfigToml(migrated);
    parseSerializedToml(serialized, migrated, params.parseToml);
  } catch (error) {
    params.onWarn(
      `[agenc:config-migration] skipped config.json migration: ${String(error)}`,
    );
    params.result.skipped.push("json:unsupported");
    return;
  }

  try {
    const backup = await createBackupIfMissing(
      params.jsonPath,
      params.state.mode,
    );
    params.result.backupCreated = backup.created;
    params.result.backupPath = backup.path;
    await writeFileAtomic(params.tomlPath, serialized, params.state.mode);
    params.result.migrated = true;
    params.result.wrote = true;
  } catch (error) {
    params.onWarn(
      `[agenc:config-migration] skipped config.json migration: failed to write ${params.tomlPath}: ${String(error)}`,
    );
    params.result.skipped.push("json:write-failed");
  }
}

export async function runConfigFileMigrations(
  opts: ConfigFileMigrationOptions,
): Promise<ConfigFileMigrationResult> {
  const onWarn = opts.onWarn ?? ((message: string) => console.warn(message));
  const result = createResult();

  try {
    const home = opts.home ??
      (opts.configTomlPath !== undefined
        ? dirname(opts.configTomlPath)
        : resolveAgencHome());
    const tomlPath = opts.configTomlPath ?? pathResolve(home, "config.toml");
    const jsonPath = pathResolve(home, "config.json");
    const tomlState = await fileState(tomlPath);
    const jsonState = await fileState(jsonPath);

    if (tomlState.exists) {
      if (jsonState.exists) {
        onWarn(
          `[agenc:config-migration] config.toml exists; leaving config.json untouched at ${jsonPath}`,
        );
        result.skipped.push("json:toml-present");
      }
      await migrateTomlConfig({
        path: tomlPath,
        state: tomlState,
        parseToml: opts.parseToml,
        onWarn,
        result,
      });
      return resultFrom(result);
    }

    if (jsonState.exists) {
      await migrateJsonConfig({
        jsonPath,
        tomlPath,
        state: jsonState,
        parseToml: opts.parseToml,
        onWarn,
        result,
      });
      return resultFrom(result);
    }

    result.skipped.push("missing");
    return resultFrom(result);
  } catch (error) {
    onWarn(
      `[agenc:config-migration] skipped config migration: ${String(error)}`,
    );
    result.skipped.push("unexpected-error");
    return resultFrom(result);
  }
}
