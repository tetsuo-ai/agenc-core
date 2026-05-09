import type { Tool, ToolResult } from "../../tools/types.js";
import type { Session } from "../../session/session.js";
import type { ReasoningEffort } from "../../session/turn-context.js";
import { delegate } from "../delegate.js";
import type { ForkMode } from "../fork-context.js";
import type { AgentThread } from "../thread.js";
import { assertValidAgentName } from "../registry.js";
import { requireAgentRole } from "../role.js";
import { canonicalAgentRoleName, formatAgentRoleLabel } from "../role-presentation.js";
import {
  BackgroundTaskError,
  backgroundTaskLifecycle,
  registerAgentThreadTask,
} from "../../tasks/index.js";
import {
  callIdFromArgs,
  currentAgentContext,
  currentAgentDepth,
  emit,
  getSessionOrError,
  hideSpawnAgentMetadata,
  json,
  recordAgentCounter,
  resolveSessionMaxAgentDepth,
  strictArgs,
  stringValue,
  toolMetadata,
  type MultiAgentV2Options,
} from "./common.js";

const SPAWN_AGENT_INHERITED_MODEL_GUIDANCE =
  "Spawned agents inherit your current model by default. Omit `model` to use that preferred default; set `model` only when an explicit override is needed.";

function buildSpawnAgentDescription(session: Session | null): string {
  const base = `Spawns an agent to work on the specified task.

NOTE ON AGENT-PATH NAMES: \`/root\`-prefixed names below refer to the
internal AGENT-TREE NAMESPACE, NOT to the filesystem. They are agent
identifiers (the root agent is named "/root", its children are
"/root/<task_name>", and so on). The filesystem working directory comes
from the Environment section of this prompt — never assume "/root" or
"/root/<x>" is a real directory.

If your current task is \`/root/task1\` and you spawn_agent with task_name "task_3" the agent will have canonical task name \`/root/task1/task_3\`.
You are then able to refer to this agent as \`task_3\` or \`/root/task1/task_3\` interchangeably. However an agent \`/root/task2/task_3\` would only be able to communicate with this agent via its canonical name \`/root/task1/task_3\`.
The spawned agent will have the same tools as you and the ability to spawn its own subagents.
${SPAWN_AGENT_INHERITED_MODEL_GUIDANCE}
It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.
The new agent's canonical task name will be provided to it along with the message.`;
  const cfg = session?.config?.multiAgentV2;
  const concurrency =
    cfg?.maxConcurrentThreadsPerSession !== undefined
      ? `\nThis session is configured with \`max_concurrent_threads_per_session = ${cfg.maxConcurrentThreadsPerSession}\` for concurrently open agent threads.`
      : "";
  let result = `${base}${concurrency}`;
  if (cfg?.usageHintEnabled && cfg.usageHintText) {
    result = `${result}\n${cfg.usageHintText}`;
  }
  return result;
}

function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "none"
  ) {
    return value;
  }
  return undefined;
}

function parseForkTurns(value: unknown): ToolResult | ForkMode | undefined {
  const raw = value === undefined ? "all" : value;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase() === "none") return undefined;
    if (trimmed.toLowerCase() === "all") return { kind: "full_history" };
    const parsed = Number.parseInt(trimmed, 10);
    if (String(parsed) === trimmed && parsed > 0) {
      return { kind: "last_n_turns", n: parsed };
    }
  }
  return json(
    { error: "fork_turns must be `none`, `all`, or a positive integer string" },
    true,
  );
}

async function validateSpawnModelOverrides(opts: {
  readonly session: Session;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}): Promise<ToolResult | null> {
  if (opts.model === undefined && opts.reasoningEffort === undefined) {
    return null;
  }
  const modelsManager = opts.session.services.modelsManager;
  const currentModel = opts.session.modelInfo.slug;
  const model = opts.model ?? currentModel;
  if (opts.model !== undefined) {
    const listed =
      modelsManager.tryListModels() ?? (await modelsManager.listModels());
    if (!listed.some((candidate) => candidate.slug === opts.model)) {
      const available = listed.map((candidate) => candidate.slug).join(", ");
      return json(
        {
          error: `Unknown model \`${opts.model}\` for spawn_agent. Available models: ${available}`,
        },
        true,
      );
    }
  }
  if (
    opts.reasoningEffort !== undefined &&
    opts.reasoningEffort !== "none"
  ) {
    const modelInfo =
      opts.model === undefined
        ? opts.session.modelInfo
        : await modelsManager.getModelInfo(model);
    if (!modelInfo.supportedReasoningLevels.includes(opts.reasoningEffort)) {
      const supported = modelInfo.supportedReasoningLevels.join(", ");
      return json(
        {
          error: `Reasoning effort \`${opts.reasoningEffort}\` is not supported for model \`${model}\`. Supported reasoning efforts: ${supported}`,
        },
        true,
      );
    }
  }
  return null;
}

