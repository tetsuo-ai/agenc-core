import type {
  AgenCConfig,
  ToolsConfig,
} from "./schema.js";
import { isCredentialLikeFieldName } from "./credential-classification.js";

type StrictRootKey = Exclude<keyof AgenCConfig, "_unknown">;
type RootValidator = (value: unknown) => void;

export class InvalidStrictConfigError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`Invalid ${field}: ${detail}`);
    this.name = "InvalidStrictConfigError";
    this.field = field;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function requirePlainObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new InvalidStrictConfigError(field, "expected plain object");
  }
  return value;
}

function rejectUnknownFields(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new InvalidStrictConfigError(`${field}.${key}`, "unknown field");
    }
  }
}

function optionalPlainObject(value: unknown, field: string): void {
  if (value !== undefined) requirePlainObject(value, field);
}

function optionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new InvalidStrictConfigError(field, "expected boolean");
  }
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new InvalidStrictConfigError(field, "expected string");
  }
}

function optionalNonEmptyString(value: unknown, field: string): void {
  optionalString(value, field);
  if (typeof value === "string" && value.trim().length === 0) {
    throw new InvalidStrictConfigError(field, "expected non-empty string");
  }
}

function optionalEnum(
  value: unknown,
  field: string,
  allowed: readonly string[],
): void {
  if (value !== undefined && !allowed.includes(value as string)) {
    throw new InvalidStrictConfigError(
      field,
      `expected one of: ${allowed.join(", ")}`,
    );
  }
}

function optionalStringArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new InvalidStrictConfigError(field, "expected string[]");
  }
}

function optionalStringRecord(value: unknown, field: string): void {
  if (value === undefined) return;
  const record = requirePlainObject(value, field);
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") {
      throw new InvalidStrictConfigError(`${field}.${key}`, "expected string");
    }
  }
}

function optionalPositiveInteger(value: unknown, field: string): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new InvalidStrictConfigError(field, "expected positive safe integer");
  }
}

function optionalNonNegativeInteger(value: unknown, field: string): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new InvalidStrictConfigError(
      field,
      "expected non-negative safe integer",
    );
  }
}

function optionalPositiveNumber(value: unknown, field: string): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
  ) {
    throw new InvalidStrictConfigError(field, "expected positive finite number");
  }
}

function optionalNonNegativeNumber(value: unknown, field: string): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 0)
  ) {
    throw new InvalidStrictConfigError(
      field,
      "expected non-negative finite number",
    );
  }
}

function fieldValidator(
  field: string,
  validate: (value: unknown, field: string) => void,
): RootValidator {
  return (value) => validate(value, field);
}

function enumValidator(field: string, allowed: readonly string[]): RootValidator {
  return (value) => optionalEnum(value, field, allowed);
}

function delegatedObjectValidator(field: string): RootValidator {
  return (value) => optionalPlainObject(value, field);
}

function validateShellEnvironmentPolicy(value: unknown): void {
  if (value === undefined) return;
  const field = "shell_environment_policy";
  const record = requirePlainObject(value, field);
  rejectUnknownFields(record, new Set(["set"]), field);
  optionalStringRecord(record.set, `${field}.set`);
  if (isPlainObject(record.set)) {
    for (const name of Object.keys(record.set)) {
      if (!isCredentialLikeFieldName(name)) continue;
      throw new InvalidStrictConfigError(
        `${field}.set.${name}`,
        "plaintext credential-like environment values are not allowed; use the documented process environment or native secure storage",
      );
    }
  }
}

function validatePerToolConfig(value: unknown, field: string): void {
  const record = requirePlainObject(value, field);
  rejectUnknownFields(
    record,
    new Set(["default_permission_mode"]),
    field,
  );
  optionalEnum(
    record.default_permission_mode,
    `${field}.default_permission_mode`,
    ["untrusted", "on-failure", "on-request", "never"],
  );
}

