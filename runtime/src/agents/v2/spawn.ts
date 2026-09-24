import {
  safeStringify,
  type Tool,
  type ToolResult,
} from "../../tools/types.js";
import { validationErrorToolResult } from "../../tools/results.js";
import {
  DEADLINE_RESERVE_SPAWN_REFUSAL,
  inDeadlineReserve,
} from "../../session/run-deadline.js";
import type { Session } from "../../session/session.js";
import { SESSION_BOUND_TOOL_SURFACE } from "../../tools/session-bound-surface.js";
import type { ModelInfo, ReasoningEffort } from "../../session/turn-context.js";
import { delegate } from "../delegate.js";
import { terminalFromAgentStatus } from "../status.js";
import { liveAgentSession } from "../live-session.js";
import { READ_ONLY_DELEGATION_PROMPT, sessionIsPlanning, sessionReadOnlyDelegation } from "../readonly-delegation.js";
import type { ForkMode } from "../fork-context.js";
import type { AgentThread } from "../thread.js";
import {
  allowedChildPairs,
  createChildExecutionPlan,
  authorizeChildExecutionPlan,
  childModelInfo,
  childProviderPolicy,
  crossProviderConsentFromSettings,
  currentChildProvider,
  resolveChildSelection,
} from "../cross-provider.js";
import { CROSS_PROVIDER_AUTH_DESCRIPTION } from "../../llm/cross-provider-auth.js";
import { resolveBuiltInProviderSlug } from "../../llm/registry/provider-info.js";
import {
  assertValidAgentName,
  depthOfAgentPath,
  joinAgentPath,
} from "../registry.js";
import { deriveAgentWorktreeSlug } from "../worktree.js";
import {
  assertAgentRoleWorkspaceMatches,
  formatRoleList,
  listAgentRoles,
  type AgentRole,
} from "../role.js";
import {
  formatAgentRoleLabel,
  formatAgentRolePublicName,
} from "../role-presentation.js";
import {
  BackgroundTaskError,
  backgroundTaskLifecycleForSession,
  observeAgentThreadTask,
  registerAgentThreadTask,
  isTerminalTaskStatus,
  type BackgroundTaskSnapshot,
} from "../../tasks/index.js";
import { syncBackgroundTaskSnapshotToAppState } from "../../tasks/app-state-bridge.js";
import {
  callIdFromArgs,
  currentAgentContext,
  emit,
  getSessionOrError,
  hideSpawnAgentMetadata,
  isCurrentAgentContextError,
  json,
  localZeroAdmissionEstimate,
  strictArgs,
  stringValue,
  toolMetadata,
  type MultiAgentV2Options,
  agentValidationError,
} from "./common.js";

const SPAWN_AGENT_INHERITED_MODEL_GUIDANCE =
  "Spawned agents inherit your current model by default. Omit `model` to use that preferred default; set `model` only when an explicit override is needed.";

/** Status projection belongs to the spawning Session, not the worker lifetime. */
function ownTaskStatusProjection(session: Session): {
  readonly active: () => boolean;
  readonly own: (unsubscribe: () => void) => void;
  readonly close: () => void;
} {
  let closed = session.isShuttingDown;
  const subscriptions = new Set<() => void>();
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const unsubscribe of subscriptions) unsubscribe();
    subscriptions.clear();
  };
  const own = (unsubscribe: () => void): void => {
    // Both Session status and task observation can replay synchronously.
    if (closed) unsubscribe();
    else subscriptions.add(unsubscribe);
  };
  if (!closed) {
    try {
      own(session.onBeforeDurableClose(close));
      // A failed durable finalizer intentionally skips later finalizers.
      // The owner shutdown status still releases projection subscriptions.
      own(session.agentStatus.subscribe(() => {
        if (session.isShuttingDown) close();
      }));
    } catch (error) {
      close();
      throw error;
    }
  }
  return {
    active: () => {
      if (session.isShuttingDown) close();
      return !closed;
    },
    own,
    close,
  };
}

function buildSpawnAgentDescription(session: Session | null): string {
  const base = `Spawns an agent to work on the specified task.

NOTE ON AGENT-PATH NAMES: \`/root\`-prefixed names below refer to the
internal AGENT-TREE NAMESPACE, NOT to the filesystem. They are agent
identifiers (the root agent is named "/root", its children are
"/root/<task_name>", and so on). The filesystem working directory comes
from the Environment section of this prompt — never assume "/root" or
"/root/<x>" is a real directory.

${SPAWN_AGENT_INHERITED_MODEL_GUIDANCE}
It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.
The new agent's canonical task name will be provided to it along with the message.`;
  const cfg = session?.config?.multiAgentV2;
  const policy = session?.services == null ? undefined : childProviderPolicy(session);
  const pairs = policy?.cross_provider_enabled === true ? allowedChildPairs(session!) : [];
  const consentClause = session != null && crossProviderConsentFromSettings(session)
    ? "The user enabled them in settings, so a spawn to an allowed provider/model pair runs without asking. Once any child reports insufficient_funds, every later cross-provider spawn in this session asks the user, and a run no one can answer gets consent_unavailable."
    : "Using one asks the user for consent at the moment of use, even when enabled.";
  const pairList = pairs.map(({ provider, model }) => provider + "/" + model).join(", ") || "none";
  const allowedPairs = policy?.cross_provider_enabled === true ? ` Allowed provider/model pairs: ${pairList}.` : "";
  const policyDescription = `Cross-provider subagents are controlled by [agents] cross_provider_enabled (off by default) and allowed_providers in user config.toml. ${consentClause} If consent_denied or consent_unavailable is returned, continue the subtask yourself and do not retry the same request. If a child reports insufficient_funds, tell the user exactly what work finished and what remains, then ask before trying another provider. Never retry that child on the exhausted provider. ${CROSS_PROVIDER_AUTH_DESCRIPTION}${allowedPairs}`;
  if (sessionIsPlanning(session) || sessionReadOnlyDelegation(session) !== undefined) {
    return `${base}\n${policyDescription}\n\n${READ_ONLY_DELEGATION_PROMPT}\nDelegate bounded independent inspection tasks in parallel. Use isolation none, list_agents, wait_agent, and close_agent for your constrained workers.`;
  }
  // The delegation rules (when to delegate, how to design subtasks, what to
  // do after delegating, parallel patterns) live in the static `# Subagents`
  // system prompt section (prompts/system-prompt.ts getAgentToolSection),
  // emitted whenever this tool is in the catalog. Keeping them out of the
  // description takes about 4.8 KB out of the tool catalog of every request.
  let result = `${base}\nThe delegation rules are in the Subagents section of your instructions.`;
  if (cfg?.usageHintEnabled && cfg.usageHintText) {
    result = `${result}\n${cfg.usageHintText}`;
  }
  return `${result}\n${policyDescription}`;
}

