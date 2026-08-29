import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { runTurn } from "../../src/session/run-turn.js";
import { SessionStore } from "../../src/session/session-store.js";
import type { SessionServices } from "../../src/session/session.js";
import type { RuntimeMessage } from "../../src/services/compact/types.js";
import { createProvider } from "../helpers/compaction-transaction-harness.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";

const SOURCE_MESSAGE_COUNT = 8;
const SOURCE_MESSAGE_BYTES = 4_000;
const SESSION_ID = "conv-test";
const REVIEWED_SESSION_ID = "conv-test-reviewed-compaction-source";
const USER_MESSAGE = "continue after automatic compaction";

const COMPACTION_ENVIRONMENT_KEYS = [
  "AGENC_AUTO_COMPACT_WINDOW",
  "AGENC_AUTOCOMPACT_PCT_OVERRIDE",
  "AGENC_DISABLE_COMPACT",
  "AGENC_DISABLE_AUTO_COMPACT",
] as const;

describe("runTurn automatic compaction rollback wiring", () => {
  it("drives the production transaction boundary before requiring a reviewed rollback for later model work", async () => {
    const environment = saveCompactionEnvironment();
    const source = createSourceMessages();
    enableAutomaticCompaction();
    const harness = createRunTurnHarness(source);
    try {
      const modelInfo = {
        ...mkCtx().modelInfo,
        slug: "grok-4.5",
        contextWindow: 64_000,
        maxOutputTokens: 512,
        autoCompactTokenLimit: 1,
      };

      await drain(
        runTurn(
          harness.session,
          mkCtx({
            cwd: harness.cwd,
            modelInfo,
          }),
          USER_MESSAGE,
        ),
      );

      const rows = harness.store.readAll();
      const intentIndex = rows.findIndex(
        (item) => item.type === "compaction_intent",
      );
      const commitIndex = rows.findIndex(
        (item) => item.type === "compaction_committed",
      );
      const boundaryIndexes = rows.flatMap((item, index) =>
        item.type === "event_msg" &&
        item.payload.msg.type === "context_compacted"
          ? [index]
          : [],
      );
      expect(intentIndex).toBeGreaterThanOrEqual(0);
      expect(commitIndex).toBeGreaterThan(intentIndex);
      expect(rows[intentIndex]).toMatchObject({
        type: "compaction_intent",
        payload: { automatic: true },
      });
      expect(boundaryIndexes).toHaveLength(1);
      expect(boundaryIndexes[0]).toBeGreaterThan(commitIndex);
      expect(rows[boundaryIndexes[0]! + 1]?.type).toBe("session_meta");

      const committed = rows[commitIndex];
      if (committed?.type !== "compaction_committed") {
        throw new Error("production runTurn did not commit compaction");
      }
      const attemptId = committed.payload.attempt_id;
      expect(() =>
        harness.store.rollbackCompaction({
          attemptId,
          nowMs: Date.now(),
        }),
      ).toThrow(/requires an explicit reviewed branch target/i);

      const rollback = await harness.session.rollbackCompaction({
        attemptId,
        reviewedBranchTargetSessionId: REVIEWED_SESSION_ID,
      });
      expect(rollback).toMatchObject({
        ok: true,
        mode: "reviewed_branch",
        targetSessionId: REVIEWED_SESSION_ID,
      });

      const reviewed = new SessionStore({
        cwd: harness.cwd,
        sessionId: REVIEWED_SESSION_ID,
        agencVersion: "0.13.0",
        resume: true,
      });
      try {
        expect(reconstructFromRollout(reviewed.readAll()).history).toEqual(
          expectedSourceHistory([
            ...source,
            { role: "user", content: USER_MESSAGE },
          ]),
        );
      } finally {
        reviewed.close();
      }
    } finally {
      harness.close();
      restoreCompactionEnvironment(environment);
    }
  });
});

interface RunTurnHarness {
  readonly cwd: string;
  readonly session: ReturnType<typeof mkSession>["session"];
  readonly store: RolloutStore;
  close(): void;
}

