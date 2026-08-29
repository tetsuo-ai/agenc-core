// T10 Group D — environment variable resolution.
//
// Precedence order (env wins over TOML):
//   XAI_API_KEY | GROK_API_KEY                     → grok api key
//   OPENAI_API_KEY / ANTHROPIC_API_KEY / ...       → provider api key
//   AGENC_PROVIDER                                 → provider slug
//   AGENC_PROFILE                                  → profile selector
//   AGENC_MODEL                                    → model slug
//   AGENC_EFFORT_LEVEL                             → reasoning_effort
//   AGENC_MAX_TURNS                               → max_turns
//   AGENC_COORDINATOR_MODE                        → coordinator_mode
//   AGENC_STREAM_IDLE_TIMEOUT_MS                  → stream_watchdog_timeout_ms
//   AGENC_WORKSPACE is consumed only by pre-repository bootstrap cwd
//   resolution. It is captured here but is not projected into AgenCConfig.
//   AGENC_HOME                                     → ~/.agenc override
//   AGENC_AUTONOMOUS                              → autonomous tick mode
//   AGENC_MAX_OUTPUT_TOKENS                       → global output budget
//   AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS        → 8k default + retry mode
//   AGENC_MAX_BUDGET_USD                           → session cost budget
//   AGENC_AUTH_BACKEND                             → auth.backend
//   AGENC_AUTH_MANAGED_KEYS_ENABLED               → auth.managedKeys.enabled
//   AGENC_BROWSER_*                                → browser.*
//   AGENC_BUDGET*                                  → budget.*
//   AGENC_HEARTBEAT*                               → heartbeat.*
//   AGENC_TRANSACTION_GUARD*                       → transaction_guard.*
//
// `applyEnvOverrides(config)` layers env values onto a base config and
// returns a new frozen snapshot.

import type { AgenCConfig } from "./schema.js";
import { mergeConfigs } from "./schema.js";
import {
  assertNoRetiredConfigDir,
  resolveHomeContext,
} from "./home.js";
import { normalizeProviderIdentity } from "../provider-identity.js";
import {
  resolveProviderApiKeyEnvironment,
  resolveProviderBaseURLEnvironment,
} from "../llm/registry/provider-ingress.js";
import { parseHeartbeatTarget } from "../heartbeat/config.js";
import { resolveProviderModelLayer } from "./provider-model-authority.js";

