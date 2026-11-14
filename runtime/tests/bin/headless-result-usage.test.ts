import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";

import { AgenCThread } from "../../src/agents/thread-manager.js";
import { terminalUsageForActiveAgent } from "../../src/app-server/background-agent-runner/snapshot-retention.js";
import { notificationFromDaemonEvent } from "../../src/app-server/background-agent-runner/daemon-events.js";
import { awaitDaemonOneShotRun } from "../../src/bin/daemon-one-shot-cli.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { GeminiProvider } from "../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../src/llm/providers/gemini/endpoint-plan.js";
import { streamModel } from "../../src/phases/stream-model.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import type { Event, Session } from "../../src/session/session.js";
import { mkCtx, mkSession } from "../fixtures.js";

it.each([
  { providerName: "gemini", model: "gemini-4-argon", estimated: false, missingUsage: false },
  { providerName: "gemini", model: "gemini-unregistered-fixture", estimated: true, missingUsage: false },
  { providerName: "deepseek", model: "deepseek-flash", estimated: false, missingUsage: false },
  { providerName: "deepseek", model: "deepseek-flash", estimated: false, missingUsage: true },
])("reports final session usage for $providerName/$model (missing usage: $missingUsage) through headless JSONL", async ({ providerName, model, estimated, missingUsage }) => {
  const home = mkdtempSync(join(tmpdir(), "headless-usage-"));
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const kernel = new ExecutionAdmissionKernel({ agencHome: home });
  const admission = kernel.bindClient({ cwd, scope: { runId: "conv-test", sessionId: "conv-test", autonomous: false } });
  let calls = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes(":countTokens")) return Response.json({ totalTokens: 10 });
    const input = 100 * ++calls;
    const data = providerName === "gemini" ? {
      candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: input, candidatesTokenCount: 5, thoughtsTokenCount: 10,
        cachedContentTokenCount: 20, totalTokenCount: input + 15 },
    } : {
      id: `completion-${calls}`, model,
      choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
      ...(missingUsage && calls === 4 ? {} : { usage: { prompt_tokens: input, completion_tokens: 15, total_tokens: input + 15,
        prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: input - 20,
        completion_tokens_details: { reasoning_tokens: 10 } } }),
    };
    return new Response(`data: ${JSON.stringify(data)}\n\n${providerName === "deepseek" ? "data: [DONE]\n\n" : ""}`,
      { headers: { "content-type": "text/event-stream" } });
  });
  const provider = providerName === "gemini"
    ? new GeminiProvider({ model, fetchImpl, endpointPlan: createGeminiEndpointPlan(),
        credentialPlan: { kind: "api-key", credential: "test-only", source: "factory" } })
    : new DeepSeekProvider({ model, apiKey: "test-only", baseURL: "https://recording-proxy.invalid/v1", fetchImpl });
  // Avoid metadata discovery. The native adapters still parse every scripted SSE response.
  vi.spyOn(provider, "getExecutionProfile").mockResolvedValue({ usageReporting: "authoritative", supportsMaxOutputTokens: true });
  const { session } = mkSession({ cwd, model, provider, services: {
    executionAdmission: admission, admissionRequired: true,
  } });
  await session.state.with(state => {
    state.sessionConfiguration = { ...state.sessionConfiguration, reasoningEffortCleared: true };
  });
  const active = { thread: new AgenCThread({ threadId: session.conversationId, kind: "root", session }),
    bootstrap: { session } } as Parameters<typeof terminalUsageForActiveAgent>[0];
  let send: ((event: unknown) => void) | undefined;
  let sequence = 0;
  // Use the production journal projection with an in-memory rollout sink.
  const unbind = bindExecutionAdmissionJournal({ conversationId: session.conversationId,
    emit: (event: Event) => {
      const projected = { ...event, seq: ++sequence };
      if (send) send(notificationFromDaemonEvent(session.conversationId, "agent", {
        id: projected.id, sequence: projected.seq, type: event.msg.type, payload: event.msg.payload,
      }));
      return projected;
    },
  } as Session, admission);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  let errors = "";
  stdout.on("data", chunk => { output += chunk.toString(); });
  stderr.on("data", chunk => { errors += chunk.toString(); });
  const client = {
    subscribeToConnectionState: () => () => {},
    subscribeToSessionEvents: (_id: string, callback: (event: unknown) => void) => {
      send = callback;
      return () => { send = undefined; };
    },
    request: async (method: string) => {
      expect(method).toBe("session.snapshot");
      return { tokenUsage: terminalUsageForActiveAgent(active) };
    },
  } as unknown as Parameters<typeof awaitDaemonOneShotRun>[0]["daemonClient"];
  try {
    const pending = awaitDaemonOneShotRun({ daemonClient: client, sessionId: session.conversationId,
      agentId: "agent", outputFormat: "stream-json", signal: new AbortController().signal,
      io: { stdin: new PassThrough() as NodeJS.ReadStream, stdout: stdout as NodeJS.WriteStream, stderr: stderr as NodeJS.WriteStream } });
    for (let i = 0; i < 2; i++) {
      const ctx = mkCtx({ cwd, subId: `turn-${i}`, collaborationMode: { model } });
      const state = buildInitialTurnState(ctx, { role: "user", content: "hello" });
      await streamModel(state, ctx, session, { input: state.messages, tools: [],
        parallelToolCalls: false, baseInstructions: "", maxOutputTokens: 64 });
    }
    // Auxiliary model calls are in session_usage but not the main-loop live counter.
    const messages = [{ role: "user" as const, content: "summarize" }];
    await runAdmittedModelCall({ session, provider, messages, options: { maxOutputTokens: 64 },
      model, providerName, stepId: "auxiliary", invoke: options => provider.chatStream(messages, () => {}, options) });
    if (missingUsage) {
      await runAdmittedModelCall({ session, provider, messages, options: { maxOutputTokens: 64 },
        model, providerName, stepId: "missing-usage", invoke: options => provider.chatStream(messages, () => {}, options) });
    }
    send!({ method: "event.agent_status", params: { sessionId: session.conversationId, status: "idle", runStatus: "completed" } });
    await pending;
    const lines = output.trim().split("\n").map(line => JSON.parse(line));
    const summary = lines.filter(line => line.event?.params?.event?.type === "session_usage").at(-1)?.event.params.event.payload;
    expect(summary).toMatchObject({ inputTokens: 600, outputTokens: 45, totalTokens: 645,
      modelCalls: 3, hasUnknownCost: missingUsage });
    expect(summary.costUsd).toBeGreaterThan(0);
    expect(lines.at(-1)).toMatchObject({ type: "result", exitCode: 0, tokenUsage: {
      inputTokens: summary.inputTokens, outputTokens: summary.outputTokens, totalTokens: summary.totalTokens,
      costUsd: summary.costUsd, costKnown: !summary.hasUnknownCost,
      ...(estimated ? { costEstimated: true } : {}),
    } });
    expect(lines.at(-1).tokenUsage.costEstimated).toBe(summary.costEstimated);
    expect(calls).toBe(missingUsage ? 4 : 3);
    expect(errors).toBe("");
  } finally {
    unbind();
    kernel.close();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  }
});

