import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import type { ChatExecutorResult } from "../llm/chat-executor.js";
import { createRuntimeContractSnapshot } from "../runtime-contract/types.js";
import { runTopLevelVerifierValidation } from "./top-level-verifier.js";
import type { VerifierRequirement } from "./verifier-probes.js";

function createResult(
  overrides: Partial<ChatExecutorResult> = {},
): ChatExecutorResult {
  return {
    content: "Implemented every requested artifact.",
    provider: "grok",
    usedFallback: false,
    toolCalls: [
      {
        name: "system.writeFile",
        args: { path: "/workspace/src/main.c" },
        result: '{"ok":true}',
        isError: false,
        durationMs: 5,
      },
    ],
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    callUsage: [],
    durationMs: 10,
    compacted: false,
    stopReason: "completed",
    completionState: "completed",
    runtimeContractSnapshot: createRuntimeContractSnapshot({
      runtimeContractV2: false,
      stopHooksEnabled: false,
      asyncTasksEnabled: false,
      persistentWorkersEnabled: false,
      mailboxEnabled: false,
      verifierRuntimeRequired: true,
      verifierProjectBootstrap: false,
      workerIsolationWorktree: false,
      workerIsolationRemote: false,
    }),
    turnExecutionContract: {
      version: 1,
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      workspaceRoot: "/workspace",
      sourceArtifacts: ["/workspace/PLAN.md"],
      targetArtifacts: ["/workspace/src/main.c"],
      delegationPolicy: "direct_owner",
      completionContract: {
        taskClass: "build_required",
        placeholdersAllowed: false,
        partialCompletionAllowed: false,
      },
      contractFingerprint: "contract-1",
      taskLineageId: "task-1",
    },
    activeTaskContext: {
      version: 1,
      taskLineageId: "task-1",
      contractFingerprint: "contract-1",
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      workspaceRoot: "/workspace",
      sourceArtifacts: ["/workspace/PLAN.md"],
      targetArtifacts: ["/workspace/src/main.c"],
    },
    ...overrides,
  };
}

function createVerifierRequirement(
  overrides: Partial<VerifierRequirement> = {},
): VerifierRequirement {
  return {
    required: true,
    profiles: ["generic"],
    probeCategories: ["build"],
    mutationPolicy: "read_only_workspace",
    allowTempArtifacts: true,
    bootstrapSource: "disabled",
    rationale: ["test requirement"],
    ...overrides,
  };
}

function createVerifierService(
  requirement: VerifierRequirement = createVerifierRequirement(),
) {
  return {
    resolveVerifierRequirement: vi.fn(() => requirement),
    shouldVerifySubAgentResult: vi.fn(() => requirement.required),
  };
}

