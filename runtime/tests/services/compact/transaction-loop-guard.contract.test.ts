import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ExecutionAdmissionKernel } from "../../../src/budget/execution-admission-kernel.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "../../../src/llm/types.js";
import { compactConversationTransactionally } from "../../../src/services/compact/transaction.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import type { Event } from "../../../src/session/event-log.js";
import { bindExecutionAdmissionJournal } from "../../../src/session/execution-admission-journal.js";
import { RolloutStore } from "../../../src/session/rollout-store.js";
import type { Session } from "../../../src/session/session.js";
import {
  openStateDatabases,
  resolveStateDatabasePaths,
} from "../../../src/state/sqlite-driver.js";

const MODEL = "grok-4.5";
const PROVIDER = "grok";
const CONTEXT_WINDOW_TOKENS = 64_000;
const OUTPUT_RESERVE_TOKENS = 512;
const BASE_CONFIGURATION = "retain durable decisions";

interface LoopGuardFixture {
  readonly home: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly previousHome: string | undefined;
}

type ProviderSpy = LLMProvider & {
  readonly chat: ReturnType<typeof vi.fn>;
};

describe("transactional compaction automatic failure guard", () => {
  it("rebuilds two failures from canonical SQLite loss and never double-counts replay", async () => {
    const fixture = createFixture("loop-guard-rebuild");
    const provider = nonStopProvider();
    try {
      let store = openStore(fixture);
      const source = appendSource(store, 8, 4_000);
      store.close();

      store = openStore(fixture, true);
      try {
        await recordAutomaticFailure(store, source, provider, BASE_CONFIGURATION);
        await recordAutomaticFailure(store, source, provider, BASE_CONFIGURATION);
        expect(provider.chat).toHaveBeenCalledTimes(2);
        expect(compactionLifecycle(store)).toHaveLength(4);
      } finally {
        store.close();
      }

      store = openStore(fixture, true);
      try {
        await expectGuardSuppressed(store, source, provider, BASE_CONFIGURATION);
        expect(provider.chat).toHaveBeenCalledTimes(2);
        expect(compactionLifecycle(store)).toHaveLength(4);
      } finally {
        store.close();
      }

      removeStateDatabase(fixture.cwd);
      store = openStore(fixture, true);
      try {
        await expectGuardSuppressed(store, source, provider, BASE_CONFIGURATION);
        expect(provider.chat).toHaveBeenCalledTimes(2);
        expect(compactionLifecycle(store)).toHaveLength(4);
      } finally {
        store.close();
      }

      store = openStore(fixture, true);
      try {
        await expectGuardSuppressed(store, source, provider, BASE_CONFIGURATION);
        expect(provider.chat).toHaveBeenCalledTimes(2);
      } finally {
        store.close();
      }

      expect(readFailureGuardRows(fixture.cwd, fixture.sessionId)).toEqual([
        expect.objectContaining({ failure_count: 2 }),
      ]);
      const [guard] = readFailureGuardRows(fixture.cwd, fixture.sessionId);
      const attemptIds = JSON.parse(guard!.attempt_ids_json) as readonly string[];
      expect(attemptIds).toHaveLength(2);
      expect(new Set(attemptIds).size).toBe(2);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("allows a new automatic attempt after authoritative history changes", async () => {
    const fixture = createFixture("loop-guard-history-change");
    const store = openStore(fixture);
    const provider = nonStopProvider();
    try {
      const source = appendSource(store, 8, 4_000);
      await recordAutomaticFailure(store, source, provider, BASE_CONFIGURATION);
      await recordAutomaticFailure(store, source, provider, BASE_CONFIGURATION);
      const changed = [
        ...source,
        ...appendSource(store, 1, 4_000, source.length),
      ];

      await recordAutomaticFailure(store, changed, provider, BASE_CONFIGURATION);

      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(compactionLifecycle(store)).toHaveLength(6);
    } finally {
      store.close();
      cleanupFixture(fixture);
    }
  });

  it("allows a new automatic attempt after configuration changes", async () => {
    const fixture = createFixture("loop-guard-config-change");
    const store = openStore(fixture);
    const provider = nonStopProvider();
    try {
      const source = appendSource(store, 8, 4_000);
      await recordAutomaticFailure(store, source, provider, BASE_CONFIGURATION);
      await recordAutomaticFailure(store, source, provider, BASE_CONFIGURATION);

      await recordAutomaticFailure(
        store,
        source,
        provider,
        `${BASE_CONFIGURATION} with changed focus`,
      );

      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(compactionLifecycle(store)).toHaveLength(6);
    } finally {
      store.close();
      cleanupFixture(fixture);
    }
  });

  it("allows an explicit manual retry without clearing the automatic guard", async () => {
    const fixture = createFixture("loop-guard-manual-retry");
    const store = openStore(fixture);
    const provider = nonStopProvider();
    try {
      const source = appendSource(store, 8, 4_000);
      await recordAutomaticFailure(store, source, provider, BASE_CONFIGURATION);
      await recordAutomaticFailure(store, source, provider, BASE_CONFIGURATION);

      await expect(
        runRealTransaction(store, source, provider, {
          automatic: false,
          customInstructions: BASE_CONFIGURATION,
        }),
      ).rejects.toThrow(/finish reason was length/i);

      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(compactionLifecycle(store)).toHaveLength(6);
      await expectGuardSuppressed(store, source, provider, BASE_CONFIGURATION);
      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(compactionLifecycle(store)).toHaveLength(6);
    } finally {
      store.close();
      cleanupFixture(fixture);
    }
  });
});

async function recordAutomaticFailure(
  store: RolloutStore,
  source: readonly RuntimeMessage[],
  provider: ProviderSpy,
  customInstructions: string,
): Promise<void> {
  await expect(
    runRealTransaction(store, source, provider, {
      automatic: true,
      customInstructions,
    }),
  ).rejects.toThrow(/finish reason was length/i);
  expect(compactionLifecycle(store).at(-1)).toMatchObject({
    type: "compaction_failed",
    payload: { reason: "provider_non_stop" },
  });
}

async function expectGuardSuppressed(
  store: RolloutStore,
  source: readonly RuntimeMessage[],
  provider: ProviderSpy,
  customInstructions: string,
): Promise<void> {
  const providerCalls = provider.chat.mock.calls.length;
  const lifecycleCount = compactionLifecycle(store).length;
  await expect(
    runRealTransaction(store, source, provider, {
      automatic: true,
      customInstructions,
    }),
  ).rejects.toThrow(/suppressed after two durable failures/i);
  expect(provider.chat).toHaveBeenCalledTimes(providerCalls);
  expect(compactionLifecycle(store)).toHaveLength(lifecycleCount);
}

function appendSource(
  store: RolloutStore,
  count: number,
  contentBytes: number,
  indexOffset = 0,
): RuntimeMessage[] {
  return Array.from({ length: count }, (_, relativeIndex) => {
    const index = indexOffset + relativeIndex;
    const role = index % 2 === 0 ? "user" as const : "assistant" as const;
    const content = `${index}:${"x".repeat(contentBytes)}`;
    store.appendRollout(
      { type: "response_item", payload: { role, content } },
      { durable: true },
    );
    return { role, content };
  });
}

function nonStopProvider(): ProviderSpy {
  const chat = vi.fn(async (
    messages: readonly LLMMessage[],
    _options?: LLMChatOptions,
  ): Promise<LLMResponse> => {
    const payload = JSON.parse(String(messages[0]?.content)) as {
      readonly allowed_source_ref_ids: readonly string[];
    };
    if (payload.allowed_source_ref_ids.length === 0) {
      throw new Error("loop-guard provider received no source allowlist");
    }
    return {
      content: JSON.stringify({
        narrative: "This non-stop body must never commit.",
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
      finishReason: "length",
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
      capabilityVersion: "c2-loop-guard-v1",
      adapterRevision: "c2-loop-guard-adapter-v1",
      configurationRevision: "c2-loop-guard-config-v1",
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
  options: {
    readonly automatic: boolean;
    readonly customInstructions: string;
  },
) {
  const admissionCwd = mkdtempSync(join(tmpdir(), "agenc-c2-loop-admission-"));
  mkdirSync(join(admissionCwd, ".git"));
  const kernel = new ExecutionAdmissionKernel({
    agencHome: process.env.AGENC_HOME!,
    ownerId: `c2-loop-guard-${store.sessionId}`,
    ownerPid: process.pid,
  });
  const executionAdmission = kernel.bindClient({
    cwd: admissionCwd,
    scope: {
      runId: store.sessionId,
      sessionId: store.sessionId,
      autonomous: options.automatic,
    },
  });
  let eventSequence = store.readAll().reduce((maximum, item) => {
    if (item.type !== "event_msg" || item.payload.seq === undefined) return maximum;
    return Math.max(maximum, item.payload.seq);
  }, 0);
  const admissionSession = {
    conversationId: store.sessionId,
    nextInternalSubId: () => "compaction-loop-guard-step",
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
        compactionMode: options.automatic ? "automatic" : "manual",
        options: {
          mainLoopModel: MODEL,
          contextWindowTokens: CONTEXT_WINDOW_TOKENS,
          maxOutputTokens: OUTPUT_RESERVE_TOKENS,
        },
      },
      {
        customInstructions: options.customInstructions,
        automatic: options.automatic,
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

function createFixture(sessionId: string): LoopGuardFixture {
  const previousHome = process.env.AGENC_HOME;
  const home = mkdtempSync(join(tmpdir(), "agenc-c2-loop-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-loop-workspace-"));
  process.env.AGENC_HOME = home;
  return { home, cwd, sessionId, previousHome };
}

function openStore(
  fixture: LoopGuardFixture,
  resume = false,
): RolloutStore {
  const store = new RolloutStore({
    cwd: fixture.cwd,
    sessionId: fixture.sessionId,
    agencVersion: "0.13.0",
    autoStartScheduler: false,
    resume,
  });
  store.open({
    sessionId: fixture.sessionId,
    timestamp: new Date().toISOString(),
    cwd: fixture.cwd,
    originator: "c2-loop-guard-contract",
    agencVersion: "0.13.0",
    model: MODEL,
    modelProvider: PROVIDER,
  });
  return store;
}

function cleanupFixture(fixture: LoopGuardFixture): void {
  if (fixture.previousHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = fixture.previousHome;
  rmSync(fixture.home, { recursive: true, force: true });
  rmSync(fixture.cwd, { recursive: true, force: true });
}

function removeStateDatabase(cwd: string): void {
  const { stateDbPath } = resolveStateDatabasePaths({ cwd });
  unlinkSync(stateDbPath);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      unlinkSync(`${stateDbPath}${suffix}`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
}

function readFailureGuardRows(cwd: string, sessionId: string): readonly {
  readonly failure_count: number;
  readonly attempt_ids_json: string;
}[] {
  const driver = openStateDatabases({ cwd });
  try {
    return driver.state.prepare<[string], {
      readonly failure_count: number;
      readonly attempt_ids_json: string;
    }>(
      `SELECT failure_count, attempt_ids_json
       FROM compaction_failure_guards
       WHERE session_id = ?
       ORDER BY history_digest, configuration_digest`,
    ).all(sessionId);
  } finally {
    driver.close();
  }
}

function compactionLifecycle(store: RolloutStore) {
  return store.readAll().filter((item) =>
    item.type.startsWith("compaction_") && item.type !== "compaction_payload_chunk"
  );
}
