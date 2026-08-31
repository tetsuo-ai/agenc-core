import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../../src/llm/types.js";
import {
  admittedModelStepId,
  streamModel,
  type StreamModelRequestContract,
} from "../../src/phases/stream-model.js";
import { runTurn } from "../../src/session/run-turn.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";

const CONTEXT_WINDOW_TOKENS = 64_000;
const MAX_OUTPUT_TOKENS = 256;

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

function scriptedProvider(contents: readonly string[]): LLMProvider {
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
    chatStream: async (): Promise<LLMResponse> => {
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

function bindAdmission(session: ReturnType<typeof mkSession>["session"], home: string, cwd: string) {
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

describe("admittedModelStepId", () => {
  test("keeps the first sample stable and forks on nudge or compact", () => {
    const ctx = { subId: "turn-stream" };
    const base = {
      turnCount: 1,
      recoveryReentryCount: 0,
      continuationNudgeCount: 0,
      autoCompactTracking: undefined,
    };

    expect(admittedModelStepId(ctx, base, "primary")).toBe(
      "model:turn-stream:1:0:0:none:primary",
    );
    expect(
      admittedModelStepId(
        ctx,
        { ...base, continuationNudgeCount: 1 },
        "primary",
      ),
    ).toBe("model:turn-stream:1:0:1:none:primary");
    expect(
      admittedModelStepId(
        ctx,
        {
          ...base,
          autoCompactTracking: {
            compacted: true,
            turnId: "auto-context_limit-in_turn-abc",
            turnCounter: 0,
            consecutiveFailures: 0,
          },
        },
        "primary",
      ),
    ).toBe(
      "model:turn-stream:1:0:0:auto-context_limit-in_turn-abc:primary",
    );
  });
});

describe("streamModel admission re-sample identity", () => {
  let home = "";
  let cwd = "";
  let previousHome: string | undefined;

  afterEach(() => {
    if (home.length > 0) rmSync(home, { recursive: true, force: true });
    if (cwd.length > 0) rmSync(cwd, { recursive: true, force: true });
    home = "";
    cwd = "";
    if (previousHome === undefined) delete process.env.AGENC_HOME;
    else process.env.AGENC_HOME = previousHome;
  });

  test("continuation-nudge re-entry acquires a new step instead of conflicting", async () => {
    previousHome = process.env.AGENC_HOME;
    home = mkdtempSync(join(tmpdir(), "agenc-step-id-home-"));
    cwd = mkdtempSync(join(tmpdir(), "agenc-step-id-cwd-"));
    mkdirSync(join(cwd, ".git"));
    process.env.AGENC_HOME = home;

    const provider = scriptedProvider([
      "Now I'll create the file.",
      "All set.",
    ]);
    const { session } = mkSession({
      cwd,
      provider,
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
    const state = buildInitialTurnState(ctx, {
      role: "user",
      content: "implement it",
    });

    try {
      await streamModel(
        state,
        ctx,
        session,
        admittedRequest([{ role: "user", content: "implement it" }]),
      );
      state.continuationNudgeCount += 1;
      state.messages.push({
        role: "user",
        content: "Continue with the task. Use the appropriate tools to proceed.",
      });
      await streamModel(
        state,
        ctx,
        session,
        admittedRequest([
          { role: "user", content: "implement it" },
          { role: "user", content: "Continue with the task." },
        ]),
      );

      const stepIds = admission.client
        .replayJournal?.()
        ?.filter((event) => event.event === "reconciled")
        .map((event) => event.stepId);
      expect(stepIds).toEqual([
        "model:turn-stream:1:0:0:none:primary",
        "model:turn-stream:1:0:1:none:primary",
      ]);
    } finally {
      admission.close();
    }
  });

  test("mid-turn compact re-entry acquires a new step instead of conflicting", async () => {
    previousHome = process.env.AGENC_HOME;
    home = mkdtempSync(join(tmpdir(), "agenc-step-id-home-"));
    cwd = mkdtempSync(join(tmpdir(), "agenc-step-id-cwd-"));
    mkdirSync(join(cwd, ".git"));
    process.env.AGENC_HOME = home;

    const provider = scriptedProvider(["first sample", "after compact"]);
    const { session } = mkSession({
      cwd,
      provider,
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
    const state = buildInitialTurnState(ctx, {
      role: "user",
      content: "fill the window",
    });

    try {
      await streamModel(
        state,
        ctx,
        session,
        admittedRequest([{ role: "user", content: "fill the window" }]),
      );
      state.autoCompactTracking = {
        compacted: true,
        turnId: "auto-context_limit-in_turn-test1",
        turnCounter: 0,
        consecutiveFailures: 0,
      };
      state.messages = [{ role: "user", content: "compacted history" }];
      await streamModel(
        state,
        ctx,
        session,
        admittedRequest([{ role: "user", content: "compacted history" }]),
      );

      const stepIds = admission.client
        .replayJournal?.()
        ?.filter((event) => event.event === "reconciled")
        .map((event) => event.stepId);
      expect(stepIds).toEqual([
        "model:turn-stream:1:0:0:none:primary",
        "model:turn-stream:1:0:0:auto-context_limit-in_turn-test1:primary",
      ]);
    } finally {
      admission.close();
    }
  });
});

describe("runTurn continuation nudge under admission", () => {
  let home = "";
  let cwd = "";
  let previousHome: string | undefined;

  afterEach(() => {
    if (home.length > 0) rmSync(home, { recursive: true, force: true });
    if (cwd.length > 0) rmSync(cwd, { recursive: true, force: true });
    home = "";
    cwd = "";
    if (previousHome === undefined) delete process.env.AGENC_HOME;
    else process.env.AGENC_HOME = previousHome;
  });

  test("a promised-but-not-dispatched turn completes the follow-up sample", async () => {
    previousHome = process.env.AGENC_HOME;
    home = mkdtempSync(join(tmpdir(), "agenc-step-id-home-"));
    cwd = mkdtempSync(join(tmpdir(), "agenc-step-id-cwd-"));
    mkdirSync(join(cwd, ".git"));
    process.env.AGENC_HOME = home;

    const provider = scriptedProvider([
      "Now I'll create the file.",
      "All set.",
    ]);
    const { session } = mkSession({
      cwd,
      provider,
      modelInfo: {
        slug: "grok-4.5",
        contextWindow: CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    });
    const admission = bindAdmission(session, home, cwd);
    try {
      await drain(
        runTurn(
          session,
          mkCtx({
            cwd,
            modelInfo: {
              ...mkCtx().modelInfo,
              slug: "grok-4.5",
              contextWindow: CONTEXT_WINDOW_TOKENS,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
            },
          }),
          "implement the helper",
        ),
      );

      const reconciled = admission.client
        .replayJournal?.()
        ?.filter((event) => event.event === "reconciled")
        .map((event) => event.stepId);
      expect(reconciled?.length).toBeGreaterThanOrEqual(2);
      expect(new Set(reconciled).size).toBe(reconciled?.length);
    } finally {
      admission.close();
    }
  });
});
