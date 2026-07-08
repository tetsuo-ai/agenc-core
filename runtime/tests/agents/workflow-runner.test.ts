/**
 * Task 11: deterministic multi-agent workflow runner. The Accept
 * scenario: a 2-phase workflow (3 parallel readers → 1 synthesizer
 * receiving their outputs) completes with correct data flow and
 * per-step task pills.
 */
import { describe, expect, it, vi } from "vitest";

import {
  runAgentWorkflow,
  validateWorkflowSteps,
  WorkflowValidationError,
  type WorkflowStepSpec,
} from "./workflow-runner.js";
import { BackgroundTaskLifecycle } from "../tasks/index.js";
import type { Session } from "../session/session.js";

interface SpawnRecord {
  readonly agentName: string;
  readonly taskPrompt: string;
}

function fakeDelegate(opts: {
  readonly finalMessages: Record<string, string>;
  readonly failing?: ReadonlySet<string>;
  readonly spawns: SpawnRecord[];
}) {
  let counter = 0;
  return vi.fn(async (delegateOpts: { agentName?: string; taskPrompt: string }) => {
    const agentName = delegateOpts.agentName ?? `agent-${counter}`;
    counter += 1;
    opts.spawns.push({ agentName, taskPrompt: delegateOpts.taskPrompt });
    const threadId = `thread-${agentName}`;
    const fails = opts.failing?.has(agentName) === true;
    return {
      kind: "async_launched" as const,
      thread: {
        threadId,
        taskPrompt: delegateOpts.taskPrompt,
        live: {
          agentId: threadId,
          abortController: new AbortController(),
          status: { value: "running" },
        },
        join: async () =>
          fails
            ? {
                threadId,
                durationMs: 1,
                outcome: "errored" as const,
                error: "boom",
              }
            : {
                threadId,
                durationMs: 1,
                outcome: "completed" as const,
                finalMessage:
                  opts.finalMessages[agentName] ?? `${agentName} done`,
              },
      },
    };
  });
}

const session = { conversationId: "conv-wf" } as unknown as Session;
const control = {} as never;
const registry = {} as never;

describe("validateWorkflowSteps", () => {
  it("rejects duplicates, unknown deps, and cycles", () => {
    expect(() =>
      validateWorkflowSteps([
        { id: "a", message: "x" },
        { id: "a", message: "y" },
      ]),
    ).toThrow(WorkflowValidationError);
    expect(() =>
      validateWorkflowSteps([{ id: "a", message: "x", after: ["ghost"] }]),
    ).toThrow(/unknown step\/group/);
    expect(() =>
      validateWorkflowSteps([
        { id: "a", message: "x", after: ["b"] },
        { id: "b", message: "y", after: ["a"] },
      ]),
    ).toThrow(/cycle/);
  });
});

describe("runAgentWorkflow", () => {
  const readerSteps: WorkflowStepSpec[] = [
    { id: "read_a", group: "readers", message: "Summarize module A" },
    { id: "read_b", group: "readers", message: "Summarize module B" },
    { id: "read_c", group: "readers", message: "Summarize module C" },
    {
      id: "synth",
      after: ["readers"],
      message: "Synthesize the findings:\n{{group.readers}}",
    },
  ];

  it("fans out readers in parallel, then feeds their outputs to the synthesizer", async () => {
    const spawns: SpawnRecord[] = [];
    const lifecycle = new BackgroundTaskLifecycle();
    const delegateFn = fakeDelegate({
      spawns,
      finalMessages: {
        read_a: "A uses pattern X",
        read_b: "B uses pattern Y",
        read_c: "C uses pattern Z",
      },
    });

    const run = await runAgentWorkflow({
      session,
      control,
      registry,
      steps: readerSteps,
      lifecycle,
      delegateFn: delegateFn as never,
    });

    // Wave 1: all three readers spawned before the synthesizer.
    expect(spawns.slice(0, 3).map((s) => s.agentName).sort()).toEqual([
      "read_a",
      "read_b",
      "read_c",
    ]);
    expect(spawns[3]?.agentName).toBe("synth");

    // Data flow: the synthesizer's prompt carries every reader output.
    expect(spawns[3]?.taskPrompt).toContain("A uses pattern X");
    expect(spawns[3]?.taskPrompt).toContain("B uses pattern Y");
    expect(spawns[3]?.taskPrompt).toContain("C uses pattern Z");
    expect(spawns[3]?.taskPrompt).toContain("### read_a");

    // Results in declaration order, all completed.
    expect(run.steps.map((s) => [s.id, s.outcome])).toEqual([
      ["read_a", "completed"],
      ["read_b", "completed"],
      ["read_c", "completed"],
      ["synth", "completed"],
    ]);

    // Per-step task pills registered on the lifecycle.
    expect(lifecycle.get("thread-read_a")?.description).toBe(
      "workflow:read_a",
    );
    expect(lifecycle.get("thread-synth")?.description).toBe("workflow:synth");
  });

  it("supports {{steps.<id>}} references and skips dependents of failures", async () => {
    const spawns: SpawnRecord[] = [];
    const delegateFn = fakeDelegate({
      spawns,
      finalMessages: { first: "FIRST OUTPUT" },
      failing: new Set(["flaky"]),
    });

    const run = await runAgentWorkflow({
      session,
      control,
      registry,
      steps: [
        { id: "first", message: "do the first thing" },
        { id: "flaky", message: "explode" },
        {
          id: "uses_first",
          after: ["first"],
          message: "continue from: {{steps.first}}",
        },
        {
          id: "uses_flaky",
          after: ["flaky"],
          message: "never runs: {{steps.flaky}}",
        },
      ],
      lifecycle: new BackgroundTaskLifecycle(),
      delegateFn: delegateFn as never,
    });

    const byId = new Map(run.steps.map((s) => [s.id, s]));
    expect(byId.get("first")?.outcome).toBe("completed");
    expect(byId.get("flaky")?.outcome).toBe("errored");
    expect(byId.get("uses_first")?.outcome).toBe("completed");
    expect(byId.get("uses_flaky")?.outcome).toBe("skipped");
    expect(
      spawns.find((s) => s.agentName === "uses_first")?.taskPrompt,
    ).toContain("FIRST OUTPUT");
    // The skipped step never spawned an agent.
    expect(spawns.some((s) => s.agentName === "uses_flaky")).toBe(false);
  });

  it("reports rejected delegations as errored steps", async () => {
    const delegateFn = vi.fn(async () => ({
      kind: "rejected" as const,
      reason: "no slots",
    }));
    const run = await runAgentWorkflow({
      session,
      control,
      registry,
      steps: [{ id: "only", message: "run" }],
      lifecycle: new BackgroundTaskLifecycle(),
      delegateFn: delegateFn as never,
    });
    expect(run.steps[0]).toMatchObject({
      id: "only",
      outcome: "errored",
      error: "no slots",
    });
  });
});
