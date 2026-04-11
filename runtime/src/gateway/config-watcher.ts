/**
 * Gateway configuration loading, validation, diffing, and file watching.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { GatewayConfig, ConfigDiff, GatewayLLMConfig } from "./types.js";
import { GatewayValidationError, GatewayConnectionError } from "./errors.js";
import {
  type ValidationResult,
  validationResult,
  requireIntRange,
  requireOneOf,
} from "../utils/validation.js";
import { isRecord, isStringArray } from "../utils/type-guards.js";
import {
  BUILTIN_STOP_HOOK_IDS,
  STOP_HOOK_CONFIG_KINDS,
  STOP_HOOK_PHASES,
  STOP_HOOK_RESERVED_ID_PREFIX,
} from "../llm/hooks/stop-hooks.js";
import {
  RESERVED_CHANNEL_NAMES,
  isValidPluginModuleSpecifier,
  isValidTrustedPackageName,
  isValidTrustedPackageSubpath,
} from "../plugins/channel-policy.js";

// ============================================================================
// Default config path
// ============================================================================

export function getDefaultConfigPath(): string {
  return process.env.AGENC_CONFIG ?? join(homedir(), ".agenc", "config.json");
}

// ============================================================================
// Config loading
// ============================================================================

export async function loadGatewayConfig(path: string): Promise<GatewayConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    throw new GatewayConnectionError(
      `Failed to read config file at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GatewayValidationError("config", "Invalid JSON");
  }

  if (!isValidGatewayConfig(parsed)) {
    const result = validateGatewayConfig(parsed);
    throw new GatewayValidationError("config", result.errors.join("; "));
  }

  return parsed;
}

// ============================================================================
// Config validation
// ============================================================================

const VALID_LOG_LEVELS: ReadonlySet<string> = new Set([
  "debug",
  "info",
  "warn",
  "error",
]);
const VALID_CLI_OUTPUT_FORMATS: ReadonlySet<string> = new Set([
  "json",
  "jsonl",
  "table",
]);
const VALID_LLM_PROVIDERS: ReadonlySet<string> = new Set([
  "grok",
  "ollama",
]);
const VALID_STOP_HOOK_PHASES = new Set<string>(STOP_HOOK_PHASES);
const VALID_STOP_HOOK_KINDS = new Set<string>(STOP_HOOK_CONFIG_KINDS);
const RESERVED_STOP_HOOK_IDS = new Set<string>(BUILTIN_STOP_HOOK_IDS);
const VALID_LLM_SEARCH_MODES: ReadonlySet<string> = new Set([
  "auto",
  "on",
  "off",
]);
const VALID_LLM_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
]);
const VALID_SUBAGENT_MODES: ReadonlySet<string> = new Set([
  "manager_tools",
  "handoff",
  "hybrid",
]);
const VALID_SUBAGENT_CHILD_TOOL_ALLOWLIST_STRATEGIES: ReadonlySet<string> =
  new Set(["inherit_intersection", "explicit_only"]);
const VALID_SUBAGENT_FALLBACK_BEHAVIORS: ReadonlySet<string> = new Set([
  "continue_without_delegation",
  "fail_request",
]);
const VALID_SUBAGENT_CHILD_PROVIDER_STRATEGIES: ReadonlySet<string> = new Set([
  "same_as_parent",
  "capability_matched",
]);
const VALID_SUBAGENT_DELEGATION_AGGRESSIVENESS: ReadonlySet<string> = new Set([
  "conservative",
  "balanced",
  "aggressive",
  "adaptive",
]);
const VALID_SUBAGENT_HARD_BLOCKED_TASK_CLASSES: ReadonlySet<string> = new Set([
  "wallet_signing",
  "wallet_transfer",
  "stake_or_rewards",
  "destructive_host_mutation",
  "credential_exfiltration",
]);
const VALID_MEMORY_BACKENDS: ReadonlySet<string> = new Set([
  "memory",
  "sqlite",
  "redis",
]);
const VALID_REPLAY_STORE_TYPES: ReadonlySet<string> = new Set([
  "memory",
  "sqlite",
]);
const VALID_CIRCUIT_BREAKER_MODES: ReadonlySet<string> = new Set([
  "pause_discovery",
  "halt_submissions",
  "safe_mode",
]);
const VALID_POLICY_SIMULATION_MODES: ReadonlySet<string> = new Set([
  "off",
  "shadow",
]);
const VALID_MCP_TRUST_TIERS: ReadonlySet<string> = new Set([
  "trusted",
  "sandboxed",
  "untrusted",
]);
const VALID_MESSAGING_MODES: ReadonlySet<string> = new Set([
  "on-chain",
  "off-chain",
  "auto",
]);
const VALID_BACKGROUND_RUN_NOTIFICATION_EVENTS: ReadonlySet<string> = new Set([
  "run_started",
  "run_updated",
  "run_blocked",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_controlled",
]);
const VALID_BACKGROUND_RUN_NOTIFICATION_SINK_TYPES: ReadonlySet<string> =
  new Set([
    "webhook",
    "discord_webhook",
    "email_webhook",
    "mobile_push_webhook",
  ]);
const DOCKER_MEMORY_LIMIT_RE = /^\d+(?:[bkmg])?$/i;
const DOCKER_CPU_LIMIT_RE = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
function normalizeBindAddress(bind: string): string {
  const normalized = bind.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function validatePluginsSection(plugins: unknown, errors: string[]): void {
  if (plugins === undefined) return;
  if (!isRecord(plugins)) {
    errors.push("plugins must be an object");
    return;
  }

  if (plugins.trustedPackages !== undefined) {
    if (!Array.isArray(plugins.trustedPackages)) {
      errors.push("plugins.trustedPackages must be an array");
    } else {
      plugins.trustedPackages.forEach((entry, index) => {
        const path = `plugins.trustedPackages[${index}]`;
        if (!isRecord(entry)) {
          errors.push(`${path} must be an object`);
          return;
        }
        if (
          typeof entry.packageName !== "string" ||
          entry.packageName.trim().length === 0
        ) {
          errors.push(`${path}.packageName must be a non-empty string`);
        } else if (!isValidTrustedPackageName(entry.packageName.trim())) {
          errors.push(
            `${path}.packageName must be a bare package name like @scope/name`,
          );
        }
        if (entry.allowedSubpaths !== undefined && !Array.isArray(entry.allowedSubpaths)) {
          errors.push(`${path}.allowedSubpaths must be an array of strings`);
        } else if (Array.isArray(entry.allowedSubpaths)) {
          entry.allowedSubpaths.forEach((subpath, subpathIndex) => {
            if (
              typeof subpath !== "string" ||
              !isValidTrustedPackageSubpath(subpath.trim())
            ) {
              errors.push(
                `${path}.allowedSubpaths[${subpathIndex}] must be a relative package subpath like channels/example`,
              );
            }
          });
        }
      });
    }
  }
}

function requireUnlimitedOrIntRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
  errors: string[],
): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    (value !== 0 && (value < min || value > max))
  ) {
    errors.push(
      `${path} must be 0 or an integer between ${min} and ${max}`,
    );
  }
}

function validateTelegramChannelConfig(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const enabled = value.enabled !== false;
  if (enabled) {
    if (
      typeof value.botToken !== "string" ||
      value.botToken.trim().length === 0
    ) {
      errors.push(`${path}.botToken must be a non-empty string when telegram is enabled`);
    }
  }

  if (value.allowedUsers !== undefined) {
    if (!Array.isArray(value.allowedUsers)) {
      errors.push(`${path}.allowedUsers must be an array of Telegram user IDs`);
    } else {
      value.allowedUsers.forEach((entry, index) => {
        if (!Number.isInteger(entry) || Number(entry) <= 0) {
          errors.push(
            `${path}.allowedUsers[${index}] must be a positive integer Telegram user ID`,
          );
        }
      });
    }
  }

  if (value.pollingIntervalMs !== undefined) {
    requireIntRange(
      value.pollingIntervalMs,
      `${path}.pollingIntervalMs`,
      1,
      Number.MAX_SAFE_INTEGER,
      errors,
    );
  }
  if (value.maxAttachmentBytes !== undefined) {
    requireIntRange(
      value.maxAttachmentBytes,
      `${path}.maxAttachmentBytes`,
      1,
      Number.MAX_SAFE_INTEGER,
      errors,
    );
  }
  if (value.rateLimitPerChat !== undefined) {
    requireIntRange(
      value.rateLimitPerChat,
      `${path}.rateLimitPerChat`,
      1,
      Number.MAX_SAFE_INTEGER,
      errors,
    );
  }

  if (value.webhook !== undefined) {
    if (!isRecord(value.webhook)) {
      errors.push(`${path}.webhook must be an object when provided`);
    } else {
      if (
        typeof value.webhook.url !== "string" ||
        value.webhook.url.trim().length === 0
      ) {
        errors.push(`${path}.webhook.url must be a non-empty string`);
      }
      if (
        value.webhook.path !== undefined &&
        value.webhook.path !== "/update"
      ) {
        errors.push(`${path}.webhook.path must be omitted or exactly "/update"`);
      }
      if (
        value.webhook.secretToken !== undefined &&
        (typeof value.webhook.secretToken !== "string" ||
          value.webhook.secretToken.trim().length === 0)
      ) {
        errors.push(`${path}.webhook.secretToken must be a non-empty string when provided`);
      }
    }
  }
}

function validateChannelsSection(channels: unknown, errors: string[]): void {
  if (channels === undefined) return;
  if (!isRecord(channels)) {
    errors.push("channels must be an object");
    return;
  }

  for (const [channelName, rawValue] of Object.entries(channels)) {
    const path = `channels.${channelName}`;
    if (!isRecord(rawValue)) {
      errors.push(`${path} must be an object`);
      continue;
    }

    if (
      rawValue.enabled !== undefined &&
      typeof rawValue.enabled !== "boolean"
    ) {
      errors.push(`${path}.enabled must be a boolean`);
    }

    const rawType =
      typeof rawValue.type === "string" ? rawValue.type.trim() : undefined;
    if (rawType === "plugin") {
      if (
        typeof rawValue.moduleSpecifier !== "string" ||
        rawValue.moduleSpecifier.trim().length === 0
      ) {
        errors.push(
          `${path}.moduleSpecifier must be a non-empty string when type is "plugin"`,
        );
      } else if (
        !isValidPluginModuleSpecifier(rawValue.moduleSpecifier.trim())
      ) {
        errors.push(
          `${path}.moduleSpecifier must be a bare package specifier like @scope/name or @scope/name/subpath`,
        );
      }
      if (RESERVED_CHANNEL_NAMES.has(channelName)) {
        errors.push(
          `${path}.type cannot be "plugin" for reserved built-in channel "${channelName}"`,
        );
      }
      if (
        rawValue.config !== undefined &&
        !isRecord(rawValue.config)
      ) {
        errors.push(`${path}.config must be an object when provided`);
      }
      continue;
    }

    if (channelName === "telegram") {
      validateTelegramChannelConfig(rawValue, path, errors);
    }
  }
}

function isLoopbackBind(bind: string | undefined): boolean {
  if (bind === undefined) return true;
  const normalized = normalizeBindAddress(bind);
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

/** Type predicate — returns true when `obj` satisfies the GatewayConfig shape. */
export function isValidGatewayConfig(obj: unknown): obj is GatewayConfig {
  return validateGatewayConfig(obj).valid;
}

function validateGatewaySection(gateway: unknown, errors: string[]): void {
  if (!isRecord(gateway)) {
    errors.push("gateway section is required");
    return;
  }
  requireIntRange(gateway.port, "gateway.port", 1, 65535, errors);
  if (gateway.bind !== undefined && typeof gateway.bind !== "string") {
    errors.push("gateway.bind must be a string");
  }
}

function validateAgentSection(agent: unknown, errors: string[]): void {
  if (!isRecord(agent)) {
    errors.push("agent section is required");
    return;
  }
  if (typeof agent.name !== "string" || agent.name.trim().length === 0) {
    errors.push("agent.name must be a non-empty string");
  }
}