// Every ReasoningEffort spelling parses here; whether a level applies is the
// target model's registry contract, checked in validateSpawnModelOverrides.
// `max` was missing, so an explicit max was refused for every model before
// that check, including models whose contract lists it (Claude Opus 5.5).
function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max" ||
    value === "none"
  ) {
    return value;
  }
  return undefined;
}

const SPAWN_VALIDATION_EVIDENCE_REF = "tool:agents.spawn-agent:validation";

/**
 * Return a rejected spawn preflight without poisoning the admitted mutation
 * gate. Callers must use this only before delegate() can create a child or a
 * worktree; failures at or beyond that boundary remain unknown-effect errors.
 */
function spawnValidationError(reason: string): ToolResult {
  return validationErrorToolResult(
    SPAWN_VALIDATION_EVIDENCE_REF,
    safeStringify({ error: reason }),
  );
}

function confirmedNoSpawn(result: ToolResult): ToolResult {
  return validationErrorToolResult(
    SPAWN_VALIDATION_EVIDENCE_REF,
    result.content,
  );
}

function parseForkTurns(value: unknown): ToolResult | ForkMode | undefined {
  // Default (omitted/empty): clean fork — the child starts fresh with only the
  // task directive, NOT the full parent conversation. This keeps an N-agent
  // fan-out at O(N × task) tokens instead of O(N × parentContext), and leaves
  // role/model/effort overrides available. `all` opts back into full history.
  if (value === undefined) return undefined;
  const raw = value;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.toLowerCase() === "none") return undefined;
    if (trimmed.toLowerCase() === "all") return { kind: "full_history" };
    const parsed = Number.parseInt(trimmed, 10);
    if (String(parsed) === trimmed && parsed > 0) {
      return { kind: "last_n_turns", n: parsed };
    }
  }
  return spawnValidationError(
    "fork_turns must be `none`, `all`, or a positive integer string",
  );
}

function normalizeSpawnTaskName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return trimmed;
  const normalized = trimmed
    .toLowerCase()
    .replace(/[\s-]+/gu, "_")
    .replace(/[^a-z0-9_]/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized.length > 0 ? normalized : trimmed;
}

function requestsOtherProvider(
  session: Session,
  requestedProvider: string | undefined,
  requestedModel: string | undefined,
): boolean {
  const activeProvider = currentChildProvider(session).provider;
  if (requestedProvider !== undefined &&
      resolveBuiltInProviderSlug(requestedProvider) !== activeProvider) return true;
  if (!requestedModel?.includes("/")) return false;
  const isLocalModel = requestedModel === session.modelInfo.slug ||
    (session.services.modelsManager?.tryListModels() ?? []).some((candidate) =>
      candidate.slug === requestedModel &&
      (candidate.provider === undefined || candidate.provider === activeProvider));
  if (isLocalModel) return false;
  const qualified = resolveBuiltInProviderSlug(requestedModel.slice(0, requestedModel.indexOf("/")));
  return qualified !== undefined && qualified !== activeProvider;
}

/**
 * The short, human-readable title shown for a spawned agent on the rail /
 * transcript / `/cost` (the task's `description`). Derived from the validated
 * `task_name` (separators humanized) — NEVER the full prompt, which floods the
 * rail with the agent's entire instruction block. Falls back to the first line
 * of the prompt only when no task name is available, always length-bounded.
 */
export function shortAgentTaskTitle(
  taskName: string | undefined,
  prompt: string,
): string {
  const fromName = taskName?.trim().replace(/[_-]+/gu, " ").trim();
  const base =
    fromName && fromName.length > 0
      ? fromName
      : (prompt.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ??
        prompt.trim());
  return base.length > 60 ? `${base.slice(0, 59).trimEnd()}…` : base;
}

function serviceTierIds(modelInfo: ModelInfo): readonly string[] {
  return (modelInfo.serviceTiers ?? []).map((tier) => tier.id);
}

function modelSupportsServiceTier(
  modelInfo: ModelInfo,
  serviceTier: string,
): boolean {
  return serviceTierIds(modelInfo).includes(serviceTier);
}

