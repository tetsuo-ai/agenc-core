import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { validateGatewayConfig } from "../gateway/config-watcher.js";
import type { GatewayConfig } from "../gateway/types.js";
import { validateConfigStrict } from "../types/config-migration.js";
import {
  parseOptionalBoolLike,
  parseOptionalIntLike,
  parseOptionalLooseString,
} from "./coercion.js";
import type {
  CliFileConfig,
  CliLogLevel,
  CliOutputFormat,
} from "./types.js";

const LEGACY_RUNTIME_CONFIG_BASENAME = ".agenc-runtime.json";
const DEFAULT_CLI_OUTPUT_FORMAT: CliOutputFormat = "json";
const DEFAULT_CLI_STORE_TYPE: "memory" | "sqlite" = "sqlite";
const DEFAULT_CLI_LOG_LEVEL: CliLogLevel = "warn";
const DEFAULT_CLI_IDEMPOTENCY_WINDOW = 900;

const LEGACY_TOP_LEVEL_KEYS = new Set([
  "configVersion",
  "rpcUrl",
  "programId",
  "storeType",
  "sqlitePath",
  "traceId",
  "strictMode",
  "idempotencyWindow",
  "outputFormat",
  "logLevel",
  "replay",
  "verbose",
  "rpc_url",
  "store_type",
  "sqlite_path",
  "strict_mode",
]);

export type CliConfigPathSource =
  | "explicit"
  | "env:AGENC_CONFIG"
  | "env:AGENC_RUNTIME_CONFIG"
  | "canonical";

type LoadedCliConfigShape =
  | "missing"
  | "canonical-gateway"
  | "legacy-flat";

export interface ResolvedCliConfigPath {
  configPath: string;
  configPathSource: CliConfigPathSource;
  canonicalConfigPath: string;
  legacyConfigPath: string;
}

export interface LoadedCliConfigContract {
  shape: LoadedCliConfigShape;
  configPath: string;
  fileConfig: CliFileConfig;
  rawConfig?: Record<string, unknown>;
  gatewayConfig?: GatewayConfig;
}

interface LoadCliConfigContractOptions {
  strictModeEnabled?: boolean;
  configPathSource?: CliConfigPathSource;
}

function normalizeOutputFormat(value: unknown): CliOutputFormat | undefined {
  return value === "jsonl" || value === "table" || value === "json"
    ? value
    : undefined;
}

function normalizeStoreType(value: unknown): "memory" | "sqlite" | undefined {
  return value === "memory" || value === "sqlite" ? value : undefined;
}

function normalizeLogLevel(value: unknown): CliLogLevel | undefined {
  return value === "silent" ||
    value === "error" ||
    value === "warn" ||
    value === "info" ||
    value === "debug"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLegacyCliConfig(value: Record<string, unknown>): CliFileConfig {
  return {
    rpcUrl: parseOptionalLooseString(value.rpcUrl ?? value.rpc_url),
    programId: parseOptionalLooseString(value.programId ?? value.program_id),
    storeType:
      normalizeStoreType(value.storeType ?? value.store_type) ??
      DEFAULT_CLI_STORE_TYPE,
    sqlitePath: parseOptionalLooseString(value.sqlitePath ?? value.sqlite_path),
    traceId: parseOptionalLooseString(value.traceId ?? value.trace_id),
    strictMode: parseOptionalBoolLike(value.strictMode ?? value.strict_mode),
    idempotencyWindow:
      parseOptionalIntLike(value.idempotencyWindow ?? value.idempotency_window) ??
      DEFAULT_CLI_IDEMPOTENCY_WINDOW,
    outputFormat:
      normalizeOutputFormat(value.outputFormat ?? value.output_format) ??
      DEFAULT_CLI_OUTPUT_FORMAT,
    logLevel:
      normalizeLogLevel(value.logLevel ?? value.log_level ?? value.verbose) ??
      DEFAULT_CLI_LOG_LEVEL,
  };
}

function parseCanonicalCliConfig(value: GatewayConfig): CliFileConfig {
  return {
    rpcUrl: parseOptionalLooseString(value.connection.rpcUrl),
    programId: parseOptionalLooseString(value.connection.programId),
    keypairPath: parseOptionalLooseString(value.connection.keypairPath),
    storeType:
      normalizeStoreType(value.replay?.store?.type) ?? DEFAULT_CLI_STORE_TYPE,
    sqlitePath: parseOptionalLooseString(value.replay?.store?.sqlitePath),
    traceId: parseOptionalLooseString(
      value.replay?.traceId ?? value.replay?.tracing?.traceId,
    ),
    strictMode: value.cli?.strictMode,
    idempotencyWindow:
      value.cli?.idempotencyWindow ?? DEFAULT_CLI_IDEMPOTENCY_WINDOW,
    outputFormat: value.cli?.outputFormat ?? DEFAULT_CLI_OUTPUT_FORMAT,
    logLevel: normalizeLogLevel(value.logging?.level) ?? DEFAULT_CLI_LOG_LEVEL,
  };
}

function looksLikeCanonicalGatewayConfig(value: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(value, "gateway") ||
    Object.prototype.hasOwnProperty.call(value, "agent") ||
    Object.prototype.hasOwnProperty.call(value, "connection")
  );
}

