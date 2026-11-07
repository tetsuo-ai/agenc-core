import { afterEach, expect, test } from "vitest";
import { BootstrapRolloutRecorderFacade } from "../../src/bin/bootstrap-services.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import { compactConversation } from "../../src/services/compact/compact.js";
import { maybePrewarmAgentTaskRegistration, recordInitialHistoryOnResume } from "../../src/session/agent-task-lifecycle.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { shutdownSessionLifecycle } from "../../src/session/lifecycle.js";
import { persistMemoryExtractionState } from "../../src/session/memory-extraction-state.js";
import { responseItemToLlmMessage } from "../../src/session/message-history-conversion.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { Session } from "../../src/session/session.js";
import { FileThreadStore } from "../../src/thread-store/store.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";
import {
  attachCompactionSession,
  createCompactionTransactionHarness,
  type CompactionTransactionHarness,
} from "../helpers/compaction-transaction-harness.js";

// A native DeepSeek Light session whose compact core catalog switched to the
// full core schemas (prompt-cache-state.ts coreCatalogSwitchItem) and then
// fills its context. Inside an open compaction attempt the rollout admits
// only the attempt's admission journal (canonical-rollout-scanner.ts
// observeAdmission); any other line fails the commit.

const ENVIRONMENT_KEYS = [
  "AGENC_AUTO_COMPACT_WINDOW",
  "AGENC_AUTOCOMPACT_PCT_OVERRIDE",
  "AGENC_DISABLE_COMPACT",
  "AGENC_DISABLE_AUTO_COMPACT",
] as const;
const previousEnvironment = new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const SUMMARY = JSON.stringify({ narrative: "Bounded summary.", facts: [], open_actions: [] });
const SWITCH_LINE = { type: "session_state", payload: { coreCatalog: "expanded" } } as const;

function response(content: string, toolCallId?: string, promptTokens = 3_100, completionTokens = 1): LLMResponse {
  return {
    content,
    toolCalls: toolCallId === undefined ? [] : [{ id: toolCallId, name: "Read", arguments: "{}" }],
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
      availability: "reported", provenance: "provider" },
    model: "grok-4.5",
    finishReason: toolCallId === undefined ? "stop" : "tool_calls",
  };
}

function isCompactionRequest(messages: readonly LLMMessage[]): boolean {
  const content = messages[0]?.content;
  if (typeof content !== "string") return false;
  try {
    const payload = JSON.parse(content) as { units?: unknown; summaries?: unknown; children?: unknown };
    return payload.units !== undefined || payload.summaries !== undefined || payload.children !== undefined;
  } catch {
    return false;
  }
}

/**
 * The registry surface of the switch (tool-registry.ts isCoreCatalogExpanded):
 * the model's selection of a compact core tool switches it, once and for good.
 */
function switchingRegistry() {
  let expanded = false;
  const registry = {
    tools: [{ name: "Read", description: "read once", inputSchema: { type: "object" },
      requiresApproval: false, recoveryCategory: "read-only",
      execute: async () => ({ content: "read result", isError: false }) }],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "read result", isError: false }),
    isCoreCatalogExpanded: () => expanded,
    expandCoreCatalog: () => { expanded = true; },
  };
  return registry as unknown as ToolRegistry & typeof registry;
}

function scenario() {
  process.env.AGENC_AUTO_COMPACT_WINDOW = "1000";
  process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE = "50";
  delete process.env.AGENC_DISABLE_COMPACT;
  delete process.env.AGENC_DISABLE_AUTO_COMPACT;
  const source: LLMMessage[] = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `source-${index}:${"x".repeat(4_000)}`,
  }));
  const modelInfo = { ...mkCtx().modelInfo, slug: "grok-4.5", contextWindow: 64_000,
    maxOutputTokens: 512, autoCompactTokenLimit: 100_000 };
  return { source, modelInfo };
}

function liveSession(harness: CompactionTransactionHarness, source: LLMMessage[],
  modelInfo: ReturnType<typeof scenario>["modelInfo"], registry: ToolRegistry) {
  const live = mkSession({ cwd: harness.store.store.cwd, provider: harness.provider, registry,
    history: source, modelInfo });
  Object.assign(live.session.config, { durableTurns: { resume: { requireLease: false } } });
  Object.assign(live.session.services, { executionAdmission: harness.session.services.executionAdmission,
    admissionRequired: true });
  attachCompactionSession(live.session, harness);
  live.session.onBeforeDurableClose(bindExecutionAdmissionJournal(live.session,
    live.session.services.executionAdmission!));
  return live;
}