function validateConnectionSection(connection: unknown, errors: string[]): void {
  if (!isRecord(connection)) {
    errors.push("connection section is required");
    return;
  }
  if (
    typeof connection.rpcUrl !== "string" ||
    connection.rpcUrl.trim().length === 0
  ) {
    errors.push("connection.rpcUrl must be a non-empty string");
  }
  if (
    connection.programId !== undefined &&
    (typeof connection.programId !== "string" ||
      connection.programId.trim().length === 0)
  ) {
    errors.push("connection.programId must be a non-empty string");
  }
}

function validateCliSection(cli: unknown, errors: string[]): void {
  if (cli === undefined) return;
  if (!isRecord(cli)) {
    errors.push("cli must be an object");
    return;
  }
  if (cli.strictMode !== undefined && typeof cli.strictMode !== "boolean") {
    errors.push("cli.strictMode must be a boolean");
  }
  if (cli.idempotencyWindow !== undefined) {
    requireIntRange(
      cli.idempotencyWindow,
      "cli.idempotencyWindow",
      1,
      86_400,
      errors,
    );
  }
  if (cli.outputFormat !== undefined) {
    requireOneOf(
      cli.outputFormat,
      "cli.outputFormat",
      VALID_CLI_OUTPUT_FORMATS,
      errors,
    );
  }
}

function validateReplaySection(replay: unknown, errors: string[]): void {
  if (replay === undefined) return;
  if (!isRecord(replay)) {
    errors.push("replay must be an object");
    return;
  }
  if (replay.enabled !== undefined && typeof replay.enabled !== "boolean") {
    errors.push("replay.enabled must be a boolean");
  }
  if (replay.store !== undefined) {
    if (!isRecord(replay.store)) {
      errors.push("replay.store must be an object");
    } else {
      if (replay.store.type !== undefined) {
        requireOneOf(
          replay.store.type,
          "replay.store.type",
          VALID_REPLAY_STORE_TYPES,
          errors,
        );
      }
      if (
        replay.store.sqlitePath !== undefined &&
        (typeof replay.store.sqlitePath !== "string" ||
          replay.store.sqlitePath.trim().length === 0)
      ) {
        errors.push("replay.store.sqlitePath must be a non-empty string");
      }
    }
  }
  if (replay.tracing !== undefined) {
    if (!isRecord(replay.tracing)) {
      errors.push("replay.tracing must be an object");
    } else {
      if (
        replay.tracing.traceId !== undefined &&
        (typeof replay.tracing.traceId !== "string" ||
          replay.tracing.traceId.trim().length === 0)
      ) {
        errors.push("replay.tracing.traceId must be a non-empty string");
      }
      if (
        replay.tracing.sampleRate !== undefined &&
        (typeof replay.tracing.sampleRate !== "number" ||
          !Number.isFinite(replay.tracing.sampleRate) ||
          replay.tracing.sampleRate < 0 ||
          replay.tracing.sampleRate > 1)
      ) {
        errors.push("replay.tracing.sampleRate must be a number between 0 and 1");
      }
      if (
        replay.tracing.emitOtel !== undefined &&
        typeof replay.tracing.emitOtel !== "boolean"
      ) {
        errors.push("replay.tracing.emitOtel must be a boolean");
      }
    }
  }
  if (
    replay.traceId !== undefined &&
    (typeof replay.traceId !== "string" || replay.traceId.trim().length === 0)
  ) {
    errors.push("replay.traceId must be a non-empty string");
  }
  if (
    replay.projectionSeed !== undefined &&
    (typeof replay.projectionSeed !== "number" ||
      !Number.isFinite(replay.projectionSeed))
  ) {
    errors.push("replay.projectionSeed must be a finite number");
  }
  if (
    replay.strictProjection !== undefined &&
    typeof replay.strictProjection !== "boolean"
  ) {
    errors.push("replay.strictProjection must be a boolean");
  }
  if (replay.backfill !== undefined) {
    if (!isRecord(replay.backfill)) {
      errors.push("replay.backfill must be an object");
    } else {
      if (replay.backfill.toSlot !== undefined) {
        requireIntRange(
          replay.backfill.toSlot,
          "replay.backfill.toSlot",
          0,
          Number.MAX_SAFE_INTEGER,
          errors,
        );
      }
      if (replay.backfill.pageSize !== undefined) {
        requireIntRange(
          replay.backfill.pageSize,
          "replay.backfill.pageSize",
          1,
          10_000,
          errors,
        );
      }
    }
  }
  if (replay.traceLevel !== undefined) {
    requireOneOf(
      replay.traceLevel,
      "replay.traceLevel",
      VALID_LOG_LEVELS,
      errors,
    );
  }
}

function validateMemorySection(memory: unknown, errors: string[]): void {
  if (memory === undefined) return;
  if (!isRecord(memory)) {
    errors.push("memory must be an object");
    return;
  }
  requireOneOf(memory.backend, "memory.backend", VALID_MEMORY_BACKENDS, errors);
}

function validateAuthSection(auth: unknown, errors: string[]): void {
  if (auth === undefined) return;
  if (!isRecord(auth)) {
    errors.push("auth must be an object");
    return;
  }
  if (auth.secret !== undefined) {
    if (typeof auth.secret !== "string") {
      errors.push("auth.secret must be a string");
    } else if (auth.secret.length < 32) {
      errors.push("auth.secret must be at least 32 characters");
    }
  }
  if (
    auth.expirySeconds !== undefined &&
    typeof auth.expirySeconds !== "number"
  ) {
    errors.push("auth.expirySeconds must be a number");
  }
  if (auth.localBypass !== undefined && typeof auth.localBypass !== "boolean") {
    errors.push("auth.localBypass must be a boolean");
  }
}

function validateAuthSecretRequirement(
  gateway: unknown,
  auth: unknown,
  errors: string[],
): void {
  const bindAddress =
    isRecord(gateway) && typeof gateway.bind === "string"
      ? gateway.bind
      : undefined;
  const authSecret =
    isRecord(auth) && typeof auth.secret === "string" ? auth.secret : undefined;
  if (!isLoopbackBind(bindAddress) && !authSecret?.trim()) {
    errors.push("auth.secret is required when gateway.bind is non-local");
  }
}

function validateDesktopSection(desktop: unknown, errors: string[]): void {
  if (desktop === undefined) return;
  if (!isRecord(desktop)) {
    errors.push("desktop must be an object");
    return;
  }
  if (desktop.enabled !== undefined && typeof desktop.enabled !== "boolean") {
    errors.push("desktop.enabled must be a boolean");
  }
  if (desktop.maxConcurrent !== undefined) {
    requireIntRange(desktop.maxConcurrent, "desktop.maxConcurrent", 1, 32, errors);
  }
  if (desktop.maxMemory !== undefined) {
    if (
      typeof desktop.maxMemory !== "string" ||
      !DOCKER_MEMORY_LIMIT_RE.test(desktop.maxMemory)
    ) {
      errors.push(
        "desktop.maxMemory must be a string like 512m or 4g (plain integers are treated as GB)",
      );
    }
  }
  if (desktop.maxCpu !== undefined) {
    if (
      typeof desktop.maxCpu !== "string" ||
      !DOCKER_CPU_LIMIT_RE.test(desktop.maxCpu)
    ) {
      errors.push(
        "desktop.maxCpu must be a positive numeric string like 0.5 or 2.0",
      );
    } else {
      const parsed = Number.parseFloat(desktop.maxCpu);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        errors.push("desktop.maxCpu must be greater than 0");
      }
    }
  }
  if (desktop.networkMode !== undefined) {
    requireOneOf(
      desktop.networkMode,
      "desktop.networkMode",
      new Set(["none", "bridge"]),
      errors,
    );
  }
  if (desktop.securityProfile !== undefined) {
    requireOneOf(
      desktop.securityProfile,
      "desktop.securityProfile",
      new Set(["strict", "permissive"]),
      errors,
    );
  }
}

function validatePolicySection(policy: unknown, errors: string[]): void {
  validatePolicySectionAtPath(policy, "policy", errors, true);
}