export function validateToolsConfig(
  value: unknown,
  field = "tools_config",
): ToolsConfig | undefined {
  if (value === undefined) return undefined;
  const record = requirePlainObject(value, field);
  for (const [key, item] of Object.entries(record)) {
    const path = `${field}.${key}`;
    if (key === "web_search_endpoint") {
      optionalString(item, path);
      continue;
    }
    if (key === "web_search_endpoint_kind") {
      optionalEnum(item, path, ["duckduckgo", "searxng", "brave", "json"]);
      continue;
    }
    if (key === "enabled_tools" || key === "disabled_tools") {
      optionalStringArray(item, path);
      continue;
    }
    validatePerToolConfig(item, path);
  }
  return value as ToolsConfig;
}

function validateAttachments(value: unknown): void {
  if (value === undefined) return;
  const field = "attachments";
  const record = requirePlainObject(value, field);
  rejectUnknownFields(record, new Set(["allowedRoots"]), field);
  optionalStringArray(record.allowedRoots, `${field}.allowedRoots`);
}

function validateIdeConnector(value: unknown): void {
  if (value === undefined) return;
  const field = "ideConnector";
  const record = requirePlainObject(value, field);
  rejectUnknownFields(record, new Set(["autoInstallExtension"]), field);
  optionalBoolean(record.autoInstallExtension, `${field}.autoInstallExtension`);
}

function validateTeammates(value: unknown): void {
  if (value === undefined) return;
  const field = "teammates";
  const record = requirePlainObject(value, field);
  rejectUnknownFields(
    record,
    new Set(["mode", "defaultModel", "preferTmuxOverIterm2"]),
    field,
  );
  optionalEnum(record.mode, `${field}.mode`, ["auto", "tmux", "in-process"]);
  optionalNonEmptyString(record.defaultModel, `${field}.defaultModel`);
  optionalBoolean(
    record.preferTmuxOverIterm2,
    `${field}.preferTmuxOverIterm2`,
  );
}

function validateDurableTurns(value: unknown): void {
  if (value === undefined) return;
  const field = "durableTurns";
  const record = requirePlainObject(value, field);
  rejectUnknownFields(record, new Set(["checkpoint", "resume"]), field);
  if (record.checkpoint !== undefined) {
    const path = `${field}.checkpoint`;
    const checkpoint = requirePlainObject(record.checkpoint, path);
    rejectUnknownFields(checkpoint, new Set(["enabled", "minIntervalMs"]), path);
    optionalBoolean(checkpoint.enabled, `${path}.enabled`);
    optionalNonNegativeInteger(checkpoint.minIntervalMs, `${path}.minIntervalMs`);
  }
  if (record.resume !== undefined) {
    const path = `${field}.resume`;
    const resume = requirePlainObject(record.resume, path);
    rejectUnknownFields(
      resume,
      new Set(["onRestart", "requireLease", "buildPinning"]),
      path,
    );
    optionalBoolean(resume.onRestart, `${path}.onRestart`);
    optionalBoolean(resume.requireLease, `${path}.requireLease`);
    optionalBoolean(resume.buildPinning, `${path}.buildPinning`);
  }
}

function validateDaemon(value: unknown): void {
  if (value === undefined) return;
  const field = "daemon";
  const record = requirePlainObject(value, field);
  rejectUnknownFields(record, new Set(["autostart"]), field);
  optionalBoolean(record.autostart, `${field}.autostart`);
}

