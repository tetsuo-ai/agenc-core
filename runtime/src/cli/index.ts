import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { inspect } from "node:util";
import {
  CliFileConfig,
  CliLogLevel,
  CliLogger,
  CliOutputFormat,
  CliParseReport,
  CliRuntimeContext,
  CliStatusCode,
  CliValidationError,
  ParsedArgv,
  PluginInstallOptions,
  PluginListOptions,
  PluginReloadOptions,
  BaseCliOptions,
  ReplayBackfillOptions,
  ReplayCompareOptions,
  ReplayIncidentOptions,
  PluginToggleOptions,
  OnboardOptions,
  HealthOptions,
  DoctorOptions,
  SecurityOptions,
  ConnectorAddTelegramOptions,
  ConnectorListOptions,
  ConnectorRemoveOptions,
  ConnectorStatusOptions,
  SkillCommandOptions,
  SkillInfoOptions,
  SkillCreateOptions,
  SkillInstallOptions,
  SkillUninstallOptions,
  SkillToggleOptions,
  RegistrySearchOptions,
  RegistryInstallOptions,
  RegistryPublishOptions,
  RegistryRateOptions,
  RegistryVerifyOptions,
  RegistryImportOpenclawOptions,
} from "./types.js";
import { runSecurityCommand } from "./security.js";
import {
  runSkillListCommand,
  runSkillInfoCommand,
  runSkillValidateCommand,
  runSkillCreateCommand,
  runSkillInstallCommand,
  runSkillUninstallCommand,
  runSkillEnableCommand,
  runSkillDisableCommand,
} from "./skills-cli.js";
import {
  runRegistrySearchCommand,
  runRegistryInstallCommand,
  runRegistryPublishCommand,
  runRegistryRateCommand,
  runRegistryVerifyCommand,
  runImportOpenclawCommand,
} from "./registry-cli.js";
import type {
  MarketCommandOptions,
  MarketTaskCancelOptions,
  MarketTaskCreateOptions,
  MarketDisputeDetailOptions,
  MarketDisputeResolveOptions,
  MarketDisputesListOptions,
  MarketGovernanceDetailOptions,
  MarketGovernanceListOptions,
  MarketGovernanceVoteOptions,
  MarketReputationDelegateOptions,
  MarketReputationStakeOptions,
  MarketReputationSummaryOptions,
  MarketSkillDetailOptions,
  MarketSkillPurchaseOptions,
  MarketSkillRateOptions,
  MarketSkillsListOptions,
  MarketTaskClaimOptions,
  MarketTaskCompleteOptions,
  MarketTaskDetailOptions,
  MarketTaskDisputeOptions,
  MarketTasksListOptions,
} from "./marketplace-cli.js";
import {
  runMarketTaskCancelCommand,
  runMarketTaskCreateCommand,
  parseArbiterVotes,
  parseExtraWorkers,
  runMarketDisputeDetailCommand,
  runMarketDisputeResolveCommand,
  runMarketDisputesListCommand,
  runMarketGovernanceDetailCommand,
  runMarketGovernanceListCommand,
  runMarketGovernanceVoteCommand,
  runMarketReputationDelegateCommand,
  runMarketReputationStakeCommand,
  runMarketReputationSummaryCommand,
  runMarketSkillDetailCommand,
  runMarketSkillPurchaseCommand,
  runMarketSkillRateCommand,
  runMarketSkillsListCommand,
  runMarketTaskClaimCommand,
  runMarketTaskCompleteCommand,
  runMarketTaskDetailCommand,
  runMarketTaskDisputeCommand,
  runMarketTasksListCommand,
} from "./marketplace-cli.js";
import type { MarketTuiOptions } from "./marketplace-tui.js";
import { runMarketTuiCommand } from "./marketplace-tui.js";
import {
  runAgentRegisterCommand,
  type AgentRegisterOptions,
} from "./agent-cli.js";
import { runOnboardCommand } from "./onboard.js";
import {
  runInteractiveOnboarding,
  shouldUseInteractiveOnboarding,
} from "../onboarding/tui.js";
import { runDoctorCommand, runHealthCommand } from "./health.js";
import {
  runStartCommand,
  runStopCommand,
  runRestartCommand,
  runStatusCommand,
  runServiceInstallCommand,
} from "./daemon.js";
import {
  runConfigInitCommand,
  runConfigValidateCommand,
  runConfigShowCommand,
} from "./wizard.js";
import { runInitCommand } from "./init.js";
import { runSessionsListCommand, runSessionsKillCommand } from "./sessions.js";
import { runLogsCommand } from "./logs.js";
import {
  runConnectorAddTelegramCommand,
  runConnectorListCommand,
  runConnectorRemoveCommand,
  runConnectorStatusCommand,
} from "./connectors.js";
import { getDefaultPidPath } from "../gateway/daemon.js";
import {
  discoverLegacyImportConfigPath,
  getCanonicalDefaultConfigPath,
  loadCliConfigContract,
  resolveCliConfigPath,
} from "./config-contract.js";
import type {
  DaemonStartOptions,
  DaemonStopOptions,
  DaemonStatusOptions,
  ServiceInstallOptions,
  WizardOptions,
  InitOptions,
  ConfigValidateOptions,
  ConfigShowOptions,
  SessionsListOptions,
  SessionsKillOptions,
  LogsOptions,
} from "./types.js";
import {
  PluginCatalog,
  type PluginPrecedence,
  type PluginSlot,
} from "../skills/catalog.js";
import {
  runJobsListCommand,
  runJobsRunCommand,
  runJobsEnableCommand,
  runJobsDisableCommand,
} from "./jobs.js";
import { CronScheduler } from "../gateway/scheduler.js";
import {
  createOnChainReplayBackfillFetcher,
  createReplayStore,
  parseLocalTrajectoryFile,
  summarizeReplayIncidentRecords,
} from "./replay.js";
import {
  ReplayBackfillService,
  type ReplayTimelineRecord,
  type ReplayTimelineStore,
} from "../replay/index.js";
import {
  type ReplayComparisonResult,
  type ReplayComparisonStrictness,
  ReplayComparisonService,
} from "../eval/replay-comparison.js";
import { TrajectoryReplayEngine } from "../eval/replay.js";
import { type TrajectoryTrace } from "../eval/types.js";
import {
  applyQueryFilter,
  normalizeQuery,
  parseQueryDSL,
  type QueryDSL,
} from "../eval/query-dsl.js";
import { buildIncidentCase } from "../eval/incident-case.js";
import {
  buildEvidencePack,
  serializeEvidencePack,
} from "../eval/evidence-pack.js";
import {
  enforceRole,
  IncidentRoleViolationError,
  type IncidentCommandCategory,
  type OperatorRole,
} from "../policy/incident-roles.js";
import {
  InMemoryAuditTrail,
  computeInputHash,
  computeOutputHash,
} from "../policy/audit-trail.js";
import type { PluginManifest } from "../skills/manifest.js";
import { bigintReplacer, safeStringify } from "../tools/types.js";