function countRequestsBySize(harness: CompactionTransactionHarness): void {
  Object.assign(harness.provider.tokenCountCapability as object, {
    countTokens: async (request: { readonly messages: readonly LLMMessage[] }) => ({
      inputTokens: Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(request.messages), "utf8") / 4)),
      complete: true as const, confidence: "exact" as const, countedComponents: ["system" as const, "messages" as const],
    }),
  });
}

const switchLines = (items: readonly RolloutItem[]) =>
  items.filter((item) => item.type === "session_state" && item.payload.coreCatalog === "expanded");
const failures = (items: readonly RolloutItem[]) =>
  items.flatMap((item) => item.type === "compaction_failed" ? [item.payload.reason] : []);
const commits = (items: readonly RolloutItem[]) =>
  items.filter((item) => item.type === "compaction_committed").length;

/** Records other than the admission journal between an intent and its terminal record. */
function linesInsideOpenAttempts(items: readonly RolloutItem[]): string[] {
  const open = new Set<string>();
  const found: string[] = [];
  for (const item of items) {
    if (item.type === "compaction_intent") { open.add(item.payload.attempt_id); continue; }
    if (item.type === "compaction_committed" || item.type === "compaction_failed") {
      open.delete(item.payload.attempt_id);
      continue;
    }
    if (open.size === 0 || item.type === "compaction_payload_chunk") continue;
    if (item.type === "event_msg" && ["execution_admission", "session_usage"].includes(item.payload.msg.type)) continue;
    found.push(item.type === "session_state" ? `session_state:${Object.keys(item.payload).join(",")}` : item.type);
  }
  return found;
}

test("a switched DeepSeek Light session commits its automatic compactions, the second one too", async () => {
  const { source, modelInfo } = scenario();
  const registry = switchingRegistry();
  let harness: CompactionTransactionHarness | undefined;
  let session: Session | undefined;
  let samples = 0;
  try {
    harness = createCompactionTransactionHarness(source, {
      sessionId: "conv-test", contextWindowTokens: 64_000, maxOutputTokens: 512,
      compactionMode: "automatic",
      chat: async (messages) => {
        if (isCompactionRequest(messages)) {
          modelInfo.autoCompactTokenLimit = 100_000;
          return response(SUMMARY, undefined, 128, 128);
        }
        samples += 1;
        // The first request of the first and the third turn selects a compact
        // core tool (the first switches the catalog), and the next request is
        // past the compaction limit. The second turn's long answer gives the
        // second compaction something to shorten.
        if (samples === 1 || samples === 4) {
          registry.expandCoreCatalog();
          modelInfo.autoCompactTokenLimit = 1;
          return response("read first", `read-${samples}`);
        }
        if (samples === 3) return response(`A long answer. ${"filler ".repeat(6_000)}`);
        return response(samples === 2 ? "first turn complete" : "third turn complete");
      },
    });
    // The harness counts any request that carries a compaction marker as 128
    // tokens; count by size here, so the second compaction can shrink.
    countRequestsBySize(harness);
    const live = liveSession(harness, source, modelInfo, registry);
    session = live.session;

    await drain(runTurn(session, mkCtx({ modelInfo }), "read then finish"));
    const first = harness.store.readAll();
    expect({ committed: commits(first), failed: failures(first), inside: linesInsideOpenAttempts(first),
      switchLines: switchLines(first).length })
      .toEqual({ committed: 1, failed: [], inside: [], switchLines: 1 });

    await drain(runTurn(session, mkCtx({ modelInfo, subId: "turn-second" }), "explain at length"));
    await drain(runTurn(session, mkCtx({ modelInfo, subId: "turn-third" }), "read again"));
    const items = harness.store.readAll();
    expect({
      committed: commits(items), failed: failures(items), inside: linesInsideOpenAttempts(items),
      switchLines: switchLines(items).length,
      turns: live.events.filter((event) => ["turn_complete", "turn_failed"].includes(event.msg.type))
        .map((event) => event.msg.type),
    }).toEqual({ committed: 2, failed: [], inside: [], switchLines: 1,
      turns: ["turn_complete", "turn_complete", "turn_complete"] });
    expect(samples).toBe(5);
  } finally {
    await session?.shutdown().catch(() => undefined);
    harness?.close();
  }
});

/**
 * What a 0.19.31 process wrote: the attempt's admission session saved the
 * switch again before the first event of every attempt. Written straight to
 * the file, as that process did.
 */
