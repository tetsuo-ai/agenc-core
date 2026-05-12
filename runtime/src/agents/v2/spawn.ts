import type { Tool, ToolResult } from "../../tools/types.js";
import type { Session } from "../../session/session.js";
import type { ReasoningEffort } from "../../session/turn-context.js";
import { delegate } from "../delegate.js";
import type { ForkMode } from "../fork-context.js";
import type { AgentThread } from "../thread.js";
import { assertValidAgentName, ROOT_AGENT_PATH } from "../registry.js";
import { requireAgentRole } from "../role.js";
import { canonicalAgentRoleName, formatAgentRoleLabel } from "../role-presentation.js";
import {
  BackgroundTaskError,
  backgroundTaskLifecycle,
  registerAgentThreadTask,
} from "../../tasks/index.js";
import { syncBackgroundTaskSnapshotToAppState } from "../../tasks/app-state-bridge.js";
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

const SPAWN_AGENT_DELEGATION_DISCIPLINE = `
### When to delegate vs. do the subtask yourself
- First, quickly analyze the overall user task and form a succinct high-level plan. Identify which tasks are immediate blockers on the critical path, and which tasks are sidecar tasks that are needed but can run in parallel without blocking the next local step. As part of that plan, explicitly decide what immediate task you should do locally right now. Do this planning step before delegating to agents so you do not hand off the immediate blocking task to a submodel and then waste time waiting on it.
- Use a subagent when a subtask is easy enough for it to handle and can run in parallel with your local work. Prefer delegating concrete, bounded sidecar tasks that materially advance the main task without blocking your immediate next local step.
- Do not delegate urgent blocking work when your immediate next step depends on that result. If the very next action is blocked on that task, the main rollout should usually do it locally to keep the critical path moving.
- Keep work local when the subtask is too difficult to delegate well and when it is tightly coupled, urgent, or likely to block your immediate next step.

### Designing delegated subtasks
- Subtasks must be concrete, well-defined, and self-contained.
- Delegated subtasks must materially advance the main task.
- Do not duplicate work between the main rollout and delegated subtasks.
- Avoid issuing multiple delegate calls on the same unresolved thread unless the new delegated task is genuinely different and necessary.
- Narrow the delegated ask to the concrete output you need next.
- For coding tasks, prefer delegating concrete code-change worker subtasks over read-only explorer analysis when the subagent can make a bounded patch in a clear write scope.
- When delegating coding work, instruct the submodel to edit files directly in its forked workspace and list the file paths it changed in the final answer.
- For code-edit subtasks, decompose work so each delegated task has a disjoint write set.
- The spawned agent inherits its working directory from the parent session and receives the same Environment section. Do NOT embed absolute filesystem paths from memory in the \`message\` body and do NOT invent project root paths. Refer to files relative to the cwd the spawned agent will already know.

### After you delegate
- Call wait_agent very sparingly. Only call wait_agent when you need the result immediately for the next critical-path step and you are blocked until it returns.
- Do not redo delegated subagent tasks yourself; focus on integrating results or tackling non-overlapping work.
- While the subagent is running in the background, do meaningful non-overlapping work immediately.
- Do not repeatedly wait by reflex.
- When a delegated coding task returns, quickly review the uploaded changes, then integrate or refine them.

### Parallel delegation patterns
- Run multiple independent information-seeking subtasks in parallel when you have distinct questions that can be answered independently.
- Split implementation into disjoint codebase slices and spawn multiple agents for them in parallel when the write scopes do not overlap.
- Delegate verification only when it can run in parallel with ongoing implementation and is likely to catch a concrete risk before final integration.
- The key is to find opportunities to spawn multiple independent subtasks in parallel within the same round, while ensuring each subtask is well-defined, self-contained, and materially advances the main task.`;

function buildSpawnAgentDescription(session: Session | null): string {
  const base = `Spawns an agent to work on the specified task.

NOTE ON AGENT-PATH NAMES: \`/root\`-prefixed names below refer to the
internal AGENT-TREE NAMESPACE, NOT to the filesystem. They are agent
identifiers (the root agent is named "/root", its children are
"/root/<task_name>", and so on). The filesystem working directory comes
from the Environment section of this prompt — never assume "/root" or
"/root/<x>" is a real directory.

Only the root task may call spawn_agent. Spawned agents cannot spawn additional agents.
${SPAWN_AGENT_INHERITED_MODEL_GUIDANCE}
It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.
The new agent's canonical task name will be provided to it along with the message.`;
  const cfg = session?.config?.multiAgentV2;
  let result = `${base}${SPAWN_AGENT_DELEGATION_DISCIPLINE}`;
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
      task_name: {
        type: "string",
        description:
          "Task name for the new agent. Use lowercase letters, digits, and underscores.",
      },
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

    const emitSpawnFailureEnd = (reason: string): void => {
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
    };
    const failSpawn = (reason: string): ToolResult => {
      emitSpawnFailureEnd(reason);
      return json({ error: reason }, true);
    };
    if (current.agentPath !== ROOT_AGENT_PATH) {
      return failSpawn("Subagents cannot spawn agents. Ask the main session to spawn agents.");
    }

    try {
      if (role !== undefined) requireAgentRole(role);
    } catch (error) {
      return failSpawn(error instanceof Error ? error.message : String(error));
    }
    const overrideError = await validateSpawnModelOverrides({
      session,
      ...(model !== undefined ? { model } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });
    if (overrideError) {
      const overrideReason =
        typeof overrideError.content === "string"
          ? (() => {
              try {
                const parsed = JSON.parse(overrideError.content) as {
                  error?: unknown;
                };
                return typeof parsed.error === "string"
                  ? parsed.error
                  : overrideError.content;
              } catch {
                return overrideError.content;
              }
            })()
          : "spawn_agent override validation failed";
      emitSpawnFailureEnd(overrideReason);
      return overrideError;
    }
    const taskName = stringValue(args.task_name);
    if (!taskName) {
      return failSpawn("task_name is required");
    }
    try {
      assertValidAgentName(taskName);
    } catch (error) {
      return failSpawn(error instanceof Error ? error.message : String(error));
    }
    const childDepth = currentAgentDepth(session, current, opts) + 1;
    const maxDepth = resolveSessionMaxAgentDepth(session);
    if (childDepth > maxDepth) {
      return failSpawn("Agent depth limit reached. Solve the task yourself.");
    }

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
        onSnapshot: (snapshot) => {
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
        },
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
