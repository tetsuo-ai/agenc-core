import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "../../src/llm/types.js";
import {
  resumeTurnFromCheckpoint,
  type DurableResumeAttempt,
} from "../../src/conversation/thread-manager.js";
import {
  admittedModelStepId,
  streamModel,
  type StreamModelRequestContract,
} from "../../src/phases/stream-model.js";
import {
  DURABLE_CHECKPOINT_WRITE_VERSION,
  readTurnCheckpoint,
} from "../../src/session/durable-checkpoint-reader.js";
import type { RolloutReconstruction } from "../../src/session/rollout-reconstruction.js";
import { runTurn } from "../../src/session/run-turn.js";
import type {
  PreparedProviderBinding,
  ProviderBinding,
} from "../../src/session/provider-service.js";
import {
  advanceModelSampleOrdinal,
  buildInitialTurnState,
} from "../../src/session/turn-state.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";

const CONTEXT_WINDOW_TOKENS = 64_000;
const MAX_OUTPUT_TOKENS = 256;
const EMPTY_RESPONSE_RETRY_TEXT =
  "Your previous response contained no visible final answer. " +
  "Return the final answer now in the assistant output channel.";

function admittedRequest(
  input: readonly LLMMessage[],
): StreamModelRequestContract {
  return {
    input,
    tools: [],
    parallelToolCalls: false,
    baseInstructions: "",
    contextWindowTokens: CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };
}

function scriptedProvider(
  contents: readonly string[],
  onCall?: (messages: readonly LLMMessage[], index: number) => void,
): LLMProvider {
  let calls = 0;
  return {
    name: "grok",
    getExecutionProfile: async () => ({
      provider: "grok",
      model: "grok-4.5",
      contextWindowTokens: CONTEXT_WINDOW_TOKENS,
      usageReporting: "authoritative" as const,
      supportsMaxOutputTokens: true,
    }),
    chat: async () => {
      throw new Error("chat must not run");
    },
    chatStream: async (messages): Promise<LLMResponse> => {
      onCall?.(messages, calls);
      const content = contents[Math.min(calls, contents.length - 1)] ?? "done";
      calls += 1;
      return {
        content,
        toolCalls: [],
        usage: {
          promptTokens: 8,
          completionTokens: 4,
          totalTokens: 12,
          availability: "reported",
          provenance: "provider",
        },
        model: "grok-4.5",
        finishReason: "stop",
      };
    },
    healthCheck: async () => true,
  } as LLMProvider;
}

function routedProvider(params: {
  readonly name: string;
  readonly model: string;
  readonly endpoint: string;
  readonly onCall: (optionsModel: string | undefined) => void;
}): LLMProvider {
  return {
    name: params.name,
    config: { model: params.model, baseURL: params.endpoint },
    getExecutionProfile: async () => ({
      provider: params.name,
      model: params.model,
      contextWindowTokens: CONTEXT_WINDOW_TOKENS,
      usageReporting: "authoritative" as const,
      supportsMaxOutputTokens: true,
    }),
    chat: async () => {
      throw new Error("chat must not run");
    },
    chatStream: async (_messages, _onChunk, options): Promise<LLMResponse> => {
      params.onCall(options?.model);
      return {
        content: "resumed on the fallback route",
        toolCalls: [],
        usage: {
          promptTokens: 8,
          completionTokens: 4,
          totalTokens: 12,
          availability: "reported",
          provenance: "provider",
        },
        model: params.model,
        finishReason: "stop",
      };
    },
    healthCheck: async () => true,
  } as LLMProvider;
}

function binding(
  provider: string,
  model: string,
  instance: LLMProvider,
  revision: number,
): ProviderBinding {
  return Object.freeze({
    provider,
    model,
    instance,
    factoryOptions: Object.freeze({ model }),
    revision,
  });
}

