import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ChatExecutor } from "./chat-executor.js";
import type { ChatExecuteParams } from "./chat-executor.js";
import { createPromptEnvelope } from "./prompt-envelope.js";
import { evaluateArtifactEvidenceGate } from "./chat-executor-stop-gate.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "./types.js";
import type { GatewayMessage } from "../gateway/message.js";

const WORKSPACE_ROOT = "/tmp/chat-executor-test-workspace";

function mockResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: "mock response",
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: "mock-model",
    finishReason: "stop",
    ...overrides,
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value);
}

function createMockProvider(
  name = "primary",
  overrides: Partial<LLMProvider> = {},
): LLMProvider {
  return {
    name,
    chat: vi
      .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
      .mockResolvedValue(mockResponse()),
    chatStream: vi
      .fn()
      .mockResolvedValue(mockResponse()),
    healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

function createMessage(content = "hello"): GatewayMessage {
  return {
    id: "msg-1",
    channel: "test",
    senderId: "user-1",
    senderName: "Test User",
    sessionId: "session-1",
    content,
    timestamp: Date.now(),
    scope: "dm",
  };
}

function createParams(
  overrides: Partial<ChatExecuteParams> = {},
): ChatExecuteParams {
  return {
    message: createMessage("Implement every phase"),
    history: [],
    promptEnvelope: createPromptEnvelope("You are a helpful assistant."),
    sessionId: "session-1",
    runtimeContext: { workspaceRoot: WORKSPACE_ROOT },
    ...overrides,
  };
}

describe("top-level artifact evidence gate", () => {
  it("forces a recovery tool turn for carried workflow implementation tasks", async () => {
    const activeTaskContext: ActiveTaskContext = {
      version: 1,
      taskLineageId: "task-1",
      contractFingerprint: "carryover-contract",
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      workspaceRoot: WORKSPACE_ROOT,
      sourceArtifacts: [`${WORKSPACE_ROOT}/PLAN.md`],
      targetArtifacts: [
        `${WORKSPACE_ROOT}/src/lexer.c`,
        `${WORKSPACE_ROOT}/src/parser.c`,
      ],
    };

    const provider = createMockProvider("primary", {
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "system.writeFile",
                arguments: safeJson({
                  path: "src/lexer.c",
                  content: "lexer",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content:
              "All phases from PLAN.md have been fully implemented and integrated across the requested workspace files, and the implementation summary is intentionally long enough to avoid truncated-success handling during this acceptance-probe test.",
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-2",
                name: "system.writeFile",
                arguments: safeJson({
                  path: "src/parser.c",
                  content: "parser",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "Implemented lexer and parser with grounded file writes.",
          }),
        ),
    });
    const toolHandler = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      safeJson({ ok: true, path: args.path }),
    );
    const executor = new ChatExecutor({ providers: [provider], toolHandler });

    const result = await executor.execute(
      createParams({
        runtimeContext: {
          workspaceRoot: WORKSPACE_ROOT,
          activeTaskContext,
        },
      }),
    );

    expect(result.stopReason).toBe("completed");
    expect(result.completionState).toBe("completed");
    expect(result.validationCode).toBeUndefined();
    expect(result.toolCalls.filter((call) => call.name === "system.writeFile")).toHaveLength(2);
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[2]?.[1]).toMatchObject({
      toolChoice: "required",
    });
    expect(result.turnExecutionContract.turnClass).toBe("workflow_implementation");
    expect(result.turnExecutionContract.contractFingerprint).toBe("carryover-contract");
    expect(result.activeTaskContext?.taskLineageId).toBe("task-1");
  });

  it("fails the turn when target artifacts are still missing after the allowed attempts", async () => {
    const provider = createMockProvider("primary", {
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "system.writeFile",
                arguments: safeJson({
                  path: "src/lexer.c",
                  content: "lexer",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "All phases from PLAN.md have been fully implemented and integrated.",
          }),
        ),
    });
    const toolHandler = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      safeJson({ ok: true, path: args.path }),
    );
    const executor = new ChatExecutor({ providers: [provider], toolHandler });

    const result = await executor.execute(
      createParams({
        requiredToolEvidence: {
          maxCorrectionAttempts: 0,
          verificationContract: {
            workspaceRoot: WORKSPACE_ROOT,
            targetArtifacts: [
              `${WORKSPACE_ROOT}/src/lexer.c`,
              `${WORKSPACE_ROOT}/src/parser.c`,
            ],
          },
          completionContract: {
            taskClass: "artifact_only",
            placeholdersAllowed: false,
            partialCompletionAllowed: false,
          },
        },
      }),
    );

    expect(result.stopReason).toBe("validation_error");
    expect(result.validationCode).toBe("missing_file_mutation_evidence");
    expect(result.content).toContain(`${WORKSPACE_ROOT}/src/parser.c`);
    expect(result.completionState).toBe("partial");
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("fails closed when an explicit correction cap is spent on another text-only completion claim", async () => {
    const provider = createMockProvider("primary", {
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "system.bash",
                arguments: safeJson({
                  command: "make",
                  args: [],
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "Build succeeded and all phases were fully implemented.",
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "Next I will fix the build and write the remaining files.",
          }),
        ),
    });
    const toolHandler = vi.fn(async (name: string) =>
      name === "system.bash"
        ? safeJson({ exitCode: 2, stderr: "link failed" })
        : safeJson({ ok: true }),
    );
    const executor = new ChatExecutor({ providers: [provider], toolHandler });

    const result = await executor.execute(
      createParams({
        requiredToolEvidence: {
          maxCorrectionAttempts: 1,
        },
      }),
    );

    expect(result.stopReason).toBe("validation_error");
    expect(result.content).toContain("Stop-gate recovery exhausted");
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[2]?.[1]).toMatchObject({
      toolChoice: "required",
    });
  });

  it("exhausts repeated narration-only recoveries after three non-productive continuations", async () => {
    const provider = createMockProvider("primary", {
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "system.bash",
                arguments: safeJson({
                  command: "make",
                  args: [],
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "Build succeeded and all phases were fully implemented.",
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "Next I will fix the build and write the remaining files.",
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "I will now update the failing source files and rerun the build.",
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "I will now update the failing source files and rerun the build.",
          }),
        ),
    });
    const toolHandler = vi.fn(async (name: string) =>
      name === "system.bash"
        ? safeJson({ exitCode: 2, stdout: "", stderr: "link failed" })
        : safeJson({ ok: true }),
    );
    const executor = new ChatExecutor({ providers: [provider], toolHandler });

    const result = await executor.execute(
      createParams({
        runtimeContext: {
          workspaceRoot: WORKSPACE_ROOT,
        },
        requiredToolEvidence: {
          maxCorrectionAttempts: 3,
        },
      }),
    );

    expect(result.stopReason).toBe("validation_error");
    expect(result.content).toContain("Stop-gate recovery exhausted");
    expect(result.toolCalls.filter((call) => call.name === "system.bash")).toHaveLength(1);
    expect(result.toolCalls.filter((call) => call.name === "system.writeFile")).toHaveLength(0);
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[2]?.[1]).toMatchObject({
      toolChoice: "required",
    });
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[3]?.[1]).toMatchObject({
      toolChoice: "required",
    });
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[4]?.[1]).toMatchObject({
      toolChoice: "required",
    });
  });

  it("keeps retrying narrated future-work stop-gate recoveries within the coding correction budget", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-stop-gate-recovery-"));
    const targetPath = join(workspaceRoot, "src/main.c");
    mkdirSync(dirname(targetPath), { recursive: true });
    const provider = createMockProvider("primary", {
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "system.writeFile",
                arguments: safeJson({
                  path: targetPath,
                  content: "phase 1",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "Build succeeded and all phases were fully implemented.",
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "Next I will fix the build and write the remaining files.",
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "I will now update the failing source files and rerun the build.",
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-2",
                name: "system.writeFile",
                arguments: safeJson({
                  path: targetPath,
                  content: "phase 2",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content:
              "Implementation completed with a successful rebuild after the recovery turns, and this summary is intentionally explicit enough to avoid stop-gate truncation handling.",
          }),
        ),
    });
    let writeAttempts = 0;
    const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name !== "system.writeFile") {
        return safeJson({ ok: true });
      }
      writeAttempts += 1;
      writeFileSync(String(args.path), String(args.content ?? ""), "utf8");
      return safeJson({ ok: true, path: String(args.path) });
    });
    const executor = new ChatExecutor({ providers: [provider], toolHandler });

    try {
      const result = await executor.execute(
        createParams({
          runtimeContext: { workspaceRoot },
          requiredToolEvidence: {
            maxCorrectionAttempts: 3,
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(writeAttempts).toBe(2);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(6);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[2]?.[1]).toMatchObject({
        toolChoice: "required",
      });
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[3]?.[1]).toMatchObject({
        toolChoice: "required",
      });
      expect(readFileSync(targetPath, "utf8")).toBe("phase 2");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("re-enters the loop when deterministic acceptance probes fail", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-acceptance-probe-"));
    const sourcePath = join(workspaceRoot, "src/main.c");
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "Makefile"),
      "all:\n\t@if grep -q good src/main.c; then echo ok; else echo build failed >&2; exit 2; fi\n",
      "utf8",
    );

    const provider = createMockProvider("primary", {
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "system.writeFile",
                arguments: safeJson({
                  path: sourcePath,
                  content: "bad build",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "All phases from PLAN.md have been fully implemented and integrated.",
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-2",
                name: "system.writeFile",
                arguments: safeJson({
                  path: sourcePath,
                  content: "good build",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content:
              "Implementation completed with passing acceptance probes after the recovery write, and this completion summary is intentionally verbose so the stop gate does not misclassify it as a truncated success claim.",
          }),
        ),
    });
    const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "system.writeFile") {
        const targetPath = String(args.path);
        writeFileSync(
          targetPath,
          String(args.content ?? ""),
          "utf8",
        );
        return safeJson({ ok: true, path: targetPath });
      }
      return safeJson({ exitCode: 0, stdout: "ok" });
    });
    const executor = new ChatExecutor({ providers: [provider], toolHandler });

    try {
      const result = await executor.execute(
        createParams({
          runtimeContext: { workspaceRoot },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.toolCalls.filter((call) => call.name === "system.writeFile")).toHaveLength(2);
      expect(result.toolCalls.filter((call) => call.name === "verification.runProbe")).toHaveLength(2);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[2]?.[1]).toMatchObject({
        toolChoice: "required",
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps repairing workflow-owned coding turns while deterministic probes remain productive", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-acceptance-budget-"));
    const sourcePath = join(workspaceRoot, "src/main.c");
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "Makefile"),
      "all:\n\t@if grep -q good src/main.c; then echo ok; else echo build failed >&2; exit 2; fi\n",
      "utf8",
    );

    const provider = createMockProvider("primary", {
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "system.writeFile",
                arguments: safeJson({
                  path: sourcePath,
                  content: "still bad build",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "Everything is implemented.",
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-2",
                name: "system.writeFile",
                arguments: safeJson({
                  path: sourcePath,
                  content: "still bad build again",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "Retried the implementation.",
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-3",
                name: "system.writeFile",
                arguments: safeJson({
                  path: sourcePath,
                  content: "good build",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content:
              "Implementation completed with passing acceptance probes after multiple productive repair turns, and this completion summary is intentionally verbose so the stop gate does not misclassify it as a truncated success claim.",
          }),
        ),
    });
    const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "system.writeFile") {
        const targetPath = String(args.path);
        writeFileSync(
          targetPath,
          String(args.content ?? ""),
          "utf8",
        );
        return safeJson({ ok: true, path: targetPath });
      }
      return safeJson({ exitCode: 0, stdout: "ok" });
    });
    const executor = new ChatExecutor({ providers: [provider], toolHandler });

    try {
      const result = await executor.execute(
        createParams({
          runtimeContext: { workspaceRoot },
          requiredToolEvidence: {
            maxCorrectionAttempts: 3,
            verificationContract: {
              workspaceRoot,
              targetArtifacts: [sourcePath],
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.toolCalls.filter((call) => call.name === "system.writeFile")).toHaveLength(3);
      expect(result.toolCalls.filter((call) => call.name === "verification.runProbe")).toHaveLength(3);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(6);
      expect(readFileSync(sourcePath, "utf8")).toBe("good build");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("allows docs-only no-op completions when the target artifact was inspected", () => {
    const decision = evaluateArtifactEvidenceGate({
      runtimeContext: { workspaceRoot: WORKSPACE_ROOT },
      requiredToolEvidence: {
        verificationContract: {
          workspaceRoot: WORKSPACE_ROOT,
          targetArtifacts: [`${WORKSPACE_ROOT}/README.md`],
        },
      },
      allToolCalls: [
        {
          name: "system.readFile",
          args: { path: "README.md" },
          result: safeJson({
            path: `${WORKSPACE_ROOT}/README.md`,
            content: "# Repo\n",
          }),
          isError: false,
          durationMs: 1,
        },
      ],
    });

    expect(decision.shouldIntervene).toBe(false);
  });

  it("allows grounded-read verifier turns when the target artifact was inspected", () => {
    const decision = evaluateArtifactEvidenceGate({
      runtimeContext: { workspaceRoot: WORKSPACE_ROOT },
      requiredToolEvidence: {
        executionEnvelope: {
          workspaceRoot: WORKSPACE_ROOT,
          targetArtifacts: [`${WORKSPACE_ROOT}/src/main.c`],
          verificationMode: "grounded_read",
        },
      },
      allToolCalls: [
        {
          name: "system.readFile",
          args: { path: "src/main.c" },
          result: safeJson({
            path: `${WORKSPACE_ROOT}/src/main.c`,
            content: "int main(void) { return 0; }\n",
          }),
          isError: false,
          durationMs: 1,
        },
      ],
    });

    expect(decision.shouldIntervene).toBe(false);
  });

  it("fails closed inside the executor when runtime-owned top-level verification cannot start", async () => {
    rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    mkdirSync(join(WORKSPACE_ROOT, "src"), { recursive: true });
    const provider = createMockProvider("primary", {
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "system.writeFile",
                arguments: safeJson({
                  path: "src/main.c",
                  content: "int main(void) { return 0; }\n",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "Applied changes summary.",
          }),
        ),
    });
    const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "system.writeFile") {
        const relativePath = typeof args.path === "string" ? args.path : "";
        const content = typeof args.content === "string" ? args.content : "";
        const absolutePath = join(WORKSPACE_ROOT, relativePath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, content, "utf8");
      }
      return safeJson({ ok: true, path: args.path });
    });
    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler,
      runtimeContractFlags: {
        runtimeContractV2: true,
        stopHooksEnabled: false,
        asyncTasksEnabled: false,
        persistentWorkersEnabled: false,
        mailboxEnabled: false,
        verifierRuntimeRequired: true,
        verifierProjectBootstrap: false,
        workerIsolationWorktree: false,
        workerIsolationRemote: false,
      },
      completionValidation: {
        topLevelVerifier: {
          subAgentManager: {
            spawn: vi.fn(async () => {
              throw new Error("verifier unavailable");
            }),
            waitForResult: vi.fn(async () => null),
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

    const result = await executor.execute(
      createParams({
        requiredToolEvidence: {
          maxCorrectionAttempts: 1,
          verificationContract: {
            workspaceRoot: WORKSPACE_ROOT,
            targetArtifacts: [`${WORKSPACE_ROOT}/src/main.c`],
            completionContract: {
              taskClass: "build_required",
              placeholdersAllowed: false,
              partialCompletionAllowed: false,
            },
          },
        },
      }),
    );

    expect(result.stopReason).toBe("validation_error");
    expect(result.completionState).toBe("partial");
    expect(result.verifierSnapshot?.overall).toBe("retry");
    expect(result.runtimeContractSnapshot?.verifier.overall).toBe("retry");
    expect(result.content).toContain("Top-level verifier worker could not be started.");
  });
});
