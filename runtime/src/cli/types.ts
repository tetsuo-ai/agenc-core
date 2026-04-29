import type { PluginPrecedence, PluginSlot } from "../skills/catalog.js";
import type { OperatorRole } from "../policy/incident-roles.js";
import type { CliConfigPathSource } from "./config-contract.js";

export type CliOutputFormat = "json" | "jsonl" | "table";

export type CliLogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface CliLogger {
  error: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  debug: (message: string, fields?: Record<string, unknown>) => void;
}

export interface CliRuntimeContext {
  logger: CliLogger;
  output: (value: unknown) => void;
  error: (value: unknown) => void;
  outputFormat: CliOutputFormat;
}

export interface BaseCliOptions {
  help: boolean;
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
}

export interface ReplayBackfillOptions extends BaseCliOptions {
  toSlot: number;
  pageSize?: number;
}

export interface ReplayCompareOptions extends BaseCliOptions {
  localTracePath?: string;
  taskPda?: string;
  disputePda?: string;
  redactFields?: string[];
}

export interface ReplayIncidentOptions extends BaseCliOptions {
  taskPda?: string;
  disputePda?: string;
  query?: string;
  fromSlot?: number;
  toSlot?: number;
  sealed?: boolean;
  redactFields?: string[];
}

export interface PluginListOptions extends BaseCliOptions {}

export interface PluginInstallOptions extends BaseCliOptions {
  manifestPath: string;
  precedence?: PluginPrecedence;
  slot?: PluginSlot;
}

export interface PluginToggleOptions extends BaseCliOptions {
  pluginId: string;
}

export interface PluginReloadOptions extends BaseCliOptions {
  pluginId: string;
  manifestPath?: string;
}

export type ConnectorName = "telegram";

export interface ConnectorListOptions extends BaseCliOptions {
  configPath: string;
  pidPath: string;
  controlPlanePort?: number;
}

export interface ConnectorStatusOptions extends BaseCliOptions {
  configPath: string;
  pidPath: string;
  controlPlanePort?: number;
  connectorName?: ConnectorName;
}

export interface ConnectorAddTelegramOptions extends BaseCliOptions {
  configPath: string;
  pidPath: string;
  controlPlanePort?: number;
  restart: boolean;
  botTokenEnv?: string;
  botTokenStdin?: boolean;
  allowedUsers?: readonly number[];
  pollingIntervalMs?: number;
  maxAttachmentBytes?: number;
  rateLimitPerChat?: number;
}

export interface ConnectorRemoveOptions extends BaseCliOptions {
  configPath: string;
  pidPath: string;
  controlPlanePort?: number;
  connectorName: ConnectorName;
  restart: boolean;
}

interface SkillListOptions extends BaseCliOptions {}
export interface SkillInfoOptions extends BaseCliOptions {
  skillName: string;
}
interface SkillValidateOptions extends BaseCliOptions {}
export interface SkillCreateOptions extends BaseCliOptions {
  skillName: string;
}
export interface SkillInstallOptions extends BaseCliOptions {
  source: string;
}
export interface SkillUninstallOptions extends BaseCliOptions {
  skillName: string;
}
export interface SkillToggleOptions extends BaseCliOptions {
  skillName: string;
}

export interface RegistrySearchOptions extends BaseCliOptions {
  query: string;
  tags?: string[];
  limit?: number;
}
export interface RegistryInstallOptions extends BaseCliOptions {
  skillId: string;
}
export interface RegistryPublishOptions extends BaseCliOptions {
  skillPath: string;
  tags?: string[];
  priceLamports?: string;
}
export interface RegistryRateOptions extends BaseCliOptions {
  skillId: string;
  rating: number;
  review?: string;
}
export interface RegistryVerifyOptions extends BaseCliOptions {
  skillId: string;
  localPath?: string;
}
export interface RegistryImportOpenclawOptions extends BaseCliOptions {
  source: string;
}

export type SkillCommandOptions =
  | SkillListOptions
  | SkillInfoOptions
  | SkillValidateOptions
  | SkillCreateOptions
  | SkillInstallOptions
  | SkillUninstallOptions
  | SkillToggleOptions
  | RegistrySearchOptions
  | RegistryInstallOptions
  | RegistryPublishOptions
  | RegistryRateOptions
  | RegistryVerifyOptions
  | RegistryImportOpenclawOptions;

export interface CliParseReport {
  command: "replay";
  replayCommand: "backfill" | "compare" | "incident";
  global: BaseCliOptions;
  options: ReplayBackfillOptions | ReplayCompareOptions | ReplayIncidentOptions;
  outputFormat: CliOutputFormat;
}

