import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { LLMProvider, LLMResponse, LLMToolCall } from "../../src/llm/types.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Session } from "../../src/session/session.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { clearSessionReadState } from "../../src/tools/system/filesystem.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

// Only model responses are scripted. Registry, Session, permissions, SQLite
// admission, file tools and canonical effect/admission journal are real.
// This is same-process close/reopen evidence, NOT SIGKILL/power-loss coverage.
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "fixture cleanup failed");
});

function call(name: string, id: string, args: Record<string, unknown>): LLMToolCall {
  return { name, id, arguments: JSON.stringify(args) };
}

function fixture(options: {
  responses: readonly (readonly LLMToolCall[])[];
  beforeResponse?: (index: number, cwd: string) => void;
  denyWrite?: boolean;
  maxTokens?: number;
  now?: () => Date;
  deadlineAt?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), "light-admitted-write-"));
  // Register each acquired resource immediately: setup failure must not strand
  // an open kernel/store or prevent the remaining task-owned cleanup actions.
  const dispose: Array<() => void | Promise<void>> = [() => rmSync(root, { recursive: true, force: true })];
  cleanup.push(async () => {
    const errors: unknown[] = [];
    for (const close of dispose.splice(0).reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "resource cleanup failed");
  });
  const cwd = join(root, "workspace"), home = join(root, "home"), scratch = join(root, "scratch");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(scratch);
  const kernel = new ExecutionAdmissionKernel({ agencHome: home,
    ownerId: "light-write-integration", ownerPid: process.pid,
    ...(options.now === undefined ? {} : { now: options.now }) });
  dispose.push(() => kernel.close());
  const admission = kernel.bindClient({ cwd,
    scope: { runId: "conv-test", sessionId: "conv-test", autonomous: false,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }) },
  });
  let session: Session;
  let providerCalls = 0;
  const advertised: string[][] = [];
  const provider: LLMProvider = {
    ...mkProvider(), name: "grok",
    getExecutionProfile: async () => ({ provider: "grok", model: "grok-4.5",
      supportsMaxOutputTokens: true, usageReporting: "authoritative", maxOutputTokens: 512 }),
    chatStream: async (_messages, _onChunk, request): Promise<LLMResponse> => {
      const index = providerCalls++;
      advertised.push((request?.tools ?? []).map(tool => tool.function.name));
      options.beforeResponse?.(index, cwd);
      if (index > options.responses.length) throw new Error("unexpected synthetic provider retry");
      const toolCalls = [...(options.responses[index] ?? [])];
      return { content: toolCalls.length ? "" : "Finished.", toolCalls,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15,
          availability: "reported", provenance: "provider" },
        model: "grok-4.5", finishReason: toolCalls.length ? "tool_calls" : "stop" };
    },
  };
  const registry = buildToolRegistry({ workspaceRoot: cwd, lightMode: true,
    requireAdmission: true, getSession: () => session });
  const permissions = new PermissionModeRegistry(createEmptyToolPermissionContext({
    mode: "acceptEdits",
    ...(options.denyWrite ? { alwaysDenyRules: { session: ["Write"] } } : {}),
  }));
  const built = mkSession({ cwd, provider, registry, modelInfo: { slug: "grok-4.5", maxOutputTokens: 512 },
    services: { executionAdmission: admission, admissionRequired: true,
      runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true }),
      permissionModeRegistry: permissions },
  });
  session = built.session;
  dispose.push(() => clearSessionReadState(session.conversationId, scratch));
  dispose.push(() => session.shutdown());
  const storeOptions = { cwd, agencHome: home, sessionId: session.conversationId,
    sessionTempRoot: scratch, agencVersion: "0.18.0", autoStartScheduler: false };
  const metadata = { sessionId: session.conversationId, timestamp: new Date().toISOString(), cwd,
    originator: "light-write-admission-test", agencVersion: "0.18.0", model: "grok-4.5", modelProvider: "grok" };
  let store = new RolloutStore(storeOptions);
  dispose.push(() => { session.mountRolloutStore(null); store.close(); });
  store.open(metadata);
  session.mountRolloutStore(store);
  const unbind = bindExecutionAdmissionJournal(session, admission);
  dispose.push(unbind);
  const journal = () => kernel.listJournal({ cwd, runId: session.conversationId });
  const canonical = () => store.readAll().flatMap(item => item.type === "event_msg" ? [item.payload] : []);
  return {
    root, cwd, session, events: built.events, advertised, journal, canonical,
    providerCalls: () => providerCalls,
    run: () => drain(runTurn(session, mkCtx({ cwd, permissionMode: "acceptEdits",
      sandboxPolicy: { value: "workspace_write" }, modelInfo: { ...mkCtx().modelInfo, slug: "grok-4.5", maxOutputTokens: 512 },
      collaborationMode: { model: "grok-4.5" }, modelProviderId: "grok",
    }), "Make only the requested local file change.")),
    reopen() {
      unbind(); session.mountRolloutStore(null); store.close();
      store = new RolloutStore({ ...storeOptions, resume: true });
      store.open(metadata);
      return store;
    },
  };
}

