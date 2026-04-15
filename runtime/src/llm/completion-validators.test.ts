import { describe, expect, it, vi } from "vitest";

import { buildStopHookRuntime } from "./hooks/stop-hooks.js";
import { buildCompletionValidators } from "./completion-validators.js";
import type { ExecutionContext, ToolCallRecord } from "./chat-executor-types.js";
import { createRuntimeContractSnapshot } from "../runtime-contract/types.js";
import type { RuntimeContractFlags } from "../runtime-contract/types.js";
import {
  createRequestTaskProgressState,
  observeRequestTaskToolRecord,
  setAllowedRequestTaskMilestones,
} from "./request-task-progress.js";

function makeFlags(
  overrides: Partial<RuntimeContractFlags> = {},
): RuntimeContractFlags {
  return {
    runtimeContractV2: false,
    stopHooksEnabled: false,
    asyncTasksEnabled: false,
    persistentWorkersEnabled: false,
    mailboxEnabled: false,
    verifierRuntimeRequired: false,
    verifierProjectBootstrap: false,
    workerIsolationWorktree: false,
    workerIsolationRemote: false,
    ...overrides,
  };
}

function makeCtx(params: {
  readonly workspaceRoot?: string;
  readonly allToolCalls?: readonly ToolCallRecord[];
  readonly activeToolHandler?: ExecutionContext["activeToolHandler"];
  readonly finalContent?: string;
  readonly targetArtifacts?: readonly string[];
  readonly turnClass?: string;
  readonly ownerMode?: string;
  readonly flags?: RuntimeContractFlags;
  readonly completionContract?: Record<string, unknown>;
  readonly requiredToolEvidence?: ExecutionContext["requiredToolEvidence"];
}): ExecutionContext {
  const flags = params.flags ?? makeFlags();
  return {
    sessionId: "session-1",
    messageText: "Implement the feature",
    runtimeWorkspaceRoot: params.workspaceRoot,
    allToolCalls: [...(params.allToolCalls ?? [])],
    activeToolHandler: params.activeToolHandler,
    response: {
      content: params.finalContent ?? "done",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test-model",
      finishReason: "stop",
    },
    stopReason: "completed",
    completionState: "completed",
    completedRequestMilestoneIds: [],
    requestTaskState: createRequestTaskProgressState(),
    activeRuntimeReminderKeys: new Set<string>(),
    turnExecutionContract: {
      turnClass: params.turnClass ?? "dialogue",
      ownerMode: params.ownerMode ?? "none",
      targetArtifacts: params.targetArtifacts ?? [],
      ...(params.completionContract ? { completionContract: params.completionContract } : {}),
    },
    runtimeContractSnapshot: createRuntimeContractSnapshot(flags),
    requiredToolEvidence: params.requiredToolEvidence
      ? {
          ...params.requiredToolEvidence,
          maxCorrectionAttemptsExplicit:
            params.requiredToolEvidence.maxCorrectionAttempts !== undefined,
        }
      : undefined,
  } as unknown as ExecutionContext;
}

function successfulWrite(path: string): ToolCallRecord {
  return {
    name: "system.writeFile",
    args: { path, content: "hello" },
    result: JSON.stringify({ ok: true, path }),
    isError: false,
    durationMs: 1,
  };
}

function syntheticAcceptanceProbe(result: unknown): ToolCallRecord {
  return {
    name: "verification.runProbe",
    args: {
      probeId: "build",
      cwd: "/tmp/workspace",
      __runtimeAcceptanceProbe: true,
    },
    result: JSON.stringify(result),
    isError: true,
    durationMs: 1,
    synthetic: true,
  };
}

