import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { createAdmittedMemorySelector } from "../../src/memory/admitted-selector.js";
import { getAttachmentTrackingState } from "../../src/session/attachment-state.js";
import { recordRetainedAttachments } from "../../src/session/attachment-retention.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { preparedSemanticDigest, type PreparedSamplingEvidence, type PreparedSamplingValidator } from "../../src/session/prepared-sampling-evidence.js";
import type { Session } from "../../src/session/session.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) try { await close(); } catch (error) { errors.push(error); }
  vi.restoreAllMocks();
  if (errors.length) throw new AggregateError(errors, "prepared fixture cleanup failed");
});

function fixture(validator?: PreparedSamplingValidator, retry = false) {
  const root = mkdtempSync(join(tmpdir(), "prepared-admission-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"), home = join(root, "home");
  mkdirSync(join(cwd, ".git"), { recursive: true }); mkdirSync(home, { mode: 0o700 });
  const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "prepared-test", ownerPid: process.pid });
  cleanups.push(() => kernel.close());
  const admission = kernel.bindClient({ cwd, scope: { runId: "conv-test", sessionId: "conv-test", autonomous: false } });
  const requests: Record<string, unknown>[] = [];
  const seenIds: Array<string | undefined> = [];
  let session: Session;
  const provider = new OpenAIProvider({ apiKey: "synthetic-unused", model: "test-model", maxRetries: 0, maxTokens: 512, useResponsesApi: true,
    fetchImpl: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (retry && requests.length === 1) {
        getAttachmentTrackingState(session).pendingCriticalReminder = "LATE_REMINDER_MUST_NOT_BE_COLLECTED";
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }
      const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
      if (requests.at(-1)?.stream !== true) return new Response(JSON.stringify({ id: "synthetic-aux", status: "completed", model: "test-model", usage,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"selected_candidate_ids":[]}' }] }] }), { headers: { "content-type": "application/json" } });
      const event = { type: "response.completed", response: { id: "synthetic-response", status: "completed", model: "test-model", usage,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Finished." }] }] } };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    } });
  const stream = provider.chatStream.bind(provider);
  provider.chatStream = (messages, callback, options) => { seenIds.push(options?.managedRequestId); return stream(messages, callback, options); };
  const registry = buildToolRegistry({ workspaceRoot: cwd, requireAdmission: true, lightMode: true, getSession: () => session });
  const built = mkSession({ cwd, provider, registry, modelInfo: { slug: "test-model", maxOutputTokens: 512 }, services: {
    executionAdmission: admission, admissionRequired: true,
    runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true }),
    ...(validator === undefined ? {} : { validatePreparedSampling: validator }),
  } });
  session = built.session; cleanups.push(() => session.shutdown());
  getAttachmentTrackingState(session).memoryMode = "disabled";
  const store = new RolloutStore({ cwd, agencHome: home, sessionId: "conv-test", agencVersion: "0.18.0", sessionTempRoot: root, autoStartScheduler: false });
  cleanups.push(() => { session.mountRolloutStore(null); store.close(); });
  store.open({ sessionId: "conv-test", cwd, timestamp: new Date().toISOString(), originator: "prepared-test", agencVersion: "0.18.0", model: "test-model", modelProvider: "openai" });
  session.mountRolloutStore(store); cleanups.push(bindExecutionAdmissionJournal(session, admission));
  return { session, requests, seenIds, events: built.events,
    journal: () => kernel.listJournal({ cwd, runId: "conv-test" }),
    run: (text = "PRIVATE_TASK", id = "turn-abc") => drain(runTurn(session, mkCtx({ cwd, subId: id,
      modelInfo: { ...mkCtx().modelInfo, slug: "test-model", maxOutputTokens: 512 }, collaborationMode: { model: "test-model" }, modelProviderId: "openai" }), text)),
  };
}

describe("selected preparation before real main admission", () => {
  test("valid detached report precedes admission; UUID propagates and later turns validate anew", async () => {
    const reports: PreparedSamplingEvidence[] = [];
    const f = fixture(report => {
      expect(f.requests).toHaveLength(reports.length);
      expect(f.journal().filter(row => row.event === "dispatched")).toHaveLength(reports.length);
      expect(report.inventory).toBe("complete");
      expect(report.details?.root).toMatchObject({ present: true, matchesActiveTurn: true, textDigest: preparedSemanticDigest("PRIVATE_TASK") });
      expect(JSON.stringify(report)).not.toContain("PRIVATE_TASK");
      reports.push(report);
    });
    await f.run(); await f.run("PRIVATE_TASK", "turn-next");
    expect(reports).toHaveLength(2); expect(f.requests).toHaveLength(2);
    expect(f.seenIds).toEqual(reports.map(report => report.managedRequestId));
    expect(new Set(f.seenIds).size).toBe(2);
    expect(reports[0]?.details?.counts).toMatchObject({ retainedBlocks: 0, rawAttachmentOutputs: 0 });
  });
  test.each(["throw", "nonundefined", "async"] as const)("%s refusal: no selected-main reservation/dispatch/fetch or reconnect", async mode => {
    let calls = 0;
    const f = fixture((() => { calls++; if (mode === "throw") throw "PRIVATE_CALLBACK_ERROR";
      return mode === "async" ? Promise.reject("PRIVATE_CALLBACK_ERROR") : null;
    }) as unknown as PreparedSamplingValidator);
    await f.run();
    expect(calls).toBe(1); expect(f.requests).toHaveLength(0); expect(f.journal()).toHaveLength(0);
    expect(JSON.stringify(f.events)).toContain("Prepared sampling validation failed");
    expect(JSON.stringify(f.events)).not.toContain("PRIVATE_CALLBACK_ERROR");
  });
  test("constructor captures gate once; absent gate retains normal real admission", async () => {
    const reject = vi.fn(() => { throw null; });
    const f = fixture(reject);
    Object.assign(f.session.services, { validatePreparedSampling: () => undefined });
    await f.run(); expect(reject).toHaveBeenCalledTimes(1); expect(f.requests).toHaveLength(0);
    const absent = fixture();
    Object.assign(absent.session.services, { validatePreparedSampling: reject });
    await absent.run(); expect(absent.requests).toHaveLength(1); expect(reject).toHaveBeenCalledTimes(1);
  });
  test("callback cancellation takes precedence over its exception and prevents admission", async () => {
    const f = fixture(() => { f.session.abortController.abort("user_cancelled"); throw "PRIVATE_CALLBACK_ERROR"; });
    await f.run();
    expect(f.requests).toHaveLength(0); expect(f.journal()).toHaveLength(0);
    expect(JSON.stringify(f.events)).not.toContain("Prepared sampling validation failed");
    expect(JSON.stringify(f.events)).not.toContain("PRIVATE_CALLBACK_ERROR");
  });
  test("base-only consumer can refuse retained records even when their stale anchor is dropped", async () => {
    const reports: PreparedSamplingEvidence[] = [];
    const f = fixture(report => { reports.push(report); if (report.details?.counts.retainedBlocks !== 0) throw null; });
    recordRetainedAttachments(getAttachmentTrackingState(f.session).retainedAttachments,
      [{ role: "user", content: "stale prior anchor" }], 0, "before", [{ role: "user", content: "stale auxiliary", runtimeOnly: { mergeBoundary: "user_context" } }]);
    await f.run();
    expect(reports).toHaveLength(1); expect(reports[0]?.details?.counts).toMatchObject({ retainedBlocks: 1, retainedMessages: 1 });
    expect(f.requests).toHaveLength(0); expect(f.journal()).toHaveLength(0);
  });
  test("reconnect retains snapshot UUID and one-shot reminder without revalidation", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const reports: PreparedSamplingEvidence[] = [];
    const f = fixture(report => { reports.push(report); }, true);
    getAttachmentTrackingState(f.session).pendingCriticalReminder = "ONE_SHOT_REMINDER";
    await f.run();
    expect(f.requests).toHaveLength(2); expect(f.requests[1]).toEqual(f.requests[0]);
    expect(reports).toHaveLength(1); expect(f.seenIds).toEqual([reports[0]?.managedRequestId, reports[0]?.managedRequestId]);
    expect(JSON.stringify(f.requests[0])).toContain("ONE_SHOT_REMINDER");
    expect(JSON.stringify(f.requests[1])).not.toContain("LATE_REMINDER");
    expect(getAttachmentTrackingState(f.session).pendingCriticalReminder).toBe("LATE_REMINDER_MUST_NOT_BE_COLLECTED");
    expect(reports[0]?.details?.counts.rawAttachmentOutputs).toBeGreaterThan(0);
  });
  test("earlier actual auxiliary admission remains settled when selected main validation refuses", async () => {
    const f = fixture(() => { throw null; });
    const result = await createAdmittedMemorySelector(f.session).select({ policy: "agenc.memory-selector.v1",
      query: { text: "fixture auxiliary", mode: "query" }, recentTools: [], candidates: [] }, new AbortController().signal);
    expect(result.kind).toBe("selected");
    const before = f.journal();
    expect(before.some(row => row.event === "dispatched" && row.stepId.startsWith("memory-selector:"))).toBe(true);
    expect(before.some(row => row.event === "reconciled")).toBe(true);
    await f.run();
    expect(f.journal()).toEqual(before); expect(f.requests).toHaveLength(1); expect(f.seenIds).toHaveLength(0);
  });
});
