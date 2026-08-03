import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const delegateMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/agents/delegate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/agents/delegate.js")>()),
  delegate: delegateMock,
}));

import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import { bindSessionAgentControl } from "../../src/bin/delegate-tool.js";
import {
  attachSandboxExecutionBroker,
  SandboxExecutionBroker,
} from "../../src/sandbox/execution-broker.js";
import type { Session } from "../../src/session/session.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  delegateMock.mockReset();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function fixture(session: Session | null = null) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "agenc-workflow-tool-"));
  temporaryRoots.push(workspaceRoot);
  const workflowRoot = join(workspaceRoot, ".agenc", "workflows");
  const agencHome = join(workspaceRoot, "state");
  await mkdir(workflowRoot, { recursive: true });
  const execCommand = vi.fn(async () => ({
    output: "ok",
    stdout: "ok",
    stderr: "",
    exitCode: 0,
    exit_code: 0,
    durationMs: 1,
    wall_time_seconds: 0.001,
    timedOut: false,
    truncated: false,
    original_token_count: 1,
  }));
  const tool = createModelFacingTools({
    workspaceRoot,
    agencHome,
    getSession: () => session,
    unifiedExecManager: { execCommand } as never,
    env: {},
  }).find((candidate) => candidate.name === "WorkflowTool");
  if (tool === undefined) throw new Error("WorkflowTool was not registered");
  return { workspaceRoot, workflowRoot, execCommand, tool };
}

function bindWorkflowSession(): Session {
  const session = {
    conversationId: "workflow-contract-session",
    services: {},
  } as unknown as Session;
  bindSessionAgentControl(session, {
    control: { shutdown: vi.fn(async () => {}) } as never,
    registry: {
      maxThreads: 64,
      acquireSpawnPermit: vi.fn(async () => ({ cancel: vi.fn() })),
    } as never,
  });
  return session;
}

function completeDelegation(
  onJoin?: (agentName: string) => void | Promise<void>,
): void {
  delegateMock.mockImplementation(
    async (options: {
      readonly agentName?: string;
      readonly taskPrompt: string;
      readonly invocationEnvelope: {
        readonly untrusted_data: readonly [{ readonly inline_payload: string }];
      };
      readonly finalMessageSink: {
        reset(): void;
        writeCanonicalDelta(delta: string): void;
      };
    }) => {
      const agentName = options.agentName ?? "unnamed";
      const workflowInputs = JSON.parse(
        options.invocationEnvelope.untrusted_data[0].inline_payload,
      ) as { logical_step_id: string };
      const logicalStepId = workflowInputs.logical_step_id;
      let joinPromise:
        | Promise<{
            readonly threadId: string;
            readonly durationMs: number;
            readonly outcome: "completed";
          }>
        | undefined;
      return {
        kind: "async_launched",
        thread: {
          threadId: `thread-${agentName}`,
          taskPrompt: options.taskPrompt,
          live: {
            agentId: `agent-${agentName}`,
            abortController: new AbortController(),
            status: { value: { status: "running" } },
          },
          join() {
            joinPromise ??= (async () => {
              await onJoin?.(logicalStepId);
              options.finalMessageSink.reset();
              options.finalMessageSink.writeCanonicalDelta(
                `${logicalStepId} complete`,
              );
              return {
                threadId: `thread-${agentName}`,
                durationMs: 1,
                outcome: "completed" as const,
              };
            })();
            return joinPromise;
          },
        },
      };
    },
  );
}

function executionArgs(
  workspaceRoot: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  attachSandboxExecutionBroker(
    value,
    new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: workspaceRoot,
    }),
    "workflow",
  );
  return value;
}

