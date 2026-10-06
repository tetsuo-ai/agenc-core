import { afterEach, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { runTurn } from "../../src/session/run-turn.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";

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
