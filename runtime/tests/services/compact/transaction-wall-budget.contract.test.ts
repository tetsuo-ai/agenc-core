import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionAdmissionKernel } from "../../../src/budget/execution-admission-kernel.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "../../../src/llm/types.js";
import { compactConversationTransactionally } from "../../../src/services/compact/transaction.js";
import { MAX_COMPACTION_WALL_MS } from "../../../src/services/compact/transaction-types.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import type { Event } from "../../../src/session/event-log.js";
import { bindExecutionAdmissionJournal } from "../../../src/session/execution-admission-journal.js";
import { RolloutStore } from "../../../src/session/rollout-store.js";
import type { Session } from "../../../src/session/session.js";

const MODEL = "grok-4.6";
const PROVIDER = "grok";
const CONTEXT_WINDOW_TOKENS = 64_000;
const OUTPUT_RESERVE_TOKENS = 512;
// One second past the former 300 s bound, where a real grok-4.6 compaction was cut off.
const SLOW_PROVIDER_CALL_MS = 301_000;

interface WallBudgetFixture {
  readonly home: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly previousHome: string | undefined;
}

type ProviderSpy = LLMProvider & {
  readonly chat: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("transactional compaction wall budget", () => {
  it("commits a compaction whose provider call outlasts the former 300 s bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const fixture = createFixture("wall-budget-slow-commit");
    const store = openStore(fixture);
    try {
      const source = appendSource(store, 8, 4_000);
      const provider = slowProvider(SLOW_PROVIDER_CALL_MS);
      const run = runRealTransaction(store, source, provider);
      const settled = run.then(() => "committed", (error: unknown) => error);

      await waitForProviderCall(provider);
      await vi.advanceTimersByTimeAsync(SLOW_PROVIDER_CALL_MS);

      expect(await settled).toBe("committed");
      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(compactionLifecycle(store).at(-1)).toMatchObject({
        type: "compaction_committed",
      });
    } finally {
      store.close();
      cleanupFixture(fixture);
    }
  }, 60_000);

  it("still fails a compaction whose provider call exceeds the wall budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const fixture = createFixture("wall-budget-exceeded");
    const store = openStore(fixture);
    try {
      const source = appendSource(store, 8, 4_000);
      const provider = slowProvider(MAX_COMPACTION_WALL_MS + 60_000);
      const rejected = expect(runRealTransaction(store, source, provider)).rejects.toThrow(
        /wall-clock deadline/,
      );

      await waitForProviderCall(provider);
      await vi.advanceTimersByTimeAsync(MAX_COMPACTION_WALL_MS + 1);

      await rejected;
      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(compactionLifecycle(store).at(-1)).toMatchObject({
        type: "compaction_failed",
        payload: { reason: "wall_time_exceeded" },
      });
    } finally {
      store.close();
      cleanupFixture(fixture);
    }
  }, 60_000);
});

// Yield real event-loop turns (setImmediate is not faked) until the provider is called, so no fake
// time passes before the slow call begins and the deadline cannot fire early.
async function waitForProviderCall(provider: ProviderSpy): Promise<void> {
  for (let turn = 0; turn < 10_000 && provider.chat.mock.calls.length === 0; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (provider.chat.mock.calls.length === 0) {
    throw new Error("compaction provider was never called");
  }
}

function slowProvider(delayMs: number): ProviderSpy {
  const chat = vi.fn(async (
    messages: readonly LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      options?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(options.signal?.reason ?? new Error("compaction provider aborted"));
        },
        { once: true },
      );
    });
    const payload = JSON.parse(String(messages[0]?.content)) as {
      readonly allowed_source_ref_ids: readonly string[];
    };
    if (payload.allowed_source_ref_ids.length === 0) {
      throw new Error("wall-budget provider received no source allowlist");
    }
    return {
      content: JSON.stringify({
        narrative: "Bounded summary.",
        facts: [],
        open_actions: [],
        tool_pairs: [],
      }),
      toolCalls: [],
      usage: {
        promptTokens: 128,
        completionTokens: 128,
        totalTokens: 256,
        availability: "reported",
        provenance: "provider",
      },
      model: MODEL,
      finishReason: "stop",
    };
  });
  return {
    name: PROVIDER,
    getExecutionProfile: async () => ({
      provider: PROVIDER,
      model: MODEL,
      contextWindowTokens: CONTEXT_WINDOW_TOKENS,
      usageReporting: "authoritative" as const,
      supportsMaxOutputTokens: true,
    }),
    chat,
    chatStream: chat,
    healthCheck: async () => true,
    tokenCountCapability: {
      capabilityVersion: "c2-wall-budget-v1",
      adapterRevision: "c2-wall-budget-adapter-v1",
      configurationRevision: "c2-wall-budget-config-v1",
      countTokens: async (request: { readonly messages: readonly LLMMessage[] }) => ({
        inputTokens: Math.max(
          1,
          Math.ceil(Buffer.byteLength(JSON.stringify(request.messages), "utf8") / 4),
        ),
        complete: true as const,
        confidence: "exact" as const,
        countedComponents: ["messages" as const],
      }),
    },
  } as unknown as ProviderSpy;
}