function writeSwitchLineInEveryAttempt(store: RolloutStore): () => void {
  const file = store.store;
  const appendRollout = file.appendRollout.bind(file);
  const append = file.append.bind(file);
  let open = false;
  let written = false;
  file.appendRollout = (item, options) => {
    appendRollout(item, options);
    if (item.type === "compaction_intent") { open = true; written = false; }
    if (item.type === "compaction_committed" || item.type === "compaction_failed") open = false;
  };
  file.append = (event, options) => {
    if (open && !written) {
      written = true;
      appendRollout(SWITCH_LINE);
    }
    return append(event, options);
  };
  return () => {
    delete (file as Partial<typeof file>).appendRollout;
    delete (file as Partial<typeof file>).append;
  };
}

/** The intent of each attempt and whether a switch line sits between it and its terminal record. */
function attemptsWithSwitchInside(items: readonly RolloutItem[]): { reason: string; switchInside: boolean }[] {
  const open = new Map<string, boolean>();
  const found: { reason: string; switchInside: boolean }[] = [];
  for (const item of items) {
    if (item.type === "compaction_intent") open.set(item.payload.attempt_id, false);
    else if (item.type === "compaction_committed" || item.type === "compaction_failed") {
      found.push({ reason: item.type === "compaction_failed" ? item.payload.reason : "committed",
        switchInside: open.get(item.payload.attempt_id) === true });
      open.delete(item.payload.attempt_id);
    } else if (item.type === "session_state" && item.payload.coreCatalog === "expanded") {
      for (const attempt of open.keys()) open.set(attempt, true);
    }
  }
  return found;
}

test("a session stuck on 0.19.31 compacts again after a restart", async () => {
  const { source, modelInfo } = scenario();
  let harness: CompactionTransactionHarness | undefined;
  let first: Session | undefined;
  let resumed: Session | undefined;
  let resumedStore: RolloutStore | undefined;
  let resumedKernel: ExecutionAdmissionKernel | undefined;
  let samples = 0;
  let restarted = false;
  let resumedRead = false;
  try {
    const firstRegistry = switchingRegistry();
    harness = createCompactionTransactionHarness(source, {
      sessionId: "conv-test", contextWindowTokens: 64_000, maxOutputTokens: 512,
      compactionMode: "automatic",
      chat: async (messages) => {
        if (isCompactionRequest(messages)) {
          if (restarted) modelInfo.autoCompactTokenLimit = 100_000;
          return response(SUMMARY, undefined, 128, 128);
        }
        samples += 1;
        if (samples === 1) {
          firstRegistry.expandCoreCatalog();
          modelInfo.autoCompactTokenLimit = 1;
          return response("read first", "read-1");
        }
        if (restarted && !resumedRead) {
          resumedRead = true;
          return response("read after the restart", "read-2");
        }
        return response("resumed turn complete");
      },
    });
    const live = liveSession(harness, source, modelInfo, firstRegistry);
    first = live.session;
    // Two submissions on 0.19.31: each one's compaction fails its commit and
    // ends the turn ("The conversation could not be shortened enough").
    const stuckErrors: string[] = [];
    const restore = writeSwitchLineInEveryAttempt(harness.store);
    try {
      for (const [index, prompt] of ["read then finish", "try again"].entries()) {
        await drain(runTurn(first, mkCtx({ modelInfo, subId: `turn-stuck-${index}` }), prompt))
          .catch((error: unknown) => { stuckErrors.push(error instanceof Error ? error.message : String(error)); });
      }
    } finally {
      restore();
    }
    // The 0.19.31 record sequence of each attempt: the intent, its payload
    // chunks, the switch line, the admission events, then a failed commit.
    const stuck = harness.store.readAll();
    const firstIntent = stuck.findIndex((item) => item.type === "compaction_intent");
    expect(stuck.slice(firstIntent).map((item) => item.type === "session_state" ? "switch" : item.type)
      .filter((type, index, all) => type !== all[index - 1]).slice(0, 5))
      .toEqual(["compaction_intent", "compaction_payload_chunk", "switch", "event_msg", "compaction_failed"]);
    expect({ attempts: attemptsWithSwitchInside(stuck), errors: stuckErrors }).toEqual({
      attempts: [{ reason: "commit_failed", switchInside: true }, { reason: "commit_failed", switchInside: true }],
      errors: Array(2).fill("active rollout advanced outside the compaction admission journal before commit"),
    });
    await shutdownSessionLifecycle({ session: first, skipMemoryExtractionDrain: true });

    // A restarted daemon resumes the conversation and its next turn compacts.
    restarted = true;
    const cwd = harness.store.store.cwd;
    const agencHome = harness.store.store.agencHome;
    resumedKernel = new ExecutionAdmissionKernel({ agencHome, ownerId: "stuck-resume", ownerPid: process.pid });
    const admission = resumedKernel.bindClient({ cwd,
      scope: { runId: "conv-test", sessionId: "conv-test", autonomous: false } });
    resumedStore = new RolloutStore({ cwd, agencHome, sessionId: "conv-test", agencVersion: "0.13.0",
      sessionTempRoot: cwd, autoStartScheduler: false, resume: true });
    resumedStore.open({ sessionId: "conv-test", timestamp: new Date().toISOString(), cwd,
      originator: "stuck-resume", agencVersion: "0.13.0", model: "grok-4.5", modelProvider: "grok" });
    const resumedRegistry = switchingRegistry();
    const items = resumedStore.readAll();
    const resumedLive = mkSession({ cwd, provider: harness.provider, registry: resumedRegistry, modelInfo,
      history: reconstructFromRollout(items).history.map(responseItemToLlmMessage) });
    resumed = resumedLive.session;
    Object.assign(resumed.config, { durableTurns: { resume: { requireLease: false } } });
    Object.assign(resumed.services, { executionAdmission: admission, admissionRequired: true });
    resumed.mountRolloutStore(resumedStore);
    resumed.eventLog.seedCanonicalHistory(items.flatMap((item) => item.type === "event_msg" ? [item.payload] : []));
    resumed.onBeforeDurableClose(bindExecutionAdmissionJournal(resumed, admission));
    await recordInitialHistoryOnResume(resumed, items, { currentModel: "grok-4.5" });
    expect(resumedRegistry.isCoreCatalogExpanded()).toBe(true);
    const before = items.length;

    let resumedError: string | undefined;
    await drain(runTurn(resumed, mkCtx({ modelInfo, subId: "turn-resumed" }), "continue"))
      .catch((error: unknown) => { resumedError = error instanceof Error ? error.message : String(error); });
    const after = resumedStore.readAll().slice(before);
    expect({
      error: resumedError, committed: commits(after), failed: failures(after), inside: linesInsideOpenAttempts(after),
      switchLines: switchLines(after).length,
      turns: resumedLive.events.filter((event) => ["turn_complete", "turn_failed"].includes(event.msg.type))
        .map((event) => event.msg.type),
    }).toEqual({ error: undefined, committed: 1, failed: [], inside: [], switchLines: 0, turns: ["turn_complete"] });
  } finally {
    await resumed?.shutdown().catch(() => undefined);
    await first?.shutdown().catch(() => undefined);
    resumedKernel?.close();
    resumedStore?.close();
    harness?.close();
  }
});