// Writable mirror used internally to build override payloads; the public
// `AgenCConfig` surface stays readonly.
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface EnvSnapshot {
  readonly AGENC_HOME?: string;
  readonly AGENC_CONFIG_DIR?: string;
  readonly AGENC_PROFILE?: string;
  readonly AGENC_PROVIDER?: string;
  readonly AGENC_MODEL?: string;
  readonly AGENC_EFFORT_LEVEL?: string;
  readonly AGENC_AGENT_MAX_DEPTH?: string;
  readonly AGENC_MAX_TURNS?: string;
  readonly AGENC_COORDINATOR_MODE?: string;
  readonly AGENC_STREAM_IDLE_TIMEOUT_MS?: string;
  readonly AGENC_DISABLE_STREAM_WATCHDOG?: string;
  readonly AGENC_ENABLE_STREAM_WATCHDOG?: string;
  readonly AGENC_ALWAYS_ENABLE_EFFORT?: string;
  readonly AGENC_WORKSPACE?: string;
  readonly AGENC_AUTONOMOUS?: string;
  readonly AGENC_MAX_OUTPUT_TOKENS?: string;
  readonly AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS?: string;
  readonly AGENC_MAX_BUDGET_USD?: string;
  readonly AGENC_AUTH_BACKEND?: string;
  readonly AGENC_AUTH_MANAGED_KEYS_ENABLED?: string;
  readonly AGENC_BROWSER_EXECUTABLE?: string;
  readonly AGENC_BROWSER_HEADLESS?: string;
  readonly AGENC_BROWSER_ALLOW_PRIVATE_NETWORK?: string;
  readonly AGENC_BROWSER_PROFILE_DIR?: string;
  readonly AGENC_BROWSER_NO_SANDBOX?: string;
  readonly AGENC_BROWSER_NAV_TIMEOUT_MS?: string;
  readonly AGENC_BUDGET?: string;
  readonly AGENC_BUDGET_DAILY_USD?: string;
  readonly AGENC_BUDGET_MONTHLY_USD?: string;
  readonly AGENC_BUDGET_DAILY_TOKENS?: string;
  readonly AGENC_BUDGET_MONTHLY_TOKENS?: string;
  readonly AGENC_BUDGET_SOFT_THRESHOLD?: string;
  readonly AGENC_BUDGET_ENFORCE_INTERACTIVE?: string;
  readonly AGENC_HEARTBEAT?: string;
  readonly AGENC_HEARTBEAT_INTERVAL?: string;
  readonly AGENC_HEARTBEAT_ACTIVE_HOURS?: string;
  readonly AGENC_HEARTBEAT_TARGET?: string;
  readonly AGENC_TRANSACTION_GUARD?: string;
  readonly AGENC_TRANSACTION_GUARD_MODEL?: string;
  readonly AGENC_TRANSACTION_GUARD_OLLAMA_URL?: string;
  readonly AGENC_TRANSACTION_GUARD_FAIL_MODE?: string;
  readonly AGENC_TRANSACTION_GUARD_TIMEOUT_MS?: string;
  readonly AGENC_TRANSACTION_GUARD_MAX_DOCKET_BYTES?: string;
  readonly XAI_API_KEY?: string;
  readonly GROK_API_KEY?: string;
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_BASE_URL?: string;
  readonly OPENAI_COMPATIBLE_API_KEY?: string;
  readonly OPENAI_COMPATIBLE_BASE_URL?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly ANTHROPIC_BASE_URL?: string;
  readonly LMSTUDIO_API_KEY?: string;
  readonly LMSTUDIO_BASE_URL?: string;
  readonly OPENROUTER_API_KEY?: string;
  readonly OPENROUTER_BASE_URL?: string;
  readonly GROQ_API_KEY?: string;
  readonly GROQ_BASE_URL?: string;
  readonly DEEPSEEK_API_KEY?: string;
  readonly DEEPSEEK_BASE_URL?: string;
  readonly GEMINI_API_KEY?: string;
  readonly GEMINI_BASE_URL?: string;
  readonly GOOGLE_API_KEY?: string;
  readonly GEMINI_ACCESS_TOKEN?: string;
  readonly GEMINI_AUTH_MODE?: string;
  readonly GEMINI_PROJECT_ID?: string;
  readonly GOOGLE_CLOUD_PROJECT?: string;
  readonly GOOGLE_CLOUD_QUOTA_PROJECT?: string;
  readonly GOOGLE_APPLICATION_CREDENTIALS?: string;
  readonly APPDATA?: string;
  readonly AWS_ACCESS_KEY_ID?: string;
  readonly AWS_SECRET_ACCESS_KEY?: string;
  readonly AWS_BEDROCK_ACCESS_KEY_ID?: string;
  readonly AWS_BEDROCK_SECRET_ACCESS_KEY?: string;
  readonly AWS_BEDROCK_BASE_URL?: string;
  readonly AWS_BEDROCK_REGION?: string;
  readonly AWS_REGION?: string;
  readonly AWS_DEFAULT_REGION?: string;
  readonly AWS_BEDROCK_SESSION_TOKEN?: string;
  readonly AWS_SESSION_TOKEN?: string;
  readonly HOME?: string;
  readonly [k: string]: string | undefined;
}

function readEnv(env: EnvSnapshot | NodeJS.ProcessEnv): EnvSnapshot {
  return env as EnvSnapshot;
}

/**
 * Resolve AGENC_HOME. Matches bin/agenc.ts:181.
 *
 * - `AGENC_HOME` wins if set.
 * - Otherwise `$HOME/.agenc`.
 * - Throws if neither is available.
 */
export function resolveAgencHome(env: EnvSnapshot = process.env): string {
  return resolveHomeContext(env, {
    ...(readNonEmpty(env.HOME) !== undefined
      ? { platformHome: readNonEmpty(env.HOME) }
      : {}),
  }).path;
}