function validatePolicySectionAtPath(
  policy: unknown,
  path: string,
  errors: string[],
  allowBundles: boolean,
): void {
  if (policy === undefined) return;
  if (!isRecord(policy)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (policy.enabled !== undefined && typeof policy.enabled !== "boolean") {
    errors.push(`${path}.enabled must be a boolean`);
  }
  if (
    policy.defaultTenantId !== undefined &&
    typeof policy.defaultTenantId !== "string"
  ) {
    errors.push(`${path}.defaultTenantId must be a string`);
  }
  if (
    policy.defaultProjectId !== undefined &&
    typeof policy.defaultProjectId !== "string"
  ) {
    errors.push(`${path}.defaultProjectId must be a string`);
  }
  if (!allowBundles && policy.simulationMode !== undefined) {
    errors.push(`${path}.simulationMode is not allowed inside nested policy bundles`);
  }
  if (!allowBundles && policy.audit !== undefined) {
    errors.push(`${path}.audit is not allowed inside nested policy bundles`);
  }
  if (!allowBundles && policy.credentialCatalog !== undefined) {
    errors.push(`${path}.credentialCatalog is not allowed inside nested policy bundles`);
  }
  if (policy.simulationMode !== undefined) {
    requireOneOf(
      policy.simulationMode,
      `${path}.simulationMode`,
      VALID_POLICY_SIMULATION_MODES,
      errors,
    );
  }
  if (policy.maxRiskScore !== undefined) {
    if (
      typeof policy.maxRiskScore !== "number" ||
      policy.maxRiskScore < 0 ||
      policy.maxRiskScore > 1
    ) {
      errors.push(`${path}.maxRiskScore must be a number between 0 and 1`);
    }
  }
  if (policy.toolAllowList !== undefined && !isStringArray(policy.toolAllowList)) {
    errors.push(`${path}.toolAllowList must be an array of strings`);
  }
  if (policy.toolDenyList !== undefined && !isStringArray(policy.toolDenyList)) {
    errors.push(`${path}.toolDenyList must be an array of strings`);
  }
  if (
    policy.credentialAllowList !== undefined &&
    !isStringArray(policy.credentialAllowList)
  ) {
    errors.push(`${path}.credentialAllowList must be an array of strings`);
  }
  if (policy.networkAccess !== undefined) {
    if (!isRecord(policy.networkAccess)) {
      errors.push(`${path}.networkAccess must be an object`);
    } else {
      if (
        policy.networkAccess.allowHosts !== undefined &&
        !isStringArray(policy.networkAccess.allowHosts)
      ) {
        errors.push(`${path}.networkAccess.allowHosts must be an array of strings`);
      }
      if (
        policy.networkAccess.denyHosts !== undefined &&
        !isStringArray(policy.networkAccess.denyHosts)
      ) {
        errors.push(`${path}.networkAccess.denyHosts must be an array of strings`);
      }
    }
  }
  if (policy.writeScope !== undefined) {
    if (!isRecord(policy.writeScope)) {
      errors.push(`${path}.writeScope must be an object`);
    } else {
      if (
        policy.writeScope.allowRoots !== undefined &&
        !isStringArray(policy.writeScope.allowRoots)
      ) {
        errors.push(`${path}.writeScope.allowRoots must be an array of strings`);
      }
      if (
        policy.writeScope.denyRoots !== undefined &&
        !isStringArray(policy.writeScope.denyRoots)
      ) {
        errors.push(`${path}.writeScope.denyRoots must be an array of strings`);
      }
    }
  }
  if (allowBundles && policy.credentialCatalog !== undefined) {
    if (!isRecord(policy.credentialCatalog)) {
      errors.push(`${path}.credentialCatalog must be an object`);
    } else {
      for (const [credentialId, value] of Object.entries(policy.credentialCatalog)) {
        if (!isRecord(value)) {
          errors.push(`${path}.credentialCatalog.${credentialId} must be an object`);
          continue;
        }
        if (
          typeof value.sourceEnvVar !== "string" ||
          value.sourceEnvVar.trim().length === 0
        ) {
          errors.push(`${path}.credentialCatalog.${credentialId}.sourceEnvVar must be a non-empty string`);
        }
        if (!isStringArray(value.domains) || value.domains.length === 0) {
          errors.push(`${path}.credentialCatalog.${credentialId}.domains must be a non-empty array of strings`);
        }
        if (
          value.headerTemplates !== undefined &&
          !isRecord(value.headerTemplates)
        ) {
          errors.push(`${path}.credentialCatalog.${credentialId}.headerTemplates must be an object`);
        } else if (isRecord(value.headerTemplates)) {
          for (const [headerName, template] of Object.entries(value.headerTemplates)) {
            if (headerName.trim().length === 0) {
              errors.push(`${path}.credentialCatalog.${credentialId}.headerTemplates contains an empty header name`);
            }
            if (typeof template !== "string" || template.length === 0) {
              errors.push(`${path}.credentialCatalog.${credentialId}.headerTemplates.${headerName} must be a non-empty string`);
            }
          }
        }
        if (
          value.allowedTools !== undefined &&
          !isStringArray(value.allowedTools)
        ) {
          errors.push(`${path}.credentialCatalog.${credentialId}.allowedTools must be an array of strings`);
        }
        if (value.ttlMs !== undefined) {
          requireIntRange(
            value.ttlMs,
            `${path}.credentialCatalog.${credentialId}.ttlMs`,
            1_000,
            86_400_000,
            errors,
          );
        }
      }
    }
  }
  if (policy.actionBudgets !== undefined) {
    validateBudgetMap(policy.actionBudgets, `${path}.actionBudgets`, errors);
  }
  if (policy.spendBudget !== undefined) {
    validateSpendBudget(policy.spendBudget, `${path}.spendBudget`, errors);
  }
  if (policy.tokenBudget !== undefined) {
    validateTokenBudget(policy.tokenBudget, `${path}.tokenBudget`, errors);
  }
  if (policy.runtimeBudget !== undefined) {
    validateRuntimeBudget(policy.runtimeBudget, `${path}.runtimeBudget`, errors);
  }
  if (policy.processBudget !== undefined) {
    validateProcessBudget(policy.processBudget, `${path}.processBudget`, errors);
  }
  if (policy.scopedActionBudgets !== undefined) {
    if (!isRecord(policy.scopedActionBudgets)) {
      errors.push(`${path}.scopedActionBudgets must be an object`);
    } else {
      for (const scopeName of ["tenant", "project", "run"] as const) {
        const scopeValue = policy.scopedActionBudgets[scopeName];
        if (scopeValue !== undefined) {
          validateBudgetMap(
            scopeValue,
            `${path}.scopedActionBudgets.${scopeName}`,
            errors,
          );
        }
      }
    }
  }
  if (policy.scopedSpendBudgets !== undefined) {
    if (!isRecord(policy.scopedSpendBudgets)) {
      errors.push(`${path}.scopedSpendBudgets must be an object`);
    } else {
      for (const scopeName of ["tenant", "project", "run"] as const) {
        const scopeValue = policy.scopedSpendBudgets[scopeName];
        if (scopeValue !== undefined) {
          validateSpendBudget(
            scopeValue,
            `${path}.scopedSpendBudgets.${scopeName}`,
            errors,
          );
        }
      }
    }
  }
  if (policy.scopedTokenBudgets !== undefined) {
    if (!isRecord(policy.scopedTokenBudgets)) {
      errors.push(`${path}.scopedTokenBudgets must be an object`);
    } else {
      for (const scopeName of ["tenant", "project", "run"] as const) {
        const scopeValue = policy.scopedTokenBudgets[scopeName];
        if (scopeValue !== undefined) {
          validateTokenBudget(
            scopeValue,
            `${path}.scopedTokenBudgets.${scopeName}`,
            errors,
          );
        }
      }
    }
  }
  if (policy.scopedRuntimeBudgets !== undefined) {
    if (!isRecord(policy.scopedRuntimeBudgets)) {
      errors.push(`${path}.scopedRuntimeBudgets must be an object`);
    } else {
      for (const scopeName of ["tenant", "project", "run"] as const) {
        const scopeValue = policy.scopedRuntimeBudgets[scopeName];
        if (scopeValue !== undefined) {
          validateRuntimeBudget(
            scopeValue,
            `${path}.scopedRuntimeBudgets.${scopeName}`,
            errors,
          );
        }
      }
    }
  }
  if (policy.scopedProcessBudgets !== undefined) {
    if (!isRecord(policy.scopedProcessBudgets)) {
      errors.push(`${path}.scopedProcessBudgets must be an object`);
    } else {
      for (const scopeName of ["tenant", "project", "run"] as const) {
        const scopeValue = policy.scopedProcessBudgets[scopeName];
        if (scopeValue !== undefined) {
          validateProcessBudget(
            scopeValue,
            `${path}.scopedProcessBudgets.${scopeName}`,
            errors,
          );
        }
      }
    }
  }
  if (policy.policyClassRules !== undefined) {
    if (!isRecord(policy.policyClassRules)) {
      errors.push(`${path}.policyClassRules must be an object`);
    } else {
      const validClasses = new Set([
        "read_only",
        "reversible_side_effect",
        "destructive_side_effect",
        "irreversible_financial_action",
        "credential_secret_access",
      ]);
      for (const [key, value] of Object.entries(policy.policyClassRules)) {
        if (!validClasses.has(key)) {
          errors.push(`${path}.policyClassRules.${key} is not a valid policy class`);
          continue;
        }
        if (!isRecord(value)) {
          errors.push(`${path}.policyClassRules.${key} must be an object`);
          continue;
        }
        if (value.deny !== undefined && typeof value.deny !== "boolean") {
          errors.push(`${path}.policyClassRules.${key}.deny must be a boolean`);
        }
        if (
          value.maxRiskScore !== undefined &&
          (typeof value.maxRiskScore !== "number" ||
            value.maxRiskScore < 0 ||
            value.maxRiskScore > 1)
        ) {
          errors.push(`${path}.policyClassRules.${key}.maxRiskScore must be a number between 0 and 1`);
        }
      }
    }
  }
  if (policy.audit !== undefined) {
    if (!isRecord(policy.audit)) {
      errors.push(`${path}.audit must be an object`);
    } else {
      if (
        policy.audit.enabled !== undefined &&
        typeof policy.audit.enabled !== "boolean"
      ) {
        errors.push(`${path}.audit.enabled must be a boolean`);
      }
      if (
        policy.audit.signingKey !== undefined &&
        typeof policy.audit.signingKey !== "string"
      ) {
        errors.push(`${path}.audit.signingKey must be a string`);
      }
      if (
        policy.audit.retentionMs !== undefined &&
        typeof policy.audit.retentionMs !== "number"
      ) {
        errors.push(`${path}.audit.retentionMs must be a number`);
      } else if (
        typeof policy.audit.retentionMs === "number" &&
        policy.audit.retentionMs <= 0
      ) {
        errors.push(`${path}.audit.retentionMs must be greater than 0`);
      }
      if (
        policy.audit.maxEntries !== undefined &&
        typeof policy.audit.maxEntries !== "number"
      ) {
        errors.push(`${path}.audit.maxEntries must be a number`);
      } else if (
        typeof policy.audit.maxEntries === "number" &&
        policy.audit.maxEntries < 0
      ) {
        errors.push(`${path}.audit.maxEntries must be greater than or equal to 0`);
      }
      if (
        policy.audit.retentionMode !== undefined &&
        policy.audit.retentionMode !== "delete" &&
        policy.audit.retentionMode !== "archive"
      ) {
        errors.push(`${path}.audit.retentionMode must be one of: delete, archive`);
      }
      if (
        policy.audit.legalHold !== undefined &&
        typeof policy.audit.legalHold !== "boolean"
      ) {
        errors.push(`${path}.audit.legalHold must be a boolean`);
      }
      if (policy.audit.redaction !== undefined) {
        if (!isRecord(policy.audit.redaction)) {
          errors.push(`${path}.audit.redaction must be an object`);
        } else {
          if (
            policy.audit.redaction.redactActors !== undefined &&
            typeof policy.audit.redaction.redactActors !== "boolean"
          ) {
            errors.push(`${path}.audit.redaction.redactActors must be a boolean`);
          }
          if (
            policy.audit.redaction.stripFields !== undefined &&
            !isStringArray(policy.audit.redaction.stripFields)
          ) {
            errors.push(
              `${path}.audit.redaction.stripFields must be an array of strings`,
            );
          }
          if (
            policy.audit.redaction.redactPatterns !== undefined &&
            !isStringArray(policy.audit.redaction.redactPatterns)
          ) {
            errors.push(
              `${path}.audit.redaction.redactPatterns must be an array of strings`,
            );
          } else {
            for (const pattern of policy.audit.redaction.redactPatterns ?? []) {
              try {
                // eslint-disable-next-line no-new
                new RegExp(pattern, "g");
              } catch {
                errors.push(
                  `${path}.audit.redaction.redactPatterns contains an invalid regex: ${pattern}`,
                );
              }
            }
          }
        }
      }
    }
  }
  if (allowBundles && policy.tenantBundles !== undefined) {
    if (!isRecord(policy.tenantBundles)) {
      errors.push(`${path}.tenantBundles must be an object`);
    } else {
      for (const [key, value] of Object.entries(policy.tenantBundles)) {
        validatePolicySectionAtPath(
          value,
          `${path}.tenantBundles.${key}`,
          errors,
          false,
        );
      }
    }
  }
  if (allowBundles && policy.projectBundles !== undefined) {
    if (!isRecord(policy.projectBundles)) {
      errors.push(`${path}.projectBundles must be an object`);
    } else {
      for (const [key, value] of Object.entries(policy.projectBundles)) {
        validatePolicySectionAtPath(
          value,
          `${path}.projectBundles.${key}`,
          errors,
          false,
        );
      }
    }
  }
  if (policy.circuitBreaker !== undefined) {
    if (!isRecord(policy.circuitBreaker)) {
      errors.push(`${path}.circuitBreaker must be an object`);
    } else {
      if (
        policy.circuitBreaker.enabled !== undefined &&
        typeof policy.circuitBreaker.enabled !== "boolean"
      ) {
        errors.push(`${path}.circuitBreaker.enabled must be a boolean`);
      }
      if (
        policy.circuitBreaker.threshold !== undefined &&
        typeof policy.circuitBreaker.threshold !== "number"
      ) {
        errors.push(`${path}.circuitBreaker.threshold must be a number`);
      }
      if (
        policy.circuitBreaker.windowMs !== undefined &&
        typeof policy.circuitBreaker.windowMs !== "number"
      ) {
        errors.push(`${path}.circuitBreaker.windowMs must be a number`);
      }
      if (policy.circuitBreaker.mode !== undefined) {
        requireOneOf(
          policy.circuitBreaker.mode,
          `${path}.circuitBreaker.mode`,
          VALID_CIRCUIT_BREAKER_MODES,
          errors,
        );
      }
    }
  }
}

function validateMcpSection(mcp: unknown, errors: string[]): void {
  if (mcp === undefined) return;
  if (!isRecord(mcp)) {
    errors.push("mcp must be an object");
    return;
  }
  if (!Array.isArray(mcp.servers)) {
    errors.push("mcp.servers must be an array");
    return;
  }
  for (const [index, server] of mcp.servers.entries()) {
    const path = `mcp.servers[${index}]`;
    if (!isRecord(server)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    if (typeof server.name !== "string" || server.name.trim().length === 0) {
      errors.push(`${path}.name must be a non-empty string`);
    }
    if (typeof server.command !== "string" || server.command.trim().length === 0) {
      errors.push(`${path}.command must be a non-empty string`);
    }
    if (!isStringArray(server.args)) {
      errors.push(`${path}.args must be an array of strings`);
    }
    if (server.env !== undefined && !isRecord(server.env)) {
      errors.push(`${path}.env must be an object`);
    } else if (isRecord(server.env)) {
      for (const [key, value] of Object.entries(server.env)) {
        if (typeof value !== "string") {
          errors.push(`${path}.env.${key} must be a string`);
        }
      }
    }
    if (server.enabled !== undefined && typeof server.enabled !== "boolean") {
      errors.push(`${path}.enabled must be a boolean`);
    }
    if (server.timeout !== undefined) {
      requireIntRange(server.timeout, `${path}.timeout`, 1, 300_000, errors);
    }
    if (
      server.container !== undefined &&
      server.container !== "desktop"
    ) {
      errors.push(`${path}.container must be "desktop" when provided`);
    }
    if (server.trustTier !== undefined) {
      requireOneOf(
        server.trustTier,
        `${path}.trustTier`,
        VALID_MCP_TRUST_TIERS,
        errors,
      );
    }
    if (server.riskControls !== undefined) {
      if (!isRecord(server.riskControls)) {
        errors.push(`${path}.riskControls must be an object`);
      } else {
        if (
          server.riskControls.toolAllowList !== undefined &&
          !isStringArray(server.riskControls.toolAllowList)
        ) {
          errors.push(`${path}.riskControls.toolAllowList must be an array of strings`);
        }
        if (
          server.riskControls.toolDenyList !== undefined &&
          !isStringArray(server.riskControls.toolDenyList)
        ) {
          errors.push(`${path}.riskControls.toolDenyList must be an array of strings`);
        }
        if (
          server.riskControls.requireApproval !== undefined &&
          typeof server.riskControls.requireApproval !== "boolean"
        ) {
          errors.push(`${path}.riskControls.requireApproval must be a boolean`);
        }
      }
    }
    if (server.supplyChain !== undefined) {
      if (!isRecord(server.supplyChain)) {
        errors.push(`${path}.supplyChain must be an object`);
      } else {
        if (
          server.supplyChain.requirePinnedPackageVersion !== undefined &&
          typeof server.supplyChain.requirePinnedPackageVersion !== "boolean"
        ) {
          errors.push(`${path}.supplyChain.requirePinnedPackageVersion must be a boolean`);
        }
        if (
          server.supplyChain.requireDesktopImageDigest !== undefined &&
          typeof server.supplyChain.requireDesktopImageDigest !== "boolean"
        ) {
          errors.push(`${path}.supplyChain.requireDesktopImageDigest must be a boolean`);
        }
        if (
          server.supplyChain.binarySha256 !== undefined &&
          (typeof server.supplyChain.binarySha256 !== "string" ||
            !SHA256_HEX_RE.test(server.supplyChain.binarySha256))
        ) {
          errors.push(`${path}.supplyChain.binarySha256 must be a 64-character hex SHA-256 digest`);
        }
        if (
          server.supplyChain.catalogSha256 !== undefined &&
          (typeof server.supplyChain.catalogSha256 !== "string" ||
            !SHA256_HEX_RE.test(server.supplyChain.catalogSha256))
        ) {
          errors.push(`${path}.supplyChain.catalogSha256 must be a 64-character hex SHA-256 digest`);
        }
      }
    }
  }
}

function validateBudgetMap(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    if (!isRecord(val)) {
      errors.push(`${path}.${key} must be an object`);
      continue;
    }
    if (typeof val.limit !== "number") {
      errors.push(`${path}.${key}.limit must be a number`);
    }
    if (typeof val.windowMs !== "number") {
      errors.push(`${path}.${key}.windowMs must be a number`);
    }
  }
}

function validateSpendBudget(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (
    typeof value.limitLamports !== "string" ||
    !/^\d+$/.test(value.limitLamports)
  ) {
    errors.push(`${path}.limitLamports must be a decimal string`);
  }
  if (typeof value.windowMs !== "number") {
    errors.push(`${path}.windowMs must be a number`);
  }
}

function validateTokenBudget(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (
    typeof value.limitTokens !== "number" ||
    !Number.isFinite(value.limitTokens) ||
    value.limitTokens <= 0
  ) {
    errors.push(`${path}.limitTokens must be a finite positive number`);
  }
  if (
    typeof value.windowMs !== "number" ||
    !Number.isFinite(value.windowMs) ||
    value.windowMs <= 0
  ) {
    errors.push(`${path}.windowMs must be a finite positive number`);
  }
}

function validateRuntimeBudget(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (
    typeof value.maxElapsedMs !== "number" ||
    !Number.isFinite(value.maxElapsedMs) ||
    value.maxElapsedMs <= 0
  ) {
    errors.push(`${path}.maxElapsedMs must be a finite positive number`);
  }
}

function validateProcessBudget(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (
    typeof value.maxConcurrent !== "number" ||
    !Number.isInteger(value.maxConcurrent) ||
    value.maxConcurrent <= 0
  ) {
    errors.push(`${path}.maxConcurrent must be a finite positive integer`);
  }
}

function validateApprovalsSection(approvals: unknown, errors: string[]): void {
  if (approvals === undefined) return;
  if (!isRecord(approvals)) {
    errors.push("approvals must be an object");
    return;
  }
  if (
    approvals.enabled !== undefined &&
    typeof approvals.enabled !== "boolean"
  ) {
    errors.push("approvals.enabled must be a boolean");
  }
  if (
    approvals.mode !== undefined &&
    approvals.mode !== "safe_local_dev" &&
    approvals.mode !== "trusted_operator" &&
    approvals.mode !== "unattended_background" &&
    approvals.mode !== "benchmark"
  ) {
    errors.push(
      "approvals.mode must be one of safe_local_dev, trusted_operator, unattended_background, benchmark",
    );
  }
  if (
    approvals.gateDesktopAutomation !== undefined &&
    typeof approvals.gateDesktopAutomation !== "boolean"
  ) {
    errors.push("approvals.gateDesktopAutomation must be a boolean");
  }
  if (
    approvals.timeoutMs !== undefined &&
    typeof approvals.timeoutMs !== "number"
  ) {
    errors.push("approvals.timeoutMs must be a number");
  } else if (
    typeof approvals.timeoutMs === "number" &&
    approvals.timeoutMs <= 0
  ) {
    errors.push("approvals.timeoutMs must be greater than 0");
  }
  if (
    approvals.defaultSlaMs !== undefined &&
    typeof approvals.defaultSlaMs !== "number"
  ) {
    errors.push("approvals.defaultSlaMs must be a number");
  } else if (
    typeof approvals.defaultSlaMs === "number" &&
    approvals.defaultSlaMs <= 0
  ) {
    errors.push("approvals.defaultSlaMs must be greater than 0");
  }
  if (
    approvals.defaultEscalationDelayMs !== undefined &&
    typeof approvals.defaultEscalationDelayMs !== "number"
  ) {
    errors.push("approvals.defaultEscalationDelayMs must be a number");
  } else if (
    typeof approvals.defaultEscalationDelayMs === "number" &&
    approvals.defaultEscalationDelayMs <= 0
  ) {
    errors.push("approvals.defaultEscalationDelayMs must be greater than 0");
  }
  if (
    approvals.resolverSigningKey !== undefined &&
    typeof approvals.resolverSigningKey !== "string"
  ) {
    errors.push("approvals.resolverSigningKey must be a string");
  }
  if (
    typeof approvals.timeoutMs === "number" &&
    typeof approvals.defaultSlaMs === "number" &&
    approvals.defaultSlaMs > approvals.timeoutMs
  ) {
    errors.push("approvals.defaultSlaMs must not exceed approvals.timeoutMs");
  }
  if (
    typeof approvals.timeoutMs === "number" &&
    typeof approvals.defaultEscalationDelayMs === "number" &&
    approvals.defaultEscalationDelayMs > approvals.timeoutMs
  ) {
    errors.push(
      "approvals.defaultEscalationDelayMs must not exceed approvals.timeoutMs",
    );
  }
}

function validateSocialSection(social: unknown, errors: string[]): void {
  if (social === undefined) return;
  if (!isRecord(social)) {
    errors.push("social must be an object");
    return;
  }
  const boolFields = [
    "enabled",
    "discoveryEnabled",
    "messagingEnabled",
    "feedEnabled",
    "collaborationEnabled",
    "reputationEnabled",
  ];
  for (const field of boolFields) {
    if (social[field] !== undefined && typeof social[field] !== "boolean") {
      errors.push(`social.${field} must be a boolean`);
    }
  }
  if (social.messagingMode !== undefined) {
    requireOneOf(
      social.messagingMode,
      "social.messagingMode",
      VALID_MESSAGING_MODES,
      errors,
    );
  }
  if (social.messagingPort !== undefined) {
    requireIntRange(
      social.messagingPort,
      "social.messagingPort",
      0,
      65535,
      errors,
    );
  }
  if (
    social.discoveryCacheTtlMs !== undefined &&
    (typeof social.discoveryCacheTtlMs !== "number" ||
      social.discoveryCacheTtlMs < 0)
  ) {
    errors.push("social.discoveryCacheTtlMs must be a non-negative number");
  }
  if (
    social.discoveryCacheMaxEntries !== undefined &&
    (typeof social.discoveryCacheMaxEntries !== "number" ||
      social.discoveryCacheMaxEntries < 1)
  ) {
    errors.push("social.discoveryCacheMaxEntries must be a positive number");
  }
  if (social.peerDirectory !== undefined) {
    if (!Array.isArray(social.peerDirectory)) {
      errors.push("social.peerDirectory must be an array");
    } else {
      social.peerDirectory.forEach((entry, index) => {
        if (!isRecord(entry)) {
          errors.push(`social.peerDirectory[${index}] must be an object`);
          return;
        }
        if (
          entry.index !== undefined &&
          (typeof entry.index !== "number" ||
            !Number.isInteger(entry.index) ||
            entry.index < 1)
        ) {
          errors.push(`social.peerDirectory[${index}].index must be a positive integer`);
        }
        if (typeof entry.label !== "string" || entry.label.trim().length === 0) {
          errors.push(`social.peerDirectory[${index}].label must be a non-empty string`);
        }
        if (
          typeof entry.authority !== "string" ||
          entry.authority.trim().length === 0
        ) {
          errors.push(`social.peerDirectory[${index}].authority must be a non-empty string`);
        }
        if (
          typeof entry.agentPda !== "string" ||
          entry.agentPda.trim().length === 0
        ) {
          errors.push(`social.peerDirectory[${index}].agentPda must be a non-empty string`);
        }
        if (entry.aliases !== undefined) {
          if (!Array.isArray(entry.aliases)) {
            errors.push(`social.peerDirectory[${index}].aliases must be an array`);
          } else if (
            entry.aliases.some(
              (alias) => typeof alias !== "string" || alias.trim().length === 0,
            )
          ) {
            errors.push(
              `social.peerDirectory[${index}].aliases entries must be non-empty strings`,
            );
          }
        }
      });
    }
  }
}

function validateAutonomySection(autonomy: unknown, errors: string[]): void {
  if (autonomy === undefined) return;
  if (!isRecord(autonomy)) {
    errors.push("autonomy must be an object");
    return;
  }

  if (autonomy.enabled !== undefined && typeof autonomy.enabled !== "boolean") {
    errors.push("autonomy.enabled must be a boolean");
  }

  const validateBoolRecord = (
    value: unknown,
    path: string,
    allowedKeys: readonly string[],
  ): void => {
    if (value === undefined) return;
    if (!isRecord(value)) {
      errors.push(`${path} must be an object`);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (!allowedKeys.includes(key)) {
        errors.push(`${path}.${key} is not a supported autonomy control`);
        continue;
      }
      if (typeof entry !== "boolean") {
        errors.push(`${path}.${key} must be a boolean`);
      }
    }
  };

  validateBoolRecord(
    autonomy.featureFlags,
    "autonomy.featureFlags",
    ["backgroundRuns", "multiAgent", "notifications", "replayGates", "canaryRollout"],
  );
  validateBoolRecord(
    autonomy.killSwitches,
    "autonomy.killSwitches",
    ["backgroundRuns", "multiAgent", "notifications", "replayGates", "canaryRollout"],
  );

  if (autonomy.slo !== undefined) {
    if (!isRecord(autonomy.slo)) {
      errors.push("autonomy.slo must be an object");
    } else {
      const sloFields = [
        "runStartLatencyMs",
        "updateCadenceMs",
        "completionAccuracyRate",
        "recoverySuccessRate",
        "stopLatencyMs",
        "eventLossRate",
      ];
      for (const field of sloFields) {
        const value = autonomy.slo[field];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          errors.push(`autonomy.slo.${field} must be a non-negative number`);
        }
      }
    }
  }

  if (autonomy.canary !== undefined) {
    if (!isRecord(autonomy.canary)) {
      errors.push("autonomy.canary must be an object");
    } else {
      if (
        autonomy.canary.enabled !== undefined &&
        typeof autonomy.canary.enabled !== "boolean"
      ) {
        errors.push("autonomy.canary.enabled must be a boolean");
      }
      if (
        autonomy.canary.tenantAllowList !== undefined &&
        !isStringArray(autonomy.canary.tenantAllowList)
      ) {
        errors.push("autonomy.canary.tenantAllowList must be an array of strings");
      }
      if (
        autonomy.canary.featureAllowList !== undefined &&
        !isStringArray(autonomy.canary.featureAllowList)
      ) {
        errors.push("autonomy.canary.featureAllowList must be an array of strings");
      }
      if (
        autonomy.canary.domainAllowList !== undefined &&
        !isStringArray(autonomy.canary.domainAllowList)
      ) {
        errors.push("autonomy.canary.domainAllowList must be an array of strings");
      }
      if (autonomy.canary.percentage !== undefined) {
        requireIntRange(
          autonomy.canary.percentage,
          "autonomy.canary.percentage",
          0,
          100,
          errors,
        );
      }
    }
  }

  if (autonomy.notifications !== undefined) {
    if (!isRecord(autonomy.notifications)) {
      errors.push("autonomy.notifications must be an object");
    } else {
      if (
        autonomy.notifications.enabled !== undefined &&
        typeof autonomy.notifications.enabled !== "boolean"
      ) {
        errors.push("autonomy.notifications.enabled must be a boolean");
      }
      const sinks = autonomy.notifications.sinks;
      if (sinks !== undefined) {
        if (!Array.isArray(sinks)) {
          errors.push("autonomy.notifications.sinks must be an array");
        } else {
          sinks.forEach((sink, index) => {
            const path = `autonomy.notifications.sinks[${index}]`;
            if (!isRecord(sink)) {
              errors.push(`${path} must be an object`);
              return;
            }
            if (typeof sink.id !== "string" || sink.id.trim().length === 0) {
              errors.push(`${path}.id must be a non-empty string`);
            }
            if (typeof sink.url !== "string" || sink.url.trim().length === 0) {
              errors.push(`${path}.url must be a non-empty string`);
            }
            if (sink.type === undefined) {
              errors.push(`${path}.type is required`);
            } else {
              requireOneOf(
                sink.type,
                `${path}.type`,
                VALID_BACKGROUND_RUN_NOTIFICATION_SINK_TYPES,
                errors,
              );
            }
            if (
              sink.enabled !== undefined &&
              typeof sink.enabled !== "boolean"
            ) {
              errors.push(`${path}.enabled must be a boolean`);
            }
            if (sink.events !== undefined) {
              if (!Array.isArray(sink.events)) {
                errors.push(`${path}.events must be an array of strings`);
              } else {
                sink.events.forEach((event, eventIndex) => {
                  requireOneOf(
                    event,
                    `${path}.events[${eventIndex}]`,
                    VALID_BACKGROUND_RUN_NOTIFICATION_EVENTS,
                    errors,
                  );
                });
              }
            }
            if (
              sink.sessionIds !== undefined &&
              !isStringArray(sink.sessionIds)
            ) {
              errors.push(`${path}.sessionIds must be an array of strings`);
            }
            if (sink.headers !== undefined) {
              if (!isRecord(sink.headers)) {
                errors.push(`${path}.headers must be an object`);
              } else {
                for (const [headerKey, headerValue] of Object.entries(sink.headers)) {
                  if (typeof headerValue !== "string") {
                    errors.push(`${path}.headers.${headerKey} must be a string`);
                  }
                }
              }
            }
            if (
              sink.signingSecret !== undefined &&
              typeof sink.signingSecret !== "string"
            ) {
              errors.push(`${path}.signingSecret must be a string`);
            }
            if (
              sink.recipient !== undefined &&
              typeof sink.recipient !== "string"
            ) {
              errors.push(`${path}.recipient must be a string`);
            }
          });
        }
      }
    }
  }
}

