import { inspect } from "node:util";
import { resolve } from "node:path";
import type {
  BaseCliOptions,
  CliFileConfig,
  CliLogLevel,
  CliLogger,
  CliOutputFormat,
  CliRuntimeContext,
  CliStatusCode,
  CliValidationError,
  ParsedArgv,
} from "./types.js";
import {
  getCanonicalDefaultConfigPath,
  loadCliConfigContract,
  resolveCliConfigPath,
} from "./config-contract.js";
import type { PluginPrecedence, PluginSlot } from "../skills/catalog.js";
import type { OperatorRole } from "../policy/incident-roles.js";
import { bigintReplacer, safeStringify } from "../tools/types.js";

export const DEFAULT_IDEMPOTENCY_WINDOW = 900;
export const DEFAULT_OUTPUT_FORMAT: CliOutputFormat = "json";
const DEFAULT_STORE_TYPE: "memory" | "sqlite" = "sqlite";
export const DEFAULT_LOG_LEVEL: CliLogLevel = "warn";

const GLOBAL_OPTIONS = new Set([
  "help",
  "h",
  "output",
  "output-format",
  "strict-mode",
  "role",
  "rpc",
  "program-id",
  "trace-id",
  "store-type",
  "sqlite-path",
  "idempotency-window",
  "log-level",
  "config",
]);

export const ERROR_CODES = {
  MISSING_ROOT_COMMAND: "MISSING_ROOT_COMMAND",
  UNKNOWN_COMMAND: "UNKNOWN_COMMAND",
  MISSING_REPLAY_COMMAND: "MISSING_REPLAY_COMMAND",
  UNKNOWN_REPLAY_COMMAND: "UNKNOWN_REPLAY_COMMAND",
  MISSING_PLUGIN_COMMAND: "MISSING_PLUGIN_COMMAND",
  UNKNOWN_PLUGIN_COMMAND: "UNKNOWN_PLUGIN_COMMAND",
  MISSING_CONNECTOR_COMMAND: "MISSING_CONNECTOR_COMMAND",
  UNKNOWN_CONNECTOR_COMMAND: "UNKNOWN_CONNECTOR_COMMAND",
  INVALID_OPTION: "INVALID_OPTION",
  INVALID_VALUE: "INVALID_VALUE",
  MISSING_REQUIRED_OPTION: "MISSING_REQUIRED_OPTION",
  CONFIG_PARSE_ERROR: "CONFIG_PARSE_ERROR",
  MISSING_TARGET: "MISSING_TARGET",
  MISSING_SKILL_COMMAND: "MISSING_SKILL_COMMAND",
  UNKNOWN_SKILL_COMMAND: "UNKNOWN_SKILL_COMMAND",
  MISSING_AGENT_COMMAND: "MISSING_AGENT_COMMAND",
  UNKNOWN_AGENT_COMMAND: "UNKNOWN_AGENT_COMMAND",
  MISSING_MARKET_COMMAND: "MISSING_MARKET_COMMAND",
  UNKNOWN_MARKET_COMMAND: "UNKNOWN_MARKET_COMMAND",
  MISSING_SESSION_ID: "MISSING_SESSION_ID",
  MISSING_CONFIG_COMMAND: "MISSING_CONFIG_COMMAND",
  UNKNOWN_CONFIG_COMMAND: "UNKNOWN_CONFIG_COMMAND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

const DEFAULT_USAGE_ERROR_CODES = new Set<string>([
  ERROR_CODES.INVALID_OPTION,
  ERROR_CODES.INVALID_VALUE,
  ERROR_CODES.MISSING_REQUIRED_OPTION,
  ERROR_CODES.MISSING_TARGET,
  ERROR_CODES.MISSING_ROOT_COMMAND,
  ERROR_CODES.UNKNOWN_COMMAND,
]);

export interface NormalizedGlobalFlags {
  outputFormat: CliOutputFormat;
  strictMode: boolean;
  role?: OperatorRole;
  rpcUrl?: string;
  programId?: string;
  keypairPath?: string;
  storeType: "memory" | "sqlite";
  sqlitePath?: string;
  traceId?: string;
  idempotencyWindow: number;
  help: boolean;
  logLevel: CliLogLevel;
}

export function createCliError(
  message: string,
  code: ErrorCode,
): CliValidationError {
  const error = new Error(message) as unknown as CliValidationError;
  error.code = code;
  return error;
}

export function normalizeBool(value: unknown, fallback = false): boolean {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true" || value.toLowerCase() === "1") {
      return true;
    }
    if (value.toLowerCase() === "false" || value.toLowerCase() === "0") {
      return false;
    }
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return fallback;
}