interface CliRunOptions {
  argv?: string[];
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

interface ReplayIncidentEventSummary {
  anomalyId: string;
  seq: number;
  slot: number;
  signature: string;
  sourceEventName: string;
  sourceEventType: string;
  taskPda?: string;
  disputePda?: string;
  timestampMs: number;
}

interface ReplayIncidentNarrative {
  lines: string[];
  anomalyIds: string[];
}

interface CliCommandDescriptor {
  name: string;
  description: string;
  commandOptions: Set<string>;
  run: (
    context: CliRuntimeContext,
    options:
      | ReplayBackfillOptions
      | ReplayCompareOptions
      | ReplayIncidentOptions,
  ) => Promise<CliStatusCode>;
}

interface PluginCommandDescriptor {
  name: string;
  description: string;
  commandOptions: Set<string>;
  run: (
    context: CliRuntimeContext,
    options: PluginCommandOptions,
  ) => Promise<CliStatusCode>;
}

type ReplayCommand = "backfill" | "compare" | "incident";
type PluginCommand = "list" | "install" | "disable" | "enable" | "reload";
type ConnectorCommand = "list" | "status" | "add" | "remove";

type CliCommandOptions =
  | ReplayBackfillOptions
  | ReplayCompareOptions
  | ReplayIncidentOptions;
type PluginCommandOptions =
  | PluginListOptions
  | PluginInstallOptions
  | PluginToggleOptions
  | PluginReloadOptions;

const DEFAULT_IDEMPOTENCY_WINDOW = 900;
const DEFAULT_OUTPUT_FORMAT: CliOutputFormat = "json";
const DEFAULT_STORE_TYPE: "memory" | "sqlite" = "sqlite";
const DEFAULT_LOG_LEVEL: CliLogLevel = "warn";

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

const COMMAND_OPTIONS: Record<ReplayCommand, Set<string>> = {
  backfill: new Set(["to-slot", "page-size"]),
  compare: new Set([
    "local-trace-path",
    "task-pda",
    "dispute-pda",
    "redact-fields",
  ]),
  incident: new Set([
    "task-pda",
    "dispute-pda",
    "query",
    "from-slot",
    "to-slot",
    "sealed",
    "redact-fields",
  ]),
};
const PLUGIN_COMMAND_OPTIONS: Record<PluginCommand, Set<string>> = {
  list: new Set(),
  install: new Set(["manifest", "precedence", "slot"]),
  disable: new Set(),
  enable: new Set(),
  reload: new Set(["manifest"]),
};

const ONBOARD_COMMAND_OPTIONS = new Set(["non-interactive", "force"]);
const HEALTH_COMMAND_OPTIONS = new Set(["non-interactive", "deep"]);
const DOCTOR_COMMAND_OPTIONS = new Set(["non-interactive", "deep", "fix"]);

const START_COMMAND_OPTIONS = new Set(["foreground", "pid-path", "yolo"]);
const STOP_COMMAND_OPTIONS = new Set(["pid-path", "timeout"]);
const RESTART_COMMAND_OPTIONS = new Set([
  ...START_COMMAND_OPTIONS,
  ...STOP_COMMAND_OPTIONS,
]);
const STATUS_COMMAND_OPTIONS = new Set(["pid-path", "port"]);
const SERVICE_COMMAND_OPTIONS = new Set(["macos", "yolo"]);
const JOBS_COMMAND_OPTIONS = new Set<string>([]);
const CONNECTOR_LIST_OPTIONS = new Set(["pid-path", "port"]);
const CONNECTOR_STATUS_OPTIONS = new Set(["pid-path", "port"]);
const CONNECTOR_ADD_OPTIONS = new Set([
  "pid-path",
  "port",
  "restart",
  "bot-token-env",
  "bot-token-stdin",
  "allowed-users",
  "polling-interval-ms",
  "max-attachment-bytes",
  "rate-limit-per-chat",
]);
const CONNECTOR_REMOVE_OPTIONS = new Set(["pid-path", "port", "restart"]);

const CONFIG_INIT_OPTIONS = new Set(["non-interactive", "force"]);
const INIT_COMMAND_OPTIONS = new Set(["force", "path", "pid-path", "port"]);
const CONFIG_VALIDATE_OPTIONS = new Set<string>([]);
const CONFIG_SHOW_OPTIONS = new Set<string>([]);
const SESSIONS_OPTIONS = new Set(["pid-path", "port"]);
const LOGS_OPTIONS = new Set(["pid-path", "session", "lines"]);

const COMMANDS: Record<ReplayCommand, CliCommandDescriptor> = {
  backfill: {
    name: "backfill",
    description: "Backfill replay timeline from on-chain history",
    commandOptions: COMMAND_OPTIONS.backfill,
    run: runReplayBackfillCommand,
  },
  compare: {
    name: "compare",
    description: "Compare replay projection against local trace",
    commandOptions: COMMAND_OPTIONS.compare,
    run: runReplayCompareCommand,
  },
  incident: {
    name: "incident",
    description: "Generate incident reconstruction summary",
    commandOptions: COMMAND_OPTIONS.incident,
    run: runReplayIncidentCommand,
  },
};
const PLUGIN_COMMANDS: Record<PluginCommand, PluginCommandDescriptor> = {
  list: {
    name: "list",
    description: "List plugin catalog entries",
    commandOptions: PLUGIN_COMMAND_OPTIONS.list,
    run: runPluginListCommand,
  },
  install: {
    name: "install",
    description: "Install a plugin from a manifest",
    commandOptions: PLUGIN_COMMAND_OPTIONS.install,
    run: runPluginInstallCommand,
  },
  disable: {
    name: "disable",
    description: "Disable a plugin by ID",
    commandOptions: PLUGIN_COMMAND_OPTIONS.disable,
    run: runPluginDisableCommand,
  },
  enable: {
    name: "enable",
    description: "Enable a plugin by ID",
    commandOptions: PLUGIN_COMMAND_OPTIONS.enable,
    run: runPluginEnableCommand,
  },
  reload: {
    name: "reload",
    description: "Reload a plugin and refresh manifest state",
    commandOptions: PLUGIN_COMMAND_OPTIONS.reload,
    run: runPluginReloadCommand,
  },
};

type SkillCommand =
  | "list"
  | "info"
  | "validate"
  | "create"
  | "install"
  | "uninstall"
  | "enable"
  | "disable"
  | "search"
  | "registry-install"
  | "publish"
  | "rate"
  | "verify"
  | "import-openclaw";

const SKILL_COMMAND_OPTIONS: Record<SkillCommand, Set<string>> = {
  list: new Set(),
  info: new Set(),
  validate: new Set(),
  create: new Set(),
  install: new Set(),
  uninstall: new Set(),
  enable: new Set(),
  disable: new Set(),
  search: new Set(["tags", "limit"]),
  "registry-install": new Set(),
  publish: new Set(["tags", "price"]),
  rate: new Set(["review"]),
  verify: new Set(["path"]),
  "import-openclaw": new Set(),
};

interface SkillCommandDescriptor {
  name: string;
  description: string;
  commandOptions: Set<string>;
  run: (
    context: CliRuntimeContext,
    options: SkillCommandOptions,
  ) => Promise<CliStatusCode>;
}

const SKILL_COMMANDS: Record<SkillCommand, SkillCommandDescriptor> = {
  list: {
    name: "list",
    description: "List all discovered skills",
    commandOptions: SKILL_COMMAND_OPTIONS.list,
    run: runSkillListCommand,
  },
  info: {
    name: "info",
    description: "Show detailed skill information",
    commandOptions: SKILL_COMMAND_OPTIONS.info,
    run: runSkillInfoCommand,
  },
  validate: {
    name: "validate",
    description: "Validate all discovered skills",
    commandOptions: SKILL_COMMAND_OPTIONS.validate,
    run: runSkillValidateCommand,
  },
  create: {
    name: "create",
    description: "Scaffold a new skill in ~/.agenc/skills/",
    commandOptions: SKILL_COMMAND_OPTIONS.create,
    run: runSkillCreateCommand,
  },
  install: {
    name: "install",
    description: "Install a skill from URL or local path",
    commandOptions: SKILL_COMMAND_OPTIONS.install,
    run: runSkillInstallCommand,
  },
  uninstall: {
    name: "uninstall",
    description: "Remove a user-level skill",
    commandOptions: SKILL_COMMAND_OPTIONS.uninstall,
    run: runSkillUninstallCommand,
  },
  enable: {
    name: "enable",
    description: "Enable a disabled skill",
    commandOptions: SKILL_COMMAND_OPTIONS.enable,
    run: runSkillEnableCommand,
  },
  disable: {
    name: "disable",
    description: "Disable a skill",
    commandOptions: SKILL_COMMAND_OPTIONS.disable,
    run: runSkillDisableCommand,
  },
  search: {
    name: "search",
    description: "Search the on-chain skill registry",
    commandOptions: SKILL_COMMAND_OPTIONS.search,
    run: runRegistrySearchCommand as SkillCommandDescriptor["run"],
  },
  "registry-install": {
    name: "registry-install",
    description: "Install a skill from the on-chain registry",
    commandOptions: SKILL_COMMAND_OPTIONS["registry-install"],
    run: runRegistryInstallCommand as SkillCommandDescriptor["run"],
  },
  publish: {
    name: "publish",
    description: "Publish a skill to the on-chain registry",
    commandOptions: SKILL_COMMAND_OPTIONS.publish,
    run: runRegistryPublishCommand as SkillCommandDescriptor["run"],
  },
  rate: {
    name: "rate",
    description: "Rate a skill in the on-chain registry",
    commandOptions: SKILL_COMMAND_OPTIONS.rate,
    run: runRegistryRateCommand as SkillCommandDescriptor["run"],
  },
  verify: {
    name: "verify",
    description: "Verify a skill content hash against the on-chain registry",
    commandOptions: SKILL_COMMAND_OPTIONS.verify,
    run: runRegistryVerifyCommand as SkillCommandDescriptor["run"],
  },
  "import-openclaw": {
    name: "import-openclaw",
    description: "Import an OpenClaw skill and convert to AgenC format",
    commandOptions: SKILL_COMMAND_OPTIONS["import-openclaw"],
    run: runImportOpenclawCommand as SkillCommandDescriptor["run"],
  },
};

function validateSkillCommand(name: string): name is SkillCommand {
  return (
    name === "list" ||
    name === "info" ||
    name === "validate" ||
    name === "create" ||
    name === "install" ||
    name === "uninstall" ||
    name === "enable" ||
    name === "disable" ||
    name === "search" ||
    name === "registry-install" ||
    name === "publish" ||
    name === "rate" ||
    name === "verify" ||
    name === "import-openclaw"
  );
}

type AgentCommand = "register";

const AGENT_COMMAND_OPTIONS: Record<AgentCommand, Set<string>> = {
  register: new Set(["capabilities", "endpoint", "metadata-uri", "agent-id"]),
};

function validateAgentCommand(name: string): name is AgentCommand {
  return name === "register";
}

type MarketCommand =
  | "tasks.list"
  | "tasks.create"
  | "tasks.detail"
  | "tasks.cancel"
  | "tasks.claim"
  | "tasks.complete"
  | "tasks.dispute"
  | "skills.list"
  | "skills.detail"
  | "skills.purchase"
  | "skills.rate"
  | "governance.list"
  | "governance.detail"
  | "governance.vote"
  | "disputes.list"
  | "disputes.detail"
  | "disputes.resolve"
  | "reputation.summary"
  | "reputation.stake"
  | "reputation.delegate"
  | "tui";

const MARKET_COMMAND_OPTIONS: Record<MarketCommand, Set<string>> = {
  "tasks.list": new Set(["status"]),
  "tasks.create": new Set([
    "description",
    "reward",
    "required-capabilities",
    "max-workers",
    "deadline",
    "task-type",
    "creator-agent-pda",
  ]),
  "tasks.detail": new Set(),
  "tasks.cancel": new Set(),
  "tasks.claim": new Set(["worker-agent-pda"]),
  "tasks.complete": new Set(["proof-hash", "result-data", "worker-agent-pda"]),
  "tasks.dispute": new Set([
    "evidence",
    "resolution-type",
    "worker-agent-pda",
    "worker-claim-pda",
    "initiator-agent-pda",
  ]),
  "skills.list": new Set(["query", "tags", "limit"]),
  "skills.detail": new Set(),
  "skills.purchase": new Set(["expected-price", "buyer-agent-pda"]),
  "skills.rate": new Set(["review", "rater-agent-pda"]),
  "governance.list": new Set(),
  "governance.detail": new Set(),
  "governance.vote": new Set(["voter-agent-pda"]),
  "disputes.list": new Set(["status"]),
  "disputes.detail": new Set(),
  "disputes.resolve": new Set(["arbiter-votes", "extra-workers"]),
  "reputation.summary": new Set(),
  "reputation.stake": new Set(["staker-agent-pda"]),
  "reputation.delegate": new Set([
    "delegatee-agent-pda",
    "delegatee-agent-id",
    "expires-at",
    "delegator-agent-pda",
  ]),
  tui: new Set(),
};

interface MarketCommandDescriptor {
  name: string;
  description: string;
  commandOptions: Set<string>;
  run: (
    context: CliRuntimeContext,
    options: MarketCommandOptions,
  ) => Promise<CliStatusCode>;
}

const MARKET_COMMANDS: Record<MarketCommand, MarketCommandDescriptor> = {
  "tasks.list": {
    name: "tasks.list",
    description: "List marketplace tasks",
    commandOptions: MARKET_COMMAND_OPTIONS["tasks.list"],
    run: runMarketTasksListCommand as MarketCommandDescriptor["run"],
  },
  "tasks.create": {
    name: "tasks.create",
    description: "Create a marketplace task",
    commandOptions: MARKET_COMMAND_OPTIONS["tasks.create"],
    run: runMarketTaskCreateCommand as MarketCommandDescriptor["run"],
  },
  "tasks.detail": {
    name: "tasks.detail",
    description: "Inspect a marketplace task",
    commandOptions: MARKET_COMMAND_OPTIONS["tasks.detail"],
    run: runMarketTaskDetailCommand as MarketCommandDescriptor["run"],
  },
  "tasks.cancel": {
    name: "tasks.cancel",
    description: "Cancel an open marketplace task",
    commandOptions: MARKET_COMMAND_OPTIONS["tasks.cancel"],
    run: runMarketTaskCancelCommand as MarketCommandDescriptor["run"],
  },
  "tasks.claim": {
    name: "tasks.claim",
    description: "Claim a marketplace task",
    commandOptions: MARKET_COMMAND_OPTIONS["tasks.claim"],
    run: runMarketTaskClaimCommand as MarketCommandDescriptor["run"],
  },
  "tasks.complete": {
    name: "tasks.complete",
    description: "Complete a marketplace task",
    commandOptions: MARKET_COMMAND_OPTIONS["tasks.complete"],
    run: runMarketTaskCompleteCommand as MarketCommandDescriptor["run"],
  },
  "tasks.dispute": {
    name: "tasks.dispute",
    description: "Open a dispute against a marketplace task",
    commandOptions: MARKET_COMMAND_OPTIONS["tasks.dispute"],
    run: runMarketTaskDisputeCommand as MarketCommandDescriptor["run"],
  },
  "skills.list": {
    name: "skills.list",
    description: "List marketplace skill registrations",
    commandOptions: MARKET_COMMAND_OPTIONS["skills.list"],
    run: runMarketSkillsListCommand as MarketCommandDescriptor["run"],
  },
  "skills.detail": {
    name: "skills.detail",
    description: "Inspect a marketplace skill",
    commandOptions: MARKET_COMMAND_OPTIONS["skills.detail"],
    run: runMarketSkillDetailCommand as MarketCommandDescriptor["run"],
  },
  "skills.purchase": {
    name: "skills.purchase",
    description: "Purchase a marketplace skill",
    commandOptions: MARKET_COMMAND_OPTIONS["skills.purchase"],
    run: runMarketSkillPurchaseCommand as MarketCommandDescriptor["run"],
  },
  "skills.rate": {
    name: "skills.rate",
    description: "Rate a marketplace skill",
    commandOptions: MARKET_COMMAND_OPTIONS["skills.rate"],
    run: runMarketSkillRateCommand as MarketCommandDescriptor["run"],
  },
  "governance.list": {
    name: "governance.list",
    description: "List governance proposals",
    commandOptions: MARKET_COMMAND_OPTIONS["governance.list"],
    run: runMarketGovernanceListCommand as MarketCommandDescriptor["run"],
  },
  "governance.detail": {
    name: "governance.detail",
    description: "Inspect a governance proposal",
    commandOptions: MARKET_COMMAND_OPTIONS["governance.detail"],
    run: runMarketGovernanceDetailCommand as MarketCommandDescriptor["run"],
  },
  "governance.vote": {
    name: "governance.vote",
    description: "Vote on a governance proposal",
    commandOptions: MARKET_COMMAND_OPTIONS["governance.vote"],
    run: runMarketGovernanceVoteCommand as MarketCommandDescriptor["run"],
  },
  "disputes.list": {
    name: "disputes.list",
    description: "List disputes",
    commandOptions: MARKET_COMMAND_OPTIONS["disputes.list"],
    run: runMarketDisputesListCommand as MarketCommandDescriptor["run"],
  },
  "disputes.detail": {
    name: "disputes.detail",
    description: "Inspect a dispute",
    commandOptions: MARKET_COMMAND_OPTIONS["disputes.detail"],
    run: runMarketDisputeDetailCommand as MarketCommandDescriptor["run"],
  },
  "disputes.resolve": {
    name: "disputes.resolve",
    description: "Resolve a dispute with explicit arbiter votes",
    commandOptions: MARKET_COMMAND_OPTIONS["disputes.resolve"],
    run: runMarketDisputeResolveCommand as MarketCommandDescriptor["run"],
  },
  "reputation.summary": {
    name: "reputation.summary",
    description: "Inspect marketplace reputation state",
    commandOptions: MARKET_COMMAND_OPTIONS["reputation.summary"],
    run: runMarketReputationSummaryCommand as MarketCommandDescriptor["run"],
  },
  "reputation.stake": {
    name: "reputation.stake",
    description: "Stake SOL on reputation",
    commandOptions: MARKET_COMMAND_OPTIONS["reputation.stake"],
    run: runMarketReputationStakeCommand as MarketCommandDescriptor["run"],
  },
  "reputation.delegate": {
    name: "reputation.delegate",
    description: "Delegate reputation to another agent",
    commandOptions: MARKET_COMMAND_OPTIONS["reputation.delegate"],
    run: runMarketReputationDelegateCommand as MarketCommandDescriptor["run"],
  },
  tui: {
    name: "tui",
    description: "Launch the interactive marketplace terminal workspace",
    commandOptions: MARKET_COMMAND_OPTIONS.tui,
    run: runMarketTuiCommand as MarketCommandDescriptor["run"],
  },
};

function validateMarketCommand(name: string): name is MarketCommand {
  return (
    name === "tasks.list" ||
    name === "tasks.create" ||
    name === "tasks.detail" ||
    name === "tasks.cancel" ||
    name === "tasks.claim" ||
    name === "tasks.complete" ||
    name === "tasks.dispute" ||
    name === "skills.list" ||
    name === "skills.detail" ||
    name === "skills.purchase" ||
    name === "skills.rate" ||
    name === "governance.list" ||
    name === "governance.detail" ||
    name === "governance.vote" ||
    name === "disputes.list" ||
    name === "disputes.detail" ||
    name === "disputes.resolve" ||
    name === "reputation.summary" ||
    name === "reputation.stake" ||
    name === "reputation.delegate" ||
    name === "tui"
  );
}

const ERROR_CODES = {
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

type ErrorCode = keyof typeof ERROR_CODES;

function createCliError(message: string, code: ErrorCode): CliValidationError {
  const error = new Error(message) as unknown as CliValidationError;
  error.code = code;
  return error;
}

function buildHelp(): string {
  return [
    "agenc-runtime [--help] [--config <path>]",
    "onboard [--help] [options]",
    "health [--help] [options]",
    "doctor [--help] [options]",
    "doctor security [--help] [options]",
    "init [--help] [options]",
    "config <init|validate|show> [--help] [options]",
    "start [--help] [options]",
    "stop [--help] [options]",
    "restart [--help] [options]",
    "status [--help] [options]",
    "service install [--help] [options]",
    "connector <list|status|add|remove> [--help] [options]",
    "sessions <list|kill> [--help] [options]",
    "logs [--help] [options]",
    "replay [--help] <command> [options]",
    "plugin [--help] <command> [options]",
    "jobs [--help] <command> [options]",
    "agent [--help] <command> [options]",
    "market [--help] <domain> <command> [options]",
    "market tui",
    "skill [--help] <command> [options]",
    "",
    "Bootstrap commands:",
    "  onboard   Generate a runtime config file and run sanity checks",
    "  health    Report RPC, store, wallet, and config status",
    "  doctor    Run all health checks and provide remediation guidance",
    "  doctor security  Security posture checks",
    "  init      Generate an AGENC.md contributor guide for the current repo",
    "",
    "Config commands:",
    "  config init      Generate gateway config and scaffold workspace",
    "  config validate  Validate an existing gateway config file",
    "  config show      Display the loaded gateway config",
    "",
    "Daemon commands:",
    "  start     Start the gateway daemon",
    "  stop      Stop the gateway daemon",
    "  restart   Restart the gateway daemon",
    "  status    Show daemon status",
    "  service install  Generate systemd/launchd service template",
    "",
    "Session commands:",
    "  sessions list              List active control plane sessions",
    "  sessions kill <sessionId>  Disconnect a control plane session",
    "",
    "Log commands:",
    "  logs                       Show daemon log viewing instructions",
    "",
    "Connector commands:",
    "  connector list                            List supported connector lifecycle status",
    "  connector status [telegram]               Show connector status details",
    "  connector add telegram --bot-token-env TELEGRAM_BOT_TOKEN",
    "                                          Configure the Telegram connector",
    "  connector remove telegram                 Remove the Telegram connector",
    "",
    "Replay subcommands:",
    "  backfill   Backfill replay timeline from on-chain history",
    "  compare    Compare replay projection against local trace",
    "  incident   Reconstruct incident timeline and summarize",
    "",
    "Jobs subcommands:",
    "  list                               List scheduled jobs",
    "  run <jobName>                      Trigger a scheduled job immediately",
    "  enable <jobName>                   Enable a scheduled job",
    "  disable <jobName>                  Disable a scheduled job",
    "",
    "Agent subcommands:",
    "  register [--capabilities mask] [--endpoint url]",
    "                                    Register the signer wallet as an on-chain agent",
    "",
    "Market subcommands:",
    "  tasks list [--status open,in_progress]       List marketplace tasks",
    "  tasks create --description txt --reward lamports",
    "                                              Create a public marketplace task",
    "  tasks detail <taskPda>                       Inspect a task",
    "  tasks cancel <taskPda>                       Cancel an open task",
    "  tasks claim <taskPda>                        Claim a task",
    "  tasks complete <taskPda> [--result-data txt] Complete a task (auto-hashes proof when omitted)",
    "  tasks dispute <taskPda> --evidence txt       Open a dispute for a task",
    "  skills list [--query text] [--tags t1,t2]    List marketplace skills",
    "  skills detail <skillPda>                     Inspect a skill registration",
    "  skills purchase <skillPda>                   Purchase and install a marketplace skill",
    '  skills rate <skillPda> <1-5> [--review "text"] Rate a marketplace skill',
    "  governance list                              List governance proposals",
    "  governance detail <proposalPda>              Inspect a governance proposal",
    "  governance vote <proposalPda> <yes|no>       Vote on a governance proposal",
    "  disputes list [--status active,resolved]     List disputes",
    "  disputes detail <disputePda>                 Inspect a dispute",
    "  disputes resolve <disputePda> --arbiter-votes votePda:arbiterPda[,..]",
    "                                              Resolve a dispute with explicit vote accounts",
    "  reputation summary [agentPda]                Inspect reputation state",
    "  reputation stake <lamports>                  Stake SOL on reputation",
    "  reputation delegate <amount> --delegatee-agent-pda <pda>",
    "                                              Delegate reputation to another agent",
    "  tui                                          Launch the interactive terminal marketplace workspace",
    "",
    "Skill subcommands:",
    "  list                               List all discovered skills",
    "  info <name>                        Show detailed skill information",
    "  validate                           Validate all discovered skills",
    "  create <name>                      Scaffold a new skill in ~/.agenc/skills/",
    "  install <url-or-path>              Install a skill from URL or local path",
    "  uninstall <name>                   Remove a user-level skill",
    "  enable <name>                      Enable a disabled skill",
    "  disable <name>                     Disable a skill",
    "  search <query> [--tags t1,t2] [--limit N]  Search on-chain skill registry",
    "  registry-install <skill-id>        Install a skill from the on-chain registry",
    "  publish <path> [--tags t1,t2] [--price N]  Publish a skill to the on-chain registry",
    '  rate <skill-id> <1-5> [--review "text"]    Rate a skill in the on-chain registry',
    "  verify <skill-id> [--path <file>]  Verify skill hash against on-chain registry",
    "  import-openclaw <path-or-url>      Import an OpenClaw skill to AgenC format",
    "",
    "Plugin subcommands:",
    "  list                               List registered plugins",
    "  install --manifest <path> [--precedence workspace|user|builtin] [--slot memory|llm|proof|telemetry|custom]",
    "                                   Install or register a plugin",
    "  disable <pluginId>                 Disable a plugin",
    "  enable <pluginId>                  Enable a plugin",
    "  reload <pluginId> [--manifest <path>] Reload a plugin and optional manifest update",
    "",
    "Global options:",
    "  -h, --help                               Show this usage",
    "      --output, --output-format json|jsonl|table  Response output format",
    "      --strict-mode                         Enable strict validation",
    "      --role <role>                         Operator role (read|investigate|execute|admin)",
    "      --rpc                                 RPC endpoint",
    "      --program-id                          Program id",
    "      --trace-id                            Trace id",
    "      --store-type memory|sqlite             Replay event store",
    "      --sqlite-path <path>                  SQLite DB path (sqlite store)",
    "      --idempotency-window <seconds>        Default: 900",
    "      --log-level silent|error|warn|info|debug",
    "      --config <path>                       Config file path (default: ~/.agenc/config.json)",
    "",
    "onboard options:",
    "      --non-interactive                     Skip interactive prompts (CI-friendly)",
    "      --force                               Overwrite existing config file",
    "",
    "health options:",
    "      --non-interactive                     Skip interactive prompts (CI-friendly)",
    "      --deep                                Run extended checks (latency, store integrity)",
    "",
    "doctor options:",
    "      --non-interactive                     Skip interactive prompts (CI-friendly)",
    "      --deep                                Run extended checks (latency, store integrity)",
    "      --fix                                 Attempt automatic remediation where possible",
    "",
    "start options:",
    "      --config <path>                           Gateway config file path",
    "      --foreground                              Run in foreground (systemd/Docker mode)",
    "      --pid-path <path>                         Custom PID file path",
    "      --yolo                                    Enable unsafe delegation benchmark mode and disable host execution deny lists",
    "",
    "stop options:",
    "      --pid-path <path>                         Custom PID file path",
    "      --timeout <ms>                            Shutdown timeout in ms (default: 30000)",
    "",
    "status options:",
    "      --pid-path <path>                         Custom PID file path",
    "      --port <port>                             Override control plane port",
    "",
    "service install options:",
    "      --macos                                   Generate launchd plist instead of systemd unit",
    "      --yolo                                    Include unsafe benchmark mode (--yolo) in the generated service command",
    "",
    "backfill options:",
    "      --to-slot <slot>                      Highest slot to scan (required)",
    "      --page-size <size>                    Number of events per page",
    "",
    "compare options:",
    "      --local-trace-path <path>              Path to local trajectory trace (required)",
    "      --task-pda <pda>                      Limit by task id",
    "      --dispute-pda <pda>                   Limit by dispute id",
    "      --redact-fields <fields>               Comma-separated output redaction keys",
    "",
    "incident options:",
    "      --task-pda <pda>                      Limit by task id",
    "      --dispute-pda <pda>                   Limit by dispute id",
    "      --query <dsl>                         Analyst query DSL filter string",
    "      --redact-fields <fields>               Comma-separated output redaction keys",
    "      --from-slot <slot>                    Replay incident from slot",
    "      --to-slot <slot>                      Replay incident to slot",
    "",
    "config init options:",
    "      --non-interactive                     Skip interactive prompts (CI-friendly)",
    "      --force                               Overwrite existing config file",
    "",
    "init options:",
    "      --force                               Overwrite an existing AGENC.md",
    "      --path <dir>                          Target project root (default: current working directory)",
    "      --pid-path <path>                     Custom PID file path",
    "      --port <port>                         Override control plane port",
    "",
    "sessions options:",
    "      --pid-path <path>                         Custom PID file path",
    "      --port <port>                             Override control plane port",
    "",
    "logs options:",
    "      --pid-path <path>                         Custom PID file path",
    "      --session <id>                            Filter by session ID",
    "      --lines <n>                               Number of recent log lines (used in journalctl hint)",
    "",
    "connector options:",
    "      --pid-path <path>                         Custom PID file path",
    "      --port <port>                             Override control plane port",
    "      --restart true|false                      Restart matching daemon after config mutation (default: true)",
    "      --bot-token-env <ENV_NAME>                Read Telegram bot token from an environment variable",
    "      --bot-token-stdin                         Read Telegram bot token from stdin",
    "      --allowed-users <id1,id2>                 Restrict Telegram access to specific user IDs",
    "      --polling-interval-ms <n>                 Telegram polling interval in ms",
    "      --max-attachment-bytes <n>                Max inbound Telegram attachment size",
    "      --rate-limit-per-chat <n>                 Outbound Telegram messages per second per chat",
    "",
    "plugin options:",
    "      --manifest <path>                     Plugin manifest path (install/reload)",
    "      --precedence workspace|user|builtin  Plugin installation precedence",
    "      --slot memory|llm|proof|telemetry|custom Plugin slot claim",
    "",
    "market options:",
    "      --status <s1,s2>                      Status filter for tasks/disputes list",
    "      --description <text>                  Task description for market tasks create",
    "      --reward <lamports>                   Task reward for market tasks create",
    "      --required-capabilities <u64>         Required capability bitmask for task creation (default: 1)",
    "      --max-workers <n>                     Max workers for task creation",
    "      --deadline <unix>                     Task deadline for task creation",
    "      --task-type <0|1|2>                   Task type for task creation",
    "      --creator-agent-pda <pda>             Explicit creator agent PDA for task creation",
    "      --query <text>                        Text filter for skills list",
    "      --tags <t1,t2>                        Tag filter for skills list",
    "      --limit <n>                           Limit skills list results",
    "      --proof-hash <hex>                    Explicit 32-byte proof hash for task completion",
    "      --result-data <text>                  Task completion result data",
    "      --evidence <text>                     Dispute evidence text",
    "      --resolution-type refund|complete|split  Desired dispute outcome",
    "      --expected-price <lamports>           Purchase price guard for skills",
    "      --arbiter-votes <votePda:arbiterPda,...> Required resolve pairs",
    "      --extra-workers <claimPda:workerPda,...> Optional collaborative worker pairs",
    "      --delegatee-agent-pda <pda>           Target agent PDA for reputation delegation",
    "      --delegatee-agent-id <hex>            Target agent id for reputation delegation",
    "      --expires-at <unix>                   Optional reputation delegation expiry",
    "      --worker-agent-pda <pda>              Explicit worker agent for task actions",
    "      --worker-claim-pda <pda>              Explicit worker claim PDA for disputes",
    "      --initiator-agent-pda <pda>           Explicit initiator agent PDA for disputes",
    "      --buyer-agent-pda <pda>               Explicit buyer agent PDA for skill purchase",
    "      --rater-agent-pda <pda>               Explicit rater agent PDA for skill rating",
    "      --voter-agent-pda <pda>               Explicit voter agent PDA for governance",
    "      --staker-agent-pda <pda>              Explicit staker agent PDA for reputation stake",
    "      --delegator-agent-pda <pda>           Explicit delegator agent PDA for reputation delegation",
    "",
    "Examples:",
    "  agenc-runtime start --config ~/.agenc/config.json",
    "  agenc-runtime start --foreground --config ~/.agenc/config.json",
    "  agenc-runtime start --foreground --yolo --config ~/.agenc/config.json",
    "  agenc-runtime stop",
    "  agenc-runtime restart --config ~/.agenc/config.json",
    "  agenc-runtime status",
    "  agenc-runtime service install",
    "  agenc-runtime service install --macos",
    "  agenc-runtime config init",
    "  agenc-runtime config init --force",
    "  agenc-runtime config validate --config ~/.agenc/config.json",
    "  agenc-runtime config show",
    "  agenc-runtime sessions list",
    "  agenc-runtime sessions kill client_1",
    "  agenc-runtime logs",
    "  agenc-runtime connector list",
    "  agenc-runtime connector status telegram",
    "  agenc-runtime connector add telegram --bot-token-env TELEGRAM_BOT_TOKEN",
    "  printf '%s' \"$TELEGRAM_BOT_TOKEN\" | agenc-runtime connector add telegram --bot-token-stdin --restart=false",
    "  agenc-runtime connector remove telegram",
    "  agenc-runtime onboard --force",
    "  agenc-runtime health --deep",
    "  agenc-runtime doctor --deep --fix",
    "  agenc-runtime doctor security --deep --fix",
    "  agenc-runtime init",
    "  agenc-runtime init --force",
    "  agenc-runtime replay backfill --to-slot 12345 --page-size 500",
    "  agenc-runtime replay compare --local-trace-path ./trace.json --task-pda AGENTpda",
    "  agenc-runtime replay incident --task-pda AGENTpda --from-slot 100 --to-slot 200",
    "  agenc-runtime plugin install --manifest ./plugin.json --precedence workspace --slot llm",
    "  agenc-runtime plugin disable memory.plugin",
    "  agenc-runtime plugin list",
    "  agenc-runtime market tasks list --status open,in_progress",
    "  agenc-runtime market tasks create --description 'public task' --reward 50000000",
    "  agenc-runtime market tasks claim <taskPda>",
    "  agenc-runtime market tasks cancel <taskPda>",
    "  agenc-runtime market tasks complete <taskPda> --result-data 'completed via cli'",
    "  agenc-runtime market tasks dispute <taskPda> --evidence 'worker failed validation' --resolution-type refund",
    "  agenc-runtime market tui",
    "  agenc-runtime market skills list --query swap --tags defi",
    "  agenc-runtime market skills purchase <skillPda>",
    "  agenc-runtime market governance vote <proposalPda> yes",
    "  agenc-runtime market disputes resolve <disputePda> --arbiter-votes vote1:arbiter1,vote2:arbiter2",
    "  agenc-runtime market reputation summary",
    "  agenc-runtime market reputation delegate 250 --delegatee-agent-pda <agentPda> --expires-at 1760000000",
    "  agenc-runtime skill list",
    "  agenc-runtime skill info my-skill",
    "  agenc-runtime skill validate",
    "  agenc-runtime skill create my-new-skill",
    "  agenc-runtime skill install ./path/to/skill.md",
    "  agenc-runtime skill uninstall my-skill",
    "  agenc-runtime skill enable my-skill",
    "  agenc-runtime skill disable my-skill",
    '  agenc-runtime skill search "defi swap" --tags defi,swap --limit 5',
    "  agenc-runtime skill registry-install my-skill-id",
    "  agenc-runtime skill publish ./skills/my-skill.md --tags defi --price 1000000",
    '  agenc-runtime skill rate my-skill-id 5 --review "Great skill!"',
    "  agenc-runtime skill verify my-skill-id --path ./local-skill.md",
    "  agenc-runtime skill import-openclaw ./openclaw-skill.md",
  ].join("\n");
}

export function parseArgv(argv: string[]): ParsedArgv {
  const positional: string[] = [];
  const flags: Record<string, string | number | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("-")) {
      positional.push(token);
      continue;
    }

    if (token === "-") {
      positional.push(token);
      continue;
    }

    if (token === "-h") {
      flags.h = true;
      continue;
    }

    if (!token.startsWith("--")) {
      // Single short option not in scope (keep deterministic error path by treating as positional for now)
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    if (!body) {
      continue;
    }

    const parts = body.split("=", 2);
    const rawName = parts[0];
    const rawValue = parts[1];
    if (parts.length === 2) {
      flags[rawName] = parseStringValue(rawValue);
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags[rawName] = parseStringValue(next);
      index += 1;
      continue;
    }

    flags[rawName] = true;
  }

  return { positional, flags };
}

function parseStringValue(raw: string): string | number | boolean {
  const lowered = raw.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  if (/^-?\d+$/.test(raw) && raw.length <= 15) {
    return Number.parseInt(raw, 10);
  }
  return raw;
}

function normalizeBool(value: unknown, fallback = false): boolean {
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

function parseIntValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parsePositiveInt(value: unknown, flagName: string): number | undefined {
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

function parseAllowedUsers(value: unknown): readonly number[] | undefined {
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

function normalizeOutputFormat(value: unknown): CliOutputFormat {
  return value === "jsonl" || value === "table" || value === "json"
    ? value
    : DEFAULT_OUTPUT_FORMAT;
}

function normalizeStoreType(value: unknown): "memory" | "sqlite" {
  return value === "memory" || value === "sqlite" ? value : DEFAULT_STORE_TYPE;
}

function normalizeLogLevel(value: unknown): CliLogLevel {
  return value === "silent" ||
    value === "error" ||
    value === "warn" ||
    value === "info" ||
    value === "debug"
    ? value
    : DEFAULT_LOG_LEVEL;
}

function normalizeCommandFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true" || value === "1") return true;
    if (value.toLowerCase() === "false" || value === "0") return false;
  }
  return false;
}

function readEnvironmentConfig(): CliFileConfig {
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

function readManagedOverrideConfig(rawFlags: ParsedArgv["flags"]): CliFileConfig {
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

function resolveLegacyCompatibleConfigSelection(
  rawFlags: ParsedArgv["flags"],
) {
  return resolveCliConfigPath({
    explicitConfigPath: parseOptionalString(rawFlags.config),
    env: process.env,
    cwd: process.cwd(),
  });
}

function resolveGatewayConfigPath(rawFlags: ParsedArgv["flags"]): string {
  const explicit = parseOptionalString(rawFlags.config);
  const envPath = parseOptionalString(process.env.AGENC_CONFIG);
  return resolve(process.cwd(), explicit ?? envPath ?? getCanonicalDefaultConfigPath());
}

function loadFileConfigFromSelection(
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

function validateUnknownOptions(
  flags: ParsedArgv["flags"],
  command: ReplayCommand | PluginCommand,
): void {
  const commandOpts =
    command === "backfill" || command === "compare" || command === "incident"
      ? COMMAND_OPTIONS[command]
      : PLUGIN_COMMAND_OPTIONS[command];
  for (const rawName of Object.keys(flags)) {
    const normalized = normalizeOptionAliases(rawName);
    if (rawName === "h" || isValidTopLevelOption(normalized)) {
      continue;
    }
    if (commandOpts.has(rawName) || commandOpts.has(normalized)) {
      continue;
    }
    throw createCliError(
      `unknown option --${rawName}`,
      ERROR_CODES.INVALID_OPTION,
    );
  }
}

function validateUnknownStandaloneOptions(
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

function normalizeGlobalFlags(
  flags: ParsedArgv["flags"],
  fileConfig: CliFileConfig,
  envConfig: CliFileConfig,
): {
  outputFormat: CliOutputFormat;
  strictMode: boolean;
  role?: OperatorRole;
  rpcUrl?: string;
  programId?: string;
  storeType: "memory" | "sqlite";
  sqlitePath?: string;
  traceId?: string;
  idempotencyWindow: number;
  help: boolean;
  logLevel: CliLogLevel;
} {
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

type PluginGlobalContext = Omit<
  ReturnType<typeof normalizeGlobalFlags>,
  "logLevel"
>;

function validateReplayCommand(name: string): name is ReplayCommand {
  return name === "backfill" || name === "compare" || name === "incident";
}

function validatePluginCommand(name: string): name is PluginCommand {
  return (
    name === "list" ||
    name === "install" ||
    name === "disable" ||
    name === "enable" ||
    name === "reload"
  );
}

function validateConnectorCommand(name: string): name is ConnectorCommand {
  return (
    name === "list" ||
    name === "status" ||
    name === "add" ||
    name === "remove"
  );
}

function parseOperatorRole(value: unknown): OperatorRole | undefined {
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

function parsePluginPrecedence(value: unknown): PluginPrecedence {
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

function parsePluginSlot(value: unknown): PluginSlot {
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

function parseConnectorName(value: unknown): "telegram" {
  if (value === "telegram") {
    return value;
  }
  throw createCliError(
    "connector name must be: telegram",
    ERROR_CODES.INVALID_VALUE,
  );
}

function makePluginOptionsBase(global: PluginGlobalContext): BaseCliOptions {
  return {
    help: global.help,
    outputFormat: global.outputFormat,
    strictMode: global.strictMode,
    role: global.role,
    rpcUrl: global.rpcUrl,
    programId: global.programId,
    storeType: global.storeType,
    sqlitePath: global.sqlitePath,
    traceId: global.traceId,
    idempotencyWindow: global.idempotencyWindow,
  };
}

function makeBackfillOptions(
  raw: Record<string, string | number | boolean>,
  global: Omit<ReplayBackfillOptions, "toSlot" | "pageSize">,
): ReplayBackfillOptions {
  const toSlot = parseIntValue(raw["to-slot"]);
  const pageSize = parseIntValue(raw["page-size"]);

  if (toSlot === undefined || toSlot <= 0) {
    throw createCliError(
      "backfill requires --to-slot as a positive integer",
      ERROR_CODES.MISSING_REQUIRED_OPTION,
    );
  }

  return {
    ...global,
    toSlot,
    pageSize: pageSize,
  };
}

function makeCompareOptions(
  raw: Record<string, string | number | boolean>,
  global: Omit<
    ReplayCompareOptions,
    "localTracePath" | "taskPda" | "disputePda"
  >,
): ReplayCompareOptions {
  const localTracePath = parseOptionalString(raw["local-trace-path"]);
  if (localTracePath === undefined) {
    throw createCliError(
      "--local-trace-path is required for replay compare",
      ERROR_CODES.MISSING_REQUIRED_OPTION,
    );
  }

  const redactFields = parseRedactFields(raw["redact-fields"]);

  return {
    ...global,
    localTracePath,
    taskPda: parseOptionalString(raw["task-pda"]),
    disputePda: parseOptionalString(raw["dispute-pda"]),
    redactFields,
  };
}

function makeIncidentOptions(
  raw: Record<string, string | number | boolean>,
  global: Omit<
    ReplayIncidentOptions,
    "taskPda" | "disputePda" | "query" | "fromSlot" | "toSlot"
  >,
): ReplayIncidentOptions {
  const taskPda = parseOptionalString(raw["task-pda"]);
  const disputePda = parseOptionalString(raw["dispute-pda"]);
  const query = parseOptionalString(raw.query);
  const fromSlot = parseIntValue(raw["from-slot"]);
  const toSlot = parseIntValue(raw["to-slot"]);
  const sealed =
    raw.sealed === undefined ? undefined : normalizeCommandFlag(raw.sealed);
  const redactFields = parseRedactFields(raw["redact-fields"]);

  if (fromSlot !== undefined && fromSlot < 0) {
    throw createCliError(
      "--from-slot must be non-negative",
      ERROR_CODES.INVALID_VALUE,
    );
  }

  if (toSlot !== undefined && toSlot < 0) {
    throw createCliError(
      "--to-slot must be non-negative",
      ERROR_CODES.INVALID_VALUE,
    );
  }

  if (fromSlot !== undefined && toSlot !== undefined && toSlot < fromSlot) {
    throw createCliError(
      "--to-slot must be greater than or equal to --from-slot",
      ERROR_CODES.INVALID_VALUE,
    );
  }

  if (
    taskPda === undefined &&
    disputePda === undefined &&
    query === undefined
  ) {
    throw createCliError(
      "incident requires --task-pda, --dispute-pda, or --query",
      ERROR_CODES.MISSING_TARGET,
    );
  }

  return {
    ...global,
    taskPda,
    disputePda,
    query,
    fromSlot,
    toSlot,
    sealed,
    redactFields,
  };
}

function makePluginListOptions(
  _raw: Record<string, string | number | boolean>,
  global: PluginGlobalContext,
): PluginListOptions {
  return {
    ...makePluginOptionsBase(global),
  };
}

function makePluginInstallOptions(
  raw: Record<string, string | number | boolean>,
  global: PluginGlobalContext,
): PluginInstallOptions {
  const manifestPath = parseOptionalString(raw.manifest);
  if (manifestPath === undefined) {
    throw createCliError(
      "--manifest is required for plugin install",
      ERROR_CODES.MISSING_REQUIRED_OPTION,
    );
  }
  const precedence = parseOptionalString(raw.precedence);
  const slot = parseOptionalString(raw.slot);

  return {
    ...makePluginOptionsBase(global),
    manifestPath,
    precedence:
      precedence === undefined ? undefined : parsePluginPrecedence(precedence),
    slot: slot === undefined ? undefined : parsePluginSlot(slot),
  };
}

function makePluginDisableOptions(
  pluginId: string | undefined,
  global: PluginGlobalContext,
): PluginToggleOptions {
  if (pluginId === undefined) {
    throw createCliError(
      "--plugin-id is required for plugin disable",
      ERROR_CODES.MISSING_REQUIRED_OPTION,
    );
  }

  return {
    ...makePluginOptionsBase(global),
    pluginId,
  };
}

function makePluginEnableOptions(
  pluginId: string | undefined,
  global: PluginGlobalContext,
): PluginToggleOptions {
  if (pluginId === undefined) {
    throw createCliError(
      "--plugin-id is required for plugin enable",
      ERROR_CODES.MISSING_REQUIRED_OPTION,
    );
  }

  return {
    ...makePluginOptionsBase(global),
    pluginId,
  };
}

function makePluginReloadOptions(
  pluginId: string | undefined,
  global: PluginGlobalContext,
  raw: Record<string, string | number | boolean>,
): PluginReloadOptions {
  if (pluginId === undefined) {
    throw createCliError(
      "--plugin-id is required for plugin reload",
      ERROR_CODES.MISSING_REQUIRED_OPTION,
    );
  }

  return {
    ...makePluginOptionsBase(global),
    pluginId,
    manifestPath: parseOptionalString(raw.manifest),
  };
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

function parseRedactFields(raw: unknown): string[] {
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

function applyRedaction<T>(value: T, redactions: readonly string[]): T {
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
      if (redactionSet.has(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = transform(itemValue);
      }
    }

    return output;
  };

  return transform(value) as T;
}

function createContext(
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

function buildErrorPayload(error: unknown): {
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

const DEFAULT_USAGE_ERROR_CODES = new Set<string>([
  ERROR_CODES.INVALID_OPTION,
  ERROR_CODES.INVALID_VALUE,
  ERROR_CODES.MISSING_REQUIRED_OPTION,
  ERROR_CODES.MISSING_TARGET,
  ERROR_CODES.MISSING_ROOT_COMMAND,
  ERROR_CODES.UNKNOWN_COMMAND,
]);

function reportCliError(
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

interface PluginParseReport {
  command: "plugin";
  pluginCommand: PluginCommand;
  global: {
    help: boolean;
    strictMode: boolean;
    outputFormat: CliOutputFormat;
    role?: OperatorRole;
    rpcUrl?: string;
    programId?: string;
    storeType: "memory" | "sqlite";
    sqlitePath?: string;
    traceId?: string;
    idempotencyWindow: number;
  };
  options: PluginCommandOptions;
  outputFormat: CliOutputFormat;
}

function normalizeAndValidate(parsed: ParsedArgv): CliParseReport {
  const configSelection = resolveLegacyCompatibleConfigSelection(parsed.flags);
  let fileConfig: CliFileConfig;
  try {
    fileConfig = loadFileConfigFromSelection(configSelection);
  } catch (error) {
    throw createCliError(
      `failed to parse config file ${configSelection.configPath}: ${error instanceof Error ? error.message : String(error)}`,
      ERROR_CODES.CONFIG_PARSE_ERROR,
    );
  }

  const envConfig = readEnvironmentConfig();

  if (parsed.positional.length === 0) {
    throw createCliError(
      "missing replay command group",
      ERROR_CODES.MISSING_ROOT_COMMAND,
    );
  }

  const root = parsed.positional[0];
  if (root !== "replay") {
    throw createCliError(
      `unknown root command: ${root}`,
      ERROR_CODES.UNKNOWN_COMMAND,
    );
  }

  const replayCommand = parsed.positional[1] as string | undefined;
  if (!replayCommand) {
    throw createCliError(
      "missing replay subcommand",
      ERROR_CODES.MISSING_REPLAY_COMMAND,
    );
  }
  if (!validateReplayCommand(replayCommand)) {
    throw createCliError(
      `unknown replay command: ${replayCommand}`,
      ERROR_CODES.UNKNOWN_REPLAY_COMMAND,
    );
  }

  validateUnknownOptions(parsed.flags, replayCommand);

  const global = normalizeGlobalFlags(parsed.flags, fileConfig, envConfig);

  if (global.storeType === "sqlite" && global.sqlitePath === undefined) {
    global.sqlitePath = fileConfig.sqlitePath ?? envConfig.sqlitePath;
  }

  const common = {
    help: global.help,
    outputFormat: global.outputFormat,
    strictMode: global.strictMode,
    role: global.role,
    rpcUrl: global.rpcUrl,
    programId: global.programId,
    storeType: global.storeType,
    sqlitePath: global.sqlitePath,
    traceId: global.traceId,
    idempotencyWindow: global.idempotencyWindow,
  };

  let options: CliCommandOptions;
  if (replayCommand === "backfill") {
    options = makeBackfillOptions(
      parsed.flags,
      common as Omit<ReplayBackfillOptions, "toSlot" | "pageSize">,
    );
  } else if (replayCommand === "compare") {
    options = makeCompareOptions(
      parsed.flags,
      common as Omit<
        ReplayCompareOptions,
        "localTracePath" | "taskPda" | "disputePda"
      >,
    );
  } else {
    options = makeIncidentOptions(
      parsed.flags,
      common as Omit<
        ReplayIncidentOptions,
        "taskPda" | "disputePda" | "fromSlot" | "toSlot"
      >,
    );
  }

  return {
    command: "replay",
    replayCommand,
    global: {
      help: global.help,
      strictMode: common.strictMode,
      outputFormat: common.outputFormat,
      role: common.role,
      rpcUrl: common.rpcUrl,
      programId: common.programId,
      storeType: common.storeType,
      sqlitePath: common.sqlitePath,
      traceId: common.traceId,
      idempotencyWindow: common.idempotencyWindow,
    },
    options,
    outputFormat: common.outputFormat,
  };
}

function normalizeAndValidatePluginCommand(
  parsed: ParsedArgv,
): PluginParseReport {
  const configSelection = resolveLegacyCompatibleConfigSelection(parsed.flags);
  let fileConfig: CliFileConfig;
  try {
    fileConfig = loadFileConfigFromSelection(configSelection);
  } catch (error) {
    throw createCliError(
      `failed to parse config file ${configSelection.configPath}: ${error instanceof Error ? error.message : String(error)}`,
      ERROR_CODES.CONFIG_PARSE_ERROR,
    );
  }

  const envConfig = readEnvironmentConfig();

  if (parsed.positional.length === 0) {
    throw createCliError(
      "missing plugin command group",
      ERROR_CODES.MISSING_ROOT_COMMAND,
    );
  }

  const root = parsed.positional[0];
  if (root !== "plugin") {
    throw createCliError(
      `unknown root command: ${root}`,
      ERROR_CODES.UNKNOWN_COMMAND,
    );
  }

  const pluginCommand = parsed.positional[1] as string | undefined;
  if (!pluginCommand) {
    throw createCliError(
      "missing plugin subcommand",
      ERROR_CODES.MISSING_PLUGIN_COMMAND,
    );
  }
  if (!validatePluginCommand(pluginCommand)) {
    throw createCliError(
      `unknown plugin command: ${pluginCommand}`,
      ERROR_CODES.UNKNOWN_PLUGIN_COMMAND,
    );
  }

  validateUnknownOptions(parsed.flags, pluginCommand);

  const global = normalizeGlobalFlags(parsed.flags, fileConfig, envConfig);

  if (global.storeType === "sqlite" && global.sqlitePath === undefined) {
    global.sqlitePath = fileConfig.sqlitePath ?? envConfig.sqlitePath;
  }

  const common = {
    help: global.help,
    outputFormat: global.outputFormat,
    strictMode: global.strictMode,
    role: global.role,
    rpcUrl: global.rpcUrl,
    programId: global.programId,
    storeType: global.storeType,
    sqlitePath: global.sqlitePath,
    traceId: global.traceId,
    idempotencyWindow: global.idempotencyWindow,
  };

  const pluginId = parseOptionalString(parsed.positional[2]);
  let options: PluginCommandOptions;
  if (pluginCommand === "list") {
    options = makePluginListOptions(parsed.flags, common);
  } else if (pluginCommand === "install") {
    options = makePluginInstallOptions(parsed.flags, common);
  } else if (pluginCommand === "disable") {
    options = makePluginDisableOptions(pluginId, common);
  } else if (pluginCommand === "enable") {
    options = makePluginEnableOptions(pluginId, common);
  } else {
    options = makePluginReloadOptions(pluginId, common, parsed.flags);
  }

  return {
    command: "plugin",
    pluginCommand,
    global: {
      help: common.help,
      strictMode: common.strictMode,
      outputFormat: common.outputFormat,
      role: common.role,
      rpcUrl: common.rpcUrl,
      programId: common.programId,
      storeType: common.storeType,
      sqlitePath: common.sqlitePath,
      traceId: common.traceId,
      idempotencyWindow: common.idempotencyWindow,
    },
    options,
    outputFormat: common.outputFormat,
  };
}

interface SkillParseReport {
  command: "skill";
  skillCommand: SkillCommand;
  global: {
    help: boolean;
    strictMode: boolean;
    outputFormat: CliOutputFormat;
    role?: OperatorRole;
    rpcUrl?: string;
    programId?: string;
    storeType: "memory" | "sqlite";
    sqlitePath?: string;
    traceId?: string;
    idempotencyWindow: number;
  };
  options: SkillCommandOptions;
  outputFormat: CliOutputFormat;
}

interface MarketParseReport {
  command: "market";
  marketCommand: MarketCommand;
  global: {
    help: boolean;
    strictMode: boolean;
    outputFormat: CliOutputFormat;
    role?: OperatorRole;
    rpcUrl?: string;
    programId?: string;
    storeType: "memory" | "sqlite";
    sqlitePath?: string;
    traceId?: string;
    idempotencyWindow: number;
  };
  options: MarketCommandOptions | MarketTuiOptions;
  outputFormat: CliOutputFormat;
}

function normalizeAndValidateSkillCommand(
  parsed: ParsedArgv,
): SkillParseReport {
  const configSelection = resolveLegacyCompatibleConfigSelection(parsed.flags);
  let fileConfig: CliFileConfig;
  try {
    fileConfig = loadFileConfigFromSelection(configSelection);
  } catch (error) {
    throw createCliError(
      `failed to parse config file ${configSelection.configPath}: ${error instanceof Error ? error.message : String(error)}`,
      ERROR_CODES.CONFIG_PARSE_ERROR,
    );
  }

  const envConfig = readEnvironmentConfig();

  const skillCommand = parsed.positional[1] as string | undefined;
  if (!skillCommand) {
    throw createCliError(
      "missing skill subcommand",
      ERROR_CODES.MISSING_SKILL_COMMAND,
    );
  }
  if (!validateSkillCommand(skillCommand)) {
    throw createCliError(
      `unknown skill command: ${skillCommand}`,
      ERROR_CODES.UNKNOWN_SKILL_COMMAND,
    );
  }

  validateUnknownStandaloneOptions(
    parsed.flags,
    SKILL_COMMAND_OPTIONS[skillCommand],
  );

  const global = normalizeGlobalFlags(parsed.flags, fileConfig, envConfig);

  const base: BaseCliOptions = {
    help: global.help,
    outputFormat: global.outputFormat,
    strictMode: global.strictMode,
    role: global.role,
    rpcUrl: global.rpcUrl,
    programId: global.programId,
    storeType: global.storeType,
    sqlitePath: global.sqlitePath,
    traceId: global.traceId,
    idempotencyWindow: global.idempotencyWindow,
  };

  let options: SkillCommandOptions;

  if (
    skillCommand === "info" ||
    skillCommand === "enable" ||
    skillCommand === "disable" ||
    skillCommand === "uninstall" ||
    skillCommand === "create"
  ) {
    const target = parsed.positional[2];
    if (!target) {
      throw createCliError(
        `skill ${skillCommand} requires a name argument`,
        ERROR_CODES.MISSING_TARGET,
      );
    }
    if (skillCommand === "info") {
      options = { ...base, skillName: target } as SkillInfoOptions;
    } else if (skillCommand === "create") {
      options = { ...base, skillName: target } as SkillCreateOptions;
    } else if (skillCommand === "uninstall") {
      options = { ...base, skillName: target } as SkillUninstallOptions;
    } else {
      options = { ...base, skillName: target } as SkillToggleOptions;
    }
  } else if (skillCommand === "install") {
    const source = parsed.positional[2];
    if (!source) {
      throw createCliError(
        "skill install requires a source argument",
        ERROR_CODES.MISSING_TARGET,
      );
    }
    options = { ...base, source } as SkillInstallOptions;
  } else if (skillCommand === "search") {
    const query = parsed.positional[2];
    if (!query) {
      throw createCliError(
        "skill search requires a query argument",
        ERROR_CODES.MISSING_TARGET,
      );
    }
    const tagsRaw = parsed.flags.tags;
    const tags =
      typeof tagsRaw === "string"
        ? tagsRaw
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;
    const limitRaw = parsed.flags.limit;
    const limit =
      typeof limitRaw === "number"
        ? limitRaw
        : typeof limitRaw === "string"
          ? Number.parseInt(limitRaw, 10)
          : undefined;
    options = { ...base, query, tags, limit } as RegistrySearchOptions;
  } else if (skillCommand === "registry-install") {
    const skillId = parsed.positional[2];
    if (!skillId) {
      throw createCliError(
        "skill registry-install requires a skill-id argument",
        ERROR_CODES.MISSING_TARGET,
      );
    }
    options = { ...base, skillId } as RegistryInstallOptions;
  } else if (skillCommand === "publish") {
    const skillPath = parsed.positional[2];
    if (!skillPath) {
      throw createCliError(
        "skill publish requires a path argument",
        ERROR_CODES.MISSING_TARGET,
      );
    }
    const tagsRaw = parsed.flags.tags;
    const tags =
      typeof tagsRaw === "string"
        ? tagsRaw
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;
    const priceLamports =
      typeof parsed.flags.price === "string"
        ? parsed.flags.price
        : typeof parsed.flags.price === "number"
          ? String(parsed.flags.price)
          : undefined;
    options = {
      ...base,
      skillPath,
      tags,
      priceLamports,
    } as RegistryPublishOptions;
  } else if (skillCommand === "rate") {
    const skillId = parsed.positional[2];
    const ratingRaw = parsed.positional[3];
    if (!skillId || !ratingRaw) {
      throw createCliError(
        "skill rate requires <skill-id> <rating> arguments",
        ERROR_CODES.MISSING_TARGET,
      );
    }
    const rating = Number.parseInt(ratingRaw, 10);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw createCliError(
        "rating must be an integer between 1 and 5",
        ERROR_CODES.INVALID_VALUE,
      );
    }
    const review =
      typeof parsed.flags.review === "string" ? parsed.flags.review : undefined;
    options = { ...base, skillId, rating, review } as RegistryRateOptions;
  } else if (skillCommand === "verify") {
    const skillId = parsed.positional[2];
    if (!skillId) {
      throw createCliError(
        "skill verify requires a skill-id argument",
        ERROR_CODES.MISSING_TARGET,
      );
    }
    const localPath =
      typeof parsed.flags.path === "string" ? parsed.flags.path : undefined;
    options = { ...base, skillId, localPath } as RegistryVerifyOptions;
  } else if (skillCommand === "import-openclaw") {
    const source = parsed.positional[2];
    if (!source) {
      throw createCliError(
        "skill import-openclaw requires a source argument",
        ERROR_CODES.MISSING_TARGET,
      );
    }
    options = { ...base, source } as RegistryImportOpenclawOptions;
  } else {
    options = { ...base };
  }

  return {
    command: "skill",
    skillCommand,
    global: {
      help: base.help,
      strictMode: base.strictMode,
      outputFormat: base.outputFormat,
      role: base.role,
      rpcUrl: base.rpcUrl,
      programId: base.programId,
      storeType: base.storeType,
      sqlitePath: base.sqlitePath,
      traceId: base.traceId,
      idempotencyWindow: base.idempotencyWindow,
    },
    options,
    outputFormat: base.outputFormat,
  };
}

function parseStringListFlag(
  raw: string | number | boolean | undefined,
): string[] | undefined {
  if (typeof raw !== "string") return undefined;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseOptionalStringFlag(
  raw: string | number | boolean | undefined,
): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

function parseOptionalScalarFlag(
  raw: string | number | boolean | undefined,
): string | undefined {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  return undefined;
}

function parseOptionalNumberFlag(
  raw: string | number | boolean | undefined,
): number | undefined {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseVoteChoice(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes" || normalized === "true" || normalized === "approve") {
    return true;
  }
  if (normalized === "no" || normalized === "false" || normalized === "reject") {
    return false;
  }
  throw createCliError(
    "market governance vote expects yes|no",
    ERROR_CODES.INVALID_VALUE,
  );
}

function normalizeAndValidateMarketCommand(
  parsed: ParsedArgv,
): MarketParseReport {
  const configSelection = resolveLegacyCompatibleConfigSelection(parsed.flags);
  let fileConfig: CliFileConfig;
  try {
    fileConfig = loadFileConfigFromSelection(configSelection);
  } catch (error) {
    throw createCliError(
      `failed to parse config file ${configSelection.configPath}: ${error instanceof Error ? error.message : String(error)}`,
      ERROR_CODES.CONFIG_PARSE_ERROR,
    );
  }

  const envConfig = readEnvironmentConfig();
  const domain = parsed.positional[1] as string | undefined;
  const action = parsed.positional[2] as string | undefined;
  if (!domain) {
    throw createCliError(
      "missing market subcommand (for example: market tasks list or market tui)",
      ERROR_CODES.MISSING_MARKET_COMMAND,
    );
  }

  const global = normalizeGlobalFlags(parsed.flags, fileConfig, envConfig);
  const base: BaseCliOptions = {
    help: global.help,
    outputFormat: global.outputFormat,
    strictMode: global.strictMode,
    role: global.role,
    rpcUrl: global.rpcUrl,
    programId: global.programId,
    storeType: global.storeType,
    sqlitePath: global.sqlitePath,
    traceId: global.traceId,
    idempotencyWindow: global.idempotencyWindow,
  };

  if (domain === "tui") {
    const explicitOutputRequested =
      parseOptionalStringFlag(parsed.flags.output) !== undefined ||
      parseOptionalStringFlag(parsed.flags["output-format"]) !== undefined;
    const interactiveOutputFormat = explicitOutputRequested
      ? base.outputFormat
      : "table";
    if (action) {
      throw createCliError(
        "market tui does not accept a subcommand",
        ERROR_CODES.INVALID_VALUE,
      );
    }
    validateUnknownStandaloneOptions(parsed.flags, MARKET_COMMAND_OPTIONS.tui);
    return {
      command: "market",
      marketCommand: "tui",
      global: {
        help: base.help,
        strictMode: base.strictMode,
        outputFormat: interactiveOutputFormat,
        role: base.role,
        rpcUrl: base.rpcUrl,
        programId: base.programId,
        storeType: base.storeType,
        sqlitePath: base.sqlitePath,
        traceId: base.traceId,
        idempotencyWindow: base.idempotencyWindow,
      },
      options: {
        ...base,
        outputFormat: interactiveOutputFormat,
      } as MarketTuiOptions,
      outputFormat: interactiveOutputFormat,
    };
  }

  if (!action) {
    throw createCliError(
      "missing market subcommand (for example: market tasks list)",
      ERROR_CODES.MISSING_MARKET_COMMAND,
    );
  }

  const marketCommand = `${domain}.${action}`;
  if (!validateMarketCommand(marketCommand) || marketCommand === "tui") {
    throw createCliError(
      `unknown market command: ${marketCommand}`,
      ERROR_CODES.UNKNOWN_MARKET_COMMAND,
    );
  }

  validateUnknownStandaloneOptions(
    parsed.flags,
    MARKET_COMMAND_OPTIONS[marketCommand],
  );

  let options: MarketCommandOptions;
  switch (marketCommand) {
    case "tasks.list":
      options = {
        ...base,
        statuses: parseStringListFlag(parsed.flags.status),
      } as MarketTasksListOptions;
      break;
    case "tasks.create": {
      const description = parseOptionalStringFlag(parsed.flags.description);
      const reward = parseOptionalScalarFlag(parsed.flags.reward);
      if (!description) {
        throw createCliError(
          "market tasks create requires --description <text>",
          ERROR_CODES.MISSING_REQUIRED_OPTION,
        );
      }
      if (!reward) {
        throw createCliError(
          "market tasks create requires --reward <lamports>",
          ERROR_CODES.MISSING_REQUIRED_OPTION,
        );
      }
      options = {
        ...base,
        description,
        reward,
        requiredCapabilities:
          parseOptionalScalarFlag(parsed.flags["required-capabilities"]) ?? "1",
        maxWorkers: parseOptionalNumberFlag(parsed.flags["max-workers"]),
        deadline: parseOptionalNumberFlag(parsed.flags.deadline),
        taskType: parseOptionalNumberFlag(parsed.flags["task-type"]),
        creatorAgentPda: parseOptionalStringFlag(parsed.flags["creator-agent-pda"]),
      } as MarketTaskCreateOptions;
      break;
    }
    case "tasks.detail": {
      const taskPda = parsed.positional[3];
      if (!taskPda) {
        throw createCliError(
          "market tasks detail requires <taskPda>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      options = { ...base, taskPda } as MarketTaskDetailOptions;
      break;
    }
    case "tasks.cancel": {
      const taskPda = parsed.positional[3];
      if (!taskPda) {
        throw createCliError(
          "market tasks cancel requires <taskPda>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      options = { ...base, taskPda } as MarketTaskCancelOptions;
      break;
    }
    case "tasks.claim": {
      const taskPda = parsed.positional[3];
      if (!taskPda) {
        throw createCliError(
          "market tasks claim requires <taskPda>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      options = {
        ...base,
        taskPda,
        workerAgentPda: parseOptionalStringFlag(parsed.flags["worker-agent-pda"]),
      } as MarketTaskClaimOptions;
      break;
    }
    case "tasks.complete": {
      const taskPda = parsed.positional[3];
      if (!taskPda) {
        throw createCliError(
          "market tasks complete requires <taskPda>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      options = {
        ...base,
        taskPda,
        proofHash: parseOptionalStringFlag(parsed.flags["proof-hash"]),
        resultData: parseOptionalStringFlag(parsed.flags["result-data"]),
        workerAgentPda: parseOptionalStringFlag(parsed.flags["worker-agent-pda"]),
      } as MarketTaskCompleteOptions;
      break;
    }
    case "tasks.dispute": {
      const taskPda = parsed.positional[3];
      const evidence = parseOptionalStringFlag(parsed.flags.evidence);
      if (!taskPda) {
        throw createCliError(
          "market tasks dispute requires <taskPda>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      if (!evidence) {
        throw createCliError(
          "market tasks dispute requires --evidence <text>",
          ERROR_CODES.MISSING_REQUIRED_OPTION,
        );
      }
      options = {
        ...base,
        taskPda,
        evidence,
        resolutionType: parseOptionalStringFlag(parsed.flags["resolution-type"]),
        workerAgentPda: parseOptionalStringFlag(parsed.flags["worker-agent-pda"]),
        workerClaimPda: parseOptionalStringFlag(parsed.flags["worker-claim-pda"]),
        initiatorAgentPda: parseOptionalStringFlag(parsed.flags["initiator-agent-pda"]),
      } as MarketTaskDisputeOptions;
      break;
    }
    case "skills.list":
      options = {
        ...base,
        query:
          parsed.positional[3] ??
          parseOptionalStringFlag(parsed.flags.query),
        tags: parseStringListFlag(parsed.flags.tags),
        limit: parseOptionalNumberFlag(parsed.flags.limit),
      } as MarketSkillsListOptions;
      break;
    case "skills.detail": {
      const skillPda = parsed.positional[3];
      if (!skillPda) {
        throw createCliError(
          "market skills detail requires <skillPda>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      options = { ...base, skillPda } as MarketSkillDetailOptions;
      break;
    }
    case "skills.purchase": {
      const skillPda = parsed.positional[3];
      if (!skillPda) {
        throw createCliError(
          "market skills purchase requires <skillPda>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      options = {
        ...base,
        skillPda,
        expectedPrice: parseOptionalStringFlag(parsed.flags["expected-price"]),
        buyerAgentPda: parseOptionalStringFlag(parsed.flags["buyer-agent-pda"]),
      } as MarketSkillPurchaseOptions;
      break;
    }
    case "skills.rate": {
      const skillPda = parsed.positional[3];
      const ratingRaw = parsed.positional[4];
      if (!skillPda || !ratingRaw) {
        throw createCliError(
          "market skills rate requires <skillPda> <rating>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      const rating = Number.parseInt(ratingRaw, 10);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw createCliError(
          "rating must be an integer between 1 and 5",
          ERROR_CODES.INVALID_VALUE,
        );
      }
      options = {
        ...base,
        skillPda,
        rating,
        review: parseOptionalStringFlag(parsed.flags.review),
        raterAgentPda: parseOptionalStringFlag(parsed.flags["rater-agent-pda"]),
      } as MarketSkillRateOptions;
      break;
    }
    case "governance.list":
      options = { ...base } as MarketGovernanceListOptions;
      break;
    case "governance.detail": {
      const proposalPda = parsed.positional[3];
      if (!proposalPda) {
        throw createCliError(
          "market governance detail requires <proposalPda>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      options = { ...base, proposalPda } as MarketGovernanceDetailOptions;
      break;
    }
    case "governance.vote": {
      const proposalPda = parsed.positional[3];
      const choice = parsed.positional[4];
      if (!proposalPda || !choice) {
        throw createCliError(
          "market governance vote requires <proposalPda> <yes|no>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      options = {
        ...base,
        proposalPda,
        approve: parseVoteChoice(choice),
        voterAgentPda: parseOptionalStringFlag(parsed.flags["voter-agent-pda"]),
      } as MarketGovernanceVoteOptions;
      break;
    }
    case "disputes.list":
      options = {
        ...base,
        statuses: parseStringListFlag(parsed.flags.status),
      } as MarketDisputesListOptions;
      break;
    case "disputes.detail": {
      const disputePda = parsed.positional[3];
      if (!disputePda) {
        throw createCliError(
          "market disputes detail requires <disputePda>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      options = { ...base, disputePda } as MarketDisputeDetailOptions;
      break;
    }
    case "disputes.resolve": {
      const disputePda = parsed.positional[3];
      const arbiterVotesRaw = parseOptionalStringFlag(parsed.flags["arbiter-votes"]);
      if (!disputePda) {
        throw createCliError(
          "market disputes resolve requires <disputePda>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      if (!arbiterVotesRaw) {
        throw createCliError(
          "market disputes resolve requires --arbiter-votes votePda:arbiterPda[,..]",
          ERROR_CODES.MISSING_REQUIRED_OPTION,
        );
      }
      options = {
        ...base,
        disputePda,
        arbiterVotes: parseArbiterVotes(arbiterVotesRaw),
        extraWorkers: parseOptionalStringFlag(parsed.flags["extra-workers"])
          ? parseExtraWorkers(String(parsed.flags["extra-workers"]))
          : undefined,
      } as MarketDisputeResolveOptions;
      break;
    }
    case "reputation.summary":
      options = {
        ...base,
        agentPda: parsed.positional[3],
      } as MarketReputationSummaryOptions;
      break;
    case "reputation.stake": {
      const amount = parsed.positional[3];
      if (!amount) {
        throw createCliError(
          "market reputation stake requires <lamports>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      options = {
        ...base,
        amount,
        stakerAgentPda: parseOptionalStringFlag(parsed.flags["staker-agent-pda"]),
      } as MarketReputationStakeOptions;
      break;
    }
    case "reputation.delegate": {
      const amountRaw = parsed.positional[3];
      if (!amountRaw) {
        throw createCliError(
          "market reputation delegate requires <amount>",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      const amount = Number.parseInt(amountRaw, 10);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw createCliError(
          "delegation amount must be a positive integer",
          ERROR_CODES.INVALID_VALUE,
        );
      }
      const delegateeAgentPda = parseOptionalStringFlag(parsed.flags["delegatee-agent-pda"]);
      const delegateeAgentId = parseOptionalStringFlag(parsed.flags["delegatee-agent-id"]);
      if (!delegateeAgentPda && !delegateeAgentId) {
        throw createCliError(
          "market reputation delegate requires --delegatee-agent-pda or --delegatee-agent-id",
          ERROR_CODES.MISSING_REQUIRED_OPTION,
        );
      }
      options = {
        ...base,
        amount,
        delegateeAgentPda,
        delegateeAgentId,
        expiresAt: parseOptionalNumberFlag(parsed.flags["expires-at"]),
        delegatorAgentPda: parseOptionalStringFlag(parsed.flags["delegator-agent-pda"]),
      } as MarketReputationDelegateOptions;
      break;
    }
  }

  return {
    command: "market",
    marketCommand,
    global: {
      help: base.help,
      strictMode: base.strictMode,
      outputFormat: base.outputFormat,
      role: base.role,
      rpcUrl: base.rpcUrl,
      programId: base.programId,
      storeType: base.storeType,
      sqlitePath: base.sqlitePath,
      traceId: base.traceId,
      idempotencyWindow: base.idempotencyWindow,
    },
    options,
    outputFormat: base.outputFormat,
  };
}

type RoutedStatus = CliStatusCode | null;

function loadLenientFileConfig(
  selection: ReturnType<typeof resolveLegacyCompatibleConfigSelection>,
): CliFileConfig {
  try {
    return loadFileConfigFromSelection(selection);
  } catch {
    return {};
  }
}

function resolveLenientGlobalFlags(parsed: ParsedArgv): {
  configPath: string;
  configPathSource: ReturnType<
    typeof resolveLegacyCompatibleConfigSelection
  >["configPathSource"];
  global: ReturnType<typeof normalizeGlobalFlags>;
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

async function dispatchBootstrapCommands(
  parsed: ParsedArgv,
  context: CliRuntimeContext,
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<RoutedStatus> {
  if (parsed.positional[0] === "onboard") {
    try {
      if (parsed.positional.length > 1) {
        throw createCliError(
          "onboard does not accept positional arguments",
          ERROR_CODES.INVALID_VALUE,
        );
      }

      validateUnknownStandaloneOptions(parsed.flags, ONBOARD_COMMAND_OPTIONS);

      const configPath = resolveGatewayConfigPath(parsed.flags);
      const { global } = resolveLenientGlobalFlags(parsed);
      const onboardOpts: OnboardOptions = {
        ...global,
        configPath,
        configPathSource: parseOptionalString(parsed.flags.config)
          ? "explicit"
          : parseOptionalString(process.env.AGENC_CONFIG)
            ? "env:AGENC_CONFIG"
            : "canonical",
        legacyImportConfigPath:
          parseOptionalString(process.env.AGENC_RUNTIME_CONFIG) ??
          discoverLegacyImportConfigPath() ??
          undefined,
        managedOverrides: readManagedOverrideConfig(parsed.flags),
        nonInteractive: normalizeBool(parsed.flags["non-interactive"], false),
        force: normalizeBool(parsed.flags.force, false),
      };

      if (
        shouldUseInteractiveOnboarding(parsed.flags, {
          stdin: process.stdin,
          stdout,
        })
      ) {
        return await runInteractiveOnboarding(onboardOpts, {
          stdin: process.stdin,
          stdout,
        });
      }

      return await runOnboardCommand(context, onboardOpts);
    } catch (error) {
      return reportCliError(context, error);
    }
  }

  if (parsed.positional[0] === "init") {
    try {
      validateUnknownStandaloneOptions(parsed.flags, INIT_COMMAND_OPTIONS);
      if (parsed.positional.length > 1) {
        throw createCliError(
          "init does not accept positional arguments; use --path <dir> instead",
          ERROR_CODES.INVALID_VALUE,
        );
      }
      const { global } = resolveLenientGlobalFlags(parsed);
      const initOpts: InitOptions = {
        ...global,
        force: normalizeCommandFlag(parsed.flags.force),
        path: parseOptionalString(parsed.flags.path),
        configPath: resolveGatewayConfigPath(parsed.flags),
        pidPath:
          parseOptionalString(parsed.flags["pid-path"]) ?? getDefaultPidPath(),
        controlPlanePort: parseIntValue(parsed.flags.port),
      };
      return await runInitCommand(context, initOpts);
    } catch (error) {
      return reportCliError(context, error);
    }
  }

  if (parsed.positional[0] === "health") {
    try {
      if (parsed.positional.length > 1) {
        throw createCliError(
          "health does not accept positional arguments",
          ERROR_CODES.INVALID_VALUE,
        );
      }

      validateUnknownStandaloneOptions(parsed.flags, HEALTH_COMMAND_OPTIONS);

      const { configPath, configPathSource, global } =
        resolveLenientGlobalFlags(parsed);
      const healthOpts: HealthOptions = {
        ...global,
        configPath,
        configPathSource,
        nonInteractive: normalizeBool(parsed.flags["non-interactive"], false),
        deep: normalizeBool(parsed.flags.deep, false),
      };

      return await runHealthCommand(context, healthOpts);
    } catch (error) {
      return reportCliError(context, error);
    }
  }

  if (
    parsed.positional[0] === "doctor" &&
    parsed.positional[1] === "security"
  ) {
    const { global } = resolveLenientGlobalFlags(parsed);
    const securityOpts: SecurityOptions = {
      ...global,
      deep: normalizeBool(parsed.flags.deep, false),
      json: normalizeBool(parsed.flags.json, false),
      fix: normalizeBool(parsed.flags.fix, false),
    };
    try {
      return await runSecurityCommand(context, securityOpts);
    } catch (error) {
      context.error(buildErrorPayload(error));
      return 1;
    }
  }

  if (parsed.positional[0] === "doctor") {
    try {
      if (parsed.positional.length > 1) {
        throw createCliError(
          `unknown doctor subcommand: ${parsed.positional[1]}`,
          ERROR_CODES.UNKNOWN_COMMAND,
        );
      }

      validateUnknownStandaloneOptions(parsed.flags, DOCTOR_COMMAND_OPTIONS);

      const { configPath, configPathSource, global } =
        resolveLenientGlobalFlags(parsed);
      const doctorOpts: DoctorOptions = {
        ...global,
        configPath,
        configPathSource,
        nonInteractive: normalizeBool(parsed.flags["non-interactive"], false),
        deep: normalizeBool(parsed.flags.deep, false),
        fix: normalizeBool(parsed.flags.fix, false),
      };

      return await runDoctorCommand(context, doctorOpts);
    } catch (error) {
      return reportCliError(context, error);
    }
  }

  return null;
}

async function dispatchDaemonCommands(
  parsed: ParsedArgv,
  context: CliRuntimeContext,
): Promise<RoutedStatus> {
  if (parsed.positional[0] === "start") {
    try {
      validateUnknownStandaloneOptions(parsed.flags, START_COMMAND_OPTIONS);
      const configPath = resolveGatewayConfigPath(parsed.flags);
      const pidPath =
        parseOptionalString(parsed.flags["pid-path"]) ?? getDefaultPidPath();
      const startOpts: DaemonStartOptions = {
        configPath,
        pidPath,
        foreground: normalizeBool(parsed.flags.foreground, false),
        logLevel: parseOptionalString(parsed.flags["log-level"]),
        yolo: normalizeBool(parsed.flags.yolo, false),
      };
      return await runStartCommand(context, startOpts);
    } catch (error) {
      return reportCliError(context, error);
    }
  }

  if (parsed.positional[0] === "stop") {
    try {
      validateUnknownStandaloneOptions(parsed.flags, STOP_COMMAND_OPTIONS);
      const pidPath =
        parseOptionalString(parsed.flags["pid-path"]) ?? getDefaultPidPath();
      const stopOpts: DaemonStopOptions = {
        pidPath,
        timeout: parseIntValue(parsed.flags.timeout),
      };
      return await runStopCommand(context, stopOpts);
    } catch (error) {
      return reportCliError(context, error);
    }
  }

  if (parsed.positional[0] === "restart") {
    try {
      validateUnknownStandaloneOptions(parsed.flags, RESTART_COMMAND_OPTIONS);
      const configPath = resolveGatewayConfigPath(parsed.flags);
      const pidPath =
        parseOptionalString(parsed.flags["pid-path"]) ?? getDefaultPidPath();
      const startOpts: DaemonStartOptions = {
        configPath,
        pidPath,
        foreground: normalizeBool(parsed.flags.foreground, false),
        logLevel: parseOptionalString(parsed.flags["log-level"]),
        yolo: normalizeBool(parsed.flags.yolo, false),
      };
      const stopOpts: DaemonStopOptions = {
        pidPath,
        timeout: parseIntValue(parsed.flags.timeout),
      };
      return await runRestartCommand(context, startOpts, stopOpts);
    } catch (error) {
      return reportCliError(context, error);
    }
  }

  if (parsed.positional[0] === "status") {
    try {
      validateUnknownStandaloneOptions(parsed.flags, STATUS_COMMAND_OPTIONS);
      const pidPath =
        parseOptionalString(parsed.flags["pid-path"]) ?? getDefaultPidPath();
      const statusOpts: DaemonStatusOptions = {
        pidPath,
        controlPlanePort: parseIntValue(parsed.flags.port),
      };
      return await runStatusCommand(context, statusOpts);
    } catch (error) {
      return reportCliError(context, error);
    }
  }

  if (
    parsed.positional[0] === "service" &&
    parsed.positional[1] === "install"
  ) {
    try {
      validateUnknownStandaloneOptions(parsed.flags, SERVICE_COMMAND_OPTIONS);
      const serviceOpts: ServiceInstallOptions = {
        configPath: parseOptionalString(parsed.flags.config),
        macos: normalizeBool(parsed.flags.macos, false),
        yolo: normalizeBool(parsed.flags.yolo, false),
      };
      return await runServiceInstallCommand(context, serviceOpts);
    } catch (error) {
      return reportCliError(context, error);
    }
  }

  return null;
}

async function dispatchConfigCommands(
  parsed: ParsedArgv,
  context: CliRuntimeContext,
): Promise<RoutedStatus> {
  if (parsed.positional[0] !== "config") {
    return null;
  }

  try {
    const subcommand = parsed.positional[1] as string | undefined;
    if (!subcommand) {
      throw createCliError(
        "missing config subcommand (init | validate | show)",
        ERROR_CODES.MISSING_CONFIG_COMMAND,
      );
    }

    const configPath = resolveGatewayConfigPath(parsed.flags);
    const global = normalizeGlobalFlags(parsed.flags, {}, readEnvironmentConfig());

    if (subcommand === "init") {
      validateUnknownStandaloneOptions(parsed.flags, CONFIG_INIT_OPTIONS);
      const wizardOpts: WizardOptions = {
        ...global,
        configPath,
        managedOverrides: readManagedOverrideConfig(parsed.flags),
        nonInteractive: normalizeBool(parsed.flags["non-interactive"], false),
        force: normalizeBool(parsed.flags.force, false),
      };
      return await runConfigInitCommand(context, wizardOpts);
    }

    if (subcommand === "validate") {
      validateUnknownStandaloneOptions(parsed.flags, CONFIG_VALIDATE_OPTIONS);
      const validateOpts: ConfigValidateOptions = {
        ...global,
        configPath,
      };
      return await runConfigValidateCommand(context, validateOpts);
    }

    if (subcommand === "show") {
      validateUnknownStandaloneOptions(parsed.flags, CONFIG_SHOW_OPTIONS);
      const showOpts: ConfigShowOptions = {
        ...global,
        configPath,
      };
      return await runConfigShowCommand(context, showOpts);
    }

    throw createCliError(
      `unknown config subcommand: ${subcommand}`,
      ERROR_CODES.UNKNOWN_CONFIG_COMMAND,
    );
  } catch (error) {
    return reportCliError(context, error, [
      ERROR_CODES.MISSING_CONFIG_COMMAND,
      ERROR_CODES.UNKNOWN_CONFIG_COMMAND,
    ]);
  }
}

async function dispatchSessionCommands(
  parsed: ParsedArgv,
  context: CliRuntimeContext,
): Promise<RoutedStatus> {
  if (parsed.positional[0] === "sessions") {
    try {
      const subcommand = parsed.positional[1] as string | undefined;
      if (!subcommand) {
        throw createCliError(
          "missing sessions subcommand (list | kill)",
          ERROR_CODES.MISSING_ROOT_COMMAND,
        );
      }

      validateUnknownStandaloneOptions(parsed.flags, SESSIONS_OPTIONS);
      const pidPath =
        parseOptionalString(parsed.flags["pid-path"]) ?? getDefaultPidPath();

      if (subcommand === "list") {
        const sessionsOpts: SessionsListOptions = {
          pidPath,
          controlPlanePort: parseIntValue(parsed.flags.port),
        };
        return await runSessionsListCommand(context, sessionsOpts);
      }

      if (subcommand === "kill") {
        const sessionId = parsed.positional[2] as string | undefined;
        if (!sessionId) {
          throw createCliError(
            "sessions kill requires a session ID argument",
            ERROR_CODES.MISSING_SESSION_ID,
          );
        }
        const killOpts: SessionsKillOptions = {
          pidPath,
          sessionId,
          controlPlanePort: parseIntValue(parsed.flags.port),
        };
        return await runSessionsKillCommand(context, killOpts);
      }

      throw createCliError(
        `unknown sessions subcommand: ${subcommand}`,
        ERROR_CODES.UNKNOWN_COMMAND,
      );
    } catch (error) {
      return reportCliError(context, error, [ERROR_CODES.MISSING_SESSION_ID]);
    }
  }

  if (parsed.positional[0] === "logs") {
    try {
      validateUnknownStandaloneOptions(parsed.flags, LOGS_OPTIONS);
      const pidPath =
        parseOptionalString(parsed.flags["pid-path"]) ?? getDefaultPidPath();
      const logsOpts: LogsOptions = {
        pidPath,
        sessionId: parseOptionalString(parsed.flags.session),
        lines: parseIntValue(parsed.flags.lines),
      };
      return await runLogsCommand(context, logsOpts);
    } catch (error) {
      return reportCliError(context, error);
    }
  }

  return null;
}

async function dispatchConnectorCommands(
  parsed: ParsedArgv,
  context: CliRuntimeContext,
): Promise<RoutedStatus> {
  if (parsed.positional[0] !== "connector") {
    return null;
  }

  try {
    const subcommand = parsed.positional[1] as string | undefined;
    if (!subcommand) {
      throw createCliError(
        "missing connector subcommand (list | status | add | remove)",
        ERROR_CODES.MISSING_CONNECTOR_COMMAND,
      );
    }
    if (!validateConnectorCommand(subcommand)) {
      throw createCliError(
        `unknown connector subcommand: ${subcommand}`,
        ERROR_CODES.UNKNOWN_CONNECTOR_COMMAND,
      );
    }

    const configPath = resolveGatewayConfigPath(parsed.flags);
    const pidPath =
      parseOptionalString(parsed.flags["pid-path"]) ?? getDefaultPidPath();
    const controlPlanePort = parseIntValue(parsed.flags.port);
    const global = normalizeGlobalFlags(parsed.flags, {}, readEnvironmentConfig());

    if (subcommand === "list") {
      validateUnknownStandaloneOptions(parsed.flags, CONNECTOR_LIST_OPTIONS);
      const listOptions: ConnectorListOptions = {
        ...global,
        configPath,
        pidPath,
        controlPlanePort,
      };
      return await runConnectorListCommand(context, listOptions);
    }

    if (subcommand === "status") {
      validateUnknownStandaloneOptions(parsed.flags, CONNECTOR_STATUS_OPTIONS);
      const connectorNameRaw = parsed.positional[2] as string | undefined;
      const statusOptions: ConnectorStatusOptions = {
        ...global,
        configPath,
        pidPath,
        controlPlanePort,
        ...(connectorNameRaw
          ? { connectorName: parseConnectorName(connectorNameRaw) }
          : {}),
      };
      return await runConnectorStatusCommand(context, statusOptions);
    }

    if (subcommand === "add") {
      validateUnknownStandaloneOptions(parsed.flags, CONNECTOR_ADD_OPTIONS);
      const connectorNameRaw = parsed.positional[2] as string | undefined;
      const connectorName = parseConnectorName(connectorNameRaw);
      if (connectorName !== "telegram") {
        throw createCliError(
          "connector add currently supports only telegram",
          ERROR_CODES.INVALID_VALUE,
        );
      }
      const addOptions: ConnectorAddTelegramOptions = {
        ...global,
        configPath,
        pidPath,
        controlPlanePort,
        restart: normalizeBool(parsed.flags.restart, true),
        botTokenEnv: parseOptionalString(parsed.flags["bot-token-env"]),
        botTokenStdin: normalizeBool(parsed.flags["bot-token-stdin"], false),
        allowedUsers: parseAllowedUsers(parsed.flags["allowed-users"]),
        pollingIntervalMs: parsePositiveInt(
          parsed.flags["polling-interval-ms"],
          "--polling-interval-ms",
        ),
        maxAttachmentBytes: parsePositiveInt(
          parsed.flags["max-attachment-bytes"],
          "--max-attachment-bytes",
        ),
        rateLimitPerChat: parsePositiveInt(
          parsed.flags["rate-limit-per-chat"],
          "--rate-limit-per-chat",
        ),
      };
      return await runConnectorAddTelegramCommand(context, addOptions);
    }

    validateUnknownStandaloneOptions(parsed.flags, CONNECTOR_REMOVE_OPTIONS);
    const connectorName = parseConnectorName(parsed.positional[2]);
    const removeOptions: ConnectorRemoveOptions = {
      ...global,
      configPath,
      pidPath,
      controlPlanePort,
      connectorName,
      restart: normalizeBool(parsed.flags.restart, true),
    };
    return await runConnectorRemoveCommand(context, removeOptions);
  } catch (error) {
    return reportCliError(context, error, [
      ERROR_CODES.MISSING_CONNECTOR_COMMAND,
      ERROR_CODES.UNKNOWN_CONNECTOR_COMMAND,
    ]);
  }
}

async function dispatchJobsCommands(
  parsed: ParsedArgv,
  context: CliRuntimeContext,
): Promise<RoutedStatus> {
  if (parsed.positional[0] !== "jobs") {
    return null;
  }

  try {
    validateUnknownStandaloneOptions(parsed.flags, JOBS_COMMAND_OPTIONS);
    const subcommand = parsed.positional[1] as string | undefined;

    if (!subcommand) {
      throw createCliError(
        "missing jobs subcommand (list | run | enable | disable)",
        ERROR_CODES.MISSING_PLUGIN_COMMAND,
      );
    }

    const scheduler = new CronScheduler();

    if (subcommand === "list") {
      return await runJobsListCommand(context, scheduler);
    }

    const jobName = parsed.positional[2] as string | undefined;

    if (subcommand === "run") {
      if (!jobName) {
        throw createCliError(
          "jobs run requires a job name",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      return await runJobsRunCommand(context, scheduler, jobName);
    }

    if (subcommand === "enable") {
      if (!jobName) {
        throw createCliError(
          "jobs enable requires a job name",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      return await runJobsEnableCommand(context, scheduler, jobName);
    }

    if (subcommand === "disable") {
      if (!jobName) {
        throw createCliError(
          "jobs disable requires a job name",
          ERROR_CODES.MISSING_TARGET,
        );
      }
      return await runJobsDisableCommand(context, scheduler, jobName);
    }

    throw createCliError(
      `unknown jobs subcommand: ${subcommand}`,
      ERROR_CODES.UNKNOWN_PLUGIN_COMMAND,
    );
  } catch (error) {
    return reportCliError(context, error, [
      ERROR_CODES.MISSING_PLUGIN_COMMAND,
      ERROR_CODES.UNKNOWN_PLUGIN_COMMAND,
    ]);
  }
}

async function dispatchAgentCommands(
  parsed: ParsedArgv,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  context: CliRuntimeContext,
): Promise<RoutedStatus> {
  if (parsed.positional[0] !== "agent") {
    return null;
  }

  try {
    const configSelection = resolveLegacyCompatibleConfigSelection(parsed.flags);
    let fileConfig: CliFileConfig;
    try {
      fileConfig = loadFileConfigFromSelection(configSelection);
    } catch (error) {
      throw createCliError(
        `failed to parse config file ${configSelection.configPath}: ${error instanceof Error ? error.message : String(error)}`,
        ERROR_CODES.CONFIG_PARSE_ERROR,
      );
    }

    const envConfig = readEnvironmentConfig();
    const agentCommand = parsed.positional[1] as string | undefined;

    if (!agentCommand) {
      throw createCliError(
        "missing agent subcommand",
        ERROR_CODES.MISSING_AGENT_COMMAND,
      );
    }

    if (!validateAgentCommand(agentCommand)) {
      throw createCliError(
        `unknown agent command: ${agentCommand}`,
        ERROR_CODES.UNKNOWN_AGENT_COMMAND,
      );
    }

    validateUnknownStandaloneOptions(
      parsed.flags,
      AGENT_COMMAND_OPTIONS[agentCommand],
    );

    const global = normalizeGlobalFlags(parsed.flags, fileConfig, envConfig);
    const agentContext = createContext(
      stdout,
      stderr,
      global.outputFormat,
      global.logLevel,
    );

    if (global.help) {
      agentContext.output(buildHelp());
      return 0;
    }

    const base: BaseCliOptions = {
      help: global.help,
      outputFormat: global.outputFormat,
      strictMode: global.strictMode,
      role: global.role,
      rpcUrl: global.rpcUrl,
      programId: global.programId,
      storeType: global.storeType,
      sqlitePath: global.sqlitePath,
      traceId: global.traceId,
      idempotencyWindow: global.idempotencyWindow,
    };

    const options: AgentRegisterOptions = {
      ...base,
      capabilities: parseOptionalScalarFlag(parsed.flags.capabilities),
      endpoint: parseOptionalStringFlag(parsed.flags.endpoint),
      metadataUri: parseOptionalStringFlag(parsed.flags["metadata-uri"]),
      agentId: parseOptionalStringFlag(parsed.flags["agent-id"]),
    };

    return await runAgentRegisterCommand(agentContext, options);
  } catch (error) {
    return reportCliError(context, error, [
      ERROR_CODES.MISSING_AGENT_COMMAND,
      ERROR_CODES.UNKNOWN_AGENT_COMMAND,
    ]);
  }
}

async function dispatchSkillCommands(
  parsed: ParsedArgv,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  context: CliRuntimeContext,
): Promise<RoutedStatus> {
  if (parsed.positional[0] !== "skill") {
    return null;
  }

  let skillReport: SkillParseReport;
  try {
    skillReport = normalizeAndValidateSkillCommand(parsed);
  } catch (error) {
    context.error(buildErrorPayload(error));
    return 2;
  }

  const skillContext = createContext(
    stdout,
    stderr,
    skillReport.outputFormat,
    normalizeLogLevel(parsed.flags["log-level"]),
  );

  if (skillReport.global.help) {
    skillContext.output(buildHelp());
    return 0;
  }

  const skillDescriptor = SKILL_COMMANDS[skillReport.skillCommand];
  try {
    return await skillDescriptor.run(skillContext, skillReport.options);
  } catch (error) {
    skillContext.error(buildErrorPayload(error));
    return 1;
  }
}

async function dispatchMarketCommands(
  parsed: ParsedArgv,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  context: CliRuntimeContext,
): Promise<RoutedStatus> {
  if (parsed.positional[0] !== "market") {
    return null;
  }

  let marketReport: MarketParseReport;
  try {
    marketReport = normalizeAndValidateMarketCommand(parsed);
  } catch (error) {
    context.error(buildErrorPayload(error));
    return 2;
  }

  const marketContext = createContext(
    stdout,
    stderr,
    marketReport.outputFormat,
    normalizeLogLevel(parsed.flags["log-level"]),
  );

  if (marketReport.global.help) {
    marketContext.output(buildHelp());
    return 0;
  }

  const marketDescriptor = MARKET_COMMANDS[marketReport.marketCommand];
  try {
    return await marketDescriptor.run(marketContext, marketReport.options);
  } catch (error) {
    marketContext.error(buildErrorPayload(error));
    return 1;
  }
}

function resolveIncidentCommandCategory(
  command: ReplayCommand,
): IncidentCommandCategory {
  switch (command) {
    case "backfill":
      return "replay.backfill";
    case "compare":
      return "replay.compare";
    case "incident":
      return "replay.incident";
  }
}

function enforceIncidentRoleAccess(
  role: OperatorRole | undefined,
  commandCategory: IncidentCommandCategory,
): void {
  if (!role) {
    return;
  }

  try {
    enforceRole(role, commandCategory);
  } catch (error) {
    if (error instanceof IncidentRoleViolationError) {
      throw createCliError(error.message, ERROR_CODES.INVALID_VALUE);
    }
    throw error;
  }
}

type CommandOutputCapture = {
  getOutput: () => unknown;
  getError: () => unknown;
};

function installCommandOutputCapture(
  commandContext: CliRuntimeContext,
  enabled: boolean,
): CommandOutputCapture {
  let capturedOutput: unknown;
  let capturedError: unknown;

  if (enabled) {
    const originalOutput = commandContext.output;
    const originalError = commandContext.error;

    commandContext.output = (value) => {
      capturedOutput = value;
      originalOutput(value);
    };

    commandContext.error = (value) => {
      capturedError = value;
      originalError(value);
    };
  }

  return {
    getOutput: () => capturedOutput,
    getError: () => capturedError,
  };
}

function appendReplayAuditEntry(
  auditTrail: InMemoryAuditTrail | null,
  role: OperatorRole | undefined,
  commandCategory: IncidentCommandCategory,
  options: CliCommandOptions,
  outputValue: unknown,
): void {
  if (!role || !auditTrail) {
    return;
  }

  auditTrail.append({
    timestamp: new Date().toISOString(),
    actor: process.env.USER ?? "unknown",
    role,
    action: commandCategory,
    inputHash: computeInputHash(options),
    outputHash: computeOutputHash(outputValue),
  });
}

async function dispatchPluginOrReplayCommand(
  parsed: ParsedArgv,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  context: CliRuntimeContext,
): Promise<CliStatusCode> {
  let report: CliParseReport | PluginParseReport;
  try {
    report =
      parsed.positional[0] === "plugin"
        ? normalizeAndValidatePluginCommand(parsed)
        : normalizeAndValidate(parsed);
  } catch (error) {
    context.error(buildErrorPayload(error));
    return 2;
  }

  const commandContext = createContext(
    stdout,
    stderr,
    report.outputFormat,
    normalizeLogLevel(parsed.flags["log-level"]),
  );

  if (report.global.help) {
    commandContext.output(buildHelp());
    return 0;
  }

  if (report.command === "plugin") {
    const pluginCommand = PLUGIN_COMMANDS[report.pluginCommand];
    try {
      return await pluginCommand.run(commandContext, report.options);
    } catch (error) {
      return reportCliError(commandContext, error, [
        ERROR_CODES.MISSING_PLUGIN_COMMAND,
        ERROR_CODES.UNKNOWN_PLUGIN_COMMAND,
      ]);
    }
  }

  const commandDescriptor = COMMANDS[report.replayCommand];
  const role = report.options.role;
  const commandCategory = resolveIncidentCommandCategory(report.replayCommand);

  const auditTrail = role ? new InMemoryAuditTrail() : null;
  const capture = installCommandOutputCapture(
    commandContext,
    role !== undefined,
  );

  try {
    enforceIncidentRoleAccess(role, commandCategory);

    const status = await commandDescriptor.run(commandContext, report.options);
    appendReplayAuditEntry(
      auditTrail,
      role,
      commandCategory,
      report.options,
      capture.getOutput() ?? { status },
    );

    return status;
  } catch (error) {
    const payload = buildErrorPayload(error);
    appendReplayAuditEntry(
      auditTrail,
      role,
      commandCategory,
      report.options,
      capture.getError() ?? payload,
    );

    return reportCliError(commandContext, payload, [
      ERROR_CODES.MISSING_REPLAY_COMMAND,
      ERROR_CODES.UNKNOWN_REPLAY_COMMAND,
    ]);
  }
}

export async function runCli(
  options: CliRunOptions = {},
): Promise<CliStatusCode> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const parsed = parseArgv(argv);
  const outputFormat = normalizeOutputFormat(
    parsed.flags.output ?? parsed.flags["output-format"],
  );

  const context = createContext(
    stdout,
    stderr,
    outputFormat,
    normalizeLogLevel(process.env.AGENC_RUNTIME_LOG_LEVEL ?? DEFAULT_LOG_LEVEL),
  );

  const showRootHelp =
    parsed.flags.help || parsed.flags.h || parsed.positional.length === 0;
  if (showRootHelp) {
    context.output(buildHelp());
    return 0;
  }

  const routed =
    (await dispatchBootstrapCommands(parsed, context, stdout)) ??
    (await dispatchDaemonCommands(parsed, context)) ??
    (await dispatchConfigCommands(parsed, context)) ??
    (await dispatchConnectorCommands(parsed, context)) ??
    (await dispatchSessionCommands(parsed, context)) ??
    (await dispatchJobsCommands(parsed, context)) ??
    (await dispatchAgentCommands(parsed, stdout, stderr, context)) ??
    (await dispatchMarketCommands(parsed, stdout, stderr, context)) ??
    (await dispatchSkillCommands(parsed, stdout, stderr, context));

  if (routed !== null) {
    return routed;
  }

  return dispatchPluginOrReplayCommand(parsed, stdout, stderr, context);
}

async function runReplayBackfillCommand(
  context: CliRuntimeContext,
  args: CliCommandOptions,
): Promise<CliStatusCode> {
  const options = args as ReplayBackfillOptions;
  if (!options.rpcUrl) {
    throw createCliError(
      "--rpc is required for replay backfill",
      ERROR_CODES.MISSING_REQUIRED_OPTION,
    );
  }

  const store = createReplayStore({
    storeType: options.storeType,
    sqlitePath: options.sqlitePath,
  });

  const fetcher = createOnChainReplayBackfillFetcher({
    rpcUrl: options.rpcUrl,
    programId: options.programId,
  });

  const service = new ReplayBackfillService(store, {
    toSlot: options.toSlot,
    pageSize: options.pageSize,
    fetcher,
    tracePolicy: {
      traceId: options.traceId ?? DEFAULT_REPLAY_TRACE_ID,
      emitOtel: false,
      sampleRate: 1,
    },
  });

  const result = await service.runBackfill();
  const cursor = await store.getCursor();

  context.output({
    status: "ok",
    command: "replay.backfill",
    schema: "replay.backfill.output.v1",
    mode: "backfill",
    strictMode: options.strictMode,
    toSlot: options.toSlot,
    pageSize: options.pageSize,
    storeType: options.storeType,
    traceId: options.traceId,
    idempotencyWindow: options.idempotencyWindow,
    result: {
      processed: result.processed,
      duplicates: result.duplicates,
      cursor,
    },
  });

  return 0;
}

function loadPluginManifest(manifestPath: string): PluginManifest {
  const rawManifest = readFileSync(resolve(manifestPath), "utf8");
  return JSON.parse(rawManifest) as PluginManifest;
}

async function runPluginListCommand(
  context: CliRuntimeContext,
  _args: PluginCommandOptions,
): Promise<CliStatusCode> {
  const catalog = new PluginCatalog();
  context.output({
    status: "ok",
    command: "plugin.list",
    schema: "plugin.list.output.v1",
    plugins: catalog.list(),
  });
  return 0;
}

async function runPluginInstallCommand(
  context: CliRuntimeContext,
  args: PluginCommandOptions,
): Promise<CliStatusCode> {
  const pluginArgs = args as PluginInstallOptions;
  const manifest = loadPluginManifest(pluginArgs.manifestPath);
  const catalog = new PluginCatalog();
  const result = catalog.install(manifest, pluginArgs.precedence ?? "user", {
    slot: pluginArgs.slot,
    sourcePath: pluginArgs.manifestPath,
  });

  context.output({
    status: "ok",
    command: "plugin.install",
    schema: "plugin.operation.output.v1",
    result,
  });

  return result.success ? 0 : 1;
}

async function runPluginDisableCommand(
  context: CliRuntimeContext,
  args: PluginCommandOptions,
): Promise<CliStatusCode> {
  const pluginArgs = args as PluginToggleOptions;
  const catalog = new PluginCatalog();
  const result = catalog.disable(pluginArgs.pluginId);
  context.output({
    status: "ok",
    command: "plugin.disable",
    schema: "plugin.operation.output.v1",
    result,
  });
  return result.success ? 0 : 1;
}

async function runPluginEnableCommand(
  context: CliRuntimeContext,
  args: PluginCommandOptions,
): Promise<CliStatusCode> {
  const pluginArgs = args as PluginToggleOptions;
  const catalog = new PluginCatalog();
  const result = catalog.enable(pluginArgs.pluginId);
  context.output({
    status: "ok",
    command: "plugin.enable",
    schema: "plugin.operation.output.v1",
    result,
  });
  return result.success ? 0 : 1;
}

async function runPluginReloadCommand(
  context: CliRuntimeContext,
  args: PluginCommandOptions,
): Promise<CliStatusCode> {
  const pluginArgs = args as PluginReloadOptions;
  const catalog = new PluginCatalog();
  const manifest =
    pluginArgs.manifestPath === undefined
      ? undefined
      : loadPluginManifest(pluginArgs.manifestPath);
  const result = catalog.reload(pluginArgs.pluginId, manifest);
  context.output({
    status: "ok",
    command: "plugin.reload",
    schema: "plugin.operation.output.v1",
    result,
  });
  return result.success ? 0 : 1;
}

async function runReplayCompareCommand(
  context: CliRuntimeContext,
  args: CliCommandOptions,
): Promise<CliStatusCode> {
  const options = args as ReplayCompareOptions;
  const store = createReplayStore({
    storeType: options.storeType,
    sqlitePath: options.sqlitePath,
  });
  const localTrace = await parseLocalTrajectoryFile(
    options.localTracePath ?? "",
  );

  const projected = await store.query({
    taskPda: options.taskPda,
    disputePda: options.disputePda,
  });
  const strictness = options.strictMode ? "strict" : "lenient";
  const comparison = await runReplayComparison({
    projected,
    localTrace,
    strictness,
  });

  context.output(
    applyRedaction(
      {
        status: "ok",
        command: "replay.compare",
        schema: "replay.compare.output.v1",
        localTracePath: options.localTracePath,
        taskPda: options.taskPda,
        disputePda: options.disputePda,
        strictness,
        strictMode: options.strictMode,
        storeType: options.storeType,
        result: buildReplayCompareResult(comparison),
      },
      options.redactFields ?? [],
    ),
  );

  return 0;
}

async function runReplayIncidentCommand(
  context: CliRuntimeContext,
  args: CliCommandOptions,
): Promise<CliStatusCode> {
  const options = args as ReplayIncidentOptions;
  const queryDsl = mergeIncidentQueryDsl(options);
  const normalizedQuery = normalizeQuery(queryDsl);
  const incidentFilters = {
    taskPda: queryDsl.taskPda,
    disputePda: queryDsl.disputePda,
    fromSlot: queryDsl.slotRange?.from,
    toSlot: queryDsl.slotRange?.to,
  };

  const store = createReplayStore({
    storeType: options.storeType,
    sqlitePath: options.sqlitePath,
  });
  const records = applyQueryFilter(
    await queryIncidentRecords(store, incidentFilters),
    queryDsl,
  );
  const summary = summarizeReplayIncidentRecords(records, incidentFilters);

  const validation = summarizeIncidentValidation(records, options.strictMode);
  const narrative = buildIncidentNarrative(
    summary.events.map((entry) => ({
      anomalyId: buildIncidentEventAnomalyId(entry),
      seq: entry.seq,
      slot: entry.slot,
      signature: entry.signature,
      sourceEventName: entry.sourceEventName,
      sourceEventType: entry.sourceEventType,
      taskPda: entry.taskPda,
      disputePda: entry.disputePda,
      timestampMs: entry.timestampMs,
    })),
    validation,
    new Set(options.redactFields ?? []),
  );

  const evidencePack =
    options.sealed === true
      ? (() => {
          const events = records.map((record) => ({
            seq: record.seq,
            type: record.type,
            taskPda: record.taskPda,
            timestampMs: record.timestampMs,
            payload: record.payload,
            slot: record.slot,
            signature: record.signature,
            sourceEventName: record.sourceEventName,
            sourceEventSequence: record.sourceEventSequence,
          }));

          const incidentCase = buildIncidentCase({
            events,
            window: {
              fromSlot: incidentFilters.fromSlot,
              toSlot: incidentFilters.toSlot,
            },
          });

          const pack = buildEvidencePack({
            incidentCase,
            events,
            seed: 0,
            queryHash: normalizedQuery.hash,
            sealed: true,
            redactionPolicy: {
              stripFields: ["payload.onchain.trace"],
              redactActors: true,
            },
          });

          return {
            manifest: pack.manifest,
            files: serializeEvidencePack(pack),
          };
        })()
      : undefined;

  const payload = {
    status: "ok",
    command: "replay.incident",
    schema: "replay.incident.output.v1",
    commandParams: {
      taskPda: incidentFilters.taskPda,
      disputePda: incidentFilters.disputePda,
      query: options.query,
      fromSlot: incidentFilters.fromSlot,
      toSlot: incidentFilters.toSlot,
      strictMode: options.strictMode,
      storeType: options.storeType,
      sqlitePath: options.sqlitePath,
      sealed: options.sealed,
    },
    summary: {
      ...summary,
      eventType: "replay-incidents",
    },
    validation,
    narrative,
    ...(evidencePack ? { evidencePack } : {}),
  };

  context.output(applyRedaction(payload, options.redactFields ?? []));

  return 0;
}

function mergeIncidentQueryDsl(options: ReplayIncidentOptions): QueryDSL {
  let queryDsl: QueryDSL = {};
  if (options.query !== undefined) {
    try {
      queryDsl = parseQueryDSL(options.query);
    } catch (error) {
      throw createCliError(
        error instanceof Error ? error.message : String(error),
        ERROR_CODES.INVALID_VALUE,
      );
    }
  }

  if (options.taskPda !== undefined) {
    if (
      queryDsl.taskPda !== undefined &&
      queryDsl.taskPda !== options.taskPda
    ) {
      throw createCliError(
        "conflicting task PDA filters between --task-pda and --query",
        ERROR_CODES.INVALID_VALUE,
      );
    }
    queryDsl.taskPda = queryDsl.taskPda ?? options.taskPda;
  }

  if (options.disputePda !== undefined) {
    if (
      queryDsl.disputePda !== undefined &&
      queryDsl.disputePda !== options.disputePda
    ) {
      throw createCliError(
        "conflicting dispute PDA filters between --dispute-pda and --query",
        ERROR_CODES.INVALID_VALUE,
      );
    }
    queryDsl.disputePda = queryDsl.disputePda ?? options.disputePda;
  }

  if (options.fromSlot !== undefined || options.toSlot !== undefined) {
    const from = queryDsl.slotRange?.from ?? options.fromSlot;
    const to = queryDsl.slotRange?.to ?? options.toSlot;

    if (
      options.fromSlot !== undefined &&
      queryDsl.slotRange?.from !== undefined &&
      options.fromSlot !== queryDsl.slotRange.from
    ) {
      throw createCliError(
        "conflicting from-slot filters between --from-slot and --query",
        ERROR_CODES.INVALID_VALUE,
      );
    }

    if (
      options.toSlot !== undefined &&
      queryDsl.slotRange?.to !== undefined &&
      options.toSlot !== queryDsl.slotRange.to
    ) {
      throw createCliError(
        "conflicting to-slot filters between --to-slot and --query",
        ERROR_CODES.INVALID_VALUE,
      );
    }

    queryDsl.slotRange = { from, to };
  }

  if (queryDsl.taskPda === undefined && queryDsl.disputePda === undefined) {
    throw createCliError(
      "incident requires --task-pda, --dispute-pda, or --query",
      ERROR_CODES.MISSING_TARGET,
    );
  }

  if (
    queryDsl.slotRange?.from !== undefined &&
    queryDsl.slotRange?.to !== undefined &&
    queryDsl.slotRange.to < queryDsl.slotRange.from
  ) {
    throw createCliError(
      "--to-slot must be greater than or equal to --from-slot",
      ERROR_CODES.INVALID_VALUE,
    );
  }

  return queryDsl;
}

function buildIncidentEventAnomalyId(entry: {
  seq: number;
  slot: number;
  signature: string;
  sourceEventName: string;
  sourceEventType: string;
  taskPda?: string;
  disputePda?: string;
  timestampMs: number;
}): string {
  const seed = `${entry.seq}|${entry.slot}|${entry.signature}|${entry.sourceEventName}|${entry.sourceEventType}|${entry.taskPda ?? ""}|${entry.disputePda ?? ""}|${entry.timestampMs}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

async function queryIncidentRecords(
  store: ReplayTimelineStore,
  filters: {
    taskPda?: string;
    disputePda?: string;
    fromSlot?: number;
    toSlot?: number;
  },
): Promise<ReadonlyArray<ReplayTimelineRecord>> {
  return store.query({
    taskPda: filters.taskPda,
    disputePda: filters.disputePda,
    fromSlot: filters.fromSlot,
    toSlot: filters.toSlot,
  });
}

function buildReplayCompareResult(comparison: ReplayComparisonResult): {
  status: ReplayComparisonResult["status"];
  strictness: ReplayComparisonStrictness;
  localEventCount: number;
  projectedEventCount: number;
  mismatchCount: number;
  matchRate: number;
  anomalyIds: string[];
  topAnomalies: Array<{
    anomalyId: string;
    code: string;
    severity: string;
    message: string;
    sourceEventName?: string;
    signature?: string;
    seq?: number;
  }>;
  hashes: {
    local: string;
    projected: string;
  };
  localSummary: ReplayComparisonResult["localReplay"];
  projectedSummary: ReplayComparisonResult["projectedReplay"];
} {
  return {
    status: comparison.status,
    strictness: comparison.strictness,
    localEventCount: comparison.localEventCount,
    projectedEventCount: comparison.projectedEventCount,
    mismatchCount: comparison.mismatchCount,
    matchRate: comparison.matchRate,
    anomalyIds: comparison.anomalies.map((anomaly, index) => {
      const sourceContext = anomaly.context;
      const seed = `${anomaly.code}|${sourceContext.sourceEventName ?? ""}|${sourceContext.seq ?? index}|${sourceContext.sourceEventSequence ?? ""}`;
      return createHash("sha256").update(seed).digest("hex").slice(0, 16);
    }),
    topAnomalies: comparison.anomalies.slice(0, 50).map((anomaly, index) => {
      const sourceContext = anomaly.context;
      const anomalySeed = `${anomaly.code}|${sourceContext.taskPda ?? ""}|${sourceContext.seq ?? index}`;
      return {
        anomalyId: createHash("sha256")
          .update(anomalySeed)
          .digest("hex")
          .slice(0, 16),
        code: anomaly.code,
        severity: anomaly.severity,
        message: anomaly.message,
        sourceEventName: sourceContext.sourceEventName,
        signature: sourceContext.signature,
        seq: sourceContext.seq,
      };
    }),
    hashes: {
      local: comparison.localReplay.deterministicHash,
      projected: comparison.projectedReplay.deterministicHash,
    },
    localSummary: comparison.localReplay,
    projectedSummary: comparison.projectedReplay,
  };
}

async function runReplayComparison(input: {
  projected: ReadonlyArray<ReplayTimelineRecord>;
  localTrace: TrajectoryTrace;
  strictness: ReplayComparisonStrictness;
}): Promise<ReplayComparisonResult> {
  const comparison = new ReplayComparisonService();
  return comparison.compare({
    projected: input.projected,
    localTrace: input.localTrace,
    options: { strictness: input.strictness },
  });
}

function buildProjectedIncidentTrace(
  records: readonly ReplayTimelineRecord[],
  seed: string,
): TrajectoryTrace {
  const events = records
    .map((record) => ({
      seq: record.seq,
      type: record.type,
      taskPda: record.taskPda,
      timestampMs: record.timestampMs,
      payload: record.payload,
    }))
    .sort((left, right) => {
      if (left.seq !== right.seq) {
        return left.seq - right.seq;
      }
      if (left.timestampMs !== right.timestampMs) {
        return left.timestampMs - right.timestampMs;
      }
      return left.taskPda?.localeCompare(right.taskPda ?? "") ?? 0;
    });

  return {
    schemaVersion: 1,
    traceId: seed,
    seed: 0,
    createdAtMs: Date.now(),
    events,
  };
}

function summarizeIncidentValidation(
  records: readonly ReplayTimelineRecord[],
  strictMode: boolean,
): {
  strictMode: boolean;
  eventValidation: {
    errors: string[];
    warnings: string[];
    replayTaskCount: number;
  };
  anomalyIds: string[];
} {
  const projectedTrace = buildProjectedIncidentTrace(
    records,
    `incident-${records.length}-${strictMode ? "strict" : "lenient"}`,
  );
  const replayResult = new TrajectoryReplayEngine({
    strictMode,
  }).replay(projectedTrace);

  const anomalyIds = [...replayResult.errors, ...replayResult.warnings].map(
    (entry, index) =>
      createHash("sha256")
        .update(entry)
        .update(String(index))
        .digest("hex")
        .slice(0, 16),
  );

  return {
    strictMode,
    eventValidation: {
      errors: replayResult.errors,
      warnings: replayResult.warnings,
      replayTaskCount: Object.keys(replayResult.tasks).length,
    },
    anomalyIds,
  };
}

function redactField<T>(
  redactions: ReadonlySet<string>,
  key: string,
  value: T,
): T | string {
  return redactions.has(key) ? "[REDACTED]" : value;
}

function buildIncidentNarrative(
  events: ReplayIncidentEventSummary[],
  validation: {
    anomalyIds: string[];
    eventValidation: { errors: string[]; warnings: string[] };
  },
  redactions: ReadonlySet<string>,
): ReplayIncidentNarrative {
  const eventsLines = events.slice(0, 40).map((event, index) => {
    const anomaly = validation.anomalyIds[index];
    const marker = anomaly === undefined ? "" : ` | anomaly:${anomaly}`;
    const seq = redactField(redactions, "seq", event.seq);
    const slot = redactField(redactions, "slot", event.slot);
    const signature = redactField(redactions, "signature", event.signature);
    const sourceEventName = redactField(
      redactions,
      "sourceEventName",
      event.sourceEventName,
    );
    const sourceEventType = redactField(
      redactions,
      "sourceEventType",
      event.sourceEventType,
    );
    return `${seq}/${slot}/${signature}: ${sourceEventName} (${sourceEventType})${marker}`;
  });

  const messages = [
    ...validation.eventValidation.errors,
    ...validation.eventValidation.warnings,
  ]
    .slice(0, 20)
    .map((entry) => `validation:${entry}`);

  return {
    lines: [...eventsLines, ...messages],
    anomalyIds: validation.anomalyIds.slice(0, 40),
  };
}

const DEFAULT_REPLAY_TRACE_ID = "replay-cli-command";

export type { ParsedArgv };