/** Run the headless finalizer over scripted session events and return its result line. */
async function resultLineFor(events: readonly unknown[]): Promise<Record<string, unknown>> {
  let send: ((event: unknown) => void) | undefined;
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", chunk => { output += chunk.toString(); });
  const client = {
    subscribeToConnectionState: () => () => {},
    subscribeToSessionEvents: (_id: string, callback: (event: unknown) => void) => {
      send = callback;
      return () => { send = undefined; };
    },
    request: async () => ({ tokenUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, costUsd: 0, costKnown: false } }),
  } as unknown as Parameters<typeof awaitDaemonOneShotRun>[0]["daemonClient"];
  const pending = awaitDaemonOneShotRun({ daemonClient: client, sessionId: "session-1", agentId: "agent",
    outputFormat: "stream-json", signal: new AbortController().signal,
    io: { stdin: new PassThrough() as NodeJS.ReadStream, stdout: stdout as NodeJS.WriteStream,
      stderr: new PassThrough() as NodeJS.WriteStream } });
  for (const event of events) send!(event);
  send!({ method: "event.agent_status", params: { sessionId: "session-1", status: "idle", runStatus: "completed" } });
  await pending;
  return JSON.parse(output.trim().split("\n").at(-1)!) as Record<string, unknown>;
}

function usageEvent(agentId: string, payload: Record<string, unknown>): unknown {
  return { jsonrpc: "2.0", method: "event.session_event",
    params: { sessionId: "session-1", agentId, event: { type: "session_usage", payload } } };
}

it("keeps the snapshot counter when the stream carried no usable ledger summary", async () => {
  const snapshot = { inputTokens: 7, outputTokens: 3, totalTokens: 10, costUsd: 0, costKnown: false };
  expect((await resultLineFor([])).tokenUsage).toEqual(snapshot);
  // Another agent's summary is not this run's, and half a summary is not a summary.
  expect((await resultLineFor([
    usageEvent("another-agent", { inputTokens: 900, outputTokens: 90, totalTokens: 990, costUsd: 1, hasUnknownCost: false }),
    usageEvent("agent", { inputTokens: 900, outputTokens: 90, totalTokens: 990, costUsd: 1 }),
    usageEvent("agent", { inputTokens: 900, outputTokens: 90, totalTokens: Number.NaN, costUsd: 1, hasUnknownCost: false }),
  ])).tokenUsage).toEqual(snapshot);
});

it("reports the latest ledger summary of the run, unknown cost included", async () => {
  expect((await resultLineFor([
    usageEvent("agent", { inputTokens: 100, outputTokens: 10, totalTokens: 110, costUsd: 0.25, hasUnknownCost: false }),
    usageEvent("agent", { inputTokens: 300, outputTokens: 30, totalTokens: 330, costUsd: 0.5, hasUnknownCost: true, costEstimated: true }),
    usageEvent("another-agent", { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 9, hasUnknownCost: false }),
  ])).tokenUsage).toEqual({ inputTokens: 300, outputTokens: 30, totalTokens: 330, costUsd: 0.5, costKnown: false, costEstimated: true });
});