function formatSupportedServiceTiers(modelInfo: ModelInfo): string {
  const supported = serviceTierIds(modelInfo);
  return supported.length > 0 ? supported.join(", ") : "none";
}

function validateCrossProviderModelOverrides(opts: {
  readonly modelInfo: ModelInfo;
  readonly reasoningEffort?: ReasoningEffort;
}): ToolResult | null {
  if (
    opts.reasoningEffort !== undefined &&
    opts.reasoningEffort !== "none"
  ) {
    const modelInfo = opts.modelInfo;
    if (!modelInfo.supportedReasoningLevels.includes(opts.reasoningEffort)) {
      const supported = modelInfo.supportedReasoningLevels.join(", ");
      return agentValidationError(
        `Reasoning effort \`${opts.reasoningEffort}\` is not supported for model \`${modelInfo.slug}\`. Supported reasoning efforts: ${supported}`,
      );
    }
  }
  return null;
}

async function validateSpawnModelOverrides(opts: {
  readonly session: Session;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}): Promise<ToolResult | null> {
  if (opts.model === undefined && opts.reasoningEffort === undefined) return null;
  const modelsManager = opts.session.services.modelsManager;
  const model = opts.model ?? opts.session.modelInfo.slug;
  if (opts.model !== undefined) {
    const listed = modelsManager.tryListModels() ?? await modelsManager.listModels();
    if (!listed.some((candidate) => candidate.slug === opts.model)) {
      return agentValidationError(
        `Unknown model \`${opts.model}\` for spawn_agent. Available models: ${listed.map((candidate) => candidate.slug).join(", ")}`,
      );
    }
  }
  if (opts.reasoningEffort !== undefined && opts.reasoningEffort !== "none") {
    const modelInfo = opts.model === undefined
      ? opts.session.modelInfo : await modelsManager.getModelInfo(model);
    if (!modelInfo.supportedReasoningLevels.includes(opts.reasoningEffort)) {
      return agentValidationError(
        `Reasoning effort \`${opts.reasoningEffort}\` is not supported for model \`${model}\`. Supported reasoning efforts: ${modelInfo.supportedReasoningLevels.join(", ")}`,
      );
    }
  }
  return null;
}

async function resolveSameProviderServiceTier(opts: {
  readonly session: Session;
  readonly model?: string;
  readonly localModelInfo?: ModelInfo;
  readonly requestedServiceTier?: string;
  readonly roleServiceTier?: string;
}): Promise<{ readonly serviceTier?: string } | ToolResult> {
  const parentServiceTier = opts.session.sessionConfiguration.serviceTier;
  if (opts.requestedServiceTier === undefined && opts.roleServiceTier === undefined && parentServiceTier === undefined) return {};
  const model = opts.model ?? opts.session.sessionConfiguration.collaborationMode.model ?? opts.session.modelInfo.slug;
  if (!model) return agentValidationError("spawn_agent could not resolve the child model for service tier validation");
  const modelInfo = opts.localModelInfo ?? (model === opts.session.modelInfo.slug
    ? opts.session.modelInfo : await opts.session.services.modelsManager.getModelInfo(model));
  if (opts.requestedServiceTier !== undefined && !modelSupportsServiceTier(modelInfo, opts.requestedServiceTier)) {
    return agentValidationError(
      `Service tier \`${opts.requestedServiceTier}\` is not supported for model \`${model}\`. Supported service tiers: ${formatSupportedServiceTiers(modelInfo)}`,
    );
  }
  for (const candidate of [opts.roleServiceTier, opts.requestedServiceTier, parentServiceTier]) {
    if (candidate !== undefined && modelSupportsServiceTier(modelInfo, candidate)) return { serviceTier: candidate };
  }
  return {};
}

function resolveCrossProviderServiceTier(opts: {
  readonly session: Session;
  readonly modelInfo: ModelInfo;
  readonly crossProvider: boolean;
  readonly requestedServiceTier?: string;
  readonly roleServiceTier?: string;
}): { readonly serviceTier?: string } | ToolResult {
  const parentServiceTier = opts.session.sessionConfiguration.serviceTier;
  if (
    opts.requestedServiceTier === undefined &&
    opts.roleServiceTier === undefined &&
    parentServiceTier === undefined
  ) {
    return {};
  }
  const modelInfo = opts.modelInfo;
  const model = modelInfo.slug;
  if (
    opts.requestedServiceTier !== undefined &&
    !modelSupportsServiceTier(modelInfo, opts.requestedServiceTier)
  ) {
    return agentValidationError(
      `Service tier \`${opts.requestedServiceTier}\` is not supported for model \`${model}\`. Supported service tiers: ${formatSupportedServiceTiers(modelInfo)}`,
    );
  }
  if (opts.roleServiceTier !== undefined &&
      !modelSupportsServiceTier(modelInfo, opts.roleServiceTier)) {
    return agentValidationError(
      `Role service tier \`${opts.roleServiceTier}\` is not supported for model \`${model}\`. Supported service tiers: ${formatSupportedServiceTiers(modelInfo)}`,
    );
  }
  for (const candidate of [
    opts.roleServiceTier,
    opts.requestedServiceTier,
    ...(opts.crossProvider ? [] : [parentServiceTier]),
  ]) {
    if (
      candidate !== undefined &&
      modelSupportsServiceTier(modelInfo, candidate)
    ) {
      return { serviceTier: candidate };
    }
  }
  return {};
}