function looksLikeLegacyCliConfig(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => LEGACY_TOP_LEVEL_KEYS.has(key));
}

function getCanonicalOperatorHome(): string {
  return join(homedir(), ".agenc");
}

export function getCanonicalDefaultConfigPath(): string {
  return join(getCanonicalOperatorHome(), "config.json");
}

function getLegacyRuntimeConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, LEGACY_RUNTIME_CONFIG_BASENAME);
}

export function resolveCliConfigPath(options: {
  explicitConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): ResolvedCliConfigPath {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const explicitConfigPath = parseOptionalLooseString(options.explicitConfigPath);
  const canonicalConfigPath = getCanonicalDefaultConfigPath();
  const legacyConfigPath = getLegacyRuntimeConfigPath(cwd);

  if (explicitConfigPath) {
    return {
      configPath: resolve(cwd, explicitConfigPath),
      configPathSource: "explicit",
      canonicalConfigPath,
      legacyConfigPath,
    };
  }

  const agencConfig = parseOptionalLooseString(env.AGENC_CONFIG);
  if (agencConfig) {
    return {
      configPath: resolve(cwd, agencConfig),
      configPathSource: "env:AGENC_CONFIG",
      canonicalConfigPath,
      legacyConfigPath,
    };
  }

  const legacyEnvConfig = parseOptionalLooseString(env.AGENC_RUNTIME_CONFIG);
  if (legacyEnvConfig) {
    return {
      configPath: resolve(cwd, legacyEnvConfig),
      configPathSource: "env:AGENC_RUNTIME_CONFIG",
      canonicalConfigPath,
      legacyConfigPath,
    };
  }

  return {
    configPath: canonicalConfigPath,
    configPathSource: "canonical",
    canonicalConfigPath,
    legacyConfigPath,
  };
}

export function discoverLegacyImportConfigPath(cwd = process.cwd()): string | null {
  const legacyConfigPath = getLegacyRuntimeConfigPath(cwd);
  return existsSync(legacyConfigPath) ? legacyConfigPath : null;
}

function describeConfigPathSource(source: CliConfigPathSource): string {
  switch (source) {
    case "explicit":
      return "--config";
    case "env:AGENC_CONFIG":
      return "AGENC_CONFIG";
    case "env:AGENC_RUNTIME_CONFIG":
      return "AGENC_RUNTIME_CONFIG";
    case "canonical":
      return "the canonical default config path";
  }
}

function requiresCanonicalGatewayConfig(
  source: CliConfigPathSource | undefined,
): boolean {
  return source === "env:AGENC_CONFIG" || source === "canonical";
}

export function loadCliConfigContract(
  configPath: string,
  options: LoadCliConfigContractOptions = {},
): LoadedCliConfigContract {
  const strictModeEnabled = options.strictModeEnabled ?? false;
  if (!existsSync(configPath)) {
    return {
      shape: "missing",
      configPath,
      fileConfig: {},
    };
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    throw new Error(`Config at ${configPath} must be a JSON object`);
  }

  if (looksLikeCanonicalGatewayConfig(parsed)) {
    const validation = validateGatewayConfig(parsed);
    if (!validation.valid) {
      throw new Error(
        `Gateway config validation failed: ${validation.errors.join("; ")}`,
      );
    }
    return {
      shape: "canonical-gateway",
      configPath,
      fileConfig: parseCanonicalCliConfig(parsed as unknown as GatewayConfig),
      rawConfig: parsed,
      gatewayConfig: parsed as unknown as GatewayConfig,
    };
  }

  if (!looksLikeLegacyCliConfig(parsed) && Object.keys(parsed).length > 0) {
    throw new Error(
      `Config at ${configPath} is neither a canonical gateway config nor a supported legacy runtime config`,
    );
  }

  const validation = validateConfigStrict(parsed, strictModeEnabled);
  if (!validation.valid) {
    throw new Error(
      `Legacy runtime config validation failed: ${validation.errors.map((entry) => entry.message).join("; ")}`,
    );
  }

  if (requiresCanonicalGatewayConfig(options.configPathSource)) {
    throw new Error(
      `Config at ${configPath} is a legacy runtime config, but ${describeConfigPathSource(options.configPathSource!)} must point to a canonical gateway config. Use --config or AGENC_RUNTIME_CONFIG for legacy compatibility input, or migrate the file into ${getCanonicalDefaultConfigPath()}.`,
    );
  }

  return {
    shape: "legacy-flat",
    configPath,
    fileConfig: parseLegacyCliConfig(validation.migratedConfig),
    rawConfig: validation.migratedConfig,
  };
}

export function buildManagedGatewayPatch(
  fileConfig: CliFileConfig,
): Partial<GatewayConfig> {
  const connectionPatch: Partial<GatewayConfig["connection"]> = {
    ...(fileConfig.rpcUrl ? { rpcUrl: fileConfig.rpcUrl } : {}),
    ...(fileConfig.programId ? { programId: fileConfig.programId } : {}),
  };
  const loggingLevel =
    fileConfig.logLevel === "silent" ? undefined : fileConfig.logLevel;
  const loggingPatch: Partial<NonNullable<GatewayConfig["logging"]>> = {
    ...(loggingLevel ? { level: loggingLevel } : {}),
  };
  const replayStorePatch: Partial<
    NonNullable<NonNullable<GatewayConfig["replay"]>["store"]>
  > = {
    ...(fileConfig.storeType ? { type: fileConfig.storeType } : {}),
    ...(fileConfig.sqlitePath ? { sqlitePath: fileConfig.sqlitePath } : {}),
  };
  const replayPatch: Partial<NonNullable<GatewayConfig["replay"]>> = {
    ...(fileConfig.traceId ? { traceId: fileConfig.traceId } : {}),
    ...(Object.keys(replayStorePatch).length > 0
      ? {
          store:
            replayStorePatch as NonNullable<
              NonNullable<GatewayConfig["replay"]>["store"]
            >,
        }
      : {}),
  };
  const cliPatch: Partial<NonNullable<GatewayConfig["cli"]>> = {
    ...(fileConfig.strictMode !== undefined
      ? { strictMode: fileConfig.strictMode }
      : {}),
    ...(fileConfig.idempotencyWindow !== undefined
      ? { idempotencyWindow: fileConfig.idempotencyWindow }
      : {}),
    ...(fileConfig.outputFormat ? { outputFormat: fileConfig.outputFormat } : {}),
  };

  return {
    ...(Object.keys(connectionPatch).length > 0
      ? { connection: connectionPatch as GatewayConfig["connection"] }
      : {}),
    ...(Object.keys(loggingPatch).length > 0
      ? { logging: loggingPatch as NonNullable<GatewayConfig["logging"]> }
      : {}),
    ...(Object.keys(replayPatch).length > 0
      ? { replay: replayPatch as NonNullable<GatewayConfig["replay"]> }
      : {}),
    ...(Object.keys(cliPatch).length > 0
      ? { cli: cliPatch as NonNullable<GatewayConfig["cli"]> }
      : {}),
  };
}

export function applyManagedGatewayPatch(
  base: GatewayConfig,
  patch: Partial<GatewayConfig>,
): GatewayConfig {
  return {
    ...base,
    connection: {
      ...base.connection,
      ...(patch.connection ?? {}),
    },
    logging:
      patch.logging || base.logging
        ? {
            ...(base.logging ?? {}),
            ...(patch.logging ?? {}),
          }
        : undefined,
    replay:
      patch.replay || base.replay
        ? {
            ...(base.replay ?? {}),
            ...(patch.replay ?? {}),
            store:
              patch.replay?.store || base.replay?.store
                ? {
                    ...(base.replay?.store ?? {}),
                    ...(patch.replay?.store ?? {}),
                  }
                : undefined,
            tracing:
              patch.replay?.tracing || base.replay?.tracing
                ? {
                    ...(base.replay?.tracing ?? {}),
                    ...(patch.replay?.tracing ?? {}),
                  }
                : undefined,
            backfill:
              patch.replay?.backfill || base.replay?.backfill
                ? {
                    ...(base.replay?.backfill ?? {}),
                    ...(patch.replay?.backfill ?? {}),
                  }
                : undefined,
          }
        : undefined,
    cli:
      patch.cli || base.cli
        ? {
            ...(base.cli ?? {}),
            ...(patch.cli ?? {}),
          }
        : undefined,
  };
}

export function createConfigBackup(configPath: string): string {
  const sourceStat = statSync(configPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(
    dirname(configPath),
    `${basename(configPath)}.bak.${timestamp}`,
  );
  copyFileSync(configPath, backupPath);
  try {
    chmodSync(backupPath, sourceStat.mode & 0o777);
  } catch {
    // Best effort: copyFileSync already succeeded.
  }
  return backupPath;
}

export function writeJsonAtomically(
  configPath: string,
  value: unknown,
  mode = 0o600,
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const tempPath = join(
    dirname(configPath),
    `.${basename(configPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tempPath, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode,
  });
  renameSync(tempPath, configPath);
}
