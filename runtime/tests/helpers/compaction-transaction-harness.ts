import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../../src/llm/types.js";
import type { ProviderTokenCountCapability } from "../../src/llm/token-accounting.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import { SessionStore } from "../../src/session/session-store.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import type { Session } from "../../src/session/session.js";
import type { CompactContext, RuntimeMessage } from "../../src/services/compact/types.js";

export interface CompactionTransactionHarness {
  readonly context: CompactContext;
  readonly provider: LLMProvider & { readonly chat: ReturnType<typeof vi.fn> };
  readonly session: Session;
  readonly store: RolloutStore;
  close(): void;
}

export function attachCompactionSession(session: Session, harness: CompactionTransactionHarness): void {
  session.mountRolloutStore(harness.store);
  session.eventLog.seedCanonicalHistory(harness.store.readAll().flatMap((item) =>
    item.type === "event_msg" ? [item.payload] : [],
  ));
  harness.session.emit = session.emit.bind(session);
}

export function bindCompactionTransactionHarness(
  store: RolloutStore,
  options: {
    readonly contextWindowTokens?: number;
    readonly maxOutputTokens?: number;
    readonly chat?: (messages: LLMMessage[]) => Promise<LLMResponse>;
  } = {},
): Pick<CompactionTransactionHarness, "context" | "provider" | "session" | "close"> {
  const home = process.env.AGENC_HOME;
  if (home === undefined) throw new Error("compaction harness requires AGENC_HOME");
  mkdirSync(join(store.store.cwd, ".git"), { recursive: true });
  const provider = createProvider(options.chat, false);
  const kernel = new ExecutionAdmissionKernel({
    agencHome: home,
    ownerId: `c2-test-harness-${store.sessionId}`,
    ownerPid: process.pid,
  });
  const admission = kernel.bindClient({
    cwd: store.store.cwd,
    scope: {
      runId: store.sessionId,
      sessionId: store.sessionId,
      autonomous: false,
    },
  });
  let eventSequence = store.readAll().reduce(
    (maximum, item) => item.type === "event_msg"
      ? Math.max(maximum, item.payload.seq ?? 0)
      : maximum,
    0,
  );
  const session = {
    conversationId: store.sessionId,
    nextInternalSubId: () => `c2-harness-step-${eventSequence + 1}`,
    modelInfo: {
      slug: "grok-4.5",
      contextWindow: options.contextWindowTokens ?? 64_000,
    },
    rolloutStore: store,
    eventLog: new EventLog(),
    emit: (event: Omit<Event, "seq">, appendOptions?: { readonly durable?: boolean }) => {
      const canonical = { ...event, seq: ++eventSequence } as Event;
      store.append(canonical, appendOptions);
      return canonical;
    },
    services: {
      provider,
      executionAdmission: admission,
      admissionRequired: true,
      agentControl: {},
    },
    abortTerminal: vi.fn(),
    clearProviderResponseId: vi.fn(),
  } as unknown as Session;
  const unbind = bindExecutionAdmissionJournal(session, admission);
  let closed = false;
  return {
    provider,
    session,
    context: {
      provider,
      admissionSession: session,
      compactionTransaction: store,
      compactionMode: "manual",
      options: {
        mainLoopModel: "grok-4.5",
        contextWindowTokens: options.contextWindowTokens ?? 64_000,
        maxOutputTokens: options.maxOutputTokens ?? 512,
      },
    },
    close: () => {
      if (closed) return;
      closed = true;
      unbind();
      kernel.close();
    },
  };
}