function fallbackReconstruction(params: {
  readonly provider: string;
  readonly model: string;
}): RolloutReconstruction {
  return {
    history: [{ role: "user", content: "continue after fallback" }],
    resumableTurns: [
      {
        turnId: "turn-cross-provider-resume",
        buildMatches: true,
        historyPrefixValid: true,
        checkpointIntegrityStatus: "valid",
        lastCheckpoint: {
          iterationIndex: 0,
          checkpointSeq: 1,
          persistedMessageCount: 1,
          prefixHash: "a".repeat(64),
          resumableState: {
            turnCount: 1,
            recoveryReentryCount: 0,
            maxOutputTokensRecoveryCount: 0,
            continuationNudgeCount: 0,
            stopHookBlockingCount: 0,
            modelSampleOrdinal: 1,
            pendingAdmissionFallback: {
              fromModel: "grok-4.5",
              fromProvider: "grok",
              toModel: params.model,
              toProvider: params.provider,
              reason: "provider_fallback_ladder",
            },
          },
        },
        danglingToolUses: [],
      },
    ],
  } as unknown as RolloutReconstruction;
}

function bindAdmission(
  session: ReturnType<typeof mkSession>["session"],
  home: string,
  cwd: string,
) {
  const kernel = new ExecutionAdmissionKernel({
    agencHome: home,
    ownerId: "admitted-model-step-id",
    ownerPid: process.pid,
  });
  const client = kernel.bindClient({
    cwd,
    scope: {
      runId: session.conversationId,
      sessionId: session.conversationId,
      autonomous: false,
    },
  });
  Object.assign(session.services, {
    executionAdmission: client,
    admissionRequired: true,
    agentControl: {
      shutdownAgentTree: async () => undefined,
    },
  });
  Object.assign(session.config, { model: "grok-4.5" });
  return {
    client,
    close(): void {
      kernel.close();
    },
  };
}

interface AdmittedHarness {
  readonly session: ReturnType<typeof mkSession>["session"];
  readonly admission: ReturnType<typeof bindAdmission>;
  readonly ctx: ReturnType<typeof mkCtx>;
}