function completed(state: ReturnType<typeof fixture>, callId: string) {
  return state.events.find(event => event.msg.type === "tool_call_completed" && event.msg.payload.callId === callId)?.msg;
}
function effectEvents(state: ReturnType<typeof fixture>, callId: string) {
  return state.canonical().filter(event => (event.msg.type === "effect_intent"
    || event.msg.type === "effect_result" || event.msg.type === "effect_unknown_outcome")
    && event.msg.payload.callId === callId);
}

describe("Light Write turns with real durable admission", () => {
  test("fresh create is advertised, admitted, committed and recoverable from canonical receipts", async () => {
    const state = fixture({ responses: [[call("Write", "create", { file_path: "new.txt", content: "created\n" })]] });
    await state.run();
    expect(state.advertised[0]).toContain("Write");
    expect(state.providerCalls()).toBe(2);
    expect(readFileSync(join(state.cwd, "new.txt"), "utf8")).toBe("created\n");
    expect(completed(state, "create")).toMatchObject({ payload: { toolName: "Write", isError: false } });
    const toolJournal = state.journal().filter(event => event.kind === "tool_exec");
    expect(toolJournal.map(event => event.event)).toEqual(expect.arrayContaining(["allowed", "dispatched", "reconciled"]));
    expect(state.journal().some(event => event.kind === "model_turn" && event.event === "reconciled")).toBe(true);
    const effects = effectEvents(state, "create");
    expect(effects.map(event => event.msg.type)).toEqual(["effect_intent", "effect_result"]);
    expect(effects.at(-1)?.msg).toMatchObject({ payload: { outcome: "committed", effectBoundary: "crossed",
      evidence: { reservationId: expect.any(String) } } });
    const projected = state.canonical().flatMap(event => event.msg.type === "execution_admission" ? [event.msg.payload] : []);
    for (const row of toolJournal) expect(projected).toContainEqual(row);
    const ids = effects.map(event => event.eventId);
    const recovered = state.reopen();
    expect(effectEvents(state, "create").map(event => event.eventId)).toEqual(ids);
    expect(state.canonical().some(event => event.msg.type === "effect_unknown_outcome")).toBe(false);
    expect(() => recovered.assertToolAdmissionAllowed("side-effecting")).not.toThrow();
    expect(() => recovered.assertToolEffectAttemptAllowed({ callId: "create", recoveryCategory: "side-effecting" }))
      .toThrow("cannot be dispatched again");
    expect(readFileSync(join(state.cwd, "new.txt"), "utf8")).toBe("created\n");
  });

  test("existing overwrite follows an actual admitted FileRead in the same turn", async () => {
    const state = fixture({ responses: [
      [call("FileRead", "read", { file_path: "existing.txt" })],
      [call("Write", "overwrite", { file_path: "existing.txt", content: "updated\n" })],
    ] });
    writeFileSync(join(state.cwd, "existing.txt"), "original\n");
    await state.run();
    expect(state.providerCalls()).toBe(3);
    expect(completed(state, "read")).toMatchObject({ payload: { isError: false } });
    expect(completed(state, "overwrite")).toMatchObject({ payload: { isError: false } });
    expect(readFileSync(join(state.cwd, "existing.txt"), "utf8")).toBe("updated\n");
    expect(state.journal().filter(event => event.kind === "tool_exec" && event.event === "reconciled")).toHaveLength(2);
  });

  test.each([false, true])("missing/stale read refusal (read first=%s) is no-effect and does not poison a later create", async readFirst => {
    const reads = readFirst ? [[call("FileRead", "read", { file_path: "existing.txt" })]] : [];
    const state = fixture({ responses: [
      ...reads,
      [call("Write", "refused", { file_path: "existing.txt", content: "must-not-write\n" })],
      [call("Write", "followup", { file_path: "followup.txt", content: "allowed\n" })],
    ], beforeResponse(index, cwd) {
      if (readFirst && index === 1) writeFileSync(join(cwd, "existing.txt"), "external concurrent change\n");
    } });
    writeFileSync(join(state.cwd, "existing.txt"), "original\n");
    await state.run();
    expect(completed(state, "refused")).toMatchObject({ payload: { isError: true } });
    expect(readFileSync(join(state.cwd, "existing.txt"), "utf8")).toBe(readFirst ? "external concurrent change\n" : "original\n");
    expect(completed(state, "followup")).toMatchObject({ payload: { isError: false } });
    expect(readFileSync(join(state.cwd, "followup.txt"), "utf8")).toBe("allowed\n");
    expect(effectEvents(state, "refused").at(-1)?.msg).toMatchObject({ type: "effect_result", payload: {
      outcome: "failed", effectBoundary: "crossed", noEffectEvidence: {
        kind: "effect_no_effect_proof", evidenceKind: "boundary_not_crossed", evidenceRef: "tool:Write:pre-mutation",
      },
    } });
    const refusal = state.session.snapshotHistoryMessages().find(message => message.toolCallId === "refused");
    expect(String(refusal?.content)).toContain(readFirst ? "modified since read" : "not been read yet");
    expect(state.canonical().some(event => event.msg.type === "effect_unknown_outcome")).toBe(false);
  });

  test("canonical permission deny prevents Write dispatch and physical creation", async () => {
    const state = fixture({ denyWrite: true,
      responses: [[call("Write", "denied", { file_path: "denied.txt", content: "forbidden\n" })]] });
    await state.run();
    expect(existsSync(join(state.cwd, "denied.txt"))).toBe(false);
    expect(completed(state, "denied")).toMatchObject({ payload: { isError: true } });
    expect(state.journal().some(event => event.kind === "tool_exec" && event.event === "dispatched")).toBe(false);
    expect(effectEvents(state, "denied")).toHaveLength(0);
  });

  test("real zero-token admission budget denies model entry before any Write can be requested", async () => {
    const state = fixture({ maxTokens: 0,
      responses: [[call("Write", "unreachable", { file_path: "budget-denied.txt", content: "forbidden\n" })]] });
    await state.run();
    expect(state.providerCalls()).toBe(0);
    expect(existsSync(join(state.cwd, "budget-denied.txt"))).toBe(false);
    expect(state.journal().some(event => event.event === "denied")).toBe(true);
    expect(state.journal().some(event => event.kind === "tool_exec")).toBe(false);
  });

  test("deadline expiry after model dispatch refuses Write at real tool admission", async () => {
    const startedAt = Date.now();
    let now = startedAt;
    const state = fixture({ now: () => new Date(now), deadlineAt: new Date(startedAt + 60_000).toISOString(),
      beforeResponse(index) { if (index === 0) now = startedAt + 60_001; },
      responses: [[call("Write", "tool-budget-denied", { file_path: "tool-denied.txt", content: "forbidden\n" })]] });
    await state.run();
    expect(state.providerCalls()).toBe(1);
    const modelJournal = state.journal().filter(event => event.kind === "model_turn");
    expect(modelJournal.map(event => event.event)).toEqual(expect.arrayContaining(["allowed", "dispatched", "reconciled"]));
    const toolJournal = state.journal().filter(event => event.kind === "tool_exec");
    expect(toolJournal).toEqual(expect.arrayContaining([expect.objectContaining({
      event: "cancelled", reason: "deadline_expired",
    })]));
    expect(toolJournal.some(event => event.event === "dispatched")).toBe(false);
    expect(toolJournal.some(event => event.event === "allowed")).toBe(false);
    expect(existsSync(join(state.cwd, "tool-denied.txt"))).toBe(false);
    expect(completed(state, "tool-budget-denied")).toMatchObject({ payload: { isError: true } });
    expect(effectEvents(state, "tool-budget-denied")).toHaveLength(0);
    const denied = toolJournal.filter(event => event.event === "cancelled" && event.reason === "deadline_expired");
    expect(denied[0]!.sequence).toBeGreaterThan(modelJournal.find(event => event.event === "reconciled")!.sequence);
    const projected = state.canonical().flatMap(event => event.msg.type === "execution_admission" ? [event.msg.payload] : []);
    for (const row of denied) expect(projected).toContainEqual(row);
    state.reopen();
    const recovered = state.canonical().flatMap(event => event.msg.type === "execution_admission" ? [event.msg.payload] : []);
    for (const row of denied) expect(recovered).toContainEqual(row);
  });
});