function taskToolResult(params: {
  readonly toolName?: "task.create" | "task.update" | "task.get";
  readonly id: string;
  readonly status: "pending" | "in_progress" | "completed" | "deleted";
  readonly metadata?: Record<string, unknown>;
}): ToolCallRecord {
  const toolName = params.toolName ?? "task.update";
  return {
    name: toolName,
    args: { taskId: params.id },
    result: JSON.stringify({
      task: {
        id: params.id,
        subject: `Task ${params.id}`,
        status: params.status,
      },
      taskRuntime: {
        fullTask: {
          id: params.id,
          subject: `Task ${params.id}`,
          description: `Description ${params.id}`,
          status: params.status,
          blocks: [],
          blockedBy: [],
          ...(params.metadata ? { metadata: params.metadata } : {}),
          createdAt: 1,
          updatedAt: 2,
        },
        runtimeMetadata: {},
      },
    }),
    isError: false,
    durationMs: 1,
  };
}

describe("completion-validators", () => {
  it("registers only the inline completion-integrity validators", () => {
    const validators = buildCompletionValidators({
      ctx: makeCtx({}),
      runtimeContractFlags: makeFlags(),
    });

    expect(validators.map((validator) => validator.id)).toEqual([
      "artifact_evidence",
      "turn_end_stop_gate",
      "request_task_progress",
    ]);
  });

  it("uses the stop-hook runtime for the stop validator when enabled", async () => {
    const flags = makeFlags({ stopHooksEnabled: true });
    const validators = buildCompletionValidators({
      ctx: makeCtx({ flags }),
      runtimeContractFlags: flags,
      stopHookRuntime: buildStopHookRuntime({
        enabled: true,
        maxAttempts: 3,
        handlers: [
          {
            id: "stop-block",
            phase: "Stop",
            kind: "command",
            target: "printf '{\"blockingError\":\"configured block\"}'",
          },
        ],
      }),
    });

    const stopValidator = validators.find(
      (validator) => validator.id === "turn_end_stop_gate",
    );
    const result = await stopValidator!.execute();

    expect(result.outcome).toBe("retry_with_blocking_message");
    expect(result.reason).toBe("stop-block");
    expect(result.blockingMessage).toBe("configured block");
    expect(result.maxAttempts).toBe(3);
    expect(result.stopHookResult?.phase).toBe("Stop");
  });

  it("lets the stop-hook path inherit the larger coding correction budget", async () => {
    const flags = makeFlags({ stopHooksEnabled: true });
    const validators = buildCompletionValidators({
      ctx: makeCtx({
        flags,
        finalContent:
          "The build is still failing. Next I will fix the linker errors.",
        allToolCalls: [successfulWrite("/tmp/workspace/src/main.c")],
        targetArtifacts: ["/tmp/workspace/src/main.c"],
        turnClass: "workflow_implementation",
        ownerMode: "workflow_owner",
        requiredToolEvidence: {
          maxCorrectionAttempts: 3,
        },
      }),
      runtimeContractFlags: flags,
      stopHookRuntime: buildStopHookRuntime({
        enabled: true,
      }),
    });

    const stopValidator = validators.find(
      (validator) => validator.id === "turn_end_stop_gate",
    );
    const result = await stopValidator!.execute();

    expect(result.outcome).toBe("retry_with_blocking_message");
    expect(result.reason).toBe("narrated_future_tool_work");
    expect(result.maxAttempts).toBe(3);
  });

  it("blocks finalization when the latest verification probe still failed", async () => {
    const flags = makeFlags({ stopHooksEnabled: true });
    const validators = buildCompletionValidators({
      ctx: makeCtx({
        flags,
        finalContent:
          "All phases of PLAN.md have been completed. The workspace is fully implemented and verified.",
        allToolCalls: [
          successfulWrite("/tmp/workspace/include/utils.h"),
          syntheticAcceptanceProbe({
            error: "include/utils.h:25:18: error: unknown type name 'FILE'",
            __agencVerification: {
              probeId: "build",
              category: "build",
              profile: "default",
              repoLocal: true,
              cwd: "/tmp/workspace",
              command: "cmake --build build",
              writesTempOnly: false,
            },
          }),
        ],
      }),
      runtimeContractFlags: flags,
      stopHookRuntime: buildStopHookRuntime({
        enabled: true,
      }),
    });

    const stopValidator = validators.find(
      (validator) => validator.id === "turn_end_stop_gate",
    );
    const result = await stopValidator!.execute();

    expect(result.outcome).toBe("retry_with_blocking_message");
    expect(result.reason).toBe("false_success_after_failed_verification");
    expect(result.blockingMessage).toContain("cmake --build build");
    expect(result.stopHookResult?.outcome).toBe("retry_with_blocking_message");
  });

  it("uses the default builtin stop-hook runtime when no explicit stop-hook config is provided", async () => {
    const validators = buildCompletionValidators({
      ctx: makeCtx({
        finalContent:
          "The current build still has failures. Next I will fix the linker errors and then rerun the build.",
        allToolCalls: [successfulWrite("/tmp/workspace/src/main.c")],
        turnClass: "workflow_implementation",
        ownerMode: "workflow_owner",
        targetArtifacts: ["/tmp/workspace/src/main.c"],
        requiredToolEvidence: {
          maxCorrectionAttempts: 3,
        },
      }),
      runtimeContractFlags: makeFlags({ stopHooksEnabled: true }),
      stopHookRuntime: buildStopHookRuntime(undefined),
    });

    const stopValidator = validators.find(
      (validator) => validator.id === "turn_end_stop_gate",
    );
    const result = await stopValidator!.execute();

    expect(result.outcome).toBe("retry_with_blocking_message");
    expect(result.reason).toBe("narrated_future_tool_work");
    expect(result.maxAttempts).toBe(3);
    expect(result.blockingMessage).toContain("bounded recovery loop");
  });

  it("does not block finalization when request milestones remain open without an in_progress task", async () => {
    const ctx = makeCtx({});
    setAllowedRequestTaskMilestones(ctx.requestTaskState, [
      { id: "phase_1", description: "Finish phase 1" },
    ]);
    const validators = buildCompletionValidators({
      ctx,
      runtimeContractFlags: makeFlags(),
    });

    const result = await validators.find(
      (validator) => validator.id === "request_task_progress",
    )!.execute();

    expect(result.outcome).toBe("pass");
  });

  it("blocks malformed runtime milestone metadata before allowing completion", async () => {
    const ctx = makeCtx({});
    setAllowedRequestTaskMilestones(ctx.requestTaskState, [
      { id: "phase_1", description: "Finish phase 1" },
    ]);
    observeRequestTaskToolRecord(
      ctx.requestTaskState,
      taskToolResult({
        id: "1",
        status: "completed",
        metadata: {
          _runtime: {
            milestoneIds: ["phase_1", "phase_1"],
          },
        },
      }),
    );
    ctx.completedRequestMilestoneIds = [...ctx.requestTaskState.completedMilestoneIds];
    const validators = buildCompletionValidators({
      ctx,
      runtimeContractFlags: makeFlags(),
    });

    const result = await validators.find(
      (validator) => validator.id === "request_task_progress",
    )!.execute();

    expect(result.outcome).toBe("retry_with_blocking_message");
    expect(result.blockingMessage).toContain("malformed");
    expect(result.blockingMessage).toContain("#1");
  });

  it("does not require a verification task after three completed non-verification tasks", async () => {
    const ctx = makeCtx({});
    for (const id of ["1", "2", "3"]) {
      observeRequestTaskToolRecord(
        ctx.requestTaskState,
        taskToolResult({
          id,
          status: "completed",
        }),
      );
    }
    const validators = buildCompletionValidators({
      ctx,
      runtimeContractFlags: makeFlags(),
    });

    const result = await validators.find(
      (validator) => validator.id === "request_task_progress",
    )!.execute();

    expect(result.outcome).toBe("pass");
  });
});