export function parseIntValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parsePositiveInt(
  value: unknown,
  flagName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createCliError(
      `${flagName} must be a positive integer`,
      ERROR_CODES.INVALID_VALUE,
    );
  }
  return parsed;
}

export function parseAllowedUsers(
  value: unknown,
): readonly number[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createCliError(
      "--allowed-users must be a comma-separated list of Telegram user IDs",
      ERROR_CODES.INVALID_VALUE,
    );
  }
  const values = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const parsed = Number.parseInt(entry, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw createCliError(
          "--allowed-users must contain only positive integer Telegram user IDs",
          ERROR_CODES.INVALID_VALUE,
        );
      }
      return parsed;
    });
  return values.length > 0 ? values : undefined;
}

export function normalizeOutputFormat(value: unknown): CliOutputFormat {
  return value === "jsonl" || value === "table" || value === "json"
    ? value
    : DEFAULT_OUTPUT_FORMAT;
}

function normalizeStoreType(value: unknown): "memory" | "sqlite" {
  return value === "memory" || value === "sqlite" ? value : DEFAULT_STORE_TYPE;
}

export function normalizeLogLevel(value: unknown): CliLogLevel {
  return value === "silent" ||
    value === "error" ||
    value === "warn" ||
    value === "info" ||
    value === "debug"
    ? value
    : DEFAULT_LOG_LEVEL;
}

export function normalizeCommandFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true" || value === "1") return true;
    if (value.toLowerCase() === "false" || value === "0") return false;
  }
  return false;
}

export function readEnvironmentConfig(): CliFileConfig {
  return {
    rpcUrl: parseOptionalString(process.env.AGENC_RUNTIME_RPC_URL),
    programId: parseOptionalString(process.env.AGENC_RUNTIME_PROGRAM_ID),
    storeType:
      process.env.AGENC_RUNTIME_STORE_TYPE === undefined
        ? undefined
        : normalizeStoreType(process.env.AGENC_RUNTIME_STORE_TYPE),
    sqlitePath: parseOptionalString(process.env.AGENC_RUNTIME_SQLITE_PATH),
    traceId: parseOptionalString(process.env.AGENC_RUNTIME_TRACE_ID),
    strictMode:
      process.env.AGENC_RUNTIME_STRICT_MODE === undefined
        ? undefined
        : normalizeBool(process.env.AGENC_RUNTIME_STRICT_MODE),
    idempotencyWindow: parseIntValue(
      process.env.AGENC_RUNTIME_IDEMPOTENCY_WINDOW,
    ),
    outputFormat:
      process.env.AGENC_RUNTIME_OUTPUT === undefined
        ? undefined
        : normalizeOutputFormat(process.env.AGENC_RUNTIME_OUTPUT),
    logLevel:
      process.env.AGENC_RUNTIME_LOG_LEVEL === undefined
        ? undefined
        : normalizeLogLevel(process.env.AGENC_RUNTIME_LOG_LEVEL),
  };
}