async function runRealTransaction(
  store: RolloutStore,
  source: readonly RuntimeMessage[],
  provider: LLMProvider,
) {
  const admissionCwd = mkdtempSync(join(tmpdir(), "agenc-c2-wall-admission-"));
  mkdirSync(join(admissionCwd, ".git"));
  const kernel = new ExecutionAdmissionKernel({
    agencHome: process.env.AGENC_HOME!,
    ownerId: `c2-wall-budget-${store.sessionId}`,
    ownerPid: process.pid,
  });
  const executionAdmission = kernel.bindClient({
    cwd: admissionCwd,
    scope: {
      runId: store.sessionId,
      sessionId: store.sessionId,
      autonomous: true,
    },
  });
  let eventSequence = store.readAll().reduce((maximum, item) => {
    if (item.type !== "event_msg" || item.payload.seq === undefined) return maximum;
    return Math.max(maximum, item.payload.seq);
  }, 0);
  const admissionSession = {
    conversationId: store.sessionId,
    nextInternalSubId: () => "compaction-wall-budget-step",
    modelInfo: { slug: MODEL, contextWindow: CONTEXT_WINDOW_TOKENS },
    rolloutStore: store,
    emit: (event: Omit<Event, "seq">, append?: { readonly durable?: boolean }) => {
      const canonical = { ...event, seq: ++eventSequence } as Event;
      store.append(canonical, append);
      return canonical;
    },
    abortTerminal: vi.fn(async () => {}),
    services: {
      provider,
      executionAdmission,
      admissionRequired: true,
      agentControl: { shutdownAgentTree: async () => {} },
    },
  } as unknown as Session;
  const unbind = bindExecutionAdmissionJournal(admissionSession, executionAdmission);
  try {
    return await compactConversationTransactionally(
      {
        provider,
        admissionSession,
        compactionTransaction: store,
        compactionMode: "automatic",
        options: {
          mainLoopModel: MODEL,
          contextWindowTokens: CONTEXT_WINDOW_TOKENS,
          maxOutputTokens: OUTPUT_RESERVE_TOKENS,
        },
      },
      {
        customInstructions: "retain durable decisions",
        automatic: true,
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

function createFixture(sessionId: string): WallBudgetFixture {
  const previousHome = process.env.AGENC_HOME;
  const home = mkdtempSync(join(tmpdir(), "agenc-c2-wall-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-wall-workspace-"));
  process.env.AGENC_HOME = home;
  return { home, cwd, sessionId, previousHome };
}

function openStore(fixture: WallBudgetFixture): RolloutStore {
  const store = new RolloutStore({
    cwd: fixture.cwd,
    sessionId: fixture.sessionId,
    agencVersion: "0.13.0",
    sessionTempRoot: tmpdir(),
    autoStartScheduler: false,
  });
  store.open({
    sessionId: fixture.sessionId,
    timestamp: new Date().toISOString(),
    cwd: fixture.cwd,
    originator: "c2-wall-budget-contract",
    agencVersion: "0.13.0",
    model: MODEL,
    modelProvider: PROVIDER,
  });
  return store;
}

function appendSource(
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
    return { role, content };
  });
}

function cleanupFixture(fixture: WallBudgetFixture): void {
  if (fixture.previousHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = fixture.previousHome;
  rmSync(fixture.home, { recursive: true, force: true });
  rmSync(fixture.cwd, { recursive: true, force: true });
}

function compactionLifecycle(store: RolloutStore) {
  return store.readAll().filter((item) =>
    item.type.startsWith("compaction_") && item.type !== "compaction_payload_chunk"
  );
}