function buildSpawnModelSchema(
  session: Session | null,
): Record<string, unknown> {
  const currentSlug = session?.modelInfo?.slug;
  const slugs = session == null ? undefined : [
    ...(session.services?.modelsManager?.tryListModels() ?? [])
      .filter((candidate) => candidate.provider === undefined || candidate.provider === currentChildProvider(session).provider)
      .map((candidate) => candidate.slug),
    ...(session.services == null ? [] : allowedChildPairs(session).map(({ provider, model }) => `${provider}/${model}`)),
  ];
  const inheritClause = currentSlug
    ? `omit to inherit the parent's current model (\`${currentSlug}\`)`
    : "omit to inherit the parent's current model";
  if (slugs && slugs.length > 0) {
    const uniqueSlugs = [...new Set(slugs)];
    return {
      type: "string",
      enum: uniqueSlugs,
      description:
        `Optional model override; ${inheritClause}. ` +
        `If set, use a model from the active provider or an allowed qualified provider/model pair: ${uniqueSlugs.join(", ")}. ` +
        "Do not use cross-provider aliases like sonnet/opus/haiku.",
    };
  }
  return {
    type: "string",
    description:
      `Optional model override; ${inheritClause}. ` +
      "If set, it must be one of the active provider's model slugs. " +
      "When cross-provider spawning is enabled, use provider/model for another provider. Do not use cross-provider aliases like sonnet/opus/haiku.",
  };
}

function roleModel(role: AgentRole | undefined): string | undefined {
  return role?.config.model;
}

function roleReasoningEffort(
  role: AgentRole | undefined,
): ReasoningEffort | undefined {
  return role?.config.reasoningEffort;
}

function roleServiceTier(role: AgentRole | undefined): string | undefined {
  return role?.config.serviceTier;
}

function buildSpawnAgentSchema(opts: MultiAgentV2Options, session = opts.getSession()): Record<string, unknown> {
  const workspaceRoles = opts.roleCatalog?.list() ?? (
    session === null
      ? listAgentRoles(opts.workspace)
      : opts.ensureAgentControl(session).control.roleCatalog.list()
  );
  const roleNames = [...new Set(
    workspaceRoles.flatMap((role) => [
      formatAgentRolePublicName(role.name) ?? role.name,
      role.name,
    ]),
  )].sort();
  return {
    type: "object",
    properties: {
      message: {
        type: "string",
        description:
          "REQUIRED. The complete task prompt for the spawned agent: the overall goal, the files it owns, local conventions it must follow, and how to verify its work. The agent sees only this message (plus any forked turns) — never assume it has context you did not include. A call without `message` is rejected.",
      },
      task_name: {
        type: "string",
        description:
          "Task name for the new agent. Lowercase letters, digits, and underscores are canonical; hyphens and spaces are accepted and normalized to underscores.",
      },
      agent_type: {
        type: "string",
        enum: roleNames,
        description:
          [
            formatRoleList(workspaceRoles),
            "Use only a listed role name. For implementation, edits, or tests use `runner`. For codebase reconnaissance use `scanner`. Omit this field for a general `netrunner` fork. Do not invent role names such as `code-implementer` or `reviewer` unless they are listed here.",
          ].join("\n\n"),
      },
      model: buildSpawnModelSchema(session),
      provider: {
        type: "string",
        description: "Optional provider for the child model. Cross-provider choices require [agents] cross_provider_enabled and an allowed provider/model pair.",
      },
      reasoning_effort: { type: "string" },
      service_tier: { type: "string" },
      tool_free: {
        type: "boolean",
        description: "Run this child with no client-side tools. Required when selecting a model without client-side tool calling.",
      },
      fork_turns: {
        type: "string",
        description:
          "Optional number of turns to fork. Omit (or use `none`) for the default clean fork. Use `all` for full history, or a positive integer string such as `3` for only the most recent turns.",
      },
      isolation: {
        type: "string",
        enum: ["none", "worktree"],
        description:
          "Optional filesystem isolation. `worktree` runs the agent in its own git worktree (branch + directory derived from its session-scoped full agent identity and this spawn), so parallel agents that WRITE files never clobber each other or your working tree and a later logical respawn cannot inherit retained state. Requires the cwd to be inside a git repository. Unchanged newly created worktrees are removed automatically when the agent closes; worktrees resumed within the same logical spawn and worktrees with commits or dirty files are kept for review. Default `none` (shared cwd).",
      },
    },
    required: ["message", "task_name"],
    additionalProperties: false,
  };
}