function validateGateway(value: unknown): void {
  if (value === undefined) return;
  const field = "gateway";
  const record = requirePlainObject(value, field);
  rejectUnknownFields(
    record,
    new Set(["channels", "bindings", "defaultAgent", "hooks"]),
    field,
  );

  if (record.channels !== undefined) {
    const channels = requirePlainObject(record.channels, `${field}.channels`);
    for (const [channelId, value] of Object.entries(channels)) {
      if (channelId.trim().length === 0) {
        throw new InvalidStrictConfigError(
          `${field}.channels`,
          "channel id is empty",
        );
      }
      const channelField = `${field}.channels.${channelId}`;
      const channel = requirePlainObject(value, channelField);
      rejectUnknownFields(
        channel,
        new Set(["dmPolicy", "allowlist"]),
        channelField,
      );
      optionalEnum(channel.dmPolicy, `${channelField}.dmPolicy`, [
        "pairing",
        "allowlist",
        "open",
        "disabled",
      ]);
      if (channel.dmPolicy === undefined) {
        throw new InvalidStrictConfigError(`${channelField}.dmPolicy`, "required");
      }
      optionalStringArray(channel.allowlist, `${channelField}.allowlist`);
      if (
        Array.isArray(channel.allowlist) &&
        channel.allowlist.some((entry) =>
          typeof entry === "string" && entry.trim().length === 0
        )
      ) {
        throw new InvalidStrictConfigError(
          `${channelField}.allowlist`,
          "entries must be non-empty strings",
        );
      }
    }
  }

  if (record.bindings !== undefined) {
    if (!Array.isArray(record.bindings)) {
      throw new InvalidStrictConfigError(`${field}.bindings`, "expected array");
    }
    record.bindings.forEach((value, index) => {
      const bindingField = `${field}.bindings.${index}`;
      const binding = requirePlainObject(value, bindingField);
      rejectUnknownFields(
        binding,
        new Set(["agent", "channelId", "peerId", "groupId"]),
        bindingField,
      );
      optionalNonEmptyString(binding.agent, `${bindingField}.agent`);
      optionalNonEmptyString(binding.channelId, `${bindingField}.channelId`);
      optionalNonEmptyString(binding.peerId, `${bindingField}.peerId`);
      optionalNonEmptyString(binding.groupId, `${bindingField}.groupId`);
      if (binding.agent === undefined) {
        throw new InvalidStrictConfigError(`${bindingField}.agent`, "required");
      }
      if (binding.channelId === undefined) {
        throw new InvalidStrictConfigError(
          `${bindingField}.channelId`,
          "required",
        );
      }
    });
  }

  optionalNonEmptyString(record.defaultAgent, `${field}.defaultAgent`);
  if (record.hooks !== undefined) {
    const hooksField = `${field}.hooks`;
    const hooks = requirePlainObject(record.hooks, hooksField);
    rejectUnknownFields(
      hooks,
      new Set(["enabled", "host", "port", "allowNonLoopback"]),
      hooksField,
    );
    optionalBoolean(hooks.enabled, `${hooksField}.enabled`);
    optionalNonEmptyString(hooks.host, `${hooksField}.host`);
    optionalNonNegativeInteger(hooks.port, `${hooksField}.port`);
    if (typeof hooks.port === "number" && hooks.port > 65_535) {
      throw new InvalidStrictConfigError(
        `${hooksField}.port`,
        "expected integer from 0 through 65535",
      );
    }
    optionalBoolean(
      hooks.allowNonLoopback,
      `${hooksField}.allowNonLoopback`,
    );
  }
}

function validateLspServers(value: unknown): void {
  if (value === undefined) return;
  const servers = requirePlainObject(value, "lsp_servers");
  const keys = new Set([
    "command",
    "args",
    "env",
    "workspaceFolder",
    "extensionToLanguage",
    "initializationOptions",
    "startupTimeout",
    "maxRestarts",
  ]);
  for (const [name, serverValue] of Object.entries(servers)) {
    if (name.trim().length === 0) {
      throw new InvalidStrictConfigError("lsp_servers", "server name is empty");
    }
    const field = `lsp_servers.${name}`;
    const server = requirePlainObject(serverValue, field);
    rejectUnknownFields(server, keys, field);
    optionalNonEmptyString(server.command, `${field}.command`);
    if (server.command === undefined) {
      throw new InvalidStrictConfigError(`${field}.command`, "required");
    }
    optionalStringArray(server.args, `${field}.args`);
    optionalStringRecord(server.env, `${field}.env`);
    optionalString(server.workspaceFolder, `${field}.workspaceFolder`);
    if (server.extensionToLanguage === undefined) {
      throw new InvalidStrictConfigError(
        `${field}.extensionToLanguage`,
        "required",
      );
    }
    optionalStringRecord(
      server.extensionToLanguage,
      `${field}.extensionToLanguage`,
    );
    if (
      isPlainObject(server.extensionToLanguage) &&
      Object.keys(server.extensionToLanguage).length === 0
    ) {
      throw new InvalidStrictConfigError(
        `${field}.extensionToLanguage`,
        "expected at least one mapping",
      );
    }
    optionalPositiveInteger(server.startupTimeout, `${field}.startupTimeout`);
    optionalNonNegativeInteger(server.maxRestarts, `${field}.maxRestarts`);
    // initializationOptions is the documented arbitrary LSP payload.
  }
}

