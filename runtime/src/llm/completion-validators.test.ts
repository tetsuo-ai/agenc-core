import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    },
    runtimeContractSnapshot: createRuntimeContractSnapshot(flags),
    requiredToolEvidence: params.requiredToolEvidence,
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
  it("registers request_task_progress between stop-gate and filesystem checks", () => {
    const validators = buildCompletionValidators({
      ctx: makeCtx({}),
      runtimeContractFlags: makeFlags(),
    });

    expect(validators.map((validator) => validator.id)).toEqual([
      "artifact_evidence",
      "turn_end_stop_gate",
      "request_task_progress",
      "filesystem_artifact_verification",
      "deterministic_acceptance_probes",
      "top_level_verifier",
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

  it("uses the shared correction budget for narrated future tool work when stop hooks are not configured", async () => {
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

  it("gates the verification stage before deterministic probes run", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "verification-ready-"));
    writeFileSync(join(workspaceRoot, "Makefile"), "all:\n\t@true\n");
    const toolHandler = vi.fn(async () =>
      JSON.stringify({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        durationMs: 1,
        truncated: false,
      }),
    );
    const flags = makeFlags({
      runtimeContractV2: true,
      stopHooksEnabled: true,
      verifierRuntimeRequired: true,
    });
    const validators = buildCompletionValidators({
      ctx: makeCtx({
        workspaceRoot,
        activeToolHandler: toolHandler,
        allToolCalls: [successfulWrite(join(workspaceRoot, "src/main.c"))],
        targetArtifacts: [join(workspaceRoot, "src/main.c")],
        flags,
      }),
      runtimeContractFlags: flags,
      stopHookRuntime: buildStopHookRuntime({
        enabled: true,
        handlers: [
          {
            id: "verification-block",
            phase: "VerificationReady",
            kind: "command",
            target: "printf '{\"blockingError\":\"verification blocked\"}'",
          },
        ],
      }),
    });

    const deterministic = validators.find(
      (validator) => validator.id === "deterministic_acceptance_probes",
    );
    const topLevel = validators.find(
      (validator) => validator.id === "top_level_verifier",
    );
    const deterministicResult = await deterministic!.execute();
    const topLevelResult = await topLevel!.execute();

    expect(deterministicResult.outcome).toBe("retry_with_blocking_message");
    expect(deterministicResult.blockingMessage).toBe("verification blocked");
    expect(deterministicResult.stopHookResult?.phase).toBe("VerificationReady");
    expect(topLevelResult.outcome).toBe("retry_with_blocking_message");
    expect(toolHandler).not.toHaveBeenCalled();
  });

  it("uses the shared correction budget for deterministic acceptance probes on workflow-owned turns", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "deterministic-budget-"));
    writeFileSync(
      join(workspaceRoot, "Makefile"),
      "all:\n\t@printf 'ok\\n'\n",
    );
    const validators = buildCompletionValidators({
      ctx: makeCtx({
        workspaceRoot,
        allToolCalls: [successfulWrite(join(workspaceRoot, "src/main.c"))],
        targetArtifacts: [join(workspaceRoot, "src/main.c")],
        turnClass: "workflow_implementation",
        ownerMode: "workflow_owner",
      }),
      runtimeContractFlags: makeFlags(),
    });

    const deterministic = validators.find(
      (validator) => validator.id === "deterministic_acceptance_probes",
    );
    const result = await deterministic!.execute();

    expect(result.outcome).toBe("pass");
    expect(result.probeRuns).toHaveLength(1);
  });

  it("fails closed when a deterministic acceptance recovery turn made no workspace mutations", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "deterministic-stall-"));
    writeFileSync(
      join(workspaceRoot, "Makefile"),
      "all:\n\t@echo build failed >&2\n\t@exit 2\n",
    );
    const validators = buildCompletionValidators({
      ctx: makeCtx({
        workspaceRoot,
        allToolCalls: [
          successfulWrite(join(workspaceRoot, "src/main.c")),
          syntheticAcceptanceProbe({
            exitCode: 2,
            stdout: "",
            stderr: "build failed",
            timedOut: false,
            durationMs: 1,
            truncated: false,
          }),
        ],
        targetArtifacts: [join(workspaceRoot, "src/main.c")],
        turnClass: "workflow_implementation",
        ownerMode: "workflow_owner",
      }),
      runtimeContractFlags: makeFlags(),
    });

    const deterministic = validators.find(
      (validator) => validator.id === "deterministic_acceptance_probes",
    );
    const result = await deterministic!.execute();

    expect(result.outcome).toBe("fail_closed");
    expect(result.reason).toBe("deterministic_acceptance_probe_failed");
    expect(result.exhaustedDetail).toContain(
      "made no successful workspace mutations",
    );
  });

  it("uses the shared correction budget for filesystem artifact recovery", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "filesystem-budget-"));
    const missingPath = join(workspaceRoot, "src/main.c");
    const validators = buildCompletionValidators({
      ctx: makeCtx({
        finalContent: "Implementation complete. All phases implemented.",
        allToolCalls: [
          {
            name: "system.writeFile",
            args: { path: missingPath, content: "phase 1" },
            result: JSON.stringify({ ok: true, path: missingPath }),
            isError: false,
            durationMs: 1,
          },
        ],
        requiredToolEvidence: {
          maxCorrectionAttempts: 3,
        },
      }),
      runtimeContractFlags: makeFlags(),
    });

    const filesystem = validators.find(
      (validator) => validator.id === "filesystem_artifact_verification",
    );
    const result = await filesystem!.execute();

    expect(result.outcome).toBe("retry_with_blocking_message");
    expect(result.maxAttempts).toBe(3);
    expect(result.blockingMessage).toContain("bounded recovery loop");
  });

  it("runs the top-level verifier even when runtimeContractV2 is false", async () => {
    const flags = makeFlags({
      runtimeContractV2: false,
      verifierRuntimeRequired: true,
    });
    const ctx = makeCtx({
      flags,
      allToolCalls: [successfulWrite("/tmp/workspace/src/main.c")],
      targetArtifacts: ["/tmp/workspace/src/main.c"],
    });
    ctx.turnExecutionContract = {
      version: 1,
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      workspaceRoot: "/tmp/workspace",
      sourceArtifacts: ["/tmp/workspace/PLAN.md"],
      targetArtifacts: ["/tmp/workspace/src/main.c"],
      delegationPolicy: "direct_owner",
      contractFingerprint: "contract-1",
      taskLineageId: "task-1",
    } as any;
    const validators = buildCompletionValidators({
      ctx,
      runtimeContractFlags: flags,
      completionValidation: {
        topLevelVerifier: {
          subAgentManager: {
            spawn: vi.fn(async () => "subagent:verify"),
            waitForResult: vi.fn(async () => ({
              sessionId: "subagent:verify",
              output: "All good.\nVERDICT: PASS",
              success: true,
              durationMs: 1,
              toolCalls: [
                {
                  name: "verification.runProbe",
                  args: { probeId: "build" },
                  result:
                    "{\"ok\":true,\"__agencVerification\":{\"probeId\":\"build\",\"category\":\"build\",\"profile\":\"generic\"}}",
                  isError: false,
                  durationMs: 1,
                },
              ],
              structuredOutput: {
                type: "json_schema",
                name: "agenc_top_level_verifier_decision",
                parsed: {
                  verdict: "pass",
                  summary: "Probe-backed verification passed.",
                },
              },
              completionState: "completed",
              stopReason: "completed",
            })),
          },
          verifierService: {
            resolveVerifierRequirement: vi.fn(() => ({
              required: true,
              profiles: ["generic"],
              probeCategories: ["build"],
              mutationPolicy: "read_only_workspace",
              allowTempArtifacts: false,
              bootstrapSource: "disabled",
              rationale: ["test"],
            })),
            shouldVerifySubAgentResult: vi.fn(() => true),
          },
        },
      },
    });

    const result = await validators.find(
      (validator) => validator.id === "top_level_verifier",
    )!.execute();

    expect(result.outcome).toBe("pass");
    expect(result.verifier?.overall).toBe("pass");
  });

  it("blocks finalization when request milestones remain open without an in_progress task", async () => {
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

    expect(result.outcome).toBe("retry_with_blocking_message");
    expect(result.blockingMessage).toContain("no task is marked in_progress");
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

  it("requires a verification task after three completed non-verification tasks", async () => {
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

    expect(result.outcome).toBe("retry_with_blocking_message");
    expect(result.blockingMessage).toContain("verification task");
  });
});