export const OBSOLETE_CONFIG_ENV_REPLACEMENTS = Object.freeze({
  AGENC_XAI_API_KEY: "XAI_API_KEY or GROK_API_KEY",
  AGENC_MCP_SERVERS: "mcp_servers in config.toml or agenc mcp add",
  AGENC_ENV_FILE:
    "Setup or SessionStart hooks that write to their injected AGENC_ENV_FILE",
  AGENC_SUBPROCESS_ENV_SCRUB:
    "no replacement; subprocess secret scrubbing is always enabled by default",
  OPENAI_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  OPENAI_COMPATIBLE_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  ANTHROPIC_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  OLLAMA_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  LMSTUDIO_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  OPENROUTER_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  GROQ_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  DEEPSEEK_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  GEMINI_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  MISTRAL_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  NVIDIA_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  MINIMAX_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  GITHUB_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  AWS_BEDROCK_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  ANTHROPIC_DEFAULT_HAIKU_MODEL:
    "AGENC_MODEL, --model, or model in config.toml",
  ANTHROPIC_DEFAULT_OPUS_MODEL:
    "AGENC_MODEL, --model, or model in config.toml",
  ANTHROPIC_DEFAULT_SONNET_MODEL:
    "AGENC_MODEL, --model, or model in config.toml",
  ANTHROPIC_SMALL_FAST_MODEL:
    "the session-owned canonical model selection",
  ANTHROPIC_CUSTOM_MODEL_OPTION:
    "a model catalog entry plus AGENC_MODEL, --model, or model in config.toml",
  AGENC_SUBAGENT_MODEL:
    "an agent definition, an explicit Agent tool model, or inherited session model",
  AGENC_AUTO_MODE_MODEL: "the session-owned canonical model selection",
  DISABLE_AUTO_COMPACT: "AGENC_DISABLE_AUTO_COMPACT",
  DISABLE_COMPACT: "AGENC_DISABLE_COMPACT",
  AGENC_DISABLE_STREAM_WATCHDOG: "AGENC_STREAM_IDLE_TIMEOUT_MS=0",
  AGENC_ENABLE_STREAM_WATCHDOG:
    "a positive AGENC_STREAM_IDLE_TIMEOUT_MS or stream_watchdog_timeout_ms in config.toml",
  AGENC_ALWAYS_ENABLE_EFFORT:
    "the canonical provider capability configuration",
  AGENC_HEARTBEAT_MODEL:
    "the model selected by the canonical gateway daemon session",
  AGENC_HEARTBEAT_AGENT:
    "the canonical heartbeat session",
  AGENC_GATEWAY_HOOKS_TOKEN: "AGENC_HOOKS_TOKEN",
  AGENC_SPECULATION_ENABLED: "speculationEnabled in config.toml",
  AGENC_DISABLE_GIT_INSTRUCTIONS: "includeGitInstructions in config.toml",
  AGENC_DISABLE_AUTO_MEMORY: "autoMemoryEnabled in config.toml",
  AGENC_DISABLE_FILE_CHECKPOINTING:
    "fileCheckpointingEnabled in config.toml",
  AGENC_ENABLE_SDK_FILE_CHECKPOINTING:
    "fileCheckpointingEnabled in config.toml",
  AGENC_USE_READABLE_STDIN: "AGENC_USE_DATA_STDIN=1",
  AGENC_USE_POWERSHELL_TOOL:
    "automatic Windows capability discovery plus defaultShell in config.toml",
} as const);

/** Reject removed environment authorities instead of silently ignoring them. */
export function assertNoObsoleteConfigEnvironment(
  env: EnvSnapshot | NodeJS.ProcessEnv = process.env,
): void {
  const e = readEnv(env);
  const present = Object.entries(OBSOLETE_CONFIG_ENV_REPLACEMENTS).filter(
    ([name]) => e[name] !== undefined,
  );
  if (present.length === 0) return;
  const details = present
    .map(([name, replacement]) => `${name} (use ${replacement})`)
    .join(", ");
  throw new Error(
    `obsolete configuration environment variable${present.length === 1 ? "" : "s"} ` +
      `${details} ${present.length === 1 ? "is" : "are"} set; remove ` +
      `${present.length === 1 ? "it" : "them"}. Defined values such as \"0\" or \"false\" are still rejected.`,
  );
}

