/**
 * Deterministic multi-agent workflow runner.
 *
 * Executes a declared step graph over the existing delegation
 * primitives: control flow (ordering, fan-out, joins, result passing)
 * lives HERE, deterministically — agents only run inside steps. This
 * is the orchestration layer the spawn/wait/send primitives were
 * missing: "spawn these N agents in parallel, gather their outputs,
 * then run phase 2 with the results".
 *
 * Manifest shape (`.agenc/workflows/<name>.json` `steps` array):
 *
 *   {
 *     "description": "review pipeline",
 *     "steps": [
 *       { "id": "read_a", "group": "readers", "message": "Summarize src/a" },
 *       { "id": "read_b", "group": "readers", "message": "Summarize src/b" },
 *       { "id": "synth", "after": ["readers"],
 *         "message": "Synthesize:\n{{group.readers}}" }
 *     ]
 *   }
 *
 * Semantics:
 *   - `after` entries reference step ids OR group names; a step runs
 *     once every referenced step/group member is terminal.
 *   - Steps whose dependencies are satisfied run CONCURRENTLY.
 *   - `{{steps.<id>}}` in a message is replaced with that step's final
 *     message; `{{group.<name>}}` with every member's final message
 *     (labeled, joined). Unknown placeholders are left verbatim.
 *   - A failed step (outcome !== "completed") marks every transitive
 *     dependent "skipped"; independent branches keep running.
 *
 * @module
 */
import { delegate, type IsolationMode } from "./delegate.js";
import type { AgentControl } from "./control.js";
import type { AgentRegistry } from "./registry.js";
import type { AgentThread } from "./thread.js";
import type { Session } from "../session/session.js";
import {
  backgroundTaskLifecycle,
  registerAgentThreadTask,
  type BackgroundTaskLifecycle,
} from "../tasks/index.js";

export interface WorkflowStepSpec {
  readonly id: string;
  readonly message: string;
  readonly task_name?: string;
  readonly agent_type?: string;
  readonly model?: string;
  readonly isolation?: IsolationMode;
  readonly group?: string;
  readonly after?: readonly string[];
}

export type WorkflowStepOutcome =
  | "completed"
  | "errored"
  | "interrupted"
  | "aborted"
  | "skipped";

export interface WorkflowStepResult {
  readonly id: string;
  readonly outcome: WorkflowStepOutcome;
  readonly final_message: string;
  readonly duration_ms?: number;
  readonly error?: string;
}

export interface RunAgentWorkflowOptions {
  readonly session: Session;
  readonly control: AgentControl;
  readonly registry: AgentRegistry;
  readonly steps: readonly WorkflowStepSpec[];
  readonly parentPath?: string;
  readonly lifecycle?: BackgroundTaskLifecycle;
  /** Injectable for tests. Defaults to the real delegate(). */
  readonly delegateFn?: typeof delegate;
}

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

/** Validate ids, dependency references, and acyclicity. */
export function validateWorkflowSteps(
  steps: readonly WorkflowStepSpec[],
): void {
  if (steps.length === 0) {
    throw new WorkflowValidationError("workflow has no steps");
  }
  const ids = new Set<string>();
  const groups = new Set<string>();
  for (const step of steps) {
    if (!step.id || typeof step.id !== "string") {
      throw new WorkflowValidationError("every step needs a string id");
    }
    if (ids.has(step.id)) {
      throw new WorkflowValidationError(`duplicate step id: ${step.id}`);
    }
    if (typeof step.message !== "string" || step.message.length === 0) {
      throw new WorkflowValidationError(`step ${step.id} needs a message`);
    }
    ids.add(step.id);
    if (step.group) groups.add(step.group);
  }
  for (const step of steps) {
    for (const dep of step.after ?? []) {
      if (!ids.has(dep) && !groups.has(dep)) {
        throw new WorkflowValidationError(
          `step ${step.id} depends on unknown step/group "${dep}"`,
        );
      }
      if (dep === step.id || dep === step.group) {
        throw new WorkflowValidationError(
          `step ${step.id} depends on itself (directly or via its group)`,
        );
      }
    }
  }
  // Cycle check: repeated ready-set peeling over the dependency graph.
  const pending = new Set(steps.map((s) => s.id));
  const byId = new Map(steps.map((s) => [s.id, s]));
  const groupMembers = new Map<string, string[]>();
  for (const step of steps) {
    if (step.group) {
      groupMembers.set(step.group, [
        ...(groupMembers.get(step.group) ?? []),
        step.id,
      ]);
    }
  }
  const depsOf = (id: string): string[] => {
    const step = byId.get(id)!;
    return (step.after ?? []).flatMap((dep) =>
      groupMembers.get(dep)?.filter((member) => member !== id) ?? [dep],
    );
  };
  while (pending.size > 0) {
    const ready = [...pending].filter((id) =>
      depsOf(id).every((dep) => !pending.has(dep)),
    );
    if (ready.length === 0) {
      throw new WorkflowValidationError(
        `dependency cycle among steps: ${[...pending].join(", ")}`,
      );
    }
    for (const id of ready) pending.delete(id);
  }
}

