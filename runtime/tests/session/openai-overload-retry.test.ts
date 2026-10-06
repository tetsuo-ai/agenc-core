import { afterEach, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { runTurn } from "../../src/session/run-turn.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";
import { recordingAdmission } from "../helpers/stream-progress-fixture.js";

const overload = 'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_is_overloaded","message":"The server is overloaded."}}}\n\n';
const done = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
  id: "completed", status: "completed", model: "gpt-6-luna",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
} })}\n\n`;

afterEach(() => vi.restoreAllMocks());

test.each(["success", "exhausted", "cancelled", "directive", "partial", "budget-spent"] as const)("real adapter reconnect preserves %s behavior", async mode => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  if (mode === "budget-spent") {
    const recovery = await import("../../src/recovery/fallback-ladder.js");
    const reserve = recovery.reserveRecoveryReentry;
    vi.spyOn(recovery, "reserveRecoveryReentry").mockImplementation(async (session, state, opts) => {
      state.recoveryReentryCount = recovery.MAX_RECOVERY_REENTRIES;
      return reserve(session, state, opts);
    });
  }
  const abort = new AbortController();
  let calls = 0;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    calls++;
    if (mode === "cancelled") abort.abort();
    const prefix = mode === "directive" ? 'event: error\ndata: {"type":"error","code":"server_is_overloaded","headers":{"x-retry-metadata":"NO_MORE_RETRY"}}\n\n'
      : mode === "partial" ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Started."}\n\n' : "";
    return new Response(mode === "success" && calls > 1 ? done : prefix + overload,
      { headers: { "content-type": "text/event-stream" } });
  });
  const provider = new OpenAIProvider({ apiKey: "test", model: "gpt-6-luna", useResponsesApi: true, fetchImpl });
  const { session, events } = mkSession({ provider, model: "gpt-6-luna" });
  const current = session.services.configStore.current();
  vi.spyOn(session.services.configStore, "current").mockReturnValue({ ...current, provider_outage_wait_ms: 0 });
  const ctx = mkCtx({ reasoningEffort: "low" });
  await drain(runTurn(session, { ...ctx,
    config: { ...ctx.config, model: "gpt-6-luna", model_provider: "openai", max_output_tokens: 8192 },
  }, "Complete the task.", { signal: abort.signal }));
  expect(fetchImpl).toHaveBeenCalledTimes(mode === "success" ? 2 : mode === "exhausted" ? 6 : 1);
  const retries = events.filter(event => event.msg.type === "stream_error" && event.msg.payload.cause === "stream_disconnected");
  expect(retries).toHaveLength(mode === "success" ? 1 : mode === "exhausted" ? 5 : 0);
  for (const event of retries) expect(event.msg).toMatchObject({ type: "stream_error", payload: { status: 503, provider: "openai" } });
  expect(events.some(event => event.msg.type === "turn_complete")).toBe(mode === "success");
  if (mode === "exhausted" || mode === "directive") expect(events.some(event => event.msg.type === "turn_failed")).toBe(true);
  // Reconnect replays the original request, retaining settings and the output ceiling.
  if (mode === "success" || mode === "exhausted") {
    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    for (const body of bodies) expect(body).toEqual(bodies[0]);
  }
});

test.each([
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "Started." }] },
  { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "Considering." }] },
  { type: "function_call", id: "fc1", call_id: "call1", name: "exec", arguments: '{"command":"touch marker"}' },
])("failed $type snapshot cannot reserve or dispatch a second admitted sample", async item => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(
    `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: {
      status: "failed", error: { code: "server_is_overloaded", message: "Overloaded" }, output: [item],
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } },
  ));
  const provider = new OpenAIProvider({ apiKey: "test", model: "gpt-6-luna", useResponsesApi: true, fetchImpl,
    providerFallback: { provider: "openai", model: "gpt-6-luna", targets: [{ provider: "grok", model: "grok-4-fast" }] },
  });
  const admission = recordingAdmission();
  const { session, events } = mkSession({ provider, model: "gpt-6-luna", services: {
    admissionRequired: true, executionAdmission: admission.client,
  } });
  const dispatch = vi.spyOn(session.services.registry, "dispatch");
  const current = session.services.configStore.current();
  vi.spyOn(session.services.configStore, "current").mockReturnValue({ ...current, provider_outage_wait_ms: 0 });
  const ctx = mkCtx({ reasoningEffort: "low" });
  await drain(runTurn(session, { ...ctx,
    config: { ...ctx.config, model: "gpt-6-luna", model_provider: "openai", max_output_tokens: 8192 },
  }, "Complete the task."));
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(admission.spies.acquire).toHaveBeenCalledOnce();
  expect(admission.spies.holdUnknown).toHaveBeenCalledExactlyOnceWith(expect.any(String), "provider_call_failed_after_dispatch");
  expect(admission.spies.acknowledgeCompletion).toHaveBeenCalledOnce();
  expect(admission.spies.reconcile).not.toHaveBeenCalled();
  expect(admission.spies.void).not.toHaveBeenCalled();
  expect(admission.spies.recordFallback).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(events.some(event => event.msg.type === "turn_failed")).toBe(true);
  expect(events.some(event => event.msg.type === "turn_complete")).toBe(false);
  expect(events.filter(event => event.msg.type === "stream_error" && event.msg.payload.cause === "stream_disconnected")).toHaveLength(0);
});
