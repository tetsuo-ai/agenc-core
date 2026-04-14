import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
        turnClass: "workflow_implementation",
        ownerMode: "workflow_owner",
        flags,
        completionContract: {
          taskClass: "build_required",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
        },
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

  it("skips the top-level verifier for ordinary workflow turns that only carry artifact completion", async () => {
    const flags = makeFlags({
      verifierRuntimeRequired: true,
    });
    const validators = buildCompletionValidators({
      ctx: makeCtx({
        flags,
        allToolCalls: [successfulWrite("/tmp/workspace/src/main.c")],
        targetArtifacts: ["/tmp/workspace/src/main.c"],
        turnClass: "workflow_implementation",
        ownerMode: "workflow_owner",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
        },
      }),
      runtimeContractFlags: flags,
    });

    const result = await validators.find(
      (validator) => validator.id === "top_level_verifier",
    )!.execute();

    expect(result.outcome).toBe("skipped");
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

  it("applies the shared 3-attempt recovery budget consistently across the primary validators", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "shared-budget-"));
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "Makefile"),
      "all:\n\t@echo build failed >&2\n\t@exit 2\n",
      "utf8",
    );
    const targetPath = join(workspaceRoot, "src/main.c");
    const stopHookFlags = makeFlags({ stopHooksEnabled: true });
    const narrativeCtx = makeCtx({
      workspaceRoot,
      finalContent: "Next I will fix the build and rerun the checks.",
      allToolCalls: [successfulWrite(targetPath)],
      targetArtifacts: [targetPath],
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      flags: stopHookFlags,
      requiredToolEvidence: {
        maxCorrectionAttempts: 3,
      },
    });
    setAllowedRequestTaskMilestones(narrativeCtx.requestTaskState, [
      { id: "phase_1", description: "Finish phase 1" },
    ]);
    const narrativeValidators = buildCompletionValidators({
      ctx: narrativeCtx,
      runtimeContractFlags: stopHookFlags,
      stopHookRuntime: buildStopHookRuntime(undefined),
    });
    const filesystemCtx = makeCtx({
      workspaceRoot,
      finalContent: "Implementation complete. All phases implemented.",
      allToolCalls: [successfulWrite(targetPath)],
      targetArtifacts: [targetPath],
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      requiredToolEvidence: {
        maxCorrectionAttempts: 3,
      },
    });
    const filesystemValidators = buildCompletionValidators({
      ctx: filesystemCtx,
      runtimeContractFlags: makeFlags(),
    });
    const narrativeById = new Map(
      narrativeValidators.map((validator) => [validator.id, validator]),
    );
    const filesystemById = new Map(
      filesystemValidators.map((validator) => [validator.id, validator]),
    );

    const [stopGate, taskProgress, deterministic, filesystem] = await Promise.all([
      narrativeById.get("turn_end_stop_gate")!.execute(),
      narrativeById.get("request_task_progress")!.execute(),
      narrativeById.get("deterministic_acceptance_probes")!.execute(),
      filesystemById.get("filesystem_artifact_verification")!.execute(),
    ]);

    try {
      expect(stopGate.outcome).toBe("retry_with_blocking_message");
      expect(stopGate.maxAttempts).toBe(3);

      expect(taskProgress.outcome).toBe("pass");

      expect(filesystem.outcome).toBe("retry_with_blocking_message");
      expect(filesystem.maxAttempts).toBe(3);

      expect(deterministic.outcome).toBe("retry_with_blocking_message");
      expect(deterministic.maxAttempts).toBe(3);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps an explicit zero correction budget at zero for the recovery validators", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "zero-budget-"));
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "Makefile"),
      "all:\n\t@echo build failed >&2\n\t@exit 2\n",
      "utf8",
    );
    const targetPath = join(workspaceRoot, "src/main.c");
    const stopHookFlags = makeFlags({ stopHooksEnabled: true });
    const narrativeCtx = makeCtx({
      workspaceRoot,
      finalContent: "Next I will fix the build and rerun the checks.",
      allToolCalls: [successfulWrite(targetPath)],
      targetArtifacts: [targetPath],
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      flags: stopHookFlags,
      requiredToolEvidence: {
        maxCorrectionAttempts: 0,
      },
    });
    setAllowedRequestTaskMilestones(narrativeCtx.requestTaskState, [
      { id: "phase_1", description: "Finish phase 1" },
    ]);
    const narrativeValidators = buildCompletionValidators({
      ctx: narrativeCtx,
      runtimeContractFlags: stopHookFlags,
      stopHookRuntime: buildStopHookRuntime(undefined),
    });
    const filesystemCtx = makeCtx({
      workspaceRoot,
      finalContent: "Implementation complete. All phases implemented.",
      allToolCalls: [successfulWrite(targetPath)],
      targetArtifacts: [targetPath],
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      requiredToolEvidence: {
        maxCorrectionAttempts: 0,
      },
    });
    const filesystemValidators = buildCompletionValidators({
      ctx: filesystemCtx,
      runtimeContractFlags: makeFlags(),
    });
    const narrativeById = new Map(
      narrativeValidators.map((validator) => [validator.id, validator]),
    );
    const filesystemById = new Map(
      filesystemValidators.map((validator) => [validator.id, validator]),
    );

    const [stopGate, taskProgress, deterministic, filesystem] = await Promise.all([
      narrativeById.get("turn_end_stop_gate")!.execute(),
      narrativeById.get("request_task_progress")!.execute(),
      narrativeById.get("deterministic_acceptance_probes")!.execute(),
      filesystemById.get("filesystem_artifact_verification")!.execute(),
    ]);

    try {
      expect(stopGate.maxAttempts).toBe(0);
      expect(taskProgress.outcome).toBe("pass");
      expect(filesystem.maxAttempts).toBe(0);
      expect(deterministic.maxAttempts).toBe(0);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
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
      completionContract: {
        taskClass: "build_required",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
      },
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