async function withAdmittedHarness(
  contents: readonly string[],
  body: (harness: AdmittedHarness) => Promise<void>,
  onCall?: (messages: readonly LLMMessage[], index: number) => void,
): Promise<void> {
  const previousHome = process.env.AGENC_HOME;
  const home = mkdtempSync(join(tmpdir(), "agenc-step-id-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "agenc-step-id-cwd-"));
  mkdirSync(join(cwd, ".git"));
  process.env.AGENC_HOME = home;
  const { session } = mkSession({
    cwd,
    provider: scriptedProvider(contents, onCall),
    modelInfo: {
      slug: "grok-4.5",
      contextWindow: CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  });
  const admission = bindAdmission(session, home, cwd);
  const ctx = mkCtx({
    subId: "turn-stream",
    cwd,
    modelInfo: {
      ...mkCtx().modelInfo,
      slug: "grok-4.5",
      contextWindow: CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  });
  try {
    await body({ session, admission, ctx });
  } finally {
    admission.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENC_HOME;
    else process.env.AGENC_HOME = previousHome;
  }
}

function captureTurnCheckpoints(
  session: ReturnType<typeof mkSession>["session"],
  onCheckpoint?: (payload: Record<string, unknown>) => void,
): Array<Record<string, unknown>> {
  const checkpoints: Array<Record<string, unknown>> = [];
  session.rolloutStore = {
    assertCompactionProjectionReady: () => {},
    append: (event: unknown) => {
      const envelope = event as {
        msg?: { type?: string; payload?: Record<string, unknown> };
      };
      if (
        envelope.msg?.type === "turn_checkpoint" &&
        envelope.msg.payload !== undefined
      ) {
        checkpoints.push(envelope.msg.payload);
        onCheckpoint?.(envelope.msg.payload);
      }
    },
    appendRollout: () => {},
    rolloutPath: "/tmp/admitted-model-step-id.jsonl",
  } as never;
  return checkpoints;
}

function reconciledStepIds(
  admission: ReturnType<typeof bindAdmission>,
): string[] | undefined {
  return admission.client
    .replayJournal?.()
    ?.filter((event) => event.event === "reconciled")
    .map((event) => event.stepId);
}

describe("admitted model sample identity", () => {
  test("keeps the upgrade-compatible first id and bounds later ordinals", () => {
    const ctx = { subId: "turn-stream" };
    const base = {
      turnCount: 1,
      recoveryReentryCount: 0,
      modelSampleOrdinal: 0,
    };

    expect(admittedModelStepId(ctx, base, "primary")).toBe(
      "model:turn-stream:1:0:primary",
    );
    expect(
      admittedModelStepId(ctx, { ...base, modelSampleOrdinal: 1 }, "primary"),
    ).toBe("model:turn-stream:1:0:sample-1:primary");

    const state = buildInitialTurnState(mkCtx(), {
      role: "user",
      content: "test",
    });
    state.modelSampleOrdinal = Number.MAX_SAFE_INTEGER;
    expect(() => advanceModelSampleOrdinal(state)).toThrow(
      "model sample ordinal is exhausted",
    );
  });

  test("assigns distinct ids after a nudge and compact replacement", async () => {
    await withAdmittedHarness(
      ["first sample", "after nudge", "after compact"],
      async ({ session, admission, ctx }) => {
        const state = buildInitialTurnState(ctx, {
          role: "user",
          content: "implement it",
        });
        const sample = async (content: string): Promise<void> => {
          await streamModel(
            state,
            ctx,
            session,
            admittedRequest([{ role: "user", content }]),
          );
        };

        await sample("implement it");
        advanceModelSampleOrdinal(state);
        await sample("continue");
        state.autoCompactTracking = {
          compacted: true,
          turnId: "auto-context_limit-in_turn-test1",
          turnCounter: 0,
          consecutiveFailures: 0,
        };
        advanceModelSampleOrdinal(state);
        await sample("compacted history");

        expect(reconciledStepIds(admission)).toEqual([
          "model:turn-stream:1:0:primary",
          "model:turn-stream:1:0:sample-1:primary",
          "model:turn-stream:1:0:sample-2:primary",
        ]);
      },
    );
  });

  test("checkpoints a continuation nudge before the follow-up admission", async () => {
    const timeline: string[] = [];
    await withAdmittedHarness(
      ["Now I'll create the file.", "All set."],
      async ({ session, admission, ctx }) => {
        const checkpoints = captureTurnCheckpoints(session, (payload) => {
          const state = payload.resumableState as
            { modelSampleOrdinal?: number } | undefined;
          if (state?.modelSampleOrdinal !== undefined) {
            timeline.push(`checkpoint:${state.modelSampleOrdinal}`);
          }
        });

        await drain(runTurn(session, ctx, "implement the helper"));

        expect(reconciledStepIds(admission)).toEqual([
          "model:turn-stream:1:0:primary",
          "model:turn-stream:1:0:sample-1:primary",
        ]);
        expect(timeline.indexOf("checkpoint:1")).toBeGreaterThan(
          timeline.indexOf("provider:0"),
        );
        expect(timeline.indexOf("checkpoint:1")).toBeLessThan(
          timeline.indexOf("provider:1"),
        );
        const modelSampleCheckpoint = checkpoints.find(
          (checkpoint) =>
            checkpoint.boundary === "iteration" &&
            (checkpoint.resumableState as { modelSampleOrdinal?: number })
              .modelSampleOrdinal === 1,
        );
        expect(readTurnCheckpoint(modelSampleCheckpoint)).toMatchObject({
          version: DURABLE_CHECKPOINT_WRITE_VERSION,
          checkpoint: {
            boundary: "iteration",
            resumableState: {
              modelSampleOrdinal: 1,
              modelSampleResumePrompt: "continuation_nudge",
            },
          },
        });
      },
      (_messages, index) => timeline.push(`provider:${index}`),
    );
  });

  test("checkpoints one empty-response retry with a new id", async () => {
    const seen: LLMMessage[][] = [];
    await withAdmittedHarness(
      ["", "final answer"],
      async ({ session, admission, ctx }) => {
        const checkpoints = captureTurnCheckpoints(session);
        await drain(runTurn(session, ctx, "answer the question"));

        expect(seen).toHaveLength(2);
        expect(seen[1]).toContainEqual({
          role: "user",
          content: EMPTY_RESPONSE_RETRY_TEXT,
        });
        expect(reconciledStepIds(admission)).toEqual([
          "model:turn-stream:1:0:primary",
          "model:turn-stream:1:0:sample-1:primary",
        ]);
        expect(checkpoints).toContainEqual(
          expect.objectContaining({
            boundary: "iteration",
            resumableState: expect.objectContaining({
              modelSampleOrdinal: 1,
              modelSampleResumePrompt: "empty_response",
            }),
          }),
        );
      },
      (messages) => seen.push(messages.map((message) => ({ ...message }))),
    );
  });

  test("resumes a reserved sample with its runtime prompt and exact id", async () => {
    const seen: LLMMessage[][] = [];
    await withAdmittedHarness(
      ["finished"],
      async ({ session, admission, ctx }) => {
        captureTurnCheckpoints(session);
        const history: LLMMessage[] = [
          { role: "user", content: "implement it" },
          { role: "assistant", content: "Now I'll create the file." },
        ];

        await drain(
          runTurn(session, ctx, "", {
            history,
            displayUserMessage: null,
            resume: {
              turnId: ctx.subId,
              fromIteration: 0,
              fromCheckpointSeq: 1,
              persistedMessageCount: history.length,
              restoreSlice: {
                turnCount: 1,
                recoveryReentryCount: 0,
                maxOutputTokensRecoveryCount: 0,
                continuationNudgeCount: 1,
                stopHookBlockingCount: 0,
                modelSampleOrdinal: 1,
                modelSampleResumePrompt: "continuation_nudge",
              },
            },
          }),
        );

        expect(seen).toHaveLength(1);
        expect(seen[0]).toContainEqual({
          role: "user",
          content:
            "Continue with the task. Use the appropriate tools to proceed.",
        });
        expect(reconciledStepIds(admission)).toEqual([
          "model:turn-stream:1:0:sample-1:primary",
        ]);
      },
      (messages) => seen.push(messages.map((message) => ({ ...message }))),
    );
  });

  test("restores a cross-provider fallback before resumed dispatch and admission", async () => {
    const previousHome = process.env.AGENC_HOME;
    const home = mkdtempSync(join(tmpdir(), "agenc-fallback-resume-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-fallback-resume-cwd-"));
    mkdirSync(join(cwd, ".git"));
    process.env.AGENC_HOME = home;

    const oldCalls: Array<string | undefined> = [];
    const fallbackCalls: Array<string | undefined> = [];
    const oldProvider = routedProvider({
      name: "grok",
      model: "grok-4.5",
      endpoint: "https://old-provider.invalid/v1",
      onCall: (model) => oldCalls.push(model),
    });
    const fallbackProvider = routedProvider({
      name: "openai",
      model: "gpt-5",
      endpoint: "https://fallback-provider.invalid/v1",
      onCall: (model) => fallbackCalls.push(model),
    });
    let activeBinding = binding("grok", "grok-4.5", oldProvider, 0);
    const prepare = vi.fn(
      async (selection: {
        readonly provider: string;
        readonly model: string;
      }): Promise<PreparedProviderBinding> => ({
        expectedRevision: activeBinding.revision,
        managedDefaultOutputCap: false,
        binding: binding(
          selection.provider,
          selection.model,
          fallbackProvider,
          activeBinding.revision + 1,
        ),
      }),
    );
    const commit = vi.fn((prepared: PreparedProviderBinding) => {
      if (prepared.expectedRevision !== activeBinding.revision) {
        throw new Error("stale provider preparation");
      }
      activeBinding = prepared.binding;
      return activeBinding;
    });
    const providerService = {
      current: () => activeBinding,
      environment: () => ({}),
      prepare,
      commit,
    };
    const { session, events } = mkSession({
      cwd,
      provider: oldProvider,
      services: {
        providerService: providerService as never,
        modelsManager: {
          getModelInfo: async (model: string) => ({
            slug: model,
            effectiveContextWindowPercent: 100,
            contextWindow: CONTEXT_WINDOW_TOKENS,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            supportedReasoningLevels: [],
            defaultReasoningSummary: "auto",
            truncationPolicy: "off",
            usedFallbackModelMetadata: false,
          }),
        } as never,
      },
      modelInfo: {
        slug: "grok-4.5",
        contextWindow: CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    });
    Object.assign(session.config, {
      model: "grok-4.5",
      durableTurns: {
        checkpoint: { enabled: false },
        resume: {
          onRestart: true,
          requireLease: false,
          buildPinning: false,
        },
      },
    });
    const admission = bindAdmission(session, home, cwd);

    try {
      const attempt: DurableResumeAttempt = await resumeTurnFromCheckpoint(
        session,
        fallbackReconstruction({ provider: "openai", model: "gpt-5" }),
      );

      expect(attempt).toEqual({ resumed: true });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5",
      });
      expect(commit).toHaveBeenCalledTimes(1);
      expect(session.providerBinding).toMatchObject({
        provider: "openai",
        model: "gpt-5",
      });
      expect(oldCalls).toEqual([]);
      const journal = admission.client.replayJournal?.() ?? [];
      expect(fallbackCalls).toEqual(["gpt-5"]);
      expect(session.pendingProviderSwitch).toBeNull();
      expect(events).toContainEqual(
        expect.objectContaining({
          msg: {
            type: "turn_context",
            payload: expect.objectContaining({
              model: "gpt-5",
              modelProviderId: "openai",
            }),
          },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          msg: {
            type: "token_count",
            payload: expect.objectContaining({
              model: "gpt-5",
              provider: "openai",
            }),
          },
        }),
      );
      expect(journal).toContainEqual(
        expect.objectContaining({
          event: "fallback",
          stepId: "model:turn-cross-provider-resume:1:0:sample-1:primary",
          provider: "openai",
          model: "gpt-5",
          reason: "provider_fallback_ladder",
          details: expect.objectContaining({
            fromProvider: "grok",
            fromModel: "grok-4.5",
            toProvider: "openai",
            toModel: "gpt-5",
          }),
        }),
      );
      expect(
        journal.filter((event) => event.event === "fallback"),
      ).toHaveLength(1);
      expect(reconciledStepIds(admission)).toContain(
        "model:turn-cross-provider-resume:1:0:sample-1:primary",
      );
    } finally {
      admission.close();
      await session.shutdown();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = previousHome;
    }
  });

  test("keeps an already-restored fallback route without rebuilding it", async () => {
    const prepareProviderSwitch = vi.fn();
    const stagePreparedProviderSwitch = vi.fn();
    const consumePendingProviderSwitch = vi.fn();
    const runTurn = vi.fn(async function* () {
      return { reason: "completed" as const };
    });
    const session = {
      config: {
        durableTurns: {
          resume: {
            onRestart: true,
            requireLease: false,
            buildPinning: false,
          },
        },
      },
      pendingProviderSwitch: null,
      providerBinding: {
        provider: "grok",
        model: "grok-4.5",
      },
      prepareProviderSwitch,
      stagePreparedProviderSwitch,
      consumePendingProviderSwitch,
      services: { registry: { tools: [] } },
      runTurn,
    } as unknown as Parameters<typeof resumeTurnFromCheckpoint>[0];

    await expect(
      resumeTurnFromCheckpoint(
        session,
        fallbackReconstruction({ provider: "grok", model: "grok-4.5" }),
      ),
    ).resolves.toEqual({ resumed: true });
    expect(prepareProviderSwitch).not.toHaveBeenCalled();
    expect(stagePreparedProviderSwitch).not.toHaveBeenCalled();
    expect(consumePendingProviderSwitch).not.toHaveBeenCalled();
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  test("preserves a pre-existing pending switch even when its route matches the checkpoint", async () => {
    const pending = Object.freeze({ provider: "openai", model: "gpt-5" });
    const prepareProviderSwitch = vi.fn();
    const consumePendingProviderSwitchTransaction = vi.fn();
    const runTurn = vi.fn();
    const session = {
      config: {
        durableTurns: {
          resume: {
            onRestart: true,
            requireLease: false,
            buildPinning: false,
          },
        },
      },
      pendingProviderSwitch: pending,
      providerBinding: {
        provider: "grok",
        model: "grok-4.5",
      },
      prepareProviderSwitch,
      stagePreparedProviderSwitch: vi.fn(),
      consumePendingProviderSwitchTransaction,
      emit: vi.fn(),
      nextInternalSubId: () => "provider-restore-pending",
      services: { registry: { tools: [] } },
      runTurn,
    } as unknown as Parameters<typeof resumeTurnFromCheckpoint>[0];

    await expect(
      resumeTurnFromCheckpoint(
        session,
        fallbackReconstruction({ provider: "openai", model: "gpt-5" }),
      ),
    ).resolves.toEqual({
      resumed: false,
      reason: "provider-restore-failed",
    });
    expect(session.pendingProviderSwitch).toBe(pending);
    expect(prepareProviderSwitch).not.toHaveBeenCalled();
    expect(consumePendingProviderSwitchTransaction).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });

  test("declines resume when the fallback provider cannot be restored", async () => {
    const emit = vi.fn();
    const runTurn = vi.fn();
    const session = {
      config: {
        durableTurns: {
          resume: {
            onRestart: true,
            requireLease: false,
            buildPinning: false,
          },
        },
      },
      pendingProviderSwitch: null,
      providerBinding: {
        provider: "grok",
        model: "grok-4.5",
      },
      prepareProviderSwitch: vi
        .fn()
        .mockRejectedValue(new Error("fallback endpoint is unavailable")),
      stagePreparedProviderSwitch: vi.fn(),
      consumePendingProviderSwitch: vi.fn(),
      emit,
      nextInternalSubId: () => "provider-restore-failed",
      services: { registry: { tools: [] } },
      runTurn,
    } as unknown as Parameters<typeof resumeTurnFromCheckpoint>[0];

    await expect(
      resumeTurnFromCheckpoint(
        session,
        fallbackReconstruction({ provider: "openai", model: "gpt-5" }),
      ),
    ).resolves.toEqual({
      resumed: false,
      reason: "provider-restore-failed",
    });
    expect(runTurn).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: {
          type: "warning",
          payload: {
            cause: "durable_resume_provider_restore_failed",
            message: expect.stringContaining(
              "fallback endpoint is unavailable",
            ),
          },
        },
      }),
    );
  });

  test("marks rollback failure as unsafe for startup fresh-turn fallback", async () => {
    const runTurn = vi.fn();
    const terminalReason =
      "provider state publication failed; rollback failed: live revision changed";
    const session = {
      config: {
        durableTurns: {
          resume: {
            onRestart: true,
            requireLease: false,
            buildPinning: false,
          },
        },
      },
      pendingProviderSwitch: null,
      providerBinding: {
        provider: "grok",
        model: "grok-4.5",
      },
      prepareProviderSwitch: vi.fn(
        async (pending: {
          readonly provider: string;
          readonly model: string;
        }) => ({
          pending,
        }),
      ),
      stagePreparedProviderSwitch: vi.fn(),
      consumePendingProviderSwitchTransaction: vi.fn(async () => ({
        status: "terminal-failure" as const,
        reason: terminalReason,
      })),
      emit: vi.fn(),
      nextInternalSubId: () => "provider-restore-terminal",
      services: { registry: { tools: [] } },
      runTurn,
    } as unknown as Parameters<typeof resumeTurnFromCheckpoint>[0];

    await expect(
      resumeTurnFromCheckpoint(
        session,
        fallbackReconstruction({ provider: "openai", model: "gpt-5" }),
      ),
    ).resolves.toEqual({
      resumed: false,
      reason: "provider-restore-failed",
      freshTurnAllowed: false,
      failureDetail: terminalReason,
    });
    expect(runTurn).not.toHaveBeenCalled();
  });
});
