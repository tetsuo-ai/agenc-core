/**
 * REPL startup gates.
 *
 * Defers startup checks (plugin/recommendation/policy bootstrap that may
 * surface focus-stealing dialogs) until the user has actually engaged
 * with the prompt. A pure timeout grace is insufficient because pausing
 * before typing would still allow dialogs to steal focus. Only the
 * user's first submission guarantees the prompt is no longer in the
 * vulnerable pre-interaction window.
 *
 * AgenC scope: this module is the upstream state-machine core plus the
 * AgenC-side derivation from live runtime data:
 *   - `trust`   is omitted unless a future runtime surface exposes a concrete
 *     project-trust decision. AgenC does not have OpenClaude's persisted trust
 *     store at this layer yet, so rendering a fake pending row would be noise.
 *   - `apiKey` is derived from the active provider and real API-key sources.
 *   - `policy` is derived from the live session/config policy snapshot.
 *
 * OpenClaude-only remote/cloud/IDE gates (console OAuth, cloud resume,
 * channel downgrade, IDE extension prompts) are intentionally omitted until
 * AgenC exposes equivalent runtime signals.
 */

/**
 * Determines whether startup checks should run.
 *
 * Startup checks are deferred until the user has submitted their first
 * message. This guarantees the prompt was the first thing the user
 * interacted with, so no recommendation dialog can steal focus before
 * the first keystroke.
 */
export function shouldRunStartupChecks(options: {
  readonly isRemoteSession: boolean;
  readonly hasStarted: boolean;
  readonly hasHadFirstSubmission: boolean;
}): boolean {
  if (options.isRemoteSession) return false;
  if (options.hasStarted) return false;
  if (!options.hasHadFirstSubmission) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// AgenC startup-gate state machine
// ─────────────────────────────────────────────────────────────────────────

/**
 * Names of the gates the AgenC REPL waits on before considering startup
 * complete. Order matters — the REPL processes gates in declaration
 * order so the user sees a deterministic sequence of confirmations.
 *
 *  - `trust`   → ProjectTrust check (workspace marked trusted/untrusted).
 *  - `apiKey`  → API key presence on the configured provider.
 *  - `policy`  → Approval/sandbox policy load completed without errors.
 */
export type StartupGateName = "trust" | "apiKey" | "policy";

export const STARTUP_GATE_ORDER: readonly StartupGateName[] = [
  "trust",
  "apiKey",
  "policy",
];

/**
 * State of a single gate. `pending` is the initial state; `cleared`
 * means the gate is satisfied and the REPL can move on; `blocked`
 * means the gate has surfaced an interactive prompt or failure that
 * the user must resolve before startup finishes.
 */
export type StartupGateState = "pending" | "cleared" | "blocked" | "omitted";

export type StartupGatesSnapshot = Readonly<
  Record<StartupGateName, StartupGateState>
>;

export function createInitialStartupGates(): StartupGatesSnapshot {
  return {
    trust: "omitted",
    apiKey: "pending",
    policy: "pending",
  };
}

export function setStartupGate(
  snapshot: StartupGatesSnapshot,
  gate: StartupGateName,
  state: StartupGateState,
): StartupGatesSnapshot {
  if (snapshot[gate] === state) return snapshot;
  return { ...snapshot, [gate]: state };
}

export function allStartupGatesCleared(
  snapshot: StartupGatesSnapshot,
): boolean {
  return STARTUP_GATE_ORDER.every((gate) => {
    const state = snapshot[gate];
    return state === "cleared" || state === "omitted";
  });
}

export function anyStartupGateBlocked(snapshot: StartupGatesSnapshot): boolean {
  return STARTUP_GATE_ORDER.some((gate) => snapshot[gate] === "blocked");
}

export function visibleStartupGateNames(
  snapshot: StartupGatesSnapshot,
): readonly StartupGateName[] {
  return STARTUP_GATE_ORDER.filter((gate) => snapshot[gate] !== "omitted");
}

/**
 * Return the first gate that is still pending in declaration order, or
 * `null` when none remain. The REPL renders the corresponding overlay
 * only for the active pending gate so we never stack two blocking
 * dialogs at once.
 */
export function nextPendingStartupGate(
  snapshot: StartupGatesSnapshot,
): StartupGateName | null {
  for (const gate of STARTUP_GATE_ORDER) {
    if (snapshot[gate] === "pending") return gate;
  }
  return null;
}

/**
 * Return the first visible gate that still needs operator attention. Blocked
 * gates count here so a single blocked API-key gate remains visible instead of
 * disappearing once no later pending gates exist.
 */
export function nextActiveStartupGate(
  snapshot: StartupGatesSnapshot,
): StartupGateName | null {
  for (const gate of STARTUP_GATE_ORDER) {
    const state = snapshot[gate];
    if (state === "pending" || state === "blocked") return gate;
  }
  return null;
}

type EnvSnapshot = Readonly<Record<string, string | undefined>>;

export interface StartupGateRuntimeInput {
  readonly session?: unknown;
  readonly config?: unknown;
  readonly configError?: unknown;
  readonly env?: EnvSnapshot;
}

const PROVIDERS_REQUIRING_API_KEY = new Set([
  "grok",
  "openai",
  "anthropic",
  "openrouter",
  "groq",
  "deepseek",
  "gemini",
]);

const PROVIDERS_WITH_OPTIONAL_LOCAL_AUTH = new Set(["ollama", "lmstudio"]);

const PROVIDER_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  grok: ["XAI_API_KEY", "GROK_API_KEY", "AGENC_XAI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  lmstudio: ["LMSTUDIO_API_KEY", "OPENAI_API_KEY"],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeProvider(value: unknown): string | undefined {
  const raw = readString(value)?.toLowerCase();
  if (!raw) return undefined;
  return raw === "xai" ? "grok" : raw;
}

function readNestedString(
  value: unknown,
  path: readonly string[],
): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return readString(current);
}