describe("runTopLevelVerifierValidation", () => {
  it("spawns the verifier worker with grounded read evidence", async () => {
    const spawn = vi.fn(async () => "subagent:verify-1");
    const waitForResult = vi.fn(async () => ({
      sessionId: "subagent:verify-1",
      output: "### Check: build\nResult: FAIL\nVERDICT: FAIL",
      success: false,
      durationMs: 42,
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/workspace/src/main.c" },
          result: '{"ok":true}',
          isError: false,
          durationMs: 2,
        },
      ],
      completionState: "completed",
      stopReason: "completed",
    }));

    const decision = await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult(),
      subAgentManager: { spawn, waitForResult },
      verifierService: createVerifierService(),
      agentDefinitions: [
        {
          name: "verify",
          description: "Verification worker",
          model: "inherit",
          tools: ["system.readFile", "system.bash", "verification.runProbe"],
          maxTurns: 8,
          source: "built-in",
          filePath: "/tmp/verify.md",
          body: "Verifier system prompt",
        },
      ],
    });

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        promptEnvelope: expect.objectContaining({
          kind: "prompt_envelope_v1",
          baseSystemPrompt: "Verifier system prompt",
        }),
        tools: [
          "system.readFile",
          "system.bash",
          "verification.runProbe",
        ],
        structuredOutput: expect.objectContaining({
          enabled: true,
          schema: expect.objectContaining({
            name: "agenc_top_level_verifier_decision",
            strict: true,
          }),
        }),
        requiredToolEvidence: expect.objectContaining({
          executionEnvelope: expect.objectContaining({
            verificationMode: "grounded_read",
            allowedWriteRoots: ["/workspace", tmpdir()],
            targetArtifacts: ["/workspace/src/main.c"],
          }),
        }),
      }),
    );
    expect(decision.outcome).toBe("retry_with_blocking_message");
    expect(decision.runtimeVerifier.overall).toBe("fail");
    expect(decision.blockingMessage).toContain("Runtime verification blocked completion");
  });

  it("prefers structured verifier verdicts over text parsing", async () => {
    const spawn = vi.fn(async () => "subagent:verify-2");
    const waitForResult = vi.fn(async () => ({
      sessionId: "subagent:verify-2",
      output: "Verifier wrote a long narrative without a VERDICT line.",
      success: false,
      durationMs: 25,
      toolCalls: [],
      structuredOutput: {
        type: "json_schema",
        name: "agenc_top_level_verifier_decision",
        parsed: {
          verdict: "fail",
          summary: "Build fails under verifier-run acceptance checks.",
        },
      },
      completionState: "completed",
      stopReason: "completed",
    }));

    const decision = await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult(),
      subAgentManager: { spawn, waitForResult },
      verifierService: createVerifierService(),
    });

    expect(decision.outcome).toBe("retry_with_blocking_message");
    expect(decision.summary).toContain(
      "Build fails under verifier-run acceptance checks.",
    );
    expect(decision.runtimeVerifier.overall).toBe("fail");
  });

  it("still runs verifier work when target artifacts are declared without structured writes", async () => {
    const spawn = vi.fn(async () => "subagent:verify-1");
    const waitForResult = vi.fn(async () => ({
      sessionId: "subagent:verify-1",
      output: "All good.\nVERDICT: PASS",
      success: true,
      durationMs: 10,
      toolCalls: [],
      structuredOutput: {
        type: "json_schema",
        name: "agenc_top_level_verifier_decision",
        parsed: {
          verdict: "pass",
          summary: "Verification passed without relying on structured write records.",
        },
      },
      completionState: "completed",
      stopReason: "completed",
    }));

    const decision = await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "hello",
      result: createResult({
        toolCalls: [],
        turnExecutionContract: {
          ...createResult().turnExecutionContract,
          turnClass: "workflow_implementation",
          ownerMode: "workflow_owner",
          completionContract: {
            taskClass: "artifact_only",
            placeholdersAllowed: false,
            partialCompletionAllowed: true,
          },
        },
      }),
      subAgentManager: { spawn, waitForResult },
      verifierService: createVerifierService(),
    });

    expect(spawn).toHaveBeenCalled();
    expect(decision.outcome).toBe("pass");
    expect(decision.runtimeVerifier.overall).toBe("pass");
  });

  it("still skips verifier workers when runtime verification is not required", async () => {
    const spawn = vi.fn(async () => "subagent:verify-1");

    const decision = await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "hello",
      result: createResult({
        runtimeContractSnapshot: createRuntimeContractSnapshot({
          runtimeContractV2: false,
          stopHooksEnabled: false,
          asyncTasksEnabled: false,
          persistentWorkersEnabled: false,
          mailboxEnabled: false,
          verifierRuntimeRequired: false,
          verifierProjectBootstrap: false,
          workerIsolationWorktree: false,
          workerIsolationRemote: false,
        }),
        turnExecutionContract: {
          ...createResult().turnExecutionContract,
          turnClass: "dialogue",
          ownerMode: "none",
          targetArtifacts: [],
        },
      }),
      subAgentManager: { spawn, waitForResult: vi.fn(async () => null) },
      verifierService: createVerifierService(
        createVerifierRequirement({ required: false }),
      ),
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(decision.outcome).toBe("skipped");
    expect(decision.runtimeVerifier.overall).toBe("skipped");
  });

  it("fails closed when runtime-required verifier services are unavailable", async () => {
    const traceEvents: string[] = [];
    const decision = await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult(),
      subAgentManager: null,
      verifierService: null,
      onTraceEvent: async (event) => {
        traceEvents.push(event.type);
      },
    });

    expect(decision.outcome).toBe("fail_closed");
    expect(decision.runtimeVerifier.overall).toBe("retry");
    expect(decision.summary).toContain("runtime is unavailable");
    expect(traceEvents).toEqual(["unavailable"]);
  });

  it("accepts PASS verdicts even when probe coverage is incomplete", async () => {
    const spawn = vi.fn(async () => "subagent:verify-coverage");
    const waitForResult = vi.fn(async () => ({
      sessionId: "subagent:verify-coverage",
      output: "All good.\nVERDICT: PASS",
      success: true,
      durationMs: 20,
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/workspace/src/main.c" },
          result: '{"ok":true}',
          isError: false,
          durationMs: 2,
        },
      ],
      structuredOutput: {
        type: "json_schema",
        name: "agenc_top_level_verifier_decision",
        parsed: {
          verdict: "pass",
          summary: "Verifier thinks the build is correct.",
        },
      },
      completionState: "completed",
      stopReason: "completed",
    }));

    const decision = await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult(),
      subAgentManager: { spawn, waitForResult },
      verifierService: createVerifierService(
        createVerifierRequirement({
          profiles: ["generic", "cli"],
          probeCategories: ["build", "smoke"],
        }),
      ),
    });

    expect(decision.outcome).toBe("pass");
    expect(decision.summary).toContain("Verifier thinks the build is correct.");
    expect(decision.runtimeVerifier.overall).toBe("pass");
  });

  it("accepts PASS verdicts even when the verifier includes weak green probe output", async () => {
    const spawn = vi.fn(async () => "subagent:verify-weak");
    const waitForResult = vi.fn(async () => ({
      sessionId: "subagent:verify-weak",
      output: "All good.\nVERDICT: PASS",
      success: true,
      durationMs: 20,
      toolCalls: [
        {
          name: "verification.runProbe",
          args: { probeId: "tests:ctest" },
          result: JSON.stringify({
            ok: true,
            exitCode: 0,
            stdout: "",
            stderr: "No tests were found!!!",
            __agencVerification: {
              probeId: "tests:ctest",
              category: "build",
              profile: "generic",
            },
          }),
          isError: false,
          durationMs: 2,
        },
      ],
      structuredOutput: {
        type: "json_schema",
        name: "agenc_top_level_verifier_decision",
        parsed: {
          verdict: "pass",
          summary: "Verifier thinks the build is correct.",
        },
      },
      completionState: "completed",
      stopReason: "completed",
    }));

    const decision = await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult(),
      subAgentManager: { spawn, waitForResult },
      verifierService: createVerifierService(
        createVerifierRequirement({
          profiles: ["generic"],
          probeCategories: ["build"],
        }),
      ),
    });

    expect(decision.outcome).toBe("pass");
    expect(decision.summary).toContain("Verifier thinks the build is correct.");
    expect(decision.runtimeVerifier.overall).toBe("pass");
  });

  it("records remote-job verifier handles when remote isolation is enabled", async () => {
    const spawn = vi.fn(async () => "subagent:verify-remote");
    const waitForResult = vi.fn(async () => ({
      sessionId: "subagent:verify-remote",
      output: "Verifier passed.\nVERDICT: PASS",
      success: true,
      durationMs: 20,
      toolCalls: [
        {
          name: "verification.runProbe",
          args: { probeId: "build" },
          result:
            '{"ok":true,"__agencVerification":{"probeId":"build","category":"build","profile":"generic"}}',
          isError: false,
          durationMs: 2,
        },
      ],
      structuredOutput: {
        type: "json_schema",
        name: "agenc_top_level_verifier_decision",
        parsed: {
          verdict: "pass",
          summary: "Verifier passed with probe-backed evidence.",
        },
      },
      completionState: "completed",
      stopReason: "completed",
    }));
    const remoteJobManager = {
      start: vi.fn(async () => ({
        content: JSON.stringify({
          jobHandleId: "rjob_123",
          remoteJobId: "verifier:session:test:abcd1234",
          serverName: "runtime",
          callback: { authToken: "job-token" },
        }),
      })),
      handleWebhook: vi.fn(async () => ({
        status: 202,
        body: { accepted: true },
      })),
    };

    const decision = await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult({
        runtimeContractSnapshot: createRuntimeContractSnapshot({
          runtimeContractV2: true,
          stopHooksEnabled: false,
          asyncTasksEnabled: true,
          persistentWorkersEnabled: true,
          mailboxEnabled: true,
          verifierRuntimeRequired: true,
          verifierProjectBootstrap: false,
          workerIsolationWorktree: false,
          workerIsolationRemote: true,
        }),
      }),
      subAgentManager: { spawn, waitForResult },
      verifierService: createVerifierService(
        createVerifierRequirement({
          probeCategories: ["build"],
        }),
      ),
      remoteJobManager,
    });

    expect(decision.outcome).toBe("pass");
    expect(decision.launcherKind).toBe("remote_job");
    expect(remoteJobManager.start).toHaveBeenCalled();
    expect(remoteJobManager.handleWebhook).toHaveBeenCalled();
  });

  it("emits spawned and verdict trace events for verifier runs", async () => {
    const traceEvents: Array<Record<string, unknown>> = [];
    const spawn = vi.fn(async () => "subagent:verify-trace");
    const waitForResult = vi.fn(async () => ({
      sessionId: "subagent:verify-trace",
      output: "All good.\nVERDICT: PASS",
      success: true,
      durationMs: 12,
      toolCalls: [
        {
          name: "verification.runProbe",
          args: { probeId: "build:default" },
          result:
            '{"probeId":"build:default","category":"build","profile":"generic"}',
          isError: false,
          durationMs: 1,
        },
      ],
      structuredOutput: {
        type: "json_schema",
        name: "agenc_top_level_verifier_decision",
        parsed: {
          verdict: "pass",
          summary: "Verification passed.",
        },
      },
      completionState: "completed",
      stopReason: "completed",
    }));

    await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult(),
      subAgentManager: { spawn, waitForResult },
      verifierService: createVerifierService(
        createVerifierRequirement({
          profiles: ["generic"],
          probeCategories: [],
        }),
      ),
      onTraceEvent: async (event) => {
        traceEvents.push({
          type: event.type,
          verdict: event.verdict,
        });
      },
    });

    expect(traceEvents).toEqual([
      expect.objectContaining({ type: "spawned" }),
      expect.objectContaining({ type: "verdict", verdict: "pass" }),
    ]);
  });
});
