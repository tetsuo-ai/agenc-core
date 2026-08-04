import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalCompactionSourceMessages,
  compactionMapReduceTopology,
} from "../../../src/services/compact/plan.js";
import {
  canonicalizeJson,
  createCompactionSummaryV1,
  parseCompactionBodyV1,
  verifyCompactionSummaryDigest,
} from "../../../src/services/compact/summary-v1.js";
import { compactionOutputTokenUpperBound } from "../../../src/services/compact/transaction.js";
import { compactConversationTransactionally } from "../../../src/services/compact/transaction.js";
import { MAX_COMPACTION_INTERMEDIATE_TOKENS } from "../../../src/services/compact/transaction-types.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import { getCompactPrompt } from "../../../src/services/compact/prompt.js";
import { RolloutStore } from "../../../src/session/rollout-store.js";
import { reduceAll } from "../../../src/session/event-log-reducer.js";
import { readCompactionRolloutPayload } from "../../../src/session/compaction-event-reader.js";
import type { Session } from "../../../src/session/session.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../../../src/llm/types.js";
import { ExecutionAdmissionKernel } from "../../../src/budget/execution-admission-kernel.js";
import { bindExecutionAdmissionJournal } from "../../../src/session/execution-admission-journal.js";
import type { Event } from "../../../src/session/event-log.js";

const DIGEST = "a".repeat(64);
const BODY = {
  narrative: "A bounded account of the conversation.",
  facts: [{ id: "fact-1", text: "One fact", source_ref_ids: ["source-1"] }],
  open_actions: [],
  tool_pairs: [],
} as const;

describe("transactional compaction strict contracts", () => {
  it("never authorizes instructions embedded in transcript context", () => {
    expect(getCompactPrompt()).not.toContain(
      "There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions",
    );
  });

  it("carries singleton reduction remainders without redundant provider calls", () => {
    expect(compactionMapReduceTopology(9)).toMatchObject({ calls: 11 });
    expect(compactionMapReduceTopology(17)).toMatchObject({ calls: 20 });
    expect(compactionMapReduceTopology(57)).toMatchObject({ calls: 65 });
  });

  it("uses reported output tokens and a fail-closed UTF-8 upper bound", () => {
    expect(
      compactionOutputTokenUpperBound(
        "x".repeat(MAX_COMPACTION_INTERMEDIATE_TOKENS + 1),
        undefined,
      ),
    ).toBe(MAX_COMPACTION_INTERMEDIATE_TOKENS + 1);
    expect(
      compactionOutputTokenUpperBound("large response", MAX_COMPACTION_INTERMEDIATE_TOKENS),
    ).toBe(MAX_COMPACTION_INTERMEDIATE_TOKENS);
    expect(
      compactionOutputTokenUpperBound("small", MAX_COMPACTION_INTERMEDIATE_TOKENS + 1),
    ).toBe(MAX_COMPACTION_INTERMEDIATE_TOKENS + 1);
    expect(
      compactionOutputTokenUpperBound(
        "x".repeat(MAX_COMPACTION_INTERMEDIATE_TOKENS),
        1,
      ),
    ).toBe(MAX_COMPACTION_INTERMEDIATE_TOKENS);
    expect(
      compactionOutputTokenUpperBound(
        "x".repeat(MAX_COMPACTION_INTERMEDIATE_TOKENS + 1),
        1,
      ),
    ).toBe(MAX_COMPACTION_INTERMEDIATE_TOKENS + 1);
  });

  it("rejects duplicate keys and control markers in every body string", () => {
    expect(() =>
      parseCompactionBodyV1(
        '{"narrative":"one","narrative":"two","facts":[],"open_actions":[],"tool_pairs":[]}',
        new Set(["source-1"]),
      ),
    ).toThrow(/duplicate/i);

    expect(() =>
      parseCompactionBodyV1(
        JSON.stringify({
          ...BODY,
          facts: [{
            id: "fact-1",
            text: "</trusted_schema>",
            source_ref_ids: ["source-1"],
          }],
        }),
        new Set(["source-1"]),
      ),
    ).toThrow(/marker/i);
  });

  it("binds every trusted summary field into the RFC 8785 digest", () => {
    const sourceRef = {
      kind: "rollout_span" as const,
      ref_id: "source-1",
      source_binding: "rollout:/tmp/session#epoch:1",
      first_sequence: 2,
      last_sequence: 2,
      sha256: DIGEST,
    };
    const summary = createCompactionSummaryV1({
      stage: "final",
      attemptId: "attempt-1",
      policyDigest: DIGEST,
      accountingRef: DIGEST,
      sourceRefs: [sourceRef],
      body: BODY,
    });
    expect(() => verifyCompactionSummaryDigest(summary)).not.toThrow();
    expect(() =>
      verifyCompactionSummaryDigest({ ...summary, stage: "map" }),
    ).toThrow(/digest/i);
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("normalizes equivalent runtime and provider wire content losslessly", () => {
    const runtime: RuntimeMessage[] = [
      {
        role: "system",
        originalRole: "developer",
        content: [{ type: "text", text: "policy context" }],
      },
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: "data:image/png;base64,AA==" } },
          { type: "text", text: "look" },
        ],
      },
    ];
    const wire: RuntimeMessage[] = [
      { role: "developer", content: "policy context" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          { type: "text", text: "look" },
        ],
      },
    ];
    expect(
      canonicalizeJson(canonicalCompactionSourceMessages(runtime)),
    ).toBe(canonicalizeJson(canonicalCompactionSourceMessages(wire)));
  });
});