type SwitchingRegistry = ReturnType<typeof switchingRegistry>;
interface Writer {
  readonly name: string;
  /** Before the turn. */
  setup?(session: Session, harness: CompactionTransactionHarness): void;
  /** While the compaction attempt is open. */
  write(session: Session, registry: SwitchingRegistry): Promise<void> | void;
  /** The line it wrote. */
  line(item: RolloutItem): boolean;
  teardown?(): void;
}

let threadStore: FileThreadStore | undefined;
function attachRecorder(session: Session, harness: CompactionTransactionHarness): void {
  const recorder = new BootstrapRolloutRecorderFacade();
  recorder.attach(harness.store);
  Object.assign(session.services, { rollout: recorder });
}

const writers: readonly Writer[] = [
  {
    // The switch happens inside the attempt, so the conversation's first
    // switch line comes from the attempt's own admission session.
    name: "the conversation's first switch line",
    write: (_session, registry) => { registry.expandCoreCatalog(); },
    line: (item) => item.type === "session_state" && item.payload.coreCatalog === "expanded",
  },
  {
    // A client Stop (background-agent-runner.ts interruptAgentTurn) marks the
    // session before it aborts the turn.
    name: "a user stop",
    write: (session) => { session.markStoppedByUser(); },
    line: (item) => item.type === "session_state" && item.payload.userStop?.stopped === true,
  },
  {
    name: "an agent task registration",
    setup: (session, harness) => {
      attachRecorder(session, harness);
      Object.assign(session.services, { agentIdentityManager: {
        registerTask: async () => ({ agentRuntimeId: "runtime-1", taskId: "task-1",
          registeredAt: "2026-11-07T00:00:00.000Z" }),
        taskMatchesCurrentIdentity: async () => true,
      } });
    },
    write: (session) => maybePrewarmAgentTaskRegistration(session),
    line: (item) => item.type === "session_state" && item.payload.agentTask !== undefined,
  },
  {
    name: "a memory extraction cadence",
    setup: attachRecorder,
    write: (session) => persistMemoryExtractionState(session, {
      memoryRoot: "/memory", processedVisibleCount: 3, turnsSinceLastExtraction: 1 }),
    line: (item) => item.type === "session_state" && item.payload.memoryExtraction !== undefined,
  },
  {
    // The thread store records a memory mode change in the live rollout.
    name: "a thread memory mode",
    setup: (_session, harness) => {
      threadStore = new FileThreadStore({ agencHome: harness.store.store.agencHome, cwd: harness.store.store.cwd });
      threadStore.createThread({ threadId: "conv-test", rolloutStore: harness.store });
    },
    write: () => {
      threadStore!.updateThreadMetadata({ threadId: "conv-test", patch: { memoryMode: "disabled" },
        includeArchived: false });
    },
    line: (item) => item.type === "session_meta" && item.payload.memoryMode === "disabled",
    teardown: () => { threadStore?.close(); threadStore = undefined; },
  },
];