function validateLlmToolFailureCircuitBreakerSection(
  breakerValue: unknown,
  errors: string[],
): void {
  if (breakerValue === undefined) return;
  if (!isRecord(breakerValue)) {
    errors.push("llm.toolFailureCircuitBreaker must be an object");
    return;
  }

  if (
    breakerValue.enabled !== undefined &&
    typeof breakerValue.enabled !== "boolean"
  ) {
    errors.push("llm.toolFailureCircuitBreaker.enabled must be a boolean");
  }
  if (breakerValue.threshold !== undefined) {
    requireIntRange(
      breakerValue.threshold,
      "llm.toolFailureCircuitBreaker.threshold",
      2,
      128,
      errors,
    );
  }
  if (breakerValue.windowMs !== undefined) {
    requireIntRange(
      breakerValue.windowMs,
      "llm.toolFailureCircuitBreaker.windowMs",
      1_000,
      3_600_000,
      errors,
    );
  }
  if (breakerValue.cooldownMs !== undefined) {
    requireIntRange(
      breakerValue.cooldownMs,
      "llm.toolFailureCircuitBreaker.cooldownMs",
      1_000,
      3_600_000,
      errors,
    );
  }
}

function validateLlmRetryPolicySection(
  retryPolicyValue: unknown,
  errors: string[],
): void {
  if (retryPolicyValue === undefined) return;
  if (!isRecord(retryPolicyValue)) {
    errors.push("llm.retryPolicy must be an object");
    return;
  }

  const validFailureClasses = new Set([
    "validation_error",
    "provider_error",
    "authentication_error",
    "rate_limited",
    "timeout",
    "tool_error",
    "budget_exceeded",
    "no_progress",
    "cancelled",
    "unknown",
  ]);

  for (const [failureClass, ruleValue] of Object.entries(retryPolicyValue)) {
    if (!validFailureClasses.has(failureClass)) {
      errors.push(
        `llm.retryPolicy.${failureClass} is not a recognized failure class`,
      );
      continue;
    }
    if (!isRecord(ruleValue)) {
      errors.push(`llm.retryPolicy.${failureClass} must be an object`);
      continue;
    }

    if (ruleValue.maxRetries !== undefined) {
      requireIntRange(
        ruleValue.maxRetries,
        `llm.retryPolicy.${failureClass}.maxRetries`,
        0,
        16,
        errors,
      );
    }
    if (ruleValue.baseDelayMs !== undefined) {
      requireIntRange(
        ruleValue.baseDelayMs,
        `llm.retryPolicy.${failureClass}.baseDelayMs`,
        0,
        120_000,
        errors,
      );
    }
    if (ruleValue.maxDelayMs !== undefined) {
      requireIntRange(
        ruleValue.maxDelayMs,
        `llm.retryPolicy.${failureClass}.maxDelayMs`,
        0,
        600_000,
        errors,
      );
    }
    if (ruleValue.jitter !== undefined && typeof ruleValue.jitter !== "boolean") {
      errors.push(`llm.retryPolicy.${failureClass}.jitter must be a boolean`);
    }
    if (
      ruleValue.circuitBreakerEligible !== undefined &&
      typeof ruleValue.circuitBreakerEligible !== "boolean"
    ) {
      errors.push(
        `llm.retryPolicy.${failureClass}.circuitBreakerEligible must be a boolean`,
      );
    }
  }
}