describe("WorkflowTool manifest boundary", () => {
  it("rejects traversal before filesystem escape or command dispatch", async () => {
    const { workspaceRoot, execCommand, tool } = await fixture();
    await mkdir(join(workspaceRoot, ".agenc"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".agenc", "escaped.json"),
      '{"command":"must-not-run"}',
      { mode: 0o600 },
    );

    const result = await tool.execute(
      executionArgs(workspaceRoot, { name: "../escaped" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("WORKFLOW_NAME");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("rejects duplicate manifest keys and legacy overrides before dispatch", async () => {
    const { workspaceRoot, workflowRoot, execCommand, tool } = await fixture();
    await writeFile(
      join(workflowRoot, "duplicate.json"),
      '{"command":"first","command":"second"}',
      { mode: 0o600 },
    );
    const duplicate = await tool.execute(
      executionArgs(workspaceRoot, { name: "duplicate" }),
    );
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content).toContain("duplicate object key");

    await writeFile(join(workflowRoot, "legacy.json"), '{"command":"safe"}', {
      mode: 0o600,
    });
    const override = await tool.execute(
      executionArgs(workspaceRoot, {
        name: "legacy",
        args: { max_concurrency: 1 },
      }),
    );
    expect(override.isError).toBe(true);
    expect(override.content).toContain("WORKFLOW_LEGACY_ARGS");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("dispatches a validated legacy command from a confined manifest", async () => {
    const { workspaceRoot, workflowRoot, execCommand, tool } = await fixture();
    await writeFile(join(workflowRoot, "safe.json"), '{"command":"do-safe-work"}', {
      mode: 0o600,
    });

    const result = await tool.execute(
      executionArgs(workspaceRoot, { name: "safe", args: {} }),
    );

    expect(result.isError).toBeUndefined();
    expect(execCommand).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "do-safe-work", workdir: workspaceRoot }),
    );
  });

  it("adapts legacy after references without object coercion", async () => {
    const session = bindWorkflowSession();
    const { workspaceRoot, workflowRoot, tool } = await fixture(session);
    const joined: string[] = [];
    completeDelegation((agentName) => {
      joined.push(agentName);
    });
    await writeFile(
      join(workflowRoot, "legacy-dag.json"),
      JSON.stringify({
        steps: [
          { id: "first", message: "first" },
          { id: "second", message: "{{steps.first}}", after: ["first"] },
        ],
      }),
      { mode: 0o600 },
    );

    const result = await tool.execute(
      executionArgs(workspaceRoot, { name: "legacy-dag" }),
    );

    expect(result.isError).toBeUndefined();
    expect(joined).toEqual(["first", "second"]);
    const secondEnvelope = delegateMock.mock.calls[1]?.[0]
      .invocationEnvelope as {
      readonly task_instructions: readonly [{ readonly inline_payload: string }];
      readonly untrusted_data: readonly [{ readonly inline_payload: string }];
    };
    expect(secondEnvelope.task_instructions[0].inline_payload).toBe(
      "[[workflow-input:legacy_0]]",
    );
    expect(secondEnvelope.untrusted_data[0].inline_payload).toContain(
      "first complete",
    );
  });

  it("executes version-2 structured references through the v2 result contract", async () => {
    const session = bindWorkflowSession();
    const { workspaceRoot, workflowRoot, tool } = await fixture(session);
    completeDelegation();
    await writeFile(
      join(workflowRoot, "v2.json"),
      JSON.stringify({
        format_version: 2,
        kind: "agent_dag",
        steps: [
          { id: "first", message: "first" },
          {
            id: "second",
            message: "second",
            after: [{ step: "first" }],
            inputs: { source: { step: "first" } },
          },
        ],
      }),
      { mode: 0o600 },
    );

    const result = await tool.execute(
      executionArgs(workspaceRoot, { name: "v2" }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('"workflow_result_version":2');
    expect(result.content).toContain('"outcome":"completed"');
    expect(delegateMock).toHaveBeenCalledTimes(2);
  });

  it("caps every accepted legacy DAG wave at sixteen active steps", async () => {
    const session = bindWorkflowSession();
    const { workspaceRoot, workflowRoot, tool } = await fixture(session);
    let active = 0;
    let peak = 0;
    completeDelegation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
      active -= 1;
    });
    await writeFile(
      join(workflowRoot, "bounded.json"),
      JSON.stringify({
        steps: Array.from({ length: 17 }, (_, index) => ({
          id: `step_${index}`,
          message: `step ${index}`,
        })),
      }),
      { mode: 0o600 },
    );

    const result = await tool.execute(
      executionArgs(workspaceRoot, { name: "bounded" }),
    );

    expect(result.isError).toBeUndefined();
    expect(delegateMock).toHaveBeenCalledTimes(17);
    expect(peak).toBe(16);
  });
});