/**
 * xAI API key resolution with aliases. Returns `undefined` if none set.
 * Priority: XAI_API_KEY → GROK_API_KEY.
 */
export function resolveApiKey(
  env: EnvSnapshot = process.env,
): string | undefined {
  return resolveProviderApiKeyEnvironment("grok", readEnv(env))?.value;
}

function readNonEmpty(
  value: string | undefined,
): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** Active profile selector from AGENC_PROFILE, or `undefined`. */
export function resolveProfileName(
  env: EnvSnapshot = process.env,
): string | undefined {
  return readNonEmpty(readEnv(env).AGENC_PROFILE);
}

export function resolveProviderBaseURL(
  provider: string,
  env: EnvSnapshot = process.env,
): string | undefined {
  return resolveProviderBaseURLEnvironment(provider, readEnv(env))?.value;
}

/** Workspace root override from AGENC_WORKSPACE, or `undefined`. */
export function resolveWorkspace(
  env: EnvSnapshot = process.env,
): string | undefined {
  const e = readEnv(env);
  return e.AGENC_WORKSPACE && e.AGENC_WORKSPACE.length > 0
    ? e.AGENC_WORKSPACE
    : undefined;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function readPositiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readPositiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+(?:_\d+)*$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed.replaceAll("_", ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readNonNegativeInteger(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+(?:_\d+)*$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed.replaceAll("_", ""), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function readBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function warnInvalidEnvironmentValue(
  onWarn: ((message: string) => void) | undefined,
  name: string,
  raw: string,
  expected: string,
): void {
  if (raw.trim().length === 0) return;
  onWarn?.(
    `[agenc:config] invalid ${name}=${JSON.stringify(raw)}; expected ${expected}`,
  );
}

function heartbeatActiveHours(
  raw: string | undefined,
): readonly number[] | null | undefined {
  const value = readNonEmpty(raw)?.toLowerCase();
  if (value === undefined) return undefined;
  if (value === "always" || value === "all") {
    return Object.freeze([0, 24]);
  }
  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(value);
  if (match === null) return null;
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  return start >= 0 && end <= 24 && start < end
    ? Object.freeze([start, end])
    : null;
}

/**
 * Layer env values onto `config` and return a new frozen snapshot.
 * Env takes precedence over whatever was loaded from TOML.
 *
 * Only fields with an explicit env override are touched — absent env vars
 * leave the base config unchanged.
 */
export function applyEnvOverrides(
  config: AgenCConfig,
  env: EnvSnapshot = process.env,
  onWarn?: (msg: string) => void,
): AgenCConfig {
  assertNoRetiredConfigDir(env);
  assertNoObsoleteConfigEnvironment(env);
  const e = readEnv(env);
  const override: Mutable<Partial<AgenCConfig>> = {};

  if (e.AGENC_MODEL && e.AGENC_MODEL.length > 0) {
    override.model = e.AGENC_MODEL;
  }
  if (e.AGENC_EFFORT_LEVEL !== undefined) {
    const effort = readNonEmpty(e.AGENC_EFFORT_LEVEL)?.toLowerCase();
    if (
      effort === "low" || effort === "medium" ||
      effort === "high" || effort === "xhigh" || effort === "none"
    ) {
      override.reasoning_effort = effort;
    } else {
      throw new Error(
        `invalid AGENC_EFFORT_LEVEL="${e.AGENC_EFFORT_LEVEL}"; ` +
          "expected one of low, medium, high, xhigh, or none",
      );
    }
  }
  const provider = normalizeProviderIdentity(e.AGENC_PROVIDER, "AGENC_PROVIDER");
  if (provider) {
    override.model_provider = provider;
  }
  if (e.AGENC_AUTONOMOUS !== undefined && e.AGENC_AUTONOMOUS.length > 0) {
    override.autonomous_mode = TRUTHY.has(e.AGENC_AUTONOMOUS.toLowerCase());
  }
  if (e.AGENC_MAX_OUTPUT_TOKENS !== undefined) {
    const maxOutputTokens = readPositiveInteger(e.AGENC_MAX_OUTPUT_TOKENS);
    if (maxOutputTokens !== undefined) {
      override.max_output_tokens = maxOutputTokens;
    } else if (e.AGENC_MAX_OUTPUT_TOKENS.trim().length > 0) {
      onWarn?.(
        `[agenc:config] invalid AGENC_MAX_OUTPUT_TOKENS="${e.AGENC_MAX_OUTPUT_TOKENS}"; expected a positive integer`,
      );
    }
  }
  if (e.AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS !== undefined) {
    const capped = readBoolean(e.AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS);
    if (capped !== undefined) {
      override.capped_default_max_output_tokens = capped;
    } else if (e.AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS.trim().length > 0) {
      onWarn?.(
        `[agenc:config] invalid AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS="${e.AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS}"; expected boolean-like value`,
      );
    }
  }
  if (e.AGENC_MAX_TURNS !== undefined) {
    const maxTurns = readPositiveInteger(e.AGENC_MAX_TURNS);
    if (maxTurns !== undefined) {
      override.max_turns = maxTurns;
    } else if (e.AGENC_MAX_TURNS.trim().length > 0) {
      onWarn?.(
        `[agenc:config] invalid AGENC_MAX_TURNS="${e.AGENC_MAX_TURNS}"; expected a positive integer`,
      );
    }
  }
  if (e.AGENC_AGENT_MAX_DEPTH !== undefined) {
    const maxDepth = readNonNegativeInteger(e.AGENC_AGENT_MAX_DEPTH);
    if (maxDepth !== undefined) {
      override.agent_max_depth = maxDepth;
    } else if (e.AGENC_AGENT_MAX_DEPTH.trim().length > 0) {
      throw new Error(
        `invalid AGENC_AGENT_MAX_DEPTH=${JSON.stringify(e.AGENC_AGENT_MAX_DEPTH)}; expected a non-negative integer`,
      );
    }
  }
  if (e.AGENC_COORDINATOR_MODE !== undefined) {
    const coordinatorMode = readBoolean(e.AGENC_COORDINATOR_MODE);
    if (coordinatorMode !== undefined) {
      override.coordinator_mode = coordinatorMode;
    } else if (e.AGENC_COORDINATOR_MODE.trim().length > 0) {
      onWarn?.(
        `[agenc:config] invalid AGENC_COORDINATOR_MODE="${e.AGENC_COORDINATOR_MODE}"; expected boolean-like value`,
      );
    }
  }
  if (e.AGENC_STREAM_IDLE_TIMEOUT_MS !== undefined) {
    const timeoutMs = readNonNegativeInteger(
      e.AGENC_STREAM_IDLE_TIMEOUT_MS,
    );
    if (timeoutMs !== undefined) {
      override.stream_watchdog_timeout_ms = timeoutMs;
    } else if (e.AGENC_STREAM_IDLE_TIMEOUT_MS.trim().length > 0) {
      onWarn?.(
        `[agenc:config] invalid AGENC_STREAM_IDLE_TIMEOUT_MS="${e.AGENC_STREAM_IDLE_TIMEOUT_MS}"; expected a non-negative integer`,
      );
    }
  }
  const maxBudgetUsd = readPositiveNumber(e.AGENC_MAX_BUDGET_USD);
  if (maxBudgetUsd !== undefined) {
    override.max_budget_usd = maxBudgetUsd;
  }
  if (e.AGENC_AUTH_BACKEND !== undefined) {
    const backend = readNonEmpty(e.AGENC_AUTH_BACKEND)?.toLowerCase();
    if (backend === "local" || backend === "remote") {
      override.auth = {
        ...(config.auth ?? {}),
        backend,
      };
    } else if (e.AGENC_AUTH_BACKEND.trim().length > 0) {
      onWarn?.(
        `[agenc:config] invalid AGENC_AUTH_BACKEND="${e.AGENC_AUTH_BACKEND}"; expected "local" or "remote"`,
      );
    }
  }
  if (e.AGENC_AUTH_MANAGED_KEYS_ENABLED !== undefined) {
    const enabled = readBoolean(e.AGENC_AUTH_MANAGED_KEYS_ENABLED);
    if (enabled !== undefined) {
      override.auth = {
        ...(config.auth ?? {}),
        ...(override.auth ?? {}),
        managedKeys: {
          ...(config.auth?.managedKeys ?? {}),
          ...(override.auth?.managedKeys ?? {}),
          enabled,
        },
      };
    } else if (e.AGENC_AUTH_MANAGED_KEYS_ENABLED.trim().length > 0) {
      onWarn?.(
        `[agenc:config] invalid AGENC_AUTH_MANAGED_KEYS_ENABLED="${e.AGENC_AUTH_MANAGED_KEYS_ENABLED}"; expected boolean-like value`,
      );
    }
  }

  const browser: Mutable<NonNullable<AgenCConfig["browser"]>> = {};
  const browserExecutable = readNonEmpty(e.AGENC_BROWSER_EXECUTABLE);
  if (browserExecutable !== undefined) {
    browser.executable_path = browserExecutable;
  }
  const browserHeadless = readBoolean(e.AGENC_BROWSER_HEADLESS);
  if (browserHeadless !== undefined) {
    browser.headless = browserHeadless;
  } else if (e.AGENC_BROWSER_HEADLESS !== undefined) {
    warnInvalidEnvironmentValue(
      onWarn,
      "AGENC_BROWSER_HEADLESS",
      e.AGENC_BROWSER_HEADLESS,
      "a boolean-like value",
    );
  }
  const allowPrivateNetwork = readBoolean(
    e.AGENC_BROWSER_ALLOW_PRIVATE_NETWORK,
  );
  if (allowPrivateNetwork !== undefined) {
    browser.allow_private_network = allowPrivateNetwork;
  } else if (e.AGENC_BROWSER_ALLOW_PRIVATE_NETWORK !== undefined) {
    warnInvalidEnvironmentValue(
      onWarn,
      "AGENC_BROWSER_ALLOW_PRIVATE_NETWORK",
      e.AGENC_BROWSER_ALLOW_PRIVATE_NETWORK,
      "a boolean-like value",
    );
  }
  const browserProfileDir = readNonEmpty(e.AGENC_BROWSER_PROFILE_DIR);
  if (browserProfileDir !== undefined) {
    browser.profile_dir = browserProfileDir;
  }
  const browserNoSandbox = readBoolean(e.AGENC_BROWSER_NO_SANDBOX);
  if (browserNoSandbox !== undefined) {
    browser.no_sandbox = browserNoSandbox;
  } else if (e.AGENC_BROWSER_NO_SANDBOX !== undefined) {
    warnInvalidEnvironmentValue(
      onWarn,
      "AGENC_BROWSER_NO_SANDBOX",
      e.AGENC_BROWSER_NO_SANDBOX,
      "a boolean-like value",
    );
  }
  const browserNavigationTimeout = readPositiveInteger(
    e.AGENC_BROWSER_NAV_TIMEOUT_MS,
  );
  if (browserNavigationTimeout !== undefined) {
    browser.navigation_timeout_ms = browserNavigationTimeout;
  } else if (e.AGENC_BROWSER_NAV_TIMEOUT_MS !== undefined) {
    warnInvalidEnvironmentValue(
      onWarn,
      "AGENC_BROWSER_NAV_TIMEOUT_MS",
      e.AGENC_BROWSER_NAV_TIMEOUT_MS,
      "a positive integer",
    );
  }
  if (Object.keys(browser).length > 0) override.browser = browser;

  const budget: Mutable<NonNullable<AgenCConfig["budget"]>> = {};
  const budgetEnabled = readBoolean(e.AGENC_BUDGET);
  if (budgetEnabled !== undefined) {
    budget.enabled = budgetEnabled;
  } else if (e.AGENC_BUDGET !== undefined) {
    warnInvalidEnvironmentValue(
      onWarn,
      "AGENC_BUDGET",
      e.AGENC_BUDGET,
      "a boolean-like value",
    );
  }
  for (const [name, field] of [
    ["AGENC_BUDGET_DAILY_USD", "daily_usd"],
    ["AGENC_BUDGET_MONTHLY_USD", "monthly_usd"],
    ["AGENC_BUDGET_DAILY_TOKENS", "daily_tokens"],
    ["AGENC_BUDGET_MONTHLY_TOKENS", "monthly_tokens"],
  ] as const) {
    const value = readPositiveNumber(e[name]);
    if (value !== undefined) {
      budget[field] = value;
    } else if (e[name] !== undefined) {
      warnInvalidEnvironmentValue(
        onWarn,
        name,
        e[name] ?? "",
        "a positive number",
      );
    }
  }
  const budgetSoftThreshold = readPositiveNumber(
    e.AGENC_BUDGET_SOFT_THRESHOLD,
  );
  if (budgetSoftThreshold !== undefined && budgetSoftThreshold < 1) {
    budget.soft_threshold = budgetSoftThreshold;
  } else if (e.AGENC_BUDGET_SOFT_THRESHOLD !== undefined) {
    warnInvalidEnvironmentValue(
      onWarn,
      "AGENC_BUDGET_SOFT_THRESHOLD",
      e.AGENC_BUDGET_SOFT_THRESHOLD,
      "a number greater than 0 and less than 1",
    );
  }
  const budgetEnforceInteractive = readBoolean(
    e.AGENC_BUDGET_ENFORCE_INTERACTIVE,
  );
  if (budgetEnforceInteractive !== undefined) {
    budget.enforce_interactive = budgetEnforceInteractive;
  } else if (e.AGENC_BUDGET_ENFORCE_INTERACTIVE !== undefined) {
    warnInvalidEnvironmentValue(
      onWarn,
      "AGENC_BUDGET_ENFORCE_INTERACTIVE",
      e.AGENC_BUDGET_ENFORCE_INTERACTIVE,
      "a boolean-like value",
    );
  }
  if (Object.keys(budget).length > 0) override.budget = budget;

  const heartbeat: Mutable<NonNullable<AgenCConfig["heartbeat"]>> = {};
  const heartbeatEnabled = readBoolean(e.AGENC_HEARTBEAT);
  if (heartbeatEnabled !== undefined) {
    heartbeat.enabled = heartbeatEnabled;
  } else if (e.AGENC_HEARTBEAT !== undefined) {
    warnInvalidEnvironmentValue(
      onWarn,
      "AGENC_HEARTBEAT",
      e.AGENC_HEARTBEAT,
      "a boolean-like value",
    );
  }
  const heartbeatInterval = readPositiveInteger(e.AGENC_HEARTBEAT_INTERVAL);
  if (heartbeatInterval !== undefined) {
    heartbeat.interval_seconds = heartbeatInterval;
  } else if (e.AGENC_HEARTBEAT_INTERVAL !== undefined) {
    warnInvalidEnvironmentValue(
      onWarn,
      "AGENC_HEARTBEAT_INTERVAL",
      e.AGENC_HEARTBEAT_INTERVAL,
      "a positive integer number of seconds",
    );
  }
  const activeHours = heartbeatActiveHours(e.AGENC_HEARTBEAT_ACTIVE_HOURS);
  if (activeHours !== undefined && activeHours !== null) {
    heartbeat.active_hours = activeHours;
  } else if (
    activeHours === null &&
    e.AGENC_HEARTBEAT_ACTIVE_HOURS !== undefined
  ) {
    warnInvalidEnvironmentValue(
      onWarn,
      "AGENC_HEARTBEAT_ACTIVE_HOURS",
      e.AGENC_HEARTBEAT_ACTIVE_HOURS,
      '"always", "all", or a start-end range between 0 and 24',
    );
  }
  let clearHeartbeatTarget = false;
  if (e.AGENC_HEARTBEAT_TARGET !== undefined) {
    const heartbeatTarget = parseHeartbeatTarget(
      e.AGENC_HEARTBEAT_TARGET,
      `AGENC_HEARTBEAT_TARGET="${e.AGENC_HEARTBEAT_TARGET}"`,
    );
    if (heartbeatTarget.kind === "none") {
      clearHeartbeatTarget = true;
    } else {
      heartbeat.target_channel = heartbeatTarget.channelId;
      heartbeat.target_conversation = heartbeatTarget.conversationId;
    }
  }
  if (Object.keys(heartbeat).length > 0) override.heartbeat = heartbeat;

  const transactionGuard: Mutable<
    NonNullable<AgenCConfig["transaction_guard"]>
  > = {};
  const transactionGuardMode = readNonEmpty(
    e.AGENC_TRANSACTION_GUARD,
  )?.toLowerCase();
  if (transactionGuardMode === "slm") {
    transactionGuard.enabled = true;
  } else if (
    transactionGuardMode !== undefined &&
    ["off", "0", "false", "no", "disabled"].includes(transactionGuardMode)
  ) {
    transactionGuard.enabled = false;
  } else if (
    transactionGuardMode !== undefined &&
    e.AGENC_TRANSACTION_GUARD !== undefined
  ) {
    warnInvalidEnvironmentValue(
      onWarn,
      "AGENC_TRANSACTION_GUARD",
      e.AGENC_TRANSACTION_GUARD,
      '"slm" or an explicit disabled value ("off", "0", "false", "no", "disabled")',
    );
  }
  const transactionGuardModel = readNonEmpty(
    e.AGENC_TRANSACTION_GUARD_MODEL,
  );
  if (transactionGuardModel !== undefined) {
    transactionGuard.model = transactionGuardModel;
  }
  const transactionGuardEndpoint = readNonEmpty(
    e.AGENC_TRANSACTION_GUARD_OLLAMA_URL,
  );
  if (transactionGuardEndpoint !== undefined) {
    transactionGuard.endpoint = transactionGuardEndpoint;
  }
  const transactionGuardFailMode = readNonEmpty(
    e.AGENC_TRANSACTION_GUARD_FAIL_MODE,
  )?.toLowerCase();
  if (
    transactionGuardFailMode === "open" ||
    transactionGuardFailMode === "closed"
  ) {
    transactionGuard.fail_mode = transactionGuardFailMode;
  } else if (e.AGENC_TRANSACTION_GUARD_FAIL_MODE !== undefined) {
    warnInvalidEnvironmentValue(
      onWarn,
      "AGENC_TRANSACTION_GUARD_FAIL_MODE",
      e.AGENC_TRANSACTION_GUARD_FAIL_MODE,
      '"open" or "closed"',
    );
  }
  for (const [name, field] of [
    ["AGENC_TRANSACTION_GUARD_TIMEOUT_MS", "timeout_ms"],
    [
      "AGENC_TRANSACTION_GUARD_MAX_DOCKET_BYTES",
      "max_docket_bytes",
    ],
  ] as const) {
    const value = readPositiveInteger(e[name]);
    if (value !== undefined) {
      transactionGuard[field] = value;
    } else if (e[name] !== undefined) {
      warnInvalidEnvironmentValue(
        onWarn,
        name,
        e[name] ?? "",
        "a positive integer",
      );
    }
  }
  if (Object.keys(transactionGuard).length > 0) {
    override.transaction_guard = transactionGuard;
  }
  // NOTE: API-key env vars (XAI_API_KEY / GROK_API_KEY)
  // are intentionally NOT layered onto the config snapshot. `resolveApiKey`
  // is the right seam — secrets should not be persisted into the config.
  const merged = mergeConfigs(
    config,
    resolveProviderModelLayer(config, override),
  );
  if (!clearHeartbeatTarget) return merged;
  const {
    target_channel: _targetChannel,
    target_conversation: _targetConversation,
    ...heartbeatWithoutTarget
  } = merged.heartbeat ?? {};
  return mergeConfigs(
    { ...merged, heartbeat: heartbeatWithoutTarget },
    {},
  );
}