export function readManagedOverrideConfig(
  rawFlags: ParsedArgv["flags"],
): CliFileConfig {
  const envConfig = readEnvironmentConfig();
  return {
    rpcUrl: parseOptionalString(rawFlags.rpc) ?? envConfig.rpcUrl,
    programId: parseOptionalString(rawFlags["program-id"]) ?? envConfig.programId,
    storeType:
      rawFlags["store-type"] === undefined
        ? envConfig.storeType
        : normalizeStoreType(rawFlags["store-type"]),
    sqlitePath:
      parseOptionalString(rawFlags["sqlite-path"]) ?? envConfig.sqlitePath,
    traceId: parseOptionalString(rawFlags["trace-id"]) ?? envConfig.traceId,
    strictMode:
      rawFlags["strict-mode"] === undefined
        ? envConfig.strictMode
        : normalizeBool(rawFlags["strict-mode"]),
    idempotencyWindow:
      parseIntValue(rawFlags["idempotency-window"]) ??
      envConfig.idempotencyWindow,
    outputFormat:
      rawFlags.output === undefined && rawFlags["output-format"] === undefined
        ? envConfig.outputFormat
        : normalizeOutputFormat(
            rawFlags.output ?? rawFlags["output-format"],
          ),
    logLevel:
      rawFlags["log-level"] === undefined
        ? envConfig.logLevel
        : normalizeLogLevel(rawFlags["log-level"]),
  };
}

export function resolveLegacyCompatibleConfigSelection(
  rawFlags: ParsedArgv["flags"],
) {
  return resolveCliConfigPath({
    explicitConfigPath: parseOptionalString(rawFlags.config),
    env: process.env,
    cwd: process.cwd(),
  });
}

export function resolveGatewayConfigPath(rawFlags: ParsedArgv["flags"]): string {
  const explicit = parseOptionalString(rawFlags.config);
  const envPath = parseOptionalString(process.env.AGENC_CONFIG);
  return resolve(process.cwd(), explicit ?? envPath ?? getCanonicalDefaultConfigPath());
}

export function loadFileConfigFromSelection(
  selection: ReturnType<typeof resolveLegacyCompatibleConfigSelection>,
  strictModeEnabled = false,
): CliFileConfig {
  return loadCliConfigContract(selection.configPath, {
    strictModeEnabled,
    configPathSource: selection.configPathSource,
  }).fileConfig;
}

function normalizeOptionAliases(name: string): string {
  if (name === "output-format") return "output";
  return name;
}

function isValidTopLevelOption(name: string): boolean {
  return GLOBAL_OPTIONS.has(name) || name === "h";
}

export function validateUnknownOptions(
  flags: ParsedArgv["flags"],
  allowed: Set<string>,
): void {
  for (const rawName of Object.keys(flags)) {
    const normalized = normalizeOptionAliases(rawName);
    if (rawName === "h" || isValidTopLevelOption(normalized)) {
      continue;
    }
    if (allowed.has(rawName) || allowed.has(normalized)) {
      continue;
    }
    throw createCliError(
      `unknown option --${rawName}`,
      ERROR_CODES.INVALID_OPTION,
    );
  }
}

export function validateUnknownStandaloneOptions(
  flags: ParsedArgv["flags"],
  allowed: Set<string>,
): void {
  validateUnknownOptions(flags, allowed);
}

export function normalizeGlobalFlags(
  flags: ParsedArgv["flags"],
  fileConfig: CliFileConfig,
  envConfig: CliFileConfig,
): NormalizedGlobalFlags {
  const configStrictMode = fileConfig.strictMode;
  return {
    outputFormat: normalizeOutputFormat(
      flags.output ??
        flags["output-format"] ??
        envConfig.outputFormat ??
        fileConfig.outputFormat,
    ),
    strictMode: normalizeBool(
      flags["strict-mode"],
      envConfig.strictMode ?? configStrictMode ?? false,
    ),
    role: parseOperatorRole(flags.role),
    rpcUrl: parseOptionalString(
      flags.rpc ?? envConfig.rpcUrl ?? fileConfig.rpcUrl,
    ),
    programId: parseOptionalString(
      flags["program-id"] ?? envConfig.programId ?? fileConfig.programId,
    ),
    keypairPath: parseOptionalString(fileConfig.keypairPath),
    storeType: normalizeStoreType(
      flags["store-type"] ?? envConfig.storeType ?? fileConfig.storeType,
    ),
    sqlitePath: parseOptionalString(
      flags["sqlite-path"] ?? envConfig.sqlitePath ?? fileConfig.sqlitePath,
    ),
    traceId: parseOptionalString(
      flags["trace-id"] ?? envConfig.traceId ?? fileConfig.traceId,
    ),
    idempotencyWindow:
      parseIntValue(flags["idempotency-window"]) ??
      envConfig.idempotencyWindow ??
      fileConfig.idempotencyWindow ??
      DEFAULT_IDEMPOTENCY_WINDOW,
    help: normalizeCommandFlag(flags.h) || normalizeCommandFlag(flags.help),
    logLevel: normalizeLogLevel(
      flags["log-level"] ?? envConfig.logLevel ?? fileConfig.logLevel,
    ),
  };
}

