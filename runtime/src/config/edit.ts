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

import type { Personality } from "./schema.js";
import { readTextFile } from "./_deps/file-read.js";
import {
  cloneRecord,
  isPlainRecord,
  stableJson,
  type JsonRecord,
} from "./json.js";
import { parseToml } from "./loader.js";
import {
  CONFIG_FILE_VERSION_KEY,
  CURRENT_CONFIG_FILE_VERSION,
  runConfigFileMigrations,
  serializeConfigToml,
} from "./migrate.js";
import {
  normalizeAgenCKeyAliases,
  normalizeRawConfig,
  validateAgenCConfigBlocks,
  validatePermissionsConfig,
} from "./schema.js";
import { migrateRawAgenCConfig } from "../state/migrations/config-migrations.js";

interface WritableConfigTarget {
  readonly path: string;
  readonly exists: boolean;
  readonly mode: number;
}

const DEFAULT_FILE_MODE = 0o600;
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

function configTomlPath(agencHome: string): string {
  return join(agencHome, "config.toml");
}

export class AgenCConfigEditsBuilder {
  private readonly edits: Array<(raw: JsonRecord) => void> = [];

  constructor(private readonly agencHome: string) {}

  setMcpServer(
    name: string,
    config: Readonly<Record<string, unknown>>,
  ): this {
    this.edits.push((raw) => {
      const existing = isPlainRecord(raw.mcp_servers)
        ? cloneRecord(raw.mcp_servers)
        : {};
      existing[name] = cloneRecord(config);
      raw.mcp_servers = existing;
    });
    return this;
  }

  removeMcpServer(name: string): this {
    this.edits.push((raw) => {
      if (!isPlainRecord(raw.mcp_servers)) return;
      const next = cloneRecord(raw.mcp_servers);
      delete next[name];
      if (Object.keys(next).length === 0) {
        delete raw.mcp_servers;
      } else {
        raw.mcp_servers = next;
      }
    });
    return this;
  }

  setModelSelection(provider: string, model: string): this {
    const normalizedProvider = provider.trim();
    const normalizedModel = model.trim();
    this.edits.push((raw) => {
      if (normalizedProvider.length > 0) {
        raw.model_provider = normalizedProvider;
      }
      if (normalizedModel.length > 0) {
        raw.model = normalizedModel;
      }
      if (
        normalizedProvider.length > 0 &&
        normalizedModel.length > 0
      ) {
        const providers = isPlainRecord(raw.providers)
          ? cloneRecord(raw.providers)
          : {};
        const existing = isPlainRecord(providers[normalizedProvider])
          ? cloneRecord(providers[normalizedProvider] as Record<string, unknown>)
          : {};
        existing.default_model = normalizedModel;
        providers[normalizedProvider] = existing;
        raw.providers = providers;
      }
    });
    return this;
  }

  setPersonality(personality: Personality | null): this {
    this.edits.push((raw) => {
      if (personality === null) {
        delete raw.personality;
      } else {
        raw.personality = personality;
      }
    });
    return this;
  }

  async apply(): Promise<void> {
    if (this.edits.length === 0) return;
    const target = await prepareConfigEditTarget(this.agencHome);
    const raw = target.exists ? await readConfigTomlRaw(target.path) : {};
    const next = prepareRawConfigForWrite(raw);
    for (const edit of this.edits) edit(next);
    await validateAndWriteConfig(next, target);
  }
}

async function prepareConfigEditTarget(
  agencHome: string,
): Promise<WritableConfigTarget> {
  const configPath = configTomlPath(agencHome);
  const initialTarget = await resolveWritableConfigTarget(configPath);
  const migrationResult = await runConfigFileMigrations({
    home: agencHome,
    configTomlPath: initialTarget.path,
    parseToml,
  });
  const target = await resolveWritableConfigTarget(configPath);
  await assertMigrationAllowsEdit({
    skipped: migrationResult.skipped,
    tomlExists: target.exists,
    jsonExists: await pathIsFile(join(agencHome, "config.json")),
  });
  return target;
}

async function resolveWritableConfigTarget(
  path: string,
): Promise<WritableConfigTarget> {
  let linkInfo;
  try {
    linkInfo = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, exists: false, mode: DEFAULT_FILE_MODE };
    }
    throw error;
  }

  const resolvedPath = linkInfo.isSymbolicLink()
    ? await resolveExistingSymlinkTarget(path)
    : path;
  const info = await stat(resolvedPath);
  if (!info.isFile()) {
    throw new Error(`config path is not a file: ${path}`);
  }
  return {
    path: resolvedPath,
    exists: true,
    mode: modeOrDefault(info.mode & 0o777),
  };
}

async function resolveExistingSymlinkTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`config symlink target does not exist: ${path}`);
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

async function assertMigrationAllowsEdit(params: {
  readonly skipped: readonly string[];
  readonly tomlExists: boolean;
  readonly jsonExists: boolean;
}): Promise<void> {
  const unsafeSkip = params.skipped.find((skip) =>
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
  validateRawConfigForWrite(raw);
  const serialized = serializeConfigToml(raw);
  const parsed = parseToml(serialized) as Record<string, unknown>;
  if (stableJson(parsed) !== stableJson(raw)) {
    throw new Error("serialized config.toml did not round-trip");
  }
  await writeTextAtomic(target.path, serialized, target.mode);
}

function validateRawConfigForWrite(raw: Readonly<Record<string, unknown>>): void {
  const validated = validateAgenCConfigBlocks(normalizeRawConfig(cloneRecord(raw)));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