function createRunTurnHarness(
  source: readonly RuntimeMessage[],
): RunTurnHarness {
  const previousHome = process.env.AGENC_HOME;
  const home = mkdtempSync(join(tmpdir(), "agenc-c2-run-turn-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-run-turn-workspace-"));
  mkdirSync(join(cwd, ".git"));
  process.env.AGENC_HOME = home;

  const store = new RolloutStore({
    cwd,
    sessionId: SESSION_ID,
    agencVersion: "0.13.0",
    sessionTempRoot: tmpdir(),
    autoStartScheduler: false,
  });
  store.open({
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    cwd,
    originator: "c2-run-turn-contract",
    agencVersion: "0.13.0",
    model: "grok-4.5",
    modelProvider: "grok",
  });
  for (const message of source) {
    store.appendRollout(
      {
        type: "response_item",
        payload: {
          role: message.role ?? "user",
          content: message.content ?? "",
        },
      },
      { durable: true },
    );
  }

  const provider = createProvider(compactionAwareProviderResponse);
  const { session } = mkSession({
    provider,
    services: {
      providerEnvironment: Object.fromEntries(
        COMPACTION_ENVIRONMENT_KEYS.flatMap((key) =>
          process.env[key] === undefined ? [] : [[key, process.env[key]]],
        ),
      ),
    },
    history: source as readonly LLMMessage[],
    modelInfo: {
      slug: "grok-4.5",
      contextWindow: 64_000,
      maxOutputTokens: 512,
      autoCompactTokenLimit: 1,
    },
  });
  const kernel = new ExecutionAdmissionKernel({
    agencHome: home,
    ownerId: "c2-run-turn-contract",
    ownerPid: process.pid,
  });
  const admission = kernel.bindClient({
    cwd,
    scope: {
      runId: SESSION_ID,
      sessionId: SESSION_ID,
      autonomous: false,
    },
  });
  Object.assign(session.services as SessionServices, {
    executionAdmission: admission,
    admissionRequired: true,
  });
  session.mountRolloutStore(store);
  const unbindAdmission = bindExecutionAdmissionJournal(session, admission);

  let closed = false;
  return {
    cwd,
    session,
    store,
    close: () => {
      if (closed) return;
      closed = true;
      unbindAdmission();
      kernel.close();
      session.mountRolloutStore(null);
      store.close();
      if (previousHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

async function compactionAwareProviderResponse(
  messages: LLMMessage[],
): Promise<LLMResponse> {
  const firstContent = messages[0]?.content;
  if (typeof firstContent === "string") {
    try {
      const payload = JSON.parse(firstContent) as {
        readonly units?: ReadonlyArray<{
          readonly messages: ReadonlyArray<{
            readonly tool_call_id?: string;
            readonly tool_result_sha256?: string;
          }>;
        }>;
        readonly summaries?: ReadonlyArray<{
          readonly body: {
            readonly tool_pairs: ReadonlyArray<{
              readonly tool_call_id: string;
              readonly result_sha256: string;
            }>;
          };
        }>;
        readonly children?: ReadonlyArray<{
          readonly body: {
            readonly tool_pairs: ReadonlyArray<{
              readonly tool_call_id: string;
              readonly result_sha256: string;
            }>;
          };
        }>;
      };
      if (
        !Array.isArray(payload.units) &&
        !Array.isArray(payload.summaries) &&
        !Array.isArray(payload.children)
      ) {
        throw new Error("not a structured compaction request");
      }
      const toolPairs =
        payload.units?.flatMap((unit) =>
          unit.messages
            .filter(
              (message) =>
                message.tool_call_id !== undefined &&
                message.tool_result_sha256 !== undefined,
            )
            .map((message) => ({
              tool_call_id: message.tool_call_id!,
              result_sha256: message.tool_result_sha256!,
            })),
        ) ??
        payload.summaries?.flatMap((summary) => summary.body.tool_pairs) ??
        payload.children?.flatMap((summary) => summary.body.tool_pairs) ??
        [];
      return providerResponse(
        JSON.stringify({
          narrative: "Bounded summary.",
          facts: [],
          open_actions: [],
          tool_pairs: toolPairs,
        }),
        "grok-4.5",
        128,
      );
    } catch {
      // Normal runTurn sampling is not a structured compaction request.
    }
  }
  return providerResponse("post-compaction response", "test-model", 8);
}

function providerResponse(
  content: string,
  model: string,
  tokens: number,
): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: {
      promptTokens: tokens,
      completionTokens: tokens,
      totalTokens: tokens * 2,
      availability: "reported",
      provenance: "provider",
    },
    model,
    finishReason: "stop",
  };
}

function createSourceMessages(): RuntimeMessage[] {
  return Array.from({ length: SOURCE_MESSAGE_COUNT }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `source-${index}:${"x".repeat(SOURCE_MESSAGE_BYTES)}`,
  }));
}

function expectedSourceHistory(source: readonly RuntimeMessage[]) {
  return source.map((message) => ({
    role: message.role ?? "user",
    content: message.content ?? "",
  }));
}

function saveCompactionEnvironment(): ReadonlyMap<string, string | undefined> {
  return new Map(
    COMPACTION_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
}

function enableAutomaticCompaction(): void {
  process.env.AGENC_AUTO_COMPACT_WINDOW = "1000";
  process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE = "50";
  delete process.env.AGENC_DISABLE_COMPACT;
  delete process.env.AGENC_DISABLE_AUTO_COMPACT;
}

function restoreCompactionEnvironment(
  environment: ReadonlyMap<string, string | undefined>,
): void {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