function validateLlmStatefulResponsesSection(
  provider: GatewayLLMConfig["provider"] | undefined,
  statefulResponsesValue: unknown,
  errors: string[],
): void {
  if (statefulResponsesValue === undefined) return;
  if (!isRecord(statefulResponsesValue)) {
    errors.push("llm.statefulResponses must be an object");
    return;
  }

  if (
    statefulResponsesValue.enabled !== undefined &&
    typeof statefulResponsesValue.enabled !== "boolean"
  ) {
    errors.push("llm.statefulResponses.enabled must be a boolean");
  }
  if (
    statefulResponsesValue.store !== undefined &&
    typeof statefulResponsesValue.store !== "boolean"
  ) {
    errors.push("llm.statefulResponses.store must be a boolean");
  }
  if (
    statefulResponsesValue.fallbackToStateless !== undefined &&
    typeof statefulResponsesValue.fallbackToStateless !== "boolean"
  ) {
    errors.push("llm.statefulResponses.fallbackToStateless must be a boolean");
  }

  const compactionValue = statefulResponsesValue.compaction;
  if (compactionValue === undefined) {
    return;
  }
  if (!isRecord(compactionValue)) {
    errors.push("llm.statefulResponses.compaction must be an object");
    return;
  }

  if (
    compactionValue.enabled !== undefined &&
    typeof compactionValue.enabled !== "boolean"
  ) {
    errors.push("llm.statefulResponses.compaction.enabled must be a boolean");
  }
  if (compactionValue.compactThreshold !== undefined) {
    requireIntRange(
      compactionValue.compactThreshold,
      "llm.statefulResponses.compaction.compactThreshold",
      1,
      Number.MAX_SAFE_INTEGER,
      errors,
    );
  }
  if (
    compactionValue.fallbackOnUnsupported !== undefined &&
    typeof compactionValue.fallbackOnUnsupported !== "boolean"
  ) {
    errors.push(
      "llm.statefulResponses.compaction.fallbackOnUnsupported must be a boolean",
    );
  }
  if (
    compactionValue.enabled === true &&
    compactionValue.compactThreshold === undefined &&
    provider !== "grok"
  ) {
    errors.push(
      "llm.statefulResponses.compaction.compactThreshold is required when compaction.enabled is true",
    );
  }
}

function validateLlmCollectionsSearchSection(
  collectionsSearchValue: unknown,
  errors: string[],
): void {
  if (collectionsSearchValue === undefined) return;
  if (!isRecord(collectionsSearchValue)) {
    errors.push("llm.collectionsSearch must be an object");
    return;
  }
  if (
    collectionsSearchValue.enabled !== undefined &&
    typeof collectionsSearchValue.enabled !== "boolean"
  ) {
    errors.push("llm.collectionsSearch.enabled must be a boolean");
  }
  if (
    collectionsSearchValue.vectorStoreIds !== undefined &&
    !isStringArray(collectionsSearchValue.vectorStoreIds)
  ) {
    errors.push("llm.collectionsSearch.vectorStoreIds must be a string array");
  }
  if (collectionsSearchValue.maxNumResults !== undefined) {
    const value = collectionsSearchValue.maxNumResults;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1
    ) {
      errors.push(
        "llm.collectionsSearch.maxNumResults must be a positive integer",
      );
    }
  }
  if (
    collectionsSearchValue.enabled === true &&
    (!isStringArray(collectionsSearchValue.vectorStoreIds) ||
      collectionsSearchValue.vectorStoreIds.length === 0)
  ) {
    errors.push(
      "llm.collectionsSearch.vectorStoreIds is required when llm.collectionsSearch.enabled is true",
    );
  }
}

function validateLlmWebSearchOptionsSection(
  webSearchOptionsValue: unknown,
  errors: string[],
): void {
  if (webSearchOptionsValue === undefined) return;
  if (!isRecord(webSearchOptionsValue)) {
    errors.push("llm.webSearchOptions must be an object");
    return;
  }
  if (
    webSearchOptionsValue.allowedDomains !== undefined &&
    !isStringArray(webSearchOptionsValue.allowedDomains)
  ) {
    errors.push("llm.webSearchOptions.allowedDomains must be a string array");
  } else if (
    Array.isArray(webSearchOptionsValue.allowedDomains) &&
    webSearchOptionsValue.allowedDomains.length > 5
  ) {
    errors.push(
      "llm.webSearchOptions.allowedDomains must contain at most 5 entries",
    );
  }
  if (
    webSearchOptionsValue.excludedDomains !== undefined &&
    !isStringArray(webSearchOptionsValue.excludedDomains)
  ) {
    errors.push("llm.webSearchOptions.excludedDomains must be a string array");
  } else if (
    Array.isArray(webSearchOptionsValue.excludedDomains) &&
    webSearchOptionsValue.excludedDomains.length > 5
  ) {
    errors.push(
      "llm.webSearchOptions.excludedDomains must contain at most 5 entries",
    );
  }
  if (
    webSearchOptionsValue.enableImageUnderstanding !== undefined &&
    typeof webSearchOptionsValue.enableImageUnderstanding !== "boolean"
  ) {
    errors.push(
      "llm.webSearchOptions.enableImageUnderstanding must be a boolean",
    );
  }
  if (
    Array.isArray(webSearchOptionsValue.allowedDomains) &&
    webSearchOptionsValue.allowedDomains.length > 0 &&
    Array.isArray(webSearchOptionsValue.excludedDomains) &&
    webSearchOptionsValue.excludedDomains.length > 0
  ) {
    errors.push(
      "llm.webSearchOptions.allowedDomains and llm.webSearchOptions.excludedDomains cannot both be set",
    );
  }
}

function isIsoLikeDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:[Tt ][^ ]+)?$/.test(value);
}

function validateLlmXSearchOptionsSection(
  xSearchOptionsValue: unknown,
  errors: string[],
): void {
  if (xSearchOptionsValue === undefined) return;
  if (!isRecord(xSearchOptionsValue)) {
    errors.push("llm.xSearchOptions must be an object");
    return;
  }
  if (
    xSearchOptionsValue.allowedXHandles !== undefined &&
    !isStringArray(xSearchOptionsValue.allowedXHandles)
  ) {
    errors.push("llm.xSearchOptions.allowedXHandles must be a string array");
  } else if (
    Array.isArray(xSearchOptionsValue.allowedXHandles) &&
    xSearchOptionsValue.allowedXHandles.length > 10
  ) {
    errors.push(
      "llm.xSearchOptions.allowedXHandles must contain at most 10 entries",
    );
  }
  if (
    xSearchOptionsValue.excludedXHandles !== undefined &&
    !isStringArray(xSearchOptionsValue.excludedXHandles)
  ) {
    errors.push("llm.xSearchOptions.excludedXHandles must be a string array");
  } else if (
    Array.isArray(xSearchOptionsValue.excludedXHandles) &&
    xSearchOptionsValue.excludedXHandles.length > 10
  ) {
    errors.push(
      "llm.xSearchOptions.excludedXHandles must contain at most 10 entries",
    );
  }
  if (
    Array.isArray(xSearchOptionsValue.allowedXHandles) &&
    xSearchOptionsValue.allowedXHandles.length > 0 &&
    Array.isArray(xSearchOptionsValue.excludedXHandles) &&
    xSearchOptionsValue.excludedXHandles.length > 0
  ) {
    errors.push(
      "llm.xSearchOptions.allowedXHandles and llm.xSearchOptions.excludedXHandles cannot both be set",
    );
  }
  if (
    xSearchOptionsValue.fromDate !== undefined &&
    (typeof xSearchOptionsValue.fromDate !== "string" ||
      !isIsoLikeDateString(xSearchOptionsValue.fromDate))
  ) {
    errors.push("llm.xSearchOptions.fromDate must be an ISO8601 string");
  }
  if (
    xSearchOptionsValue.toDate !== undefined &&
    (typeof xSearchOptionsValue.toDate !== "string" ||
      !isIsoLikeDateString(xSearchOptionsValue.toDate))
  ) {
    errors.push("llm.xSearchOptions.toDate must be an ISO8601 string");
  }
  if (
    xSearchOptionsValue.enableImageUnderstanding !== undefined &&
    typeof xSearchOptionsValue.enableImageUnderstanding !== "boolean"
  ) {
    errors.push(
      "llm.xSearchOptions.enableImageUnderstanding must be a boolean",
    );
  }
  if (
    xSearchOptionsValue.enableVideoUnderstanding !== undefined &&
    typeof xSearchOptionsValue.enableVideoUnderstanding !== "boolean"
  ) {
    errors.push(
      "llm.xSearchOptions.enableVideoUnderstanding must be a boolean",
    );
  }
}