export function resolveLenientGlobalFlags(parsed: ParsedArgv): {
  configPath: string;
  configPathSource: ReturnType<
    typeof resolveLegacyCompatibleConfigSelection
  >["configPathSource"];
  global: NormalizedGlobalFlags;
} {
  const configSelection = resolveLegacyCompatibleConfigSelection(parsed.flags);
  const fileConfig = loadLenientFileConfig(configSelection);
  const envConfig = readEnvironmentConfig();
  return {
    configPath: configSelection.configPath,
    configPathSource: configSelection.configPathSource,
    global: normalizeGlobalFlags(parsed.flags, fileConfig, envConfig),
  };
}

function loadLenientFileConfig(
  selection: ReturnType<typeof resolveLegacyCompatibleConfigSelection>,
): CliFileConfig {
  try {
    return loadFileConfigFromSelection(selection);
  } catch {
    return {};
  }
}

export function parseOperatorRole(value: unknown): OperatorRole | undefined {
  const raw = parseOptionalString(value);
  if (raw === undefined) {
    return undefined;
  }

  if (
    raw === "read" ||
    raw === "investigate" ||
    raw === "execute" ||
    raw === "admin"
  ) {
    return raw;
  }

  throw createCliError(
    "--role must be one of: read, investigate, execute, admin",
    ERROR_CODES.INVALID_VALUE,
  );
}

export function parsePluginPrecedence(value: unknown): PluginPrecedence {
  if (value === undefined) {
    return "user";
  }
  if (value === "workspace" || value === "user" || value === "builtin") {
    return value;
  }
  throw createCliError(
    "--precedence must be one of: workspace, user, builtin",
    ERROR_CODES.INVALID_VALUE,
  );
}

export function parsePluginSlot(value: unknown): PluginSlot {
  if (
    value === "memory" ||
    value === "llm" ||
    value === "proof" ||
    value === "telemetry" ||
    value === "custom"
  ) {
    return value;
  }
  throw createCliError(
    "--slot must be one of: memory, llm, proof, telemetry, custom",
    ERROR_CODES.INVALID_VALUE,
  );
}

export function parseConnectorName(value: unknown): "telegram" {
  if (value === "telegram") {
    return value;
  }
  throw createCliError(
    "connector name must be: telegram",
    ERROR_CODES.INVALID_VALUE,
  );
}

function buildOutput(value: unknown, format: CliOutputFormat): string {
  if (format === "jsonl") {
    if (Array.isArray(value)) {
      return value.map((entry) => safeStringify(entry)).join("\n");
    }
    return safeStringify(value);
  }

  if (format === "table") {
    return inspect(value, {
      colors: false,
      compact: false,
      depth: 6,
      sorted: true,
    });
  }

  return JSON.stringify(value, bigintReplacer, 2);
}