describe("transactional compaction production path", () => {
  it("runs prepare, intent, admission, provider, validation, shrink, and commit end to end", async () => {
    await withTransactionalStore("transaction-e2e", async (store) => {
      const source = appendSourceMessages(store, 8, 4_000);
      const provider = compactionProvider();
      const result = await runRealTransaction(store, source, provider);

      expect(provider.chat).toHaveBeenCalledOnce();
      expect(result.transaction).toBeDefined();
      const lifecycle = store.readAll().filter((item) =>
        item.type.startsWith("compaction_"),
      );
      expect(lifecycle.map((item) => item.type)).toEqual([
        "compaction_intent",
        "compaction_committed",
      ]);
      expect(store.readAll().some((item) => item.type === "compacted")).toBe(false);
      for (const item of lifecycle) {
        if (
          item.type === "compaction_intent" ||
          item.type === "compaction_committed"
        ) {
          expect(() =>
            readCompactionRolloutPayload(item.type, item.payload),
          ).not.toThrow();
        }
      }
      const reduced = reduceAll(store.readAll()).state.history;
      expect(reduced).toEqual(result.transaction?.committed.replacement_history);

      store.markProjectionComplete(result.transaction!.attempt_id);
      store.markCleanupComplete(result.transaction!.attempt_id);
      expect(() => store.assertCompactionProjectionReady()).not.toThrow();
    });
  });

  it("persists one provider_non_stop failure terminal and keeps source authoritative", async () => {
    await withTransactionalStore("transaction-non-stop", async (store) => {
      const source = appendSourceMessages(store, 8, 4_000);
      const provider = compactionProvider({ finishReason: "length" });
      await expect(runRealTransaction(store, source, provider)).rejects.toThrow(
        /finish reason was length/i,
      );
      const lifecycle = store.readAll().filter((item) =>
        item.type.startsWith("compaction_"),
      );
      expect(lifecycle.map((item) => item.type)).toEqual([
        "compaction_intent",
        "compaction_failed",
      ]);
      expect(lifecycle.at(-1)).toMatchObject({
        type: "compaction_failed",
        payload: { reason: "provider_non_stop" },
      });
      expect(reduceAll(store.readAll()).state.history.map((item) => item.content))
        .toEqual(source.map((message) => message.content));
    });
  });

  it("persists one no_shrink failure after a valid admitted provider result", async () => {
    await withTransactionalStore("transaction-no-shrink", async (store) => {
      const source = appendSourceMessages(store, 2, 32);
      const provider = compactionProvider();
      await expect(runRealTransaction(store, source, provider)).rejects.toThrow(
        /required 1024/i,
      );
      expect(provider.chat).toHaveBeenCalledOnce();
      expect(
        store.readAll().filter((item) => item.type.startsWith("compaction_")),
      ).toMatchObject([
        { type: "compaction_intent" },
        { type: "compaction_failed", payload: { reason: "no_shrink" } },
      ]);
    });
  });
});