export interface ParsedArgv {
  positional: string[];
  flags: Record<string, string | number | boolean>;
}

export interface CliFileConfig {
  configVersion?: string;
  rpcUrl?: string;
  programId?: string;
  keypairPath?: string;
  storeType?: "memory" | "sqlite";
  sqlitePath?: string;
  traceId?: string;
  strictMode?: boolean;
  idempotencyWindow?: number;
  outputFormat?: CliOutputFormat;
  logLevel?: CliLogLevel;
}

export interface OnboardOptions extends BaseCliOptions {
  /** If true, skip interactive prompts (default false). */
  nonInteractive?: boolean;
  /** Force overwrite existing config. */
  force?: boolean;
  /** Config file path override for onboard output. */
  configPath?: string;
  /** Source used to resolve configPath precedence. */
  configPathSource?: CliConfigPathSource;
  /** Optional legacy import source discovered before writing canonical config. */
  legacyImportConfigPath?: string;
  /** Explicit CLI/env managed-field overrides. */
  managedOverrides?: Partial<CliFileConfig>;
}

export interface HealthOptions extends BaseCliOptions {
  /** If true, skip interactive prompts. */
  nonInteractive?: boolean;
  /** Run extended checks (slower but more thorough). */
  deep?: boolean;
  /** Config file path override for health output. */
  configPath?: string;
  /** Source used to resolve configPath precedence. */
  configPathSource?: CliConfigPathSource;
}

export interface DoctorOptions extends BaseCliOptions {
  nonInteractive?: boolean;
  deep?: boolean;
  /** Attempt automatic fixes where possible. */
  fix?: boolean;
  /** Config file path override for doctor output. */
  configPath?: string;
  /** Source used to resolve configPath precedence. */
  configPathSource?: CliConfigPathSource;
}

export interface SecurityOptions extends BaseCliOptions {
  deep?: boolean;
  json?: boolean;
  fix?: boolean;
}

export type CliStatusCode = 0 | 1 | 2;

export interface DaemonStartOptions {
  configPath: string;
  pidPath: string;
  foreground?: boolean;
  logLevel?: string;
  yolo?: boolean;
}

export interface DaemonStopOptions {
  pidPath: string;
  timeout?: number;
}

export interface DaemonStatusOptions {
  pidPath: string;
  controlPlanePort?: number;
}

export interface ShellOptions extends BaseCliOptions {
  configPath: string;
  pidPath: string;
  controlPlanePort?: number;
  profile?: string;
  newSession?: boolean;
  sessionId?: string;
}

export interface ShellExecOptions extends ShellOptions {
  commandText: string;
  quietConnection?: boolean;
}

export interface ServiceInstallOptions {
  configPath?: string;
  macos?: boolean;
  yolo?: boolean;
}

export interface WizardOptions extends BaseCliOptions {
  nonInteractive?: boolean;
  force?: boolean;
  configPath?: string;
  /** Explicit CLI/env managed-field overrides to persist into generated config. */
  managedOverrides?: Partial<CliFileConfig>;
}

export interface InitOptions extends BaseCliOptions {
  /** Overwrite an existing AGENC.md file. */
  force?: boolean;
  /** Target directory to inspect. Defaults to the current working directory. */
  path?: string;
  /** Gateway config path used if init needs to start the daemon. */
  configPath?: string;
  /** PID file for the daemon that should service the init request. */
  pidPath?: string;
  /** Override the daemon control-plane port instead of reading it from the PID file. */
  controlPlanePort?: number;
}

export interface ConfigValidateOptions extends BaseCliOptions {
  configPath?: string;
}

export interface ConfigShowOptions extends BaseCliOptions {
  configPath?: string;
}

export interface SessionsListOptions {
  pidPath: string;
  controlPlanePort?: number;
}

export interface SessionsKillOptions {
  pidPath: string;
  sessionId: string;
  controlPlanePort?: number;
}

export interface SessionContinuityListOptions {
  pidPath: string;
  controlPlanePort?: number;
  activeOnly?: boolean;
  limit?: number;
  profile?: string;
}

export interface SessionContinuityInspectOptions {
  pidPath: string;
  sessionId: string;
  controlPlanePort?: number;
}

export interface SessionContinuityHistoryOptions {
  pidPath: string;
  sessionId: string;
  controlPlanePort?: number;
  limit?: number;
  includeTools?: boolean;
}

export interface SessionContinuityForkOptions {
  pidPath: string;
  sessionId: string;
  controlPlanePort?: number;
  objective?: string;
  profile?: string;
}

export interface LogsOptions {
  pidPath: string;
  sessionId?: string;
  follow?: boolean;
  lines?: number;
}

export interface CliValidationError extends Error {
  code: string;
}