export function createSpawnAgentTool(opts: MultiAgentV2Options): Tool {
  const preflight: NonNullable<Tool["preflight"]> = (args) => {
    for (const key of ["message", "task_name"]) {
      if (typeof args[key] !== "string" || args[key].trim().length === 0) {
        return { code: `missing-${key}`, message: `${key} is required` };
      }
    }
    return null;
  };
  const execute = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const preflightFailure = preflight(args);
    if (preflightFailure !== null) return spawnValidationError(preflightFailure.message);
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) {
      return confirmedNoSpawn(sessionOrError);
    }
    const rootSession = sessionOrError;
    // A run in its deadline reserve (#2503) finishes with what it has.
    if (inDeadlineReserve(rootSession)) {
      return spawnValidationError(DEADLINE_RESERVE_SPAWN_REFUSAL);
    }
    const strict = strictArgs(args, {
      allowed: new Set([
        "message",
        "task_name",
        "agent_type",
        "model",
        "provider",
        "reasoning_effort",
        "service_tier",
        "tool_free",
        "fork_turns",
        "fork_context",
        "isolation",
      ]),
      required: ["message", "task_name"],
    });
    if (strict) return confirmedNoSpawn(strict);
    for (const key of [
      "message",
      "task_name",
      "agent_type",
      "model",
      "provider",
      "reasoning_effort",
      "service_tier",
      "fork_turns",
      "isolation",
    ]) {
      if (args[key] !== undefined && typeof args[key] !== "string") {
        return spawnValidationError(`${key} must be a string`);
      }
    }
    if (
      args.fork_context !== undefined &&
      typeof args.fork_context !== "boolean"
    ) {
      return spawnValidationError("fork_context must be a boolean");
    }
    if (args.tool_free !== undefined && typeof args.tool_free !== "boolean") {
      return spawnValidationError("tool_free must be a boolean");
    }
    const prompt = stringValue(args.message);
    if (!prompt || prompt.trim().length === 0) {
      return spawnValidationError("message is required");
    }
    if (args.fork_context !== undefined) {
      return spawnValidationError(
        "fork_context is not supported in MultiAgentV2; use fork_turns instead",
      );
    }
    try {
      assertAgentRoleWorkspaceMatches(
        rootSession.roleWorkspace,
        opts.workspace.id,
      );
    } catch (error) {
      return spawnValidationError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const { control, registry } = opts.ensureAgentControl(rootSession);
    try {
      control.assertRoleWorkspace(opts.workspace);
    } catch (error) {
      return spawnValidationError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const current = currentAgentContext(rootSession, args, opts);
    if (isCurrentAgentContextError(current)) return confirmedNoSpawn(current);
    const caller = current.threadId === rootSession.conversationId
      ? undefined : control.getLive(current.threadId);
    const inheritedConsentPlan = caller?.metadata?.executionPlan;
    const session = current.threadId === rootSession.conversationId
      ? rootSession : caller === undefined ? undefined : liveAgentSession(caller);
    const callerIsCurrent = (): boolean => session !== undefined &&
      (caller === undefined
        ? session === rootSession
        : control.getLive(current.threadId) === caller &&
          caller.agentId === current.threadId && caller.agentPath === current.agentPath &&
          liveAgentSession(caller) === session);
    if (session === undefined || !callerIsCurrent()) {
      return spawnValidationError("invalid-runtime-identity: calling agent session is not live");
    }
    try {
      assertAgentRoleWorkspaceMatches(session.roleWorkspace, opts.workspace.id);
    } catch (error) {
      return spawnValidationError(error instanceof Error ? error.message : String(error));
    }
    const rawRole = stringValue(args.agent_type);
    // The session catalog performs exact-name lookup before public alias
    // fallback. Canonicalizing here would make an executable plugin/workspace
    // definition whose exact name is also a built-in alias disappear.
    const role = rawRole;
    const model = stringValue(args.model);
    const requestedProvider = stringValue(args.provider);
    const rawReasoningEffort = stringValue(args.reasoning_effort);
    const reasoningEffort = parseReasoningEffort(rawReasoningEffort);
    if (rawReasoningEffort !== undefined && reasoningEffort === undefined) {
      return spawnValidationError("invalid reasoning_effort");
    }
    const rawTaskName = stringValue(args.task_name);
    const taskName = normalizeSpawnTaskName(rawTaskName);
    const forkMode = parseForkTurns(args.fork_turns);
    if (forkMode !== undefined && "content" in forkMode) return forkMode;
    if (forkMode?.kind === "full_history" &&
        (role !== undefined || model !== undefined || reasoningEffort !== undefined) &&
        !requestsOtherProvider(session, requestedProvider, model)) {
      return spawnValidationError(
        "Full-history forked agents inherit the parent agent type, model, and reasoning effort; omit agent_type, model, and reasoning_effort, or spawn without a full-history fork.",
      );
    }
    const rawIsolation = stringValue(args.isolation);
    if (
      rawIsolation !== undefined &&
      rawIsolation !== "none" &&
      rawIsolation !== "worktree"
    ) {
      return spawnValidationError("isolation must be `none` or `worktree`");
    }
    const isolation = rawIsolation === "worktree" ? ("worktree" as const) : undefined;
    if (isolation !== undefined && (!taskName || taskName.length === 0)) {
      return spawnValidationError(
        "worktree isolation requires a non-empty task_name (it identifies the agent worktree)",
      );
    }
    const requestedServiceTier = stringValue(args.service_tier);
    const callId = callIdFromArgs(args, "agent");
    const activeProvider = currentChildProvider(session).provider;
    let reportedProvider = requestedProvider ?? activeProvider;
    let reportedModel = model ?? session.sessionConfiguration.collaborationMode.model;
    let reportedEffort = reasoningEffort ?? session.sessionConfiguration.collaborationMode.reasoningEffort;

    let begun = false;
    const emitSpawnBegin = (): void => {
      if (begun) return;
      begun = true;
      emit(session, {
        type: "collab_agent_spawn_begin",
        payload: {
          callId, senderThreadId: current.threadId, prompt, taskName,
          agentType: role, model: reportedModel,
          ...(crossProviderRequested ? { provider: reportedProvider } : {}),
          reasoningEffort: reportedEffort,
        },
      });
    };

    const emitSpawnFailureEnd = (reason: string): void => {
      emitSpawnBegin();
      emit(session, {
        type: "collab_agent_spawn_end",
        payload: {
          callId,
          senderThreadId: current.threadId,
          prompt,
          taskName,
          agentType: role,
          model: reportedModel,
          ...(crossProviderRequested ? { provider: reportedProvider } : {}),
          reasoningEffort: reportedEffort,
          status: {
            status: "errored",
            turnId: callId,
            endedAtMs: Date.now(),
            error: reason,
          },
        },
      });
    };
    const failSpawn = (reason: string): ToolResult => {
      emitSpawnFailureEnd(reason);
      return spawnValidationError(reason);
    };
    let crossProviderRequested = requestsOtherProvider(session, requestedProvider, model);
    // Main's lifecycle begins before role and model validation for local spawns.
    let resolvedRole: AgentRole | undefined;
    try {
      if (role !== undefined) {
        resolvedRole = control.roleCatalog.require(role);
      }
    } catch (error) {
      return failSpawn(error instanceof Error ? error.message : String(error));
    }
    const roleConfiguredModel = roleModel(resolvedRole);
    const roleConfiguredReasoningEffort = roleReasoningEffort(resolvedRole);
    const roleConfiguredServiceTier = roleServiceTier(resolvedRole);
    const effectiveModel = roleConfiguredModel ?? model;
    const effectiveReasoningEffort = roleConfiguredReasoningEffort ?? reasoningEffort;
    if (!crossProviderRequested) crossProviderRequested = requestsOtherProvider(session, requestedProvider, effectiveModel);
    const provenancedDescendant = !crossProviderRequested && inheritedConsentPlan?.crossProvider === true;
    if (!crossProviderRequested) emitSpawnBegin();
    const overrideReason = (result: ToolResult): string => {
      try {
        const parsed = JSON.parse(result.content) as { error?: unknown };
        return typeof parsed.error === "string" ? parsed.error : result.content;
      } catch {
        return result.content;
      }
    };
    let selection: Awaited<ReturnType<typeof resolveChildSelection>> | undefined;
    let targetModelInfo: ModelInfo | undefined;
    let selectedReasoningEffort: ReasoningEffort | undefined;
    let serviceTierResult: { readonly serviceTier?: string } | ToolResult;
    if (crossProviderRequested) {
      try {
        selection = await resolveChildSelection(session, requestedProvider, effectiveModel);
        reportedProvider = selection.provider;
        reportedModel = selection.model;
        if (forkMode !== undefined) return failSpawn("Cross-provider subagents require fork_turns = none. Omit fork_turns or set it to none.");
        targetModelInfo = await childModelInfo(session, selection);
      } catch (error) {
        return failSpawn(error instanceof Error ? error.message : String(error));
      }
      if (targetModelInfo.supportsToolUse === false && args.tool_free !== true) {
        return failSpawn(`Model \`${selection.provider}/${selection.model}\` does not support client-side tool calling. Set tool_free = true for an explicitly tool-free task.`);
      }
      selectedReasoningEffort = effectiveReasoningEffort ?? targetModelInfo.defaultReasoningLevel;
      reportedEffort = selectedReasoningEffort;
      const effortError = validateCrossProviderModelOverrides({ modelInfo: targetModelInfo,
        ...(selectedReasoningEffort !== undefined ? { reasoningEffort: selectedReasoningEffort } : {}) });
      if (effortError !== null) {
        emitSpawnFailureEnd(overrideReason(effortError));
        return confirmedNoSpawn(effortError);
      }
      serviceTierResult = resolveCrossProviderServiceTier({ session, modelInfo: targetModelInfo, crossProvider: true,
        ...(requestedServiceTier !== undefined ? { requestedServiceTier } : {}),
        ...(roleConfiguredServiceTier !== undefined ? { roleServiceTier: roleConfiguredServiceTier } : {}) });
    } else {
      if (provenancedDescendant) {
        try {
          selection = await resolveChildSelection(session, requestedProvider, effectiveModel);
          targetModelInfo = await childModelInfo(session, selection, true);
        } catch (error) {
          return failSpawn(error instanceof Error ? error.message : String(error));
        }
        selectedReasoningEffort = effectiveReasoningEffort ??
          session.sessionConfiguration.collaborationMode.reasoningEffort;
        const effortError = validateCrossProviderModelOverrides({ modelInfo: targetModelInfo,
          ...(selectedReasoningEffort !== undefined ? { reasoningEffort: selectedReasoningEffort } : {}) });
        if (effortError !== null) {
          emitSpawnFailureEnd(overrideReason(effortError));
          return confirmedNoSpawn(effortError);
        }
      }
      if (!provenancedDescendant) for (const overrides of [
        { model, reasoningEffort },
        ...(roleConfiguredModel !== undefined || roleConfiguredReasoningEffort !== undefined
          ? [{ model: effectiveModel, reasoningEffort: effectiveReasoningEffort }] : []),
      ]) {
        let failure: ToolResult | null;
        try { failure = await validateSpawnModelOverrides({ session, ...overrides }); }
        catch (error) { return failSpawn(error instanceof Error ? error.message : String(error)); }
        if (failure !== null) {
          emitSpawnFailureEnd(overrideReason(failure));
          return confirmedNoSpawn(failure);
        }
      }
      if (!provenancedDescendant && effectiveModel !== undefined &&
          effectiveModel !== currentChildProvider(session).model) {
        try {
          targetModelInfo = await childModelInfo(session, {
            provider: activeProvider, model: effectiveModel,
          });
        } catch (error) {
          return failSpawn(error instanceof Error ? error.message : String(error));
        }
      }
      try {
        serviceTierResult = await resolveSameProviderServiceTier({ session, model: effectiveModel,
          ...(provenancedDescendant && targetModelInfo !== undefined
            ? { localModelInfo: targetModelInfo } : {}),
          ...(requestedServiceTier !== undefined ? { requestedServiceTier } : {}),
          ...(roleConfiguredServiceTier !== undefined ? { roleServiceTier: roleConfiguredServiceTier } : {}) });
      } catch (error) { return failSpawn(error instanceof Error ? error.message : String(error)); }
    }
    if ("content" in serviceTierResult) {
      emitSpawnFailureEnd(overrideReason(serviceTierResult));
      return confirmedNoSpawn(serviceTierResult);
    }
    if (!taskName) {
      return failSpawn("task_name is required");
    }
    try {
      assertValidAgentName(taskName);
    } catch (error) {
      return failSpawn(error instanceof Error ? error.message : String(error));
    }
    // Model/tier validation can await. Never delegate using a child Session
    // that closed or was replaced while those checks were pending.
    if (!callerIsCurrent()) {
      return failSpawn("invalid-runtime-identity: calling agent session is no longer live");
    }
    let thread: AgentThread | undefined;
    let rejectedEffectDisposition: ToolResult["effectDisposition"];
    try {
      const childAgentPath = joinAgentPath(current.agentPath, taskName);
      let plan: Awaited<ReturnType<typeof createChildExecutionPlan>> | undefined;
      if (selection !== undefined && targetModelInfo !== undefined) {
        const proposedPlan = await createChildExecutionPlan({
          session, selection, modelInfo: targetModelInfo,
          parentPath: current.agentPath, taskId: callId, taskName, taskText: prompt,
          toolFree: args.tool_free === true, forkedHistory: forkMode !== undefined,
          ...(resolvedRole?.config.allowlist !== undefined
            ? { toolAllowlist: resolvedRole.config.allowlist } : {}),
          ...(selectedReasoningEffort !== undefined ? { reasoningEffort: selectedReasoningEffort } : {}),
          ...(serviceTierResult.serviceTier !== undefined ? { serviceTier: serviceTierResult.serviceTier } : {}),
          ...(inheritedConsentPlan !== undefined ? { inheritedConsentPlan } : {}),
        });
        const consent = await authorizeChildExecutionPlan(session, proposedPlan);
        if (consent.kind !== "granted") {
          emitSpawnFailureEnd(consent.reason);
          return confirmedNoSpawn(json({ code: consent.kind, error: consent.reason,
            action: "Continue this subtask yourself on the current provider; do not retry the same cross-provider request." }, true));
        }
        plan = consent.plan;
        reportedProvider = plan.destination.provider;
        reportedModel = plan.destination.model;
        reportedEffort = plan.reasoningEffort ?? reportedEffort;
        emitSpawnBegin();
      }
      const worktreeSlug =
        isolation !== undefined
          ? deriveAgentWorktreeSlug({
              sessionId: session.conversationId,
              agentPath: childAgentPath,
              spawnId: callId,
            })
          : undefined;
      const outcome = await delegate({
        parent: session,
        parentPath: current.agentPath,
        ...(caller !== undefined ? {
          assertParentSessionActive: () => {
            if (!callerIsCurrent()) throw new Error("invalid-runtime-identity: calling agent session is no longer live");
          },
        } : {}),
        control,
        registry,
        taskPrompt: prompt,
        taskId: callId,
        agentName: taskName,
        depthCap: depthOfAgentPath(current.agentPath) + 1,
        ...(forkMode !== undefined ? { forkMode } : {}),
        runInBackground: true,
        // Keep collab workers alive so assign_task after first completion
        // has a consumer (todo-106). close_agent still tears them down.
        keepAlive: true,
        ...(args.tool_free === true ? { toolAllowlist: [] } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(plan !== undefined ? { plan } : {}),
        ...(plan === undefined && effectiveModel !== undefined ? { model: effectiveModel } : {}),
        ...(plan === undefined && targetModelInfo !== undefined
          ? { modelInfo: targetModelInfo } : {}),
        ...(plan === undefined && effectiveReasoningEffort !== undefined
          ? { reasoningEffort: effectiveReasoningEffort } : {}),
        ...(plan === undefined && serviceTierResult.serviceTier !== undefined
          ? { serviceTier: serviceTierResult.serviceTier } : {}),
        ...(isolation !== undefined
          ? { isolation, worktreeSlug }
          : {}),
      });
      if (outcome.kind === "rejected") {
        rejectedEffectDisposition = outcome.effectDisposition;
        throw new Error(outcome.reason);
      }
      thread = outcome.thread;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      emit(session, {
        type: "collab_agent_spawn_end",
        payload: {
          callId,
          senderThreadId: current.threadId,
          prompt,
          taskName,
          agentType: role,
          model: reportedModel,
          ...(crossProviderRequested ? { provider: reportedProvider } : {}),
          reasoningEffort: reportedEffort,
          status: {
            status: "errored",
            turnId: callId,
            endedAtMs: Date.now(),
            error: reason,
          },
        },
      });
      return {
        ...json({ error: reason }, true),
        ...(rejectedEffectDisposition !== undefined
          ? { effectDisposition: rejectedEffectDisposition }
          : {}),
      };
    }
    if (thread === undefined) {
      return json({ error: "spawn_agent did not return an agent thread" }, true);
    }
    const live = thread.live;
    const projection = ownTaskStatusProjection(session);
    const emitTaskStatus = (snapshot: BackgroundTaskSnapshot): void => {
      if (snapshot.status === "pending" || !projection.active()) return;
      try {
        const terminal = terminalFromAgentStatus(live.status.value) ?? live.lastTaskReceipt?.terminal;
        emit(session, {
          type: "collab_agent_status",
          payload: {
            callId,
            senderThreadId: current.threadId,
            threadId: live.agentId,
            ...(live.status.timing !== undefined ? { timing: live.status.timing } : {}),
            agentPath: live.agentPath,
            agentNickname: live.nickname,
            agentRole: live.role.name,
            agentRoleDisplayName: formatAgentRoleLabel(live.role.name),
            prompt,
            model: reportedModel,
            ...(crossProviderRequested ? { provider: reportedProvider } : {}),
            reasoningEffort: reportedEffort,
            status: snapshot.status,
            // Forward the live per-agent tool-use + token counts so the fan-out
            // rail / fleet panel show real activity for collab-spawned agents
            // instead of a frozen `tools 0 tokens 0`. The snapshot's progress is
            // refreshed from the live handle by registerAgentThreadTask.
            ...(snapshot.progress?.toolUseCount !== undefined
              ? { toolUseCount: snapshot.progress.toolUseCount }
              : {}),
            ...(snapshot.progress?.tokenCount !== undefined
              ? { tokenCount: snapshot.progress.tokenCount }
              : {}),
            ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
            ...(terminal !== undefined ? { terminal } : {}),
          },
        });
      } finally {
        if (isTerminalTaskStatus(snapshot.status)) projection.close();
      }
    };
    // Tasks belong to the root session: agent paths such as
    // /root/<task_name> repeat across the sessions of one daemon.
    const lifecycle = backgroundTaskLifecycleForSession(rootSession);
    const registerTask = (registerAgentPathAlias: boolean): void => {
      registerAgentThreadTask(lifecycle, thread, {
        toolUseId: callId,
        runtimeOptions: session.services.runtimeOptions,
        // Short title (from task_name), not the full prompt — the rail /
        // transcript / `/cost` show this as the agent's label. The full prompt
        // is preserved separately on the task's `prompt` field.
        description: shortAgentTaskTitle(taskName, prompt),
        prompt,
        registerAgentPathAlias,
      });
    };
    try {
      try {
        registerTask(true);
      } catch (error) {
        if (
          !(error instanceof BackgroundTaskError) ||
          error.code !== "already_exists"
        ) {
          throw error;
        }
        // The child is already running. Another registration of this same
        // thread is fine to observe. A live task that still holds the agent
        // path, such as a stale record of a closed agent, must not leave this
        // child unregistered: register it by its id alone.
        if (lifecycle.get(thread.threadId ?? live.agentId) === undefined) {
          registerTask(false);
        }
      }
    } catch (error) {
      projection.close();
      throw error;
    }
    try {
      // The daemon may already own registration. In either case, status
      // projection has a separate subscription scoped to this Session.
      projection.own(observeAgentThreadTask(
        lifecycle,
        thread,
        (snapshot) => {
          if (!projection.active()) return;
          syncBackgroundTaskSnapshotToAppState(
            (
              session as unknown as {
                readonly appStateBridge?: {
                  readonly setAppState?: (updater: (prev: unknown) => unknown) => void;
                };
              }
            ).appStateBridge,
            snapshot,
          );
          emitTaskStatus(snapshot);
        },
      ));
      emit(session, {
        type: "collab_agent_spawn_end",
        payload: {
          callId,
          senderThreadId: current.threadId,
          newThreadId: live.agentId,
          ...(live.status.timing !== undefined ? { timing: live.status.timing } : {}),
          newAgentPath: live.agentPath,
          newAgentNickname: live.nickname,
          newAgentRole: live.role.name,
          newAgentRoleDisplayName: formatAgentRoleLabel(live.role.name),
          prompt,
          model: reportedModel,
          ...(crossProviderRequested ? { provider: reportedProvider } : {}),
          reasoningEffort: reportedEffort,
          status: live.status.value,
        },
      });
    } catch (error) {
      projection.close();
      throw error;
    }
    return json({
      task_name: live.agentPath,
      ...(crossProviderRequested ? {
        provider: reportedProvider,
        model: reportedModel,
        ...(reportedEffort !== undefined ? { reasoning_effort: reportedEffort } : {}),
      } : {}),
      ...(!hideSpawnAgentMetadata(session)
        ? { nickname: live.nickname ?? null }
        : {}),
      ...(thread.worktree !== undefined
        ? {
            isolation: "worktree",
            worktree_path: thread.worktree.path,
            worktree_branch: thread.worktree.branch,
          }
        : {}),
    });
  };

  return {
    [SESSION_BOUND_TOOL_SURFACE]: (session: Session | null) => ({
      description: buildSpawnAgentDescription(session),
      inputSchema: buildSpawnAgentSchema(opts, session),
    }),
    name: "spawn_agent",
    // Read per request: the tool is built before its session exists, and the
    // allowed cross-provider pairs follow the live config.
    get description(): string {
      return buildSpawnAgentDescription(opts.getSession());
    },
    metadata: toolMetadata("agent", {
      mutating: true,
      // Spawning mutates collaboration/runtime state, while any child file
      // writes are enforced by that child's own sandbox. Worktree paths are
      // derived and contained by the trusted worktree manager.
      virtualNoFsWrites: true,
      keywords: ["agent", "spawn", "delegate", "subagent"],
    }),
    requiresApproval: true,
    recoveryCategory: "side-effecting",
    preflight,
    admissionEstimate: localZeroAdmissionEstimate,
    get inputSchema(): Record<string, unknown> {
      return buildSpawnAgentSchema(opts);
    },
    execute,
  };
}