export function createCompactionTransactionHarness(
  messages: readonly RuntimeMessage[],
  options: {
    readonly contextWindowTokens?: number;
    readonly maxOutputTokens?: number;
    readonly compactionMode?: "automatic" | "manual";
    readonly chat?: (messages: LLMMessage[]) => Promise<LLMResponse>;
    readonly sessionId?: string;
  } = {},
): CompactionTransactionHarness {
  const previousHome = process.env.AGENC_HOME;
  const home = mkdtempSync(join(tmpdir(), "agenc-c2-harness-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-harness-workspace-"));
  mkdirSync(join(cwd, ".git"));
  process.env.AGENC_HOME = home;
  const sessionId = options.sessionId ??
    `c2-harness-${Math.random().toString(36).slice(2)}`;
  const storeOptions = {
    cwd,
    sessionId,
    agencVersion: "0.13.0",
    sessionTempRoot: tmpdir(),
    autoStartScheduler: false,
  };
  const seedStore = new SessionStore(storeOptions);
  const metadata = {
    sessionId,
    timestamp: new Date().toISOString(),
    cwd,
    originator: "c2-test-harness",
    agencVersion: "0.13.0",
    model: "grok-4.5",
    modelProvider: "grok",
  };
  seedStore.open(metadata);
  for (const message of messages) {
    seedStore.appendRollout({
      type: "response_item",
      payload: {
        role: message.originalRole ?? message.role ?? "user",
        content: message.content ?? message.message?.content ?? "",
        ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
        ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
        ...(message.runtimeOnly?.toolResultIntegrity !== undefined
          ? { toolResultIntegrity: message.runtimeOnly.toolResultIntegrity }
          : {}),
        ...(message.runtimeOnly?.agentInvocation !== undefined
          ? { agentInvocation: message.runtimeOnly.agentInvocation }
          : {}),
        ...(message.runtimeOnly?.compactionHistory !== undefined
          ? { compactionHistory: message.runtimeOnly.compactionHistory }
          : {}),
      },
    });
  }
  // Seed one durable source rather than simulating thousands of live turns.
  // Reopening through RolloutStore validates the complete tool-pair history
  // and builds its real SQLite projection in one transaction.
  if (!seedStore.flushBatch(true)) throw new Error("fixture source was not durably flushed");
  seedStore.close();
  const store = new RolloutStore({ ...storeOptions, resume: true });
  store.open(metadata);

  const provider = createProvider(options.chat);
  const kernel = new ExecutionAdmissionKernel({
    agencHome: home,
    ownerId: `c2-test-harness-${sessionId}`,
    ownerPid: process.pid,
  });
  const admission = kernel.bindClient({
    cwd,
    scope: { runId: sessionId, sessionId, autonomous: false },
  });
  let eventSequence = 0;
  const eventLog = new EventLog();
  const session = {
    conversationId: sessionId,
    nextInternalSubId: () => `c2-harness-step-${eventSequence + 1}`,
    modelInfo: {
      slug: "grok-4.5",
      contextWindow: options.contextWindowTokens ?? 64_000,
    },
    rolloutStore: store,
    eventLog,
    emit: (event: Omit<Event, "seq">, appendOptions?: { readonly durable?: boolean }) => {
      const canonical = { ...event, seq: ++eventSequence } as Event;
      store.append(canonical, appendOptions);
      return canonical;
    },
    services: {
      provider,
      executionAdmission: admission,
      admissionRequired: true,
      agentControl: {},
    },
    abortTerminal: vi.fn(),
    clearProviderResponseId: vi.fn(),
  } as unknown as Session;
  const unbind = bindExecutionAdmissionJournal(session, admission);
  let closed = false;
  return {
    store,
    provider,
    session,
    context: {
      provider,
      admissionSession: session,
      compactionTransaction: store,
      compactionMode: options.compactionMode ?? "manual",
      options: {
        mainLoopModel: "grok-4.5",
        contextWindowTokens: options.contextWindowTokens ?? 64_000,
        maxOutputTokens: options.maxOutputTokens ?? 512,
      },
    },
    close: () => {
      if (closed) return;
      closed = true;
      unbind();
      kernel.close();
      store.close();
      if (previousHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

export function createProvider(
  chatOverride?: (messages: LLMMessage[]) => Promise<LLMResponse>,
  countCompactionMarkersAsFixed = true,
): CompactionTransactionHarness["provider"] {
  const countTokens = vi.fn(async (request: {
    readonly messages: readonly LLMMessage[];
  }) => ({
    inputTokens: countCompactionMarkersAsFixed && request.messages.some((message) =>
      message.runtimeOnly?.compactionHistory !== undefined
    )
      ? 128
      : Math.max(1, Math.ceil(Buffer.byteLength(
          JSON.stringify(request.messages),
          "utf8",
        ) / 4)),
    complete: true as const,
    confidence: "exact" as const,
    countedComponents: ["system" as const, "messages" as const],
  }));
  // The runtime pins every tool pair itself; the summary is prose only.
  const defaultChat: (messages: LLMMessage[]) => Promise<LLMResponse> = async () => ({
    content: JSON.stringify({
      narrative: "Bounded summary.",
      facts: [],
      open_actions: [],
    }),
    toolCalls: [],
    usage: {
      promptTokens: 128,
      completionTokens: 128,
      totalTokens: 256,
      availability: "reported",
      provenance: "provider",
    },
    model: "grok-4.5",
    finishReason: "stop",
  });
  const chat = vi.fn(chatOverride ?? defaultChat);
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
    tokenCountCapability: {
      capabilityVersion: "c2-test-v1",
      adapterRevision: "c2-test-adapter-v1",
      configurationRevision: "c2-test-config-v1",
      countTokens,
    } satisfies ProviderTokenCountCapability,
  } as unknown as CompactionTransactionHarness["provider"];
}