function renderTemplate(
  message: string,
  results: ReadonlyMap<string, WorkflowStepResult>,
  groupMembers: ReadonlyMap<string, readonly string[]>,
): string {
  return message
    .replace(/\{\{\s*steps\.([A-Za-z0-9_-]+)\s*\}\}/g, (match, id: string) => {
      const result = results.get(id);
      return result !== undefined ? result.final_message : match;
    })
    .replace(/\{\{\s*group\.([A-Za-z0-9_-]+)\s*\}\}/g, (match, name: string) => {
      const members = groupMembers.get(name);
      if (members === undefined) return match;
      return members
        .map((id) => {
          const result = results.get(id);
          return `### ${id}\n${result?.final_message ?? ""}`;
        })
        .join("\n\n");
    });
}

/**
 * Run the workflow to completion. Deterministic control flow: waves of
 * ready steps execute concurrently; each wave joins before dependents
 * are scheduled.
 */
export async function runAgentWorkflow(
  opts: RunAgentWorkflowOptions,
): Promise<{ readonly steps: readonly WorkflowStepResult[] }> {
  validateWorkflowSteps(opts.steps);
  const delegateFn = opts.delegateFn ?? delegate;
  const lifecycle = opts.lifecycle ?? backgroundTaskLifecycle;
  const parentPath = opts.parentPath ?? "/root";

  const groupMembers = new Map<string, string[]>();
  for (const step of opts.steps) {
    if (step.group) {
      groupMembers.set(step.group, [
        ...(groupMembers.get(step.group) ?? []),
        step.id,
      ]);
    }
  }
  const results = new Map<string, WorkflowStepResult>();
  const pending = new Map(opts.steps.map((s) => [s.id, s]));

  const depIds = (step: WorkflowStepSpec): string[] =>
    (step.after ?? []).flatMap((dep) =>
      groupMembers.get(dep)?.filter((member) => member !== step.id) ?? [dep],
    );

  const runStep = async (step: WorkflowStepSpec): Promise<WorkflowStepResult> => {
    const deps = depIds(step);
    if (deps.some((dep) => results.get(dep)?.outcome !== "completed")) {
      return { id: step.id, outcome: "skipped", final_message: "", error: "upstream step did not complete" };
    }
    const message = renderTemplate(step.message, results, groupMembers);
    const outcome = await delegateFn({
      parent: opts.session,
      parentPath,
      control: opts.control,
      registry: opts.registry,
      taskPrompt: message,
      agentName: step.task_name ?? step.id,
      runInBackground: true,
      ...(step.agent_type !== undefined ? { role: step.agent_type } : {}),
      ...(step.model !== undefined ? { model: step.model } : {}),
      ...(step.isolation !== undefined && step.isolation !== "none"
        ? { isolation: step.isolation, worktreeSlug: step.task_name ?? step.id }
        : {}),
      forkMode: undefined,
    });
    if (outcome.kind === "rejected") {
      return {
        id: step.id,
        outcome: "errored",
        final_message: "",
        error: outcome.reason,
      };
    }
    const thread: AgentThread = outcome.thread;
    try {
      registerAgentThreadTask(lifecycle, thread as never, {
        description: `workflow:${step.id}`,
        prompt: message,
      });
    } catch {
      /* pill registration is best-effort (duplicate ids etc.) */
    }
    const result = await thread.join();
    return {
      id: step.id,
      outcome: result.outcome,
      final_message: result.finalMessage ?? "",
      duration_ms: result.durationMs,
      ...(result.outcome !== "completed" && result.error !== undefined
        ? { error: String(result.error) }
        : {}),
    };
  };

  while (pending.size > 0) {
    const wave = [...pending.values()].filter((step) =>
      depIds(step).every((dep) => results.has(dep)),
    );
    // validateWorkflowSteps guarantees progress; this guard is a
    // belt-and-suspenders against future validation drift.
    if (wave.length === 0) {
      throw new WorkflowValidationError(
        `workflow stalled with pending steps: ${[...pending.keys()].join(", ")}`,
      );
    }
    for (const step of wave) pending.delete(step.id);
    const waveResults = await Promise.all(wave.map((step) => runStep(step)));
    for (const result of waveResults) results.set(result.id, result);
  }

  return {
    steps: opts.steps.map((step) => results.get(step.id)!),
  };
}