function readActiveProvider(input: StartupGateRuntimeInput): string | undefined {
  const sessionProvider =
    readNestedString(input.session, ["services", "provider", "name"]) ??
    readNestedString(input.session, ["sessionConfiguration", "provider", "name"]);
  const configProvider = readNestedString(input.config, ["model_provider"]);
  return normalizeProvider(sessionProvider ?? configProvider);
}

function readProjectTrust(input: StartupGateRuntimeInput): string | undefined {
  const direct =
    readNestedString(input.session, ["projectTrust"]) ??
    readNestedString(input.config, ["project_trust"]);
  if (direct) return direct;

  const current = readPath(input.session, ["services", "projectTrust", "current"]);
  if (typeof current !== "function") return undefined;
  try {
    return readString(current());
  } catch {
    return undefined;
  }
}

function readProviderFactoryApiKey(session: unknown): string | undefined {
  const provider = readPath(session, ["services", "provider"]);
  const providerRecord = asRecord(provider);
  if (!providerRecord) return undefined;
  const markedState = asRecord(
    (provider as { readonly [key: symbol]: unknown })[
      Symbol.for("agenc.factoryProviderState")
    ],
  );
  const markedApiKey = readNestedString(markedState, ["options", "apiKey"]);
  return (
    markedApiKey ??
    readNestedString(providerRecord, ["config", "apiKey"]) ??
    readNestedString(providerRecord, ["options", "apiKey"])
  );
}

function readSessionAuthMode(input: StartupGateRuntimeInput): string | undefined {
  return (
    readNestedString(input.session, ["authManager", "mode"]) ??
    readNestedString(input.session, ["services", "authManager", "mode"])
  );
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function readConfigProviderApiKey(
  provider: string,
  config: unknown,
  env: EnvSnapshot,
): string | undefined {
  const configuredEnvKey = readNestedString(config, [
    "providers",
    provider,
    "api_key_env",
  ]);
  if (configuredEnvKey) {
    const value = readString(env[configuredEnvKey]);
    if (value) return value;
  }

  for (const key of PROVIDER_ENV_KEYS[provider] ?? []) {
    const value = readString(env[key]);
    if (value) return value;
  }
  return undefined;
}

function deriveTrustGate(input: StartupGateRuntimeInput): StartupGateState {
  const trust = readProjectTrust(input);
  if (trust === "trusted") return "cleared";
  if (trust === "untrusted") return "blocked";
  return "omitted";
}

function deriveApiKeyGate(input: StartupGateRuntimeInput): StartupGateState {
  const provider = readActiveProvider(input);
  if (!provider) return "omitted";
  if (PROVIDERS_WITH_OPTIONAL_LOCAL_AUTH.has(provider)) return "cleared";

  const env = input.env ?? process.env;
  const apiKey =
    readProviderFactoryApiKey(input.session) ??
    readConfigProviderApiKey(provider, input.config, env);
  if (apiKey) return "cleared";
  if (readSessionAuthMode(input) === "oauth") return "cleared";

  return PROVIDERS_REQUIRING_API_KEY.has(provider) ? "blocked" : "omitted";
}

function isKnownApprovalPolicy(value: unknown): boolean {
  return (
    value === "never" ||
    value === "on_failure" ||
    value === "on_request" ||
    value === "granular" ||
    value === "untrusted" ||
    value === "on-failure" ||
    value === "on-request"
  );
}

function derivePolicyGate(input: StartupGateRuntimeInput): StartupGateState {
  if (input.configError !== undefined) return "blocked";

  const sessionPolicy = readNestedString(input.session, [
    "sessionConfiguration",
    "approvalPolicy",
    "value",
  ]);
  if (isKnownApprovalPolicy(sessionPolicy)) return "cleared";

  const configPolicy = readNestedString(input.config, ["approval_policy"]);
  if (configPolicy === undefined || isKnownApprovalPolicy(configPolicy)) {
    return input.config !== undefined ? "cleared" : "omitted";
  }
  return "blocked";
}

export function deriveStartupGatesFromRuntime(
  input: StartupGateRuntimeInput,
): StartupGatesSnapshot {
  return {
    trust: deriveTrustGate(input),
    apiKey: deriveApiKeyGate(input),
    policy: derivePolicyGate(input),
  };
}