test.each(writers)("$name written while an automatic compaction is open follows its terminal record", async (writer) => {
  const { source, modelInfo } = scenario();
  const registry = switchingRegistry();
  let harness: CompactionTransactionHarness | undefined;
  let session: Session | undefined;
  let samples = 0;
  let written = false;
  try {
    harness = createCompactionTransactionHarness(source, {
      sessionId: "conv-test", contextWindowTokens: 64_000, maxOutputTokens: 512,
      compactionMode: "automatic",
      chat: async (messages) => {
        if (isCompactionRequest(messages)) {
          if (!written) {
            written = true;
            await writer.write(session!, registry);
          }
          modelInfo.autoCompactTokenLimit = 100_000;
          return response(SUMMARY, undefined, 128, 128);
        }
        samples += 1;
        if (samples === 1) {
          modelInfo.autoCompactTokenLimit = 1;
          return response("read first", "read-1");
        }
        return response("turn complete");
      },
    });
    const live = liveSession(harness, source, modelInfo, registry);
    session = live.session;
    writer.setup?.(session, harness);

    await drain(runTurn(session, mkCtx({ modelInfo }), "read then finish"));
    const items = harness.store.readAll();
    const commit = items.findIndex((item) => item.type === "compaction_committed");
    const lines = items.flatMap((item, index) => writer.line(item) ? [index] : []);
    expect({ written, committed: commits(items), failed: failures(items), inside: linesInsideOpenAttempts(items),
      lines: lines.length, afterCommit: lines.every((index) => index > commit) })
      .toEqual({ written: true, committed: 1, failed: [], inside: [], lines: 1, afterCommit: true });
  } finally {
    writer.teardown?.();
    await session?.shutdown().catch(() => undefined);
    harness?.close();
  }
});

test("a line held for an attempt that never ends is written when the store closes", async () => {
  // The process stops inside the attempt: reopening closes the attempt as
  // interrupted, and the held line is in the rollout.
  const { source } = scenario();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const harness = createCompactionTransactionHarness(source, {
    chat: async () => {
      entered.resolve();
      await release.promise;
      throw new DOMException("stopped", "AbortError");
    },
  });
  const pending = compactConversation(source, harness.context).catch(() => undefined);
  try {
    await entered.promise;
    harness.store.appendRollout({ type: "session_state", payload: { userStop: { stopped: true, generation: 1 } } },
      { durable: true });
    const open = harness.store.readAll();
    expect(open.filter((item) => item.type === "compaction_intent")).toHaveLength(1);
    expect(open.some((item) => item.type === "session_state")).toBe(false);
    const cwd = harness.store.store.cwd;
    harness.store.close();
    const reopened = new RolloutStore({ cwd, sessionId: harness.store.sessionId, agencVersion: "0.13.0",
      sessionTempRoot: cwd, autoStartScheduler: false, resume: true });
    try {
      reopened.open({ sessionId: harness.store.sessionId, timestamp: new Date().toISOString(), cwd,
        originator: "held-line-test", agencVersion: "0.13.0", model: "grok-4.5", modelProvider: "grok" });
      const items = reopened.readAll();
      expect(items.filter((item) => item.type === "session_state" && item.payload.userStop?.stopped === true))
        .toHaveLength(1);
      expect(failures(items)).toEqual(["recovery_interrupted"]);
    } finally {
      reopened.close();
    }
  } finally {
    release.resolve();
    await pending;
    harness.close();
  }
});