function validateBudget(value: unknown): void {
  if (value === undefined) return;
  const field = "budget";
  const record = requirePlainObject(value, field);
  rejectUnknownFields(
    record,
    new Set([
      "enabled",
      "daily_usd",
      "monthly_usd",
      "daily_tokens",
      "monthly_tokens",
      "soft_threshold",
      "enforce_interactive",
    ]),
    field,
  );
  optionalBoolean(record.enabled, `${field}.enabled`);
  for (const key of [
    "daily_usd",
    "monthly_usd",
    "daily_tokens",
    "monthly_tokens",
  ]) {
    optionalNonNegativeNumber(record[key], `${field}.${key}`);
  }
  if (record.soft_threshold !== undefined) {
    if (
      typeof record.soft_threshold !== "number" ||
      !Number.isFinite(record.soft_threshold) ||
      record.soft_threshold <= 0 ||
      record.soft_threshold >= 1
    ) {
      throw new InvalidStrictConfigError(
        `${field}.soft_threshold`,
        "expected finite number greater than 0 and less than 1",
      );
    }
  }
  optionalBoolean(record.enforce_interactive, `${field}.enforce_interactive`);
}

function validateHeartbeat(value: unknown): void {
  if (value === undefined) return;
  const field = "heartbeat";
  const record = requirePlainObject(value, field);
  rejectUnknownFields(
    record,
    new Set([
      "enabled",
      "interval_seconds",
      "active_hours",
      "skip_when_busy",
      "target_channel",
      "target_conversation",
    ]),
    field,
  );
  optionalBoolean(record.enabled, `${field}.enabled`);
  optionalPositiveInteger(record.interval_seconds, `${field}.interval_seconds`);
  optionalBoolean(record.skip_when_busy, `${field}.skip_when_busy`);
  optionalNonEmptyString(record.target_channel, `${field}.target_channel`);
  optionalNonEmptyString(record.target_conversation, `${field}.target_conversation`);
  if (record.active_hours !== undefined) {
    if (
      !Array.isArray(record.active_hours) ||
      record.active_hours.length !== 2 ||
      record.active_hours.some(
        (hour) => typeof hour !== "number" || !Number.isInteger(hour),
      )
    ) {
      throw new InvalidStrictConfigError(
        `${field}.active_hours`,
        "expected [startHour, endHour] integer pair",
      );
    }
    const [start, end] = record.active_hours as number[];
    if (start! < 0 || end! > 24 || start! >= end!) {
      throw new InvalidStrictConfigError(
        `${field}.active_hours`,
        "expected 0 <= startHour < endHour <= 24",
      );
    }
  }
  const hasChannel = record.target_channel !== undefined;
  const hasConversation = record.target_conversation !== undefined;
  if (hasChannel !== hasConversation) {
    throw new InvalidStrictConfigError(
      field,
      "target_channel and target_conversation must be configured together",
    );
  }
}

/*
 * This registry is deliberately exhaustive. The `satisfies Record` check
 * makes a new AgenCConfig member a compile error until it has an explicit
 * validation decision. Fixed blocks are validated here; existing specialized
 * schema validators are marked as delegated and run immediately afterward by
 * validateAgenCConfigBlocks.
 */