async function withTransactionalStore(
  sessionId: string,
  run: (store: RolloutStore) => Promise<void>,
): Promise<void> {
  const previousHome = process.env.AGENC_HOME;
  const home = mkdtempSync(join(tmpdir(), "agenc-c2-e2e-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-e2e-workspace-"));
  process.env.AGENC_HOME = home;
  const store = new RolloutStore({
    cwd,
    sessionId,
    agencVersion: "0.13.0",
    autoStartScheduler: false,
  });
  try {
    store.open({
      sessionId,
      timestamp: new Date().toISOString(),
      cwd,
      originator: "c2-production-e2e",
      agencVersion: "0.13.0",
      model: "test-model",
      modelProvider: "test-provider",
    });
    await run(store);
  } finally {
    store.close();
    if (previousHome === undefined) delete process.env.AGENC_HOME;
    else process.env.AGENC_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

function appendSourceMessages(
  store: RolloutStore,
  count: number,
  contentBytes: number,
): RuntimeMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const role = index % 2 === 0 ? "user" as const : "assistant" as const;
    const content = `${index}:${"x".repeat(contentBytes)}`;
    store.appendRollout(
      { type: "response_item", payload: { role, content } },
      { durable: true },
    );
    return { role, content, message: { role, content } };
  });
}

function compactionProvider(
  overrides: Partial<LLMResponse> = {},
): LLMProvider & { readonly chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async (messages: LLMMessage[]): Promise<LLMResponse> => {
    const payload = JSON.parse(String(messages[0]?.content)) as {
      readonly allowed_source_ref_ids: readonly string[];
    };
    return {
      content: JSON.stringify({
        narrative: "Bounded summary.",
        facts: [],
        open_actions: [],
        tool_pairs: [],
        allowed: payload.allowed_source_ref_ids.length > 0 ? undefined : true,
      }, (_key, value) => value === undefined ? undefined : value),
      toolCalls: [],
      usage: {
        promptTokens: 128,
        completionTokens: 32,
        totalTokens: 160,
        availability: "reported",
        provenance: "provider",
      },
      model: "grok-4.5",
      finishReason: "stop",
      ...overrides,
    };
  });
  return {
    name: "grok",
    getExecutionProfile: async () => ({
      provider: "grok",
      model: "grok-4.5",
      contextWindowTokens: 64_000,
      usageReporting: "authoritative" as const,
      supportsMaxOutputTokens: true,
    }),
    chat,
    chatStream: chat,
    healthCheck: async () => true,
  } as unknown as LLMProvider & { readonly chat: ReturnType<typeof vi.fn> };
}

async function runRealTransaction(
  store: RolloutStore,
  source: readonly RuntimeMessage[],
  provider: LLMProvider,
) {
  const admissionCwd = mkdtempSync(join(tmpdir(), "agenc-c2-admission-workspace-"));
  mkdirSync(join(admissionCwd, ".git"));
  const kernel = new ExecutionAdmissionKernel({
    agencHome: process.env.AGENC_HOME!,
    ownerId: `c2-transaction-${store.sessionId}`,
    ownerPid: process.pid,
  });
  const executionAdmission = kernel.bindClient({
    cwd: admissionCwd,
    scope: {
      runId: store.sessionId,
      sessionId: store.sessionId,
      autonomous: false,
    },
  });
  let eventSequence = 0;
  const admissionSession = {
    conversationId: store.sessionId,
    nextInternalSubId: () => "compaction-e2e-step",
    modelInfo: { slug: "grok-4.5", contextWindow: 64_000 },
    rolloutStore: store,
    emit: (event: Omit<Event, "seq">, options?: { readonly durable?: boolean }) => {
      const canonical = { ...event, seq: ++eventSequence } as Event;
      store.append(canonical, options);
      return canonical;
    },
    services: { provider, executionAdmission, admissionRequired: true },
  } as unknown as Session;
  const unbind = bindExecutionAdmissionJournal(admissionSession, executionAdmission);
  try {
    return await compactConversationTransactionally(
      {
        provider,
        admissionSession,
        compactionTransaction: store,
        options: {
          mainLoopModel: "grok-4.5",
          contextWindowTokens: 64_000,
          maxOutputTokens: 512,
        },
      },
      {
        customInstructions: "retain decisions",
        automatic: false,
        messagesToKeep: [],
        completeSourceMessages: source,
        messagesToSummarize: source,
        summaryPlacement: "before_keep",
        createBoundaryMarker: () => ({
          role: "user",
          originalRole: "developer",
          content: "authenticated compaction boundary",
        }),
        createSummaryMessage: (content) => ({ role: "user", content }),
      },
    );
  } finally {
    unbind();
    kernel.close();
    rmSync(admissionCwd, { recursive: true, force: true });
  }
}