function snakeToCamel(value: string): string {
  if (!value.includes("_")) {
    return value;
  }
  return value.replace(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

export function parseRedactFields(raw: unknown): string[] {
  if (raw === undefined) {
    return [];
  }

  let input = raw;
  if (Array.isArray(raw)) {
    input = raw.join(",");
  } else if (typeof raw !== "string") {
    return [];
  }

  return String(input)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => snakeToCamel(entry));
}

export function applyRedaction<T>(value: T, redactions: readonly string[]): T {
  if (redactions.length === 0) {
    return value;
  }

  const redactionSet = new Set(redactions);
  const transform = (input: unknown): unknown => {
    if (input === null || input === undefined || typeof input !== "object") {
      return input;
    }

    if (Array.isArray(input)) {
      return input.map((entry) => transform(entry));
    }

    const output: Record<string, unknown> = {};
    const record = input as Record<string, unknown>;
    for (const [key, itemValue] of Object.entries(record)) {
      output[key] = redactionSet.has(key) ? "[REDACTED]" : transform(itemValue);
    }

    return output;
  };

  return transform(value) as T;
}

export function createContext(
  output: NodeJS.WritableStream,
  errorOutput: NodeJS.WritableStream,
  outputFormat: CliOutputFormat,
  logLevel: CliLogLevel,
): CliRuntimeContext {
  const write = (stream: NodeJS.WritableStream) => (value: unknown) => {
    stream.write(`${String(buildOutput(value, outputFormat))}\n`);
  };

  const levels: CliLogLevel[] = ["silent", "error", "warn", "info", "debug"];
  const enabled = levels.indexOf(logLevel);

  const logger: CliLogger = {
    error: (message, fields) => {
      if (enabled >= levels.indexOf("error")) {
        const payload = fields
          ? { level: "error", message, ...fields }
          : { level: "error", message };
        write(errorOutput)(payload);
      }
    },
    warn: (message, fields) => {
      if (enabled >= levels.indexOf("warn")) {
        const payload = fields
          ? { level: "warn", message, ...fields }
          : { level: "warn", message };
        write(errorOutput)(payload);
      }
    },
    info: (message, fields) => {
      if (enabled >= levels.indexOf("info")) {
        const payload = fields
          ? { level: "info", message, ...fields }
          : { level: "info", message };
        write(errorOutput)(payload);
      }
    },
    debug: (message, fields) => {
      if (enabled >= levels.indexOf("debug")) {
        const payload = fields
          ? { level: "debug", message, ...fields }
          : { level: "debug", message };
        write(errorOutput)(payload);
      }
    },
  };

  return {
    logger,
    output: write(output),
    error: write(errorOutput),
    outputFormat,
  };
}

export function buildErrorPayload(error: unknown): {
  status: "error";
  code: string;
  message: string;
} {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as CliValidationError).code === "string"
  ) {
    return {
      status: "error",
      code: (error as CliValidationError).code,
      message: error.message,
    };
  }

  return {
    status: "error",
    code: ERROR_CODES.INTERNAL_ERROR,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function reportCliError(
  context: Pick<CliRuntimeContext, "error">,
  error: unknown,
  extraUsageCodes: readonly string[] = [],
): CliStatusCode {
  const payload =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    "code" in error &&
    "message" in error &&
    (error as { status?: unknown }).status === "error" &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { status: "error"; code: string; message: string })
      : buildErrorPayload(error);
  context.error(payload);
  const isUsageError =
    DEFAULT_USAGE_ERROR_CODES.has(payload.code) ||
    extraUsageCodes.includes(payload.code);
  return isUsageError ? 2 : 1;
}

export function parseStringListFlag(
  raw: string | number | boolean | undefined,
): string[] | undefined {
  if (typeof raw !== "string") return undefined;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseOptionalStringFlag(
  raw: string | number | boolean | undefined,
): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

export function parseOptionalScalarFlag(
  raw: string | number | boolean | undefined,
): string | undefined {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  return undefined;
}

export function parseOptionalNumberFlag(
  raw: string | number | boolean | undefined,
): number | undefined {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function makeBaseCliOptions(global: NormalizedGlobalFlags): BaseCliOptions {
  return {
    help: global.help,
    outputFormat: global.outputFormat,
    strictMode: global.strictMode,
    role: global.role,
    rpcUrl: global.rpcUrl,
    programId: global.programId,
    keypairPath: global.keypairPath,
    storeType: global.storeType,
    sqlitePath: global.sqlitePath,
    traceId: global.traceId,
    idempotencyWindow: global.idempotencyWindow,
  };
}