const ROOT_FIELD_VALIDATORS = {
  configVersion: fieldValidator("configVersion", optionalPositiveInteger),
  model: fieldValidator("model", optionalString),
  model_provider: fieldValidator("model_provider", optionalString),
  approval_policy: enumValidator("approval_policy", ["untrusted", "on-failure", "on-request", "never"]),
  sandbox_mode: enumValidator("sandbox_mode", ["read-only", "workspace-write", "danger-full-access"]),
  sandbox: delegatedObjectValidator("sandbox"),
  shell_environment_policy: validateShellEnvironmentPolicy,
  reasoning_effort: enumValidator("reasoning_effort", ["low", "medium", "high", "xhigh", "none"]),
  reasoning_summary: enumValidator("reasoning_summary", ["auto", "concise", "detailed", "none"]),
  approvals_reviewer: enumValidator("approvals_reviewer", ["user", "auto_review"]),
  model_verbosity: enumValidator("model_verbosity", ["low", "medium", "high"]),
  service_tier: enumValidator("service_tier", ["priority", "flex"]),
  personality: enumValidator("personality", ["none", "friendly", "pragmatic"]),
  agent_max_threads: fieldValidator("agent_max_threads", optionalPositiveInteger),
  agent_max_depth: fieldValidator("agent_max_depth", optionalNonNegativeInteger),
  auth: delegatedObjectValidator("auth"),
  profiles: delegatedObjectValidator("profiles"),
  providers: delegatedObjectValidator("providers"),
  project_root_markers: fieldValidator("project_root_markers", optionalStringArray),
  project_doc_max_bytes: fieldValidator("project_doc_max_bytes", optionalPositiveInteger),
  tools_config: (value) => { validateToolsConfig(value); },
  experimental_realtime_start_instructions: fieldValidator("experimental_realtime_start_instructions", optionalString),
  experimental_realtime_ws_backend_prompt: fieldValidator("experimental_realtime_ws_backend_prompt", optionalString),
  hooks: delegatedObjectValidator("hooks"),
  mcp: delegatedObjectValidator("mcp"),
  mcp_servers: delegatedObjectValidator("mcp_servers"),
  daemon: validateDaemon,
  gateway: validateGateway,
  protocol: delegatedObjectValidator("protocol"),
  lsp_servers: validateLspServers,
  plugins: delegatedObjectValidator("plugins"),
  autoUpdates: fieldValidator("autoUpdates", optionalBoolean),
  ideConnector: validateIdeConnector,
  permissions: delegatedObjectValidator("permissions"),
  statusLine: delegatedObjectValidator("statusLine"),
  outputStyle: fieldValidator("outputStyle", optionalString),
  attachments: validateAttachments,
  buffer: delegatedObjectValidator("buffer"),
  tui: delegatedObjectValidator("tui"),
  autoFix: delegatedObjectValidator("autoFix"),
  fileSuggestion: delegatedObjectValidator("fileSuggestion"),
  respectGitignore: fieldValidator("respectGitignore", optionalBoolean),
  transcriptPersistenceEnabled: fieldValidator("transcriptPersistenceEnabled", optionalBoolean),
  attribution: delegatedObjectValidator("attribution"),
  includeGitInstructions: fieldValidator("includeGitInstructions", optionalBoolean),
  worktree: delegatedObjectValidator("worktree"),
  defaultShell: enumValidator("defaultShell", ["bash", "powershell"]),
  language: fieldValidator("language", optionalString),
  spinnerTipsEnabled: fieldValidator("spinnerTipsEnabled", optionalBoolean),
  spinnerVerbs: delegatedObjectValidator("spinnerVerbs"),
  syntaxHighlightingDisabled: fieldValidator("syntaxHighlightingDisabled", optionalBoolean),
  alwaysThinkingEnabled: fieldValidator("alwaysThinkingEnabled", optionalBoolean),
  swarmMode: fieldValidator("swarmMode", optionalBoolean),
  fastMode: fieldValidator("fastMode", optionalBoolean),
  promptSuggestionEnabled: fieldValidator("promptSuggestionEnabled", optionalBoolean),
  pluginConfigs: delegatedObjectValidator("pluginConfigs"),
  autoUpdatesChannel: enumValidator("autoUpdatesChannel", ["latest", "stable"]),
  plansDirectory: fieldValidator("plansDirectory", optionalString),
  prefersReducedMotion: fieldValidator("prefersReducedMotion", optionalBoolean),
  autoMemoryEnabled: fieldValidator("autoMemoryEnabled", optionalBoolean),
  autoMemoryDirectory: fieldValidator("autoMemoryDirectory", optionalString),
  autoDreamEnabled: fieldValidator("autoDreamEnabled", optionalBoolean),
  autoDreamMinHours: fieldValidator("autoDreamMinHours", optionalPositiveNumber),
  autoDreamMinSessions: fieldValidator("autoDreamMinSessions", optionalPositiveInteger),
  showThinkingSummaries: fieldValidator("showThinkingSummaries", optionalBoolean),
  autoMode: delegatedObjectValidator("autoMode"),
  teammates: validateTeammates,
  speculationEnabled: fieldValidator("speculationEnabled", optionalBoolean),
  fileCheckpointingEnabled: fieldValidator("fileCheckpointingEnabled", optionalBoolean),
  xaa_idp: delegatedObjectValidator("xaa_idp"),
  availableModels: fieldValidator("availableModels", optionalStringArray),
  modelOverrides: fieldValidator("modelOverrides", optionalStringRecord),
  allowedMcpServers: (value) => { if (value !== undefined && !Array.isArray(value)) throw new InvalidStrictConfigError("allowedMcpServers", "expected array"); },
  deniedMcpServers: (value) => { if (value !== undefined && !Array.isArray(value)) throw new InvalidStrictConfigError("deniedMcpServers", "expected array"); },
  disableAllHooks: fieldValidator("disableAllHooks", optionalBoolean),
  allowManagedHooksOnly: fieldValidator("allowManagedHooksOnly", optionalBoolean),
  allowedHttpHookUrls: fieldValidator("allowedHttpHookUrls", optionalStringArray),
  httpHookAllowedEnvVars: fieldValidator("httpHookAllowedEnvVars", optionalStringArray),
  allowManagedPermissionRulesOnly: fieldValidator("allowManagedPermissionRulesOnly", optionalBoolean),
  allowManagedMcpServersOnly: fieldValidator("allowManagedMcpServersOnly", optionalBoolean),
  strictPluginOnlyCustomization: () => { /* specialized managed-policy validator */ },
  strictKnownMarketplaces: (value) => { if (value !== undefined && !Array.isArray(value)) throw new InvalidStrictConfigError("strictKnownMarketplaces", "expected array"); },
  blockedMarketplaces: (value) => { if (value !== undefined && !Array.isArray(value)) throw new InvalidStrictConfigError("blockedMarketplaces", "expected array"); },
  forceLoginOrgUUID: fieldValidator("forceLoginOrgUUID", optionalString),
  skipWebFetchPreflight: fieldValidator("skipWebFetchPreflight", optionalBoolean),
  minimumVersion: fieldValidator("minimumVersion", optionalString),
  disableAutoMode: enumValidator("disableAutoMode", ["disable"]),
  agencMdExcludes: fieldValidator("agencMdExcludes", optionalStringArray),
  pluginTrustMessage: fieldValidator("pluginTrustMessage", optionalString),
  agent: delegatedObjectValidator("agent"),
  durableTurns: validateDurableTurns,
  stream_watchdog_timeout_ms: fieldValidator("stream_watchdog_timeout_ms", optionalNonNegativeInteger),
  max_output_tokens: fieldValidator("max_output_tokens", optionalPositiveInteger),
  capped_default_max_output_tokens: fieldValidator("capped_default_max_output_tokens", optionalBoolean),
  max_turns: fieldValidator("max_turns", optionalPositiveInteger),
  max_budget_usd: fieldValidator("max_budget_usd", optionalPositiveNumber),
  autonomous_mode: fieldValidator("autonomous_mode", optionalBoolean),
  coordinator_mode: fieldValidator("coordinator_mode", optionalBoolean),
  transaction_guard: delegatedObjectValidator("transaction_guard"),
  budget: validateBudget,
  browser: delegatedObjectValidator("browser"),
  heartbeat: validateHeartbeat,
} satisfies Record<StrictRootKey, RootValidator>;

export const STRICT_VALIDATED_CONFIG_KEYS: readonly StrictRootKey[] =
  Object.freeze(Object.keys(ROOT_FIELD_VALIDATORS) as StrictRootKey[]);

export function validateStrictAgenCConfigFields(config: AgenCConfig): void {
  const record = config as unknown as Readonly<Record<string, unknown>>;
  for (const [field, validate] of Object.entries(ROOT_FIELD_VALIDATORS)) {
    validate(record[field]);
  }
}
