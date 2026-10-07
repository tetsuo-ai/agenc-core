import { GrokProvider } from "../../src/llm/providers/grok/adapter.js";
import { conservativeModelCost } from "../../src/session/cost.js";
import type { LLMProvider } from "../../src/llm/types.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionUsageSummary } from "../../src/budget/admission-types.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { GeminiProvider } from "../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../src/llm/providers/gemini/endpoint-plan.js";
import { isLLMPreGenerationRejection } from "../../src/llm/errors.js";
import type { Session } from "../../src/session/session.js";

let home: string;
let workspace: string;
let kernel: ExecutionAdmissionKernel;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-usage-home-"));
  workspace = mkdtempSync(join(tmpdir(), "agenc-usage-project-"));
  mkdirSync(join(workspace, ".git"));
  kernel = new ExecutionAdmissionKernel({ agencHome: home });
});

afterEach(() => {
  kernel.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function bind(runId: string, cwd = workspace) {
  return kernel.bindClient({
    cwd,
    scope: { runId, sessionId: runId, autonomous: false, maxCostUsd: 3 },
  });
}

function acquire(client: ExecutionAdmissionClient, stepId: string, cost = 1) {
  return client.acquire({
    stepId,
    kind: "model_turn",
    model: "usage-fixture",
    provider: "usage-fixture",
    maxInputTokens: 4,
    maxOutputTokens: 2,
    maxCostUsd: cost,
  });
}

function observe(client: ExecutionAdmissionClient) {
  const snapshots: AdmissionUsageSummary[] = [];
  if (client.subscribeUsage === undefined) throw new Error("Missing usage subscription");
  const unsubscribe = client.subscribeUsage((summary) => snapshots.push(summary));
  return { snapshots, unsubscribe };
}

describe("canonical allocation usage observers", () => {
  it("releases every rejected model attempt under a $20 Goal cap", async () => {
    const parent = kernel.bindClient({
      cwd: workspace,
      scope: { runId: "goal", sessionId: "goal", autonomous: true, maxCostUsd: 20, maxTokens: 156_392 },
    });
    const child = parent.forSession({ runId: "worker", sessionId: "worker" });
    const acquireModel = child.acquire.bind(child);
    vi.spyOn(child, "acquire").mockImplementation((input) => acquireModel({
      ...input, maxInputTokens: 150_000, maxOutputTokens: 6_392, maxCostUsd: 1.02,
    }));
    const session = { services: { executionAdmission: child } } as unknown as Session;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ error: { message: "Too many requests" } }, {
        status: 429, headers: { "retry-after": "30" },
      }));
    const provider = new GrokProvider({ apiKey: "xai-test", model: "grok-4.5", fetchImpl });
    vi.spyOn(provider, "getExecutionProfile").mockResolvedValue({
      usageReporting: "authoritative", supportsMaxOutputTokens: true,
    });
    const messages = [{ role: "user" as const, content: "hello" }];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await expect(runAdmittedModelCall({
        session, provider, messages, options: { maxOutputTokens: 6_392 },
        stepId: `retry:${attempt}`, model: "grok-4.5", providerName: "grok",
        invoke: (options) => provider.chatStream(messages, () => {}, options),
      })).rejects.toMatchObject({ name: "LLMRateLimitError", retryAfterMs: 30_000 });
      expect(parent.getUsageSummary?.()).toMatchObject({
        costUsd: 0, totalTokens: 0, heldCostUsd: 0, hasUnknownCost: false,
      });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(25);
    const journal = child.replayJournal?.() ?? [];
    expect(journal.filter((event) => event.event === "allowed")).toHaveLength(25);
    expect(journal.filter((event) => event.event === "reconciled")).toHaveLength(25);
    expect(journal.filter((event) => event.event === "held_unknown")).toHaveLength(0);
  });

  it("keeps reset-after-dispatch holds and denies retries beyond the $20 Goal cap", async () => {
    const parent = kernel.bindClient({
      cwd: workspace,
      scope: { runId: "goal", sessionId: "goal", autonomous: true, maxCostUsd: 20 },
    });
    const child = parent.forSession({ runId: "worker", sessionId: "worker" });
    const acquireModel = child.acquire.bind(child);
    vi.spyOn(child, "acquire").mockImplementation((input) => acquireModel({
      ...input, maxInputTokens: 150_000, maxOutputTokens: 6_392, maxCostUsd: 1.02,
    }));
    const session = { services: { executionAdmission: child } } as unknown as Session;
    const provider = {
      name: "grok",
      getExecutionProfile: async () => ({ usageReporting: "authoritative", supportsMaxOutputTokens: true }),
    } as unknown as LLMProvider;
    const error = Object.assign(new Error("Connection error."), { code: "ECONNRESET" });
    const invoke = vi.fn(async () => { throw error; });
    const attempt = (index: number) => runAdmittedModelCall({
      session, provider, messages: [], options: { maxOutputTokens: 6_392 },
      stepId: `retry:${index}`, model: "grok-4.5", providerName: "grok", invoke,
    });
    for (let index = 0; index < 19; index += 1) {
      await expect(attempt(index)).rejects.toBe(error);
      expect(parent.getUsageSummary?.()).toMatchObject({
        costUsd: 0, totalTokens: 0, hasUnknownCost: true,
      });
      expect(parent.getUsageSummary?.().heldCostUsd).toBeCloseTo((index + 1) * 1.02);
    }
    await expect(attempt(19)).rejects.toMatchObject({
      code: "ADMISSION_DENIED", reason: "budget_exceeded",
    });
    expect(invoke).toHaveBeenCalledTimes(19);
    const journal = child.replayJournal?.() ?? [];
    expect(journal.filter((event) => event.event === "dispatched")).toHaveLength(19);
    expect(journal.filter((event) => event.event === "held_unknown")).toHaveLength(19);
    expect(journal.filter((event) => event.event === "reconciled")).toHaveLength(0);
  });

  it("runs an unpriced model under a hard cap, persists estimated usage and stops at the ceiling", async () => {
    const rates = conservativeModelCost();
    const cost = 100 / 1000 * rates.inputUsdPer1K + 200 / 1000 * rates.outputUsdPer1K;
    const client = kernel.bindClient({ cwd: workspace,
      scope: { runId: "estimated-goal", sessionId: "estimated-goal", autonomous: false, maxCostUsd: cost },
    });
    const events: import("../../src/budget/admission-types.js").AdmissionJournalEvent[] = [];
    client.subscribe(event => events.push(event));
    const provider = {
      name: "meta",
      getExecutionProfile: async () => ({ usageReporting: "authoritative", supportsMaxOutputTokens: true }),
      tokenCountCapability: { capabilityVersion: "test", adapterRevision: "1", configurationRevision: "1",
        countTokens: async () => ({ inputTokens: 100, complete: true, confidence: "exact",
          countedComponents: ["system", "messages", "tools", "provider_framing"] }) },
    } as unknown as LLMProvider;
    const session = { conversationId: "estimated-goal", services: { executionAdmission: client, admissionRequired: true },
      abortTerminal: vi.fn() } as unknown as Session;
    const invoke = vi.fn(async () => ({ model: "muse-spark-future", content: "ok", toolCalls: [], finishReason: "stop" as const,
      usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300, cachedInputTokens: 20,
        availability: "reported" as const, provenance: "provider" as const } }));
    const call = (stepId: string) => runAdmittedModelCall({ session, provider, messages: [{role: "user", content: "hi"}],
      options: { maxOutputTokens: 200 }, model: "muse-spark-future", providerName: "meta", stepId, invoke });
    await expect(call("first")).resolves.toMatchObject({ content: "ok" });
    expect(events.find(event => event.event === "allowed")).toMatchObject({ reservedCostUsd: cost, details: {costEstimated: true} });
    expect(events.find(event => event.event === "reconciled")).toMatchObject({ actualCostUsd: cost, reason: "estimated_model_price", details: {costEstimated: true} });
    expect(client.getUsageSummary?.()).toMatchObject({ costUsd: cost, costEstimated: true, hasUnknownCost: false });
    await expect(call("second")).rejects.toMatchObject({ reason: "budget_exceeded" });
    expect(invoke).toHaveBeenCalledTimes(1);
    kernel.close();
    kernel = new ExecutionAdmissionKernel({ agencHome: home });
    const restored = kernel.bindClient({ cwd: workspace, scope: { runId: "estimated-goal", sessionId: "estimated-goal", autonomous: false, maxCostUsd: cost } });
    expect(restored.getUsageSummary?.()).toMatchObject({ costUsd: cost, costEstimated: true });
  });

  it("does not exhaust a Goal on rejected Gemini calls, but retains uncertain spend and bills successful cached/thinking usage", async () => {
    const parent = kernel.bindClient({ cwd: workspace,
      scope: { runId: "goal", sessionId: "goal", autonomous: false, maxCostUsd: 20 },
    });
    const child = parent.forSession({ runId: "child", sessionId: "child" });
    const uncertain = await acquire(child, "disconnected", 0.5);
    child.markDispatched(uncertain.reservation.reservationId, { boundary: "provider_wire" });
    child.holdUnknown(uncertain.reservation.reservationId, "connection lost");
    let status = 429;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes(":countTokens")) return Response.json({ totalTokens: 23_917 });
      if (status !== 200) return Response.json({ error: { code: status, message: "request rejected" } }, { status });
      return new Response(`data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 20,
          candidatesTokenCount: 5, thoughtsTokenCount: 10, totalTokenCount: 115 },
      })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const provider = new GeminiProvider({ model: "gemini-3.8-flash", fetchImpl,
      endpointPlan: createGeminiEndpointPlan(),
      credentialPlan: { kind: "api-key", credential: "test-only", source: "factory" },
    });
    const session = { conversationId: "child", services: { executionAdmission: child, admissionRequired: true }, abortTerminal: vi.fn() } as unknown as Session;
    const messages = [{ role: "user" as const, content: "hello" }];
    const call = (stepId: string) => runAdmittedModelCall({ session, provider, messages,
      options: { maxOutputTokens: 65_536 }, stepId, model: "gemini-3.8-flash", providerName: "gemini",
      invoke: options => provider.chatStream(messages, () => {}, options),
    });
    // 80 x $0.26369775 would exceed the $20 cap if rejections kept their holds.
    for (let attempt = 0; attempt < 80; attempt++) {
      status = attempt < 78 ? 429 : 402;
      const error = await call(`rejected:${attempt}`).catch(error => error);
      expect(isLLMPreGenerationRejection(error, "gemini"), String(error)).toBe(true);
    }
    expect(parent.getUsageSummary?.()).toMatchObject({ costUsd: 0, heldCostUsd: 0.5, hasUnknownCost: true, totalTokens: 0 });
    status = 200;
    await call("success");
    expect(parent.getUsageSummary?.()).toMatchObject({ costUsd: 0.00011775, heldCostUsd: 0.5, totalTokens: 115 });
    // The failed request's cost stays conservative across restart too.
    kernel.close();
    kernel = new ExecutionAdmissionKernel({ agencHome: home });
    const restored = kernel.bindClient({ cwd: workspace,
      scope: { runId: "goal", sessionId: "goal", autonomous: false, maxCostUsd: 20 },
    });
    expect(restored.getUsageSummary?.()).toMatchObject({ costUsd: 0.00011775, heldCostUsd: 0.5, hasUnknownCost: true });
  });
  it("reports descendants once without rewriting their journal identity", async () => {
    const parent = bind("parent");
    const child = parent.forSession({ runId: "child", sessionId: "child" });
    const grandchild = child.forSession({ runId: "grandchild", sessionId: "grandchild" });
    const parentJournal: string[] = [];
    parent.subscribe((event) => parentJournal.push(event.runId));
    const observed = observe(parent);
    for (const [index, client] of [parent, child, grandchild].entries()) {
      const lease = await acquire(client, "sample");
      client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
      client.reconcile(lease.reservation.reservationId, {
        inputTokens: 4, outputTokens: 2, costUsd: (index + 1) / 10,
      });
    }
    expect(parent.getUsageSummary?.()).toMatchObject({
      runId: "parent", costUsd: 0.6, inputTokens: 12, outputTokens: 6,
      totalTokens: 18, modelCalls: 3, heldCostUsd: 0, hasUnknownCost: false,
    });
    expect(child.getUsageSummary?.()).toMatchObject({
      runId: "child", costUsd: 0.5, modelCalls: 2,
    });
    expect(observed.snapshots.at(-1)?.costUsd).toBe(0.6);
    expect(new Set(parentJournal)).toEqual(new Set(["parent"]));
    expect(observed.snapshots.map((snapshot) => snapshot.sequence))
      .toEqual([...observed.snapshots.map((snapshot) => snapshot.sequence)].sort((left, right) => left - right));
    observed.unsubscribe();
  });

  it("does not notify unrelated run scopes in the same or another workspace", async () => {
    const parent = bind("parent");
    const sibling = bind("unrelated");
    const otherWorkspace = join(home, "other-project");
    mkdirSync(join(otherWorkspace, ".git"), { recursive: true });
    const outside = bind("outside", otherWorkspace);
    const observed = observe(parent);
    for (const client of [sibling, outside]) {
      const lease = await acquire(client, "unrelated-spend");
      client.reconcile(lease.reservation.reservationId, {
        inputTokens: 4, outputTokens: 2, costUsd: 0.5,
      });
    }
    expect(observed.snapshots).toEqual([]);
    expect(parent.getUsageSummary?.()).toMatchObject({ costUsd: 0, modelCalls: 0 });
    observed.unsubscribe();
  });

  it("keeps unknown holds separate from actual usage and refreshes after late reconciliation", async () => {
    const parent = bind("parent");
    const child = parent.forSession({ runId: "child", sessionId: "child" });
    const observed = observe(parent);
    const lease = await acquire(child, "unknown-response");
    child.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    child.holdUnknown(lease.reservation.reservationId, "fixture missing usage");
    expect(observed.snapshots.at(-1)).toMatchObject({
      costUsd: 0, modelCalls: 0, hasUnknownCost: true, heldCostUsd: 1,
    });
    child.reconcile(lease.reservation.reservationId, {
      inputTokens: 4, outputTokens: 2, costUsd: 0.25,
    });
    expect(observed.snapshots.at(-1)).toMatchObject({
      costUsd: 0.25, modelCalls: 1, hasUnknownCost: false, heldCostUsd: 0,
    });
    const count = observed.snapshots.length;
    child.reconcile(lease.reservation.reservationId, {
      inputTokens: 4, outputTokens: 2, costUsd: 0.25,
    });
    expect(observed.snapshots).toHaveLength(count);
    observed.unsubscribe();
  });

  it("drops observers on unsubscribe and restores authoritative totals after restart", async () => {
    const parent = bind("parent");
    const observed = observe(parent);
    const lease = await acquire(parent, "sample");
    observed.unsubscribe();
    const count = observed.snapshots.length;
    parent.reconcile(lease.reservation.reservationId, {
      inputTokens: 4, outputTokens: 2, costUsd: 0.25,
    });
    expect(observed.snapshots).toHaveLength(count);
    kernel.close();
    kernel = new ExecutionAdmissionKernel({ agencHome: home });
    kernel.initializeExistingState();
    const restored = bind("parent");
    expect(restored.getUsageSummary?.()).toMatchObject({ costUsd: 0.25, modelCalls: 1 });
    const renewed = observe(restored);
    const next = await acquire(restored, "next");
    restored.void(next.reservation.reservationId, "fixture complete");
    expect(renewed.snapshots.at(-1)).toMatchObject({ costUsd: 0.25, heldCostUsd: 0 });
    expect(observed.snapshots).toHaveLength(count);
    renewed.unsubscribe();
  });

  it("retries a failed observer on the next journal boundary without charging usage twice", async () => {
    const parent = bind("parent");
    const unrelated = bind("unrelated");
    const lease = await acquire(parent, "sample");
    const snapshots: AdmissionUsageSummary[] = [];
    let attempts = 0;
    const unsubscribe = parent.subscribeUsage?.((summary) => {
      attempts += 1;
      if (attempts === 1) throw new Error("fixture observer unavailable");
      snapshots.push(summary);
    });
    parent.reconcile(lease.reservation.reservationId, {
      inputTokens: 4, outputTokens: 2, costUsd: 0.25,
    });
    expect(attempts).toBe(1);
    expect(snapshots).toEqual([]);
    const other = await acquire(unrelated, "next-boundary");
    expect(attempts).toBe(2);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ costUsd: 0.25, modelCalls: 1, heldCostUsd: 0 });
    unrelated.void(other.reservation.reservationId, "fixture complete");
    expect(attempts).toBe(2);
    expect(parent.getUsageSummary?.()).toMatchObject({ costUsd: 0.25, modelCalls: 1 });
    unsubscribe?.();
  });
});