export function createSpawnAgentTool(opts: MultiAgentV2Options): Tool {
  const spawnAgentSchema = {
    type: "object",
    properties: {
      message: { type: "string" },
      task_name: { type: "string" },
      agent_type: {
        type: "string",
        description:
          "Optional role name. Accepts any registered built-in or user-defined role; defaults to `default` when omitted.",
      },
      model: { type: "string" },
      reasoning_effort: { type: "string" },
      fork_turns: { type: "string" },
    },
    required: ["message", "task_name"],
    additionalProperties: false,
  };

  const execute = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const session = sessionOrError;
    const strict = strictArgs(args, {
      allowed: new Set([
        "message",
        "task_name",
        "agent_type",
        "model",
        "reasoning_effort",
        "fork_turns",
        "fork_context",
      ]),
      required: ["message", "task_name"],
    });
    if (strict) return strict;
    for (const key of [
      "message",
      "task_name",
      "agent_type",
      "model",
      "reasoning_effort",
      "fork_turns",
    ]) {
      if (args[key] !== undefined && typeof args[key] !== "string") {
        return json({ error: `${key} must be a string` }, true);
      }
    }
    if (
      args.fork_context !== undefined &&
      typeof args.fork_context !== "boolean"
    ) {
      return json({ error: "fork_context must be a boolean" }, true);
    }
    const prompt = stringValue(args.message);
    if (!prompt || prompt.trim().length === 0) {
      return json({ error: "message is required" }, true);
    }
    if (args.fork_context !== undefined) {
      return json(
        { error: "fork_context is not supported in MultiAgentV2; use fork_turns instead" },
        true,
      );
    }
    const { control, registry } = opts.ensureAgentControl(session);
    const current = currentAgentContext(session, args, opts);
    const rawRole = stringValue(args.agent_type);
    const role =
      rawRole !== undefined ? canonicalAgentRoleName(rawRole) : undefined;
    const model = stringValue(args.model);
    const rawReasoningEffort = args.reasoning_effort;
    const reasoningEffort = parseReasoningEffort(rawReasoningEffort);
    if (rawReasoningEffort !== undefined && reasoningEffort === undefined) {
      return json({ error: "invalid reasoning_effort" }, true);
    }
    const forkMode = parseForkTurns(args.fork_turns);
    if (forkMode !== undefined && "content" in forkMode) return forkMode;
    if (
      forkMode?.kind === "full_history" &&
      (role !== undefined || model !== undefined || reasoningEffort !== undefined)
    ) {
      return json(
        {
          error:
            "Full-history forked agents inherit the parent agent type, model, and reasoning effort; omit agent_type, model, and reasoning_effort, or spawn without a full-history fork.",
        },
        true,
      );
    }
    try {
      if (role !== undefined) requireAgentRole(role);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
    const overrideError = await validateSpawnModelOverrides({
      session,
      ...(model !== undefined ? { model } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });
    if (overrideError) return overrideError;
    const taskName = stringValue(args.task_name);
    if (!taskName) {
      return json({ error: "task_name is required" }, true);
    }
    try {
      assertValidAgentName(taskName);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
    const childDepth = currentAgentDepth(session, current, opts) + 1;
    const maxDepth = resolveSessionMaxAgentDepth(session);
    if (childDepth > maxDepth) {
      return json(
        { error: "Agent depth limit reached. Solve the task yourself." },
        true,
      );
    }
    const callId = callIdFromArgs(args, "agent");

    emit(session, {
      type: "collab_agent_spawn_begin",
      payload: {
        callId,
        senderThreadId: current.threadId,
        prompt,
        model: model ?? session.sessionConfiguration.collaborationMode.model,
        reasoningEffort:
          reasoningEffort ??
          session.sessionConfiguration.collaborationMode.reasoningEffort,
      },
    });

    let thread: AgentThread | undefined;
    try {
      const outcome = await delegate({
        parent: session,
        parentPath: current.agentPath,
        control,
        registry,
        taskPrompt: prompt,
        agentName: taskName,
        ...(forkMode !== undefined ? { forkMode } : {}),
        runInBackground: true,
        ...(role !== undefined ? { role } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      });
      if (outcome.kind === "rejected") {
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
          model: model ?? session.sessionConfiguration.collaborationMode.model,
          reasoningEffort:
            reasoningEffort ??
            session.sessionConfiguration.collaborationMode.reasoningEffort,
          status: {
            status: "errored",
            turnId: callId,
            endedAtMs: Date.now(),
            error: reason,
          },
        },
      });
      return json({ error: reason }, true);
    }
    if (thread === undefined) {
      return json({ error: "spawn_agent did not return an agent thread" }, true);
    }
    try {
      registerAgentThreadTask(backgroundTaskLifecycle, thread, {
        toolUseId: callId,
        description: prompt,
      });
    } catch (error) {
      if (
        !(error instanceof BackgroundTaskError) ||
        error.code !== "already_exists"
      ) {
        throw error;
      }
    }
    const live = thread.live;
    emit(session, {
      type: "collab_agent_spawn_end",
      payload: {
        callId,
        senderThreadId: current.threadId,
        newThreadId: live.agentId,
        newAgentNickname: live.nickname,
        newAgentRole: live.role.name,
        newAgentRoleDisplayName: formatAgentRoleLabel(live.role.name),
        prompt,
        model: model ?? session.sessionConfiguration.collaborationMode.model,
        reasoningEffort:
          reasoningEffort ??
          session.sessionConfiguration.collaborationMode.reasoningEffort,
        status: live.status.value,
      },
    });
    recordAgentCounter(session, "agenc.multi_agent.spawn", [
      ["role", live.role.name],
    ]);

    return json({
      task_name: live.agentPath,
      ...(!hideSpawnAgentMetadata(session)
        ? { nickname: live.nickname ?? null }
        : {}),
    });
  };

  return {
    name: "spawn_agent",
    description: buildSpawnAgentDescription(opts.getSession()),
    metadata: toolMetadata("agent", {
      mutating: true,
      keywords: ["agent", "spawn", "delegate", "subagent"],
    }),
    requiresApproval: true,
    recoveryCategory: "side-effecting",
    inputSchema: spawnAgentSchema,
    execute,
  };
}