function validateLlmRemoteMcpSection(
  remoteMcpValue: unknown,
  errors: string[],
): void {
  if (remoteMcpValue === undefined) return;
  if (!isRecord(remoteMcpValue)) {
    errors.push("llm.remoteMcp must be an object");
    return;
  }
  if (
    remoteMcpValue.enabled !== undefined &&
    typeof remoteMcpValue.enabled !== "boolean"
  ) {
    errors.push("llm.remoteMcp.enabled must be a boolean");
  }
  if (remoteMcpValue.servers !== undefined && !Array.isArray(remoteMcpValue.servers)) {
    errors.push("llm.remoteMcp.servers must be an array");
  } else if (Array.isArray(remoteMcpValue.servers)) {
    remoteMcpValue.servers.forEach((server, index) => {
      const path = `llm.remoteMcp.servers[${index}]`;
      if (!isRecord(server)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (
        typeof server.serverUrl !== "string" ||
        server.serverUrl.trim().length === 0
      ) {
        errors.push(`${path}.serverUrl must be a non-empty string`);
      }
      if (
        typeof server.serverLabel !== "string" ||
        server.serverLabel.trim().length === 0
      ) {
        errors.push(`${path}.serverLabel must be a non-empty string`);
      }
      if (
        server.serverDescription !== undefined &&
        typeof server.serverDescription !== "string"
      ) {
        errors.push(`${path}.serverDescription must be a string`);
      }
      if (server.allowedTools !== undefined && !isStringArray(server.allowedTools)) {
        errors.push(`${path}.allowedTools must be a string array`);
      }
      if (
        server.authorization !== undefined &&
        typeof server.authorization !== "string"
      ) {
        errors.push(`${path}.authorization must be a string`);
      }
      if (server.headers !== undefined && !isRecord(server.headers)) {
        errors.push(`${path}.headers must be an object`);
      } else if (isRecord(server.headers)) {
        for (const [key, value] of Object.entries(server.headers)) {
          if (typeof value !== "string") {
            errors.push(`${path}.headers.${key} must be a string`);
          }
        }
      }
    });
  }
  if (
    remoteMcpValue.enabled === true &&
    (!Array.isArray(remoteMcpValue.servers) || remoteMcpValue.servers.length === 0)
  ) {
    errors.push(
      "llm.remoteMcp.servers is required when llm.remoteMcp.enabled is true",
    );
  }
}

function validateStopHooksConfig(
  stopHooksValue: unknown,
  errors: string[],
): void {
  if (stopHooksValue === undefined) return;
  if (!isRecord(stopHooksValue)) {
    errors.push("llm.stopHooks must be an object");
    return;
  }
  if (
    stopHooksValue.enabled !== undefined &&
    typeof stopHooksValue.enabled !== "boolean"
  ) {
    errors.push("llm.stopHooks.enabled must be a boolean");
  }
  if (stopHooksValue.maxAttempts !== undefined) {
    requireIntRange(
      stopHooksValue.maxAttempts,
      "llm.stopHooks.maxAttempts",
      1,
      16,
      errors,
    );
  }
  if (stopHooksValue.handlers !== undefined && !Array.isArray(stopHooksValue.handlers)) {
    errors.push("llm.stopHooks.handlers must be an array");
    return;
  }
  if (!Array.isArray(stopHooksValue.handlers)) {
    return;
  }
  const seenIds = new Set<string>();
  stopHooksValue.handlers.forEach((entry, index) => {
    const path = `llm.stopHooks.handlers[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
      errors.push(`${path}.id must be a non-empty string`);
    } else {
      const id = entry.id.trim();
      if (id.startsWith(STOP_HOOK_RESERVED_ID_PREFIX)) {
        errors.push(`${path}.id must not start with "${STOP_HOOK_RESERVED_ID_PREFIX}"`);
      }
      if (RESERVED_STOP_HOOK_IDS.has(id)) {
        errors.push(`${path}.id collides with a reserved stop hook id`);
      }
      if (seenIds.has(id)) {
        errors.push(`${path}.id must be unique`);
      }
      seenIds.add(id);
    }
    if (typeof entry.phase !== "string" || !VALID_STOP_HOOK_PHASES.has(entry.phase)) {
      errors.push(
        `${path}.phase must be one of: ${[...VALID_STOP_HOOK_PHASES].join(", ")}`,
      );
    }
    if (typeof entry.kind !== "string" || !VALID_STOP_HOOK_KINDS.has(entry.kind)) {
      errors.push(
        `${path}.kind must be one of: ${[...VALID_STOP_HOOK_KINDS].join(", ")}`,
      );
    }
    if (typeof entry.target !== "string" || entry.target.trim().length === 0) {
      errors.push(`${path}.target must be a non-empty string`);
    }
    if (
      entry.matcher !== undefined &&
      typeof entry.matcher !== "string"
    ) {
      errors.push(`${path}.matcher must be a string`);
    }
    if (entry.timeoutMs !== undefined) {
      requireIntRange(entry.timeoutMs, `${path}.timeoutMs`, 1, 120_000, errors);
    }
  });
}

function validateLlmStructuredOutputsSection(
  structuredOutputsValue: unknown,
  errors: string[],
): void {
  if (structuredOutputsValue === undefined) return;
  if (!isRecord(structuredOutputsValue)) {
    errors.push("llm.structuredOutputs must be an object");
    return;
  }
  if (
    structuredOutputsValue.enabled !== undefined &&
    typeof structuredOutputsValue.enabled !== "boolean"
  ) {
    errors.push("llm.structuredOutputs.enabled must be a boolean");
  }
  if (
    structuredOutputsValue.strict !== undefined &&
    typeof structuredOutputsValue.strict !== "boolean"
  ) {
    errors.push("llm.structuredOutputs.strict must be a boolean");
  }
}

function validateLlmToolRoutingSection(
  toolRoutingValue: unknown,
  errors: string[],
): void {
  if (toolRoutingValue === undefined) return;
  if (!isRecord(toolRoutingValue)) {
    errors.push("llm.toolRouting must be an object");
    return;
  }

  if (
    toolRoutingValue.enabled !== undefined &&
    typeof toolRoutingValue.enabled !== "boolean"
  ) {
    errors.push("llm.toolRouting.enabled must be a boolean");
  }
  if (toolRoutingValue.minToolsPerTurn !== undefined) {
    requireIntRange(
      toolRoutingValue.minToolsPerTurn,
      "llm.toolRouting.minToolsPerTurn",
      1,
      256,
      errors,
    );
  }
  if (toolRoutingValue.maxToolsPerTurn !== undefined) {
    requireIntRange(
      toolRoutingValue.maxToolsPerTurn,
      "llm.toolRouting.maxToolsPerTurn",
      1,
      256,
      errors,
    );
  }
  if (toolRoutingValue.maxExpandedToolsPerTurn !== undefined) {
    requireIntRange(
      toolRoutingValue.maxExpandedToolsPerTurn,
      "llm.toolRouting.maxExpandedToolsPerTurn",
      1,
      256,
      errors,
    );
  }
  if (toolRoutingValue.cacheTtlMs !== undefined) {
    requireIntRange(
      toolRoutingValue.cacheTtlMs,
      "llm.toolRouting.cacheTtlMs",
      10_000,
      86_400_000,
      errors,
    );
  }
  if (toolRoutingValue.minCacheConfidence !== undefined) {
    if (
      typeof toolRoutingValue.minCacheConfidence !== "number" ||
      !Number.isFinite(toolRoutingValue.minCacheConfidence) ||
      toolRoutingValue.minCacheConfidence < 0 ||
      toolRoutingValue.minCacheConfidence > 1
    ) {
      errors.push(
        "llm.toolRouting.minCacheConfidence must be a number between 0 and 1",
      );
    }
  }
  if (toolRoutingValue.pivotSimilarityThreshold !== undefined) {
    if (
      typeof toolRoutingValue.pivotSimilarityThreshold !== "number" ||
      !Number.isFinite(toolRoutingValue.pivotSimilarityThreshold) ||
      toolRoutingValue.pivotSimilarityThreshold < 0 ||
      toolRoutingValue.pivotSimilarityThreshold > 1
    ) {
      errors.push(
        "llm.toolRouting.pivotSimilarityThreshold must be a number between 0 and 1",
      );
    }
  }
  if (toolRoutingValue.pivotMissThreshold !== undefined) {
    requireIntRange(
      toolRoutingValue.pivotMissThreshold,
      "llm.toolRouting.pivotMissThreshold",
      1,
      64,
      errors,
    );
  }
  if (
    toolRoutingValue.mandatoryTools !== undefined &&
    !isStringArray(toolRoutingValue.mandatoryTools)
  ) {
    errors.push("llm.toolRouting.mandatoryTools must be a string array");
  }
  if (toolRoutingValue.familyCaps !== undefined) {
    if (!isRecord(toolRoutingValue.familyCaps)) {
      errors.push("llm.toolRouting.familyCaps must be an object");
    } else {
      for (const [family, cap] of Object.entries(toolRoutingValue.familyCaps)) {
        if (
          typeof cap !== "number" ||
          !Number.isFinite(cap) ||
          cap < 1 ||
          cap > 256 ||
          !Number.isInteger(cap)
        ) {
          errors.push(
            `llm.toolRouting.familyCaps.${family} must be an integer between 1 and 256`,
          );
        }
      }
    }
  }
  if (
    toolRoutingValue.minToolsPerTurn !== undefined &&
    toolRoutingValue.maxToolsPerTurn !== undefined &&
    typeof toolRoutingValue.minToolsPerTurn === "number" &&
    typeof toolRoutingValue.maxToolsPerTurn === "number" &&
    toolRoutingValue.minToolsPerTurn > toolRoutingValue.maxToolsPerTurn
  ) {
    errors.push(
      "llm.toolRouting.minToolsPerTurn must be less than or equal to llm.toolRouting.maxToolsPerTurn",
    );
  }
  if (
    toolRoutingValue.maxToolsPerTurn !== undefined &&
    toolRoutingValue.maxExpandedToolsPerTurn !== undefined &&
    typeof toolRoutingValue.maxToolsPerTurn === "number" &&
    typeof toolRoutingValue.maxExpandedToolsPerTurn === "number" &&
    toolRoutingValue.maxExpandedToolsPerTurn < toolRoutingValue.maxToolsPerTurn
  ) {
    errors.push(
      "llm.toolRouting.maxExpandedToolsPerTurn must be greater than or equal to llm.toolRouting.maxToolsPerTurn",
    );
  }
}

function validateLlmSubagentsSection(
  subagentsValue: unknown,
  errors: string[],
): void {
  if (subagentsValue === undefined) return;
  if (!isRecord(subagentsValue)) {
    errors.push("llm.subagents must be an object");
    return;
  }

  if (
    subagentsValue.enabled !== undefined &&
    typeof subagentsValue.enabled !== "boolean"
  ) {
    errors.push("llm.subagents.enabled must be a boolean");
  }
  if (subagentsValue.mode !== undefined) {
    requireOneOf(
      subagentsValue.mode,
      "llm.subagents.mode",
      VALID_SUBAGENT_MODES,
      errors,
    );
  }
  if (subagentsValue.delegationAggressiveness !== undefined) {
    requireOneOf(
      subagentsValue.delegationAggressiveness,
      "llm.subagents.delegationAggressiveness",
      VALID_SUBAGENT_DELEGATION_AGGRESSIVENESS,
      errors,
    );
  }
  if (subagentsValue.maxConcurrent !== undefined) {
    requireUnlimitedOrIntRange(
      subagentsValue.maxConcurrent,
      "llm.subagents.maxConcurrent",
      1,
      64,
      errors,
    );
  }
  if (subagentsValue.maxDepth !== undefined) {
    requireUnlimitedOrIntRange(
      subagentsValue.maxDepth,
      "llm.subagents.maxDepth",
      1,
      16,
      errors,
    );
  }
  if (subagentsValue.maxFanoutPerTurn !== undefined) {
    requireUnlimitedOrIntRange(
      subagentsValue.maxFanoutPerTurn,
      "llm.subagents.maxFanoutPerTurn",
      1,
      64,
      errors,
    );
  }
  if (subagentsValue.maxTotalSubagentsPerRequest !== undefined) {
    requireUnlimitedOrIntRange(
      subagentsValue.maxTotalSubagentsPerRequest,
      "llm.subagents.maxTotalSubagentsPerRequest",
      1,
      1024,
      errors,
    );
  }
  if (subagentsValue.maxCumulativeToolCallsPerRequestTree !== undefined) {
    requireUnlimitedOrIntRange(
      subagentsValue.maxCumulativeToolCallsPerRequestTree,
      "llm.subagents.maxCumulativeToolCallsPerRequestTree",
      1,
      4096,
      errors,
    );
  }
  if (subagentsValue.maxCumulativeTokensPerRequestTree !== undefined) {
    requireIntRange(
      subagentsValue.maxCumulativeTokensPerRequestTree,
      "llm.subagents.maxCumulativeTokensPerRequestTree",
      0,
      10_000_000,
      errors,
    );
  }
  if (subagentsValue.defaultTimeoutMs !== undefined) {
    requireUnlimitedOrIntRange(
      subagentsValue.defaultTimeoutMs,
      "llm.subagents.defaultTimeoutMs",
      1_000,
      3_600_000,
      errors,
    );
  }
  if (subagentsValue.spawnDecisionThreshold !== undefined) {
    if (
      typeof subagentsValue.spawnDecisionThreshold !== "number" ||
      !Number.isFinite(subagentsValue.spawnDecisionThreshold) ||
      subagentsValue.spawnDecisionThreshold < 0 ||
      subagentsValue.spawnDecisionThreshold > 1
    ) {
      errors.push(
        "llm.subagents.spawnDecisionThreshold must be a number between 0 and 1",
      );
    }
  }
  if (subagentsValue.handoffMinPlannerConfidence !== undefined) {
    if (
      typeof subagentsValue.handoffMinPlannerConfidence !== "number" ||
      !Number.isFinite(subagentsValue.handoffMinPlannerConfidence) ||
      subagentsValue.handoffMinPlannerConfidence < 0 ||
      subagentsValue.handoffMinPlannerConfidence > 1
    ) {
      errors.push(
        "llm.subagents.handoffMinPlannerConfidence must be a number between 0 and 1",
      );
    }
  }
  if (
    subagentsValue.forceVerifier !== undefined &&
    typeof subagentsValue.forceVerifier !== "boolean"
  ) {
    errors.push("llm.subagents.forceVerifier must be a boolean");
  }
  if (
    subagentsValue.allowParallelSubtasks !== undefined &&
    typeof subagentsValue.allowParallelSubtasks !== "boolean"
  ) {
    errors.push("llm.subagents.allowParallelSubtasks must be a boolean");
  }
  if (
    subagentsValue.allowedParentTools !== undefined &&
    !isStringArray(subagentsValue.allowedParentTools)
  ) {
    errors.push("llm.subagents.allowedParentTools must be a string array");
  }
  if (
    subagentsValue.forbiddenParentTools !== undefined &&
    !isStringArray(subagentsValue.forbiddenParentTools)
  ) {
    errors.push("llm.subagents.forbiddenParentTools must be a string array");
  }
  if (subagentsValue.hardBlockedTaskClasses !== undefined) {
    if (!isStringArray(subagentsValue.hardBlockedTaskClasses)) {
      errors.push("llm.subagents.hardBlockedTaskClasses must be a string array");
    } else {
      for (let i = 0; i < subagentsValue.hardBlockedTaskClasses.length; i++) {
        const item = subagentsValue.hardBlockedTaskClasses[i];
        if (!VALID_SUBAGENT_HARD_BLOCKED_TASK_CLASSES.has(item)) {
          errors.push(
            `llm.subagents.hardBlockedTaskClasses[${i}] must be one of: ${[...VALID_SUBAGENT_HARD_BLOCKED_TASK_CLASSES].join(", ")}`,
          );
        }
      }
    }
  }
  if (subagentsValue.childToolAllowlistStrategy !== undefined) {
    requireOneOf(
      subagentsValue.childToolAllowlistStrategy,
      "llm.subagents.childToolAllowlistStrategy",
      VALID_SUBAGENT_CHILD_TOOL_ALLOWLIST_STRATEGIES,
      errors,
    );
  }
  if (subagentsValue.childProviderStrategy !== undefined) {
    requireOneOf(
      subagentsValue.childProviderStrategy,
      "llm.subagents.childProviderStrategy",
      VALID_SUBAGENT_CHILD_PROVIDER_STRATEGIES,
      errors,
    );
  }
  if (subagentsValue.fallbackBehavior !== undefined) {
    requireOneOf(
      subagentsValue.fallbackBehavior,
      "llm.subagents.fallbackBehavior",
      VALID_SUBAGENT_FALLBACK_BEHAVIORS,
      errors,
    );
  }

  if (
    subagentsValue.maxFanoutPerTurn !== undefined &&
    subagentsValue.maxTotalSubagentsPerRequest !== undefined &&
    typeof subagentsValue.maxFanoutPerTurn === "number" &&
    typeof subagentsValue.maxTotalSubagentsPerRequest === "number" &&
    subagentsValue.maxFanoutPerTurn > 0 &&
    subagentsValue.maxTotalSubagentsPerRequest > 0 &&
    subagentsValue.maxFanoutPerTurn > subagentsValue.maxTotalSubagentsPerRequest
  ) {
    errors.push(
      "llm.subagents.maxFanoutPerTurn must be less than or equal to llm.subagents.maxTotalSubagentsPerRequest",
    );
  }
}

function validateLlmSection(llm: unknown, errors: string[]): void {
  if (llm === undefined) return;
  if (!isRecord(llm)) {
    errors.push("llm must be an object");
    return;
  }

  requireOneOf(llm.provider, "llm.provider", VALID_LLM_PROVIDERS, errors);
  if (llm.webSearch !== undefined && typeof llm.webSearch !== "boolean") {
    errors.push("llm.webSearch must be a boolean");
  }
  if (llm.searchMode !== undefined) {
    requireOneOf(
      llm.searchMode,
      "llm.searchMode",
      VALID_LLM_SEARCH_MODES,
      errors,
    );
  }
  validateLlmWebSearchOptionsSection(llm.webSearchOptions, errors);
  if (llm.xSearch !== undefined && typeof llm.xSearch !== "boolean") {
    errors.push("llm.xSearch must be a boolean");
  }
  validateLlmXSearchOptionsSection(llm.xSearchOptions, errors);
  if (
    llm.codeExecution !== undefined &&
    typeof llm.codeExecution !== "boolean"
  ) {
    errors.push("llm.codeExecution must be a boolean");
  }
  if (
    llm.includeEncryptedReasoning !== undefined &&
    typeof llm.includeEncryptedReasoning !== "boolean"
  ) {
    errors.push("llm.includeEncryptedReasoning must be a boolean");
  }
  if (llm.maxTurns !== undefined) {
    if (
      typeof llm.maxTurns !== "number" ||
      !Number.isInteger(llm.maxTurns) ||
      llm.maxTurns < 1
    ) {
      errors.push("llm.maxTurns must be a positive integer");
    }
  }
  if (llm.reasoningEffort !== undefined) {
    requireOneOf(
      llm.reasoningEffort,
      "llm.reasoningEffort",
      VALID_LLM_REASONING_EFFORTS,
      errors,
    );
  }

  if (llm.timeoutMs !== undefined) {
    requireUnlimitedOrIntRange(
      llm.timeoutMs,
      "llm.timeoutMs",
      1_000,
      3_600_000,
      errors,
    );
  }
  if (llm.requestTimeoutMs !== undefined) {
    const requestTimeoutMs = llm.requestTimeoutMs;
    if (
      typeof requestTimeoutMs !== "number" ||
      !Number.isInteger(requestTimeoutMs) ||
      (
        requestTimeoutMs !== 0 &&
        (requestTimeoutMs < 5_000 || requestTimeoutMs > 7_200_000)
      )
    ) {
      errors.push(
        "llm.requestTimeoutMs must be 0 or an integer between 5000 and 7200000",
      );
    }
  }
  if (llm.toolCallTimeoutMs !== undefined) {
    requireUnlimitedOrIntRange(
      llm.toolCallTimeoutMs,
      "llm.toolCallTimeoutMs",
      1_000,
      3_600_000,
      errors,
    );
  }

  validateLlmToolFailureCircuitBreakerSection(llm.toolFailureCircuitBreaker, errors);
  validateLlmRetryPolicySection(llm.retryPolicy, errors);

  if (llm.maxTokens !== undefined) {
    requireUnlimitedOrIntRange(
      llm.maxTokens,
      "llm.maxTokens",
      1,
      262_144,
      errors,
    );
  }
  if (llm.contextWindowTokens !== undefined) {
    requireUnlimitedOrIntRange(
      llm.contextWindowTokens,
      "llm.contextWindowTokens",
      2_048,
      2_000_000,
      errors,
    );
  }
  if (llm.promptHardMaxChars !== undefined) {
    requireIntRange(
      llm.promptHardMaxChars,
      "llm.promptHardMaxChars",
      8_000,
      1_500_000,
      errors,
    );
  }
  if (llm.promptSafetyMarginTokens !== undefined) {
    requireIntRange(
      llm.promptSafetyMarginTokens,
      "llm.promptSafetyMarginTokens",
      128,
      200_000,
      errors,
    );
  }
  if (llm.promptCharPerToken !== undefined) {
    requireIntRange(
      llm.promptCharPerToken,
      "llm.promptCharPerToken",
      1,
      12,
      errors,
    );
  }
  if (llm.maxRuntimeHints !== undefined) {
    requireIntRange(llm.maxRuntimeHints, "llm.maxRuntimeHints", 0, 32, errors);
  }
  if (llm.maxToolRounds !== undefined) {
    requireUnlimitedOrIntRange(
      llm.maxToolRounds,
      "llm.maxToolRounds",
      1,
      2_048,
      errors,
    );
  }
  if (llm.plannerEnabled !== undefined && typeof llm.plannerEnabled !== "boolean") {
    errors.push("llm.plannerEnabled must be a boolean");
  }
  if (llm.plannerMaxTokens !== undefined) {
    requireUnlimitedOrIntRange(
      llm.plannerMaxTokens,
      "llm.plannerMaxTokens",
      16,
      65_536,
      errors,
    );
  }
  if (llm.toolBudgetPerRequest !== undefined) {
    requireUnlimitedOrIntRange(
      llm.toolBudgetPerRequest,
      "llm.toolBudgetPerRequest",
      1,
      8_192,
      errors,
    );
  }
  if (llm.maxModelRecallsPerRequest !== undefined) {
    requireIntRange(
      llm.maxModelRecallsPerRequest,
      "llm.maxModelRecallsPerRequest",
      0,
      128,
      errors,
    );
  }
  if (llm.maxFailureBudgetPerRequest !== undefined) {
    requireUnlimitedOrIntRange(
      llm.maxFailureBudgetPerRequest,
      "llm.maxFailureBudgetPerRequest",
      1,
      256,
      errors,
    );
  }
  if (
    llm.economicsMode !== undefined &&
    llm.economicsMode !== "report_only" &&
    llm.economicsMode !== "enforce"
  ) {
    errors.push('llm.economicsMode must be "report_only" or "enforce"');
  }
  if (llm.parallelToolCalls !== undefined && typeof llm.parallelToolCalls !== "boolean") {
    errors.push("llm.parallelToolCalls must be a boolean");
  }
  if (
    llm.runtimeContractV2 !== undefined &&
    typeof llm.runtimeContractV2 !== "boolean"
  ) {
    errors.push("llm.runtimeContractV2 must be a boolean");
  }
  validateStopHooksConfig(llm.stopHooks, errors);
  if (llm.asyncTasks !== undefined) {
    if (!isRecord(llm.asyncTasks)) {
      errors.push("llm.asyncTasks must be an object");
    } else if (
      llm.asyncTasks.enabled !== undefined &&
      typeof llm.asyncTasks.enabled !== "boolean"
    ) {
      errors.push("llm.asyncTasks.enabled must be a boolean");
    }
  }
  if (llm.persistentWorkers !== undefined) {
    if (!isRecord(llm.persistentWorkers)) {
      errors.push("llm.persistentWorkers must be an object");
    } else if (
      llm.persistentWorkers.enabled !== undefined &&
      typeof llm.persistentWorkers.enabled !== "boolean"
    ) {
      errors.push("llm.persistentWorkers.enabled must be a boolean");
    }
  }
  if (llm.mailbox !== undefined) {
    if (!isRecord(llm.mailbox)) {
      errors.push("llm.mailbox must be an object");
    } else if (
      llm.mailbox.enabled !== undefined &&
      typeof llm.mailbox.enabled !== "boolean"
    ) {
      errors.push("llm.mailbox.enabled must be a boolean");
    }
  }
  if (llm.verifier !== undefined) {
    if (!isRecord(llm.verifier)) {
      errors.push("llm.verifier must be an object");
    } else {
      if (
        llm.verifier.runtimeRequired !== undefined &&
        typeof llm.verifier.runtimeRequired !== "boolean"
      ) {
        errors.push("llm.verifier.runtimeRequired must be a boolean");
      }
      if (
        llm.verifier.projectBootstrap !== undefined &&
        typeof llm.verifier.projectBootstrap !== "boolean"
      ) {
        errors.push("llm.verifier.projectBootstrap must be a boolean");
      }
    }
  }
  if (llm.workerIsolation !== undefined) {
    if (!isRecord(llm.workerIsolation)) {
      errors.push("llm.workerIsolation must be an object");
    } else {
      if (
        llm.workerIsolation.worktree !== undefined &&
        typeof llm.workerIsolation.worktree !== "boolean"
      ) {
        errors.push("llm.workerIsolation.worktree must be a boolean");
      }
      if (
        llm.workerIsolation.remote !== undefined &&
        typeof llm.workerIsolation.remote !== "boolean"
      ) {
        errors.push("llm.workerIsolation.remote must be a boolean");
      }
    }
  }

  const llmProvider =
    typeof llm.provider === "string" && VALID_LLM_PROVIDERS.has(llm.provider)
      ? (llm.provider as GatewayLLMConfig["provider"])
      : undefined;

  validateLlmCollectionsSearchSection(llm.collectionsSearch, errors);
  validateLlmRemoteMcpSection(llm.remoteMcp, errors);
  validateLlmStructuredOutputsSection(llm.structuredOutputs, errors);
  validateLlmStatefulResponsesSection(
    llmProvider,
    llm.statefulResponses,
    errors,
  );
  validateLlmToolRoutingSection(llm.toolRouting, errors);
  validateLlmSubagentsSection(llm.subagents, errors);
}

export function validateGatewayConfig(obj: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(obj)) {
    return { valid: false, errors: ["Config must be a non-null object"] };
  }

  validateGatewaySection(obj.gateway, errors);
  validateAgentSection(obj.agent, errors);
  validateConnectionSection(obj.connection, errors);
  validateCliSection(obj.cli, errors);
  validateReplaySection(obj.replay, errors);

  // logging (optional — requires process restart to change level)
  if (obj.logging !== undefined) {
    if (!isRecord(obj.logging)) {
      errors.push("logging must be an object");
    } else {
      if (obj.logging.level !== undefined) {
        requireOneOf(
          obj.logging.level,
          "logging.level",
          VALID_LOG_LEVELS,
          errors,
        );
      }
      if (obj.logging.trace !== undefined) {
        if (!isRecord(obj.logging.trace)) {
          errors.push("logging.trace must be an object");
        } else {
          const boolFields = [
            "enabled",
            "includeHistory",
            "includeSystemPrompt",
            "includeToolArgs",
            "includeToolResults",
            "includeProviderPayloads",
          ];
          for (const field of boolFields) {
            if (
              obj.logging.trace[field] !== undefined &&
              typeof obj.logging.trace[field] !== "boolean"
            ) {
              errors.push(`logging.trace.${field} must be a boolean`);
            }
          }
          if (obj.logging.trace.maxChars !== undefined) {
            requireIntRange(
              obj.logging.trace.maxChars,
              "logging.trace.maxChars",
              256,
              200_000,
              errors,
            );
          }
          if (obj.logging.trace.fanout !== undefined) {
            if (!isRecord(obj.logging.trace.fanout)) {
              errors.push("logging.trace.fanout must be an object");
            } else if (
              obj.logging.trace.fanout.enabled !== undefined &&
              typeof obj.logging.trace.fanout.enabled !== "boolean"
            ) {
              errors.push("logging.trace.fanout.enabled must be a boolean");
            }
          }
        }
      }
    }
  }

  if (obj.workspace !== undefined) {
    if (!isRecord(obj.workspace)) {
      errors.push("workspace must be an object");
    } else if (
      obj.workspace.hostPath !== undefined &&
      (typeof obj.workspace.hostPath !== "string" ||
        obj.workspace.hostPath.trim().length === 0)
    ) {
      errors.push("workspace.hostPath must be a non-empty string");
    }
  }

  validateLlmSection(obj.llm, errors);

  validateMemorySection(obj.memory, errors);
  if (
    isRecord(obj.llm) &&
    isRecord(obj.llm.asyncTasks) &&
    obj.llm.asyncTasks.enabled === true &&
    isRecord(obj.memory) &&
    obj.memory.backend === "memory"
  ) {
    errors.push(
      "memory.backend=memory is invalid when llm.asyncTasks.enabled is true",
    );
  }
  validateAuthSection(obj.auth, errors);
  validateAuthSecretRequirement(obj.gateway, obj.auth, errors);
  validateDesktopSection(obj.desktop, errors);
  validateMcpSection(obj.mcp, errors);
  validatePolicySection(obj.policy, errors);
  validateApprovalsSection(obj.approvals, errors);
  validateSocialSection(obj.social, errors);
  validateAutonomySection(obj.autonomy, errors);
  validatePluginsSection(obj.plugins, errors);
  validateChannelsSection(obj.channels, errors);

  return validationResult(errors);
}

// ============================================================================
// Config diffing
// ============================================================================

const UNSAFE_KEYS = new Set([
  "gateway.port",
  "gateway.bind",
  "connection.rpcUrl",
  "connection.keypairPath",
  "agent.capabilities",
  "agent.name",
  "desktop.enabled",
  "social.enabled",
]);
const UNSAFE_KEY_PREFIXES = ["channels.", "plugins."] as const;

function isUnsafeConfigKey(key: string): boolean {
  if (UNSAFE_KEYS.has(key)) return true;
  return UNSAFE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function diffGatewayConfig(
  oldConfig: GatewayConfig,
  newConfig: GatewayConfig,
): ConfigDiff {
  const safe: string[] = [];
  const unsafe: string[] = [];

  const flatOld = flattenConfig(
    oldConfig as unknown as Record<string, unknown>,
  );
  const flatNew = flattenConfig(
    newConfig as unknown as Record<string, unknown>,
  );

  const allKeys = new Set([...Object.keys(flatOld), ...Object.keys(flatNew)]);

  for (const key of allKeys) {
    const oldVal = flatOld[key];
    const newVal = flatNew[key];

    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      if (isUnsafeConfigKey(key)) {
        unsafe.push(key);
      } else {
        safe.push(key);
      }
    }
  }

  return { safe, unsafe };
}

function flattenConfig(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(
        result,
        flattenConfig(value as Record<string, unknown>, fullKey),
      );
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

// ============================================================================
// ConfigWatcher
// ============================================================================

export type ConfigReloadCallback = (config: GatewayConfig) => void;
export type ConfigErrorCallback = (error: Error) => void;

export class ConfigWatcher {
  private readonly configPath: string;
  private readonly debounceMs: number;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(configPath: string, debounceMs = 500) {
    this.configPath = configPath;
    this.debounceMs = debounceMs;
  }

  start(onReload: ConfigReloadCallback, onError?: ConfigErrorCallback): void {
    if (this.watcher) return;

    try {
      this.watcher = watch(this.configPath, () => {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(async () => {
          try {
            const config = await loadGatewayConfig(this.configPath);
            onReload(config);
          } catch (err) {
            onError?.(err as Error);
          }
        }, this.debounceMs);
      });

      this.watcher.on("error", (err) => {
        onError?.(err);
      });
    } catch (err) {
      onError?.(err as Error);
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
