import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../../src/llm/provider.js";
import { LLMServerError } from "../../src/llm/errors.js";
import { runTurn } from "../../src/session/run-turn.js";
import { createTestConfigStore, drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { setRunDeadlineClockForTests } from "../../src/session/run-deadline.js";

afterEach(() => { vi.restoreAllMocks(); setRunDeadlineClockForTests(null); });
const frame = (delta: unknown, finish_reason?: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const services = () => ({ configStore: createTestConfigStore({ base: { provider_outage_wait_ms: 0 } }),
  permissionModeRegistry: new PermissionModeRegistry(createEmptyToolPermissionContext({ mode: "bypassPermissions", isBypassPermissionsModeAvailable: true })) });

describe("transport recovery receipts", () => {
  it("recovers generic partial SSE and 502, preserving a completed tool exactly once", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const responses = [
      sse(frame({ content: "discard this partial text" }) + 'data: {"choices":[{"delta":{"tool_calls":'),
      new Response("synthetic upstream transport failure", { status: 502 }),
      sse(frame({ tool_calls: [{ index: 0, id: "write-once", type: "function", function: { name: "stream_write", arguments: "{}" } }] }, "tool_calls")),
      sse(frame({ content: "also discard" })),
      sse(frame({ content: "Finished." }, "stop")),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() ?? sse(""));
    const provider = createProvider("openai-compatible", { model: "mock-model", extra: { fetchImpl, maxRetries: 0 } });
    const dispatch = vi.fn(async () => ({ content: "written once", isError: false }));
    const { session, events, state } = mkSession({ provider, registry: {
      tools: [{ name: "stream_write", description: "fixture write", inputSchema: { type: "object" }, execute: dispatch }],
      toLLMTools: () => [], dispatch,
    }, services: services() });
    await drain(session.runTurn("write once then report", { ctx: mkCtx() }));
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(events.some(event => event.msg.type === "turn_failed")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ msg: { type: "turn_complete", payload: expect.objectContaining({ lastAgentMessage: "Finished.", usableFinalAnswer: true }) } }));
    const receipts = events.filter(event => event.msg.type === "warning" && event.msg.payload.cause === "transport_recovery");
    expect(receipts).toContainEqual(expect.objectContaining({ msg: expect.objectContaining({ payload: expect.objectContaining({ details: expect.objectContaining({ category: "http_5xx", status: 502, toolReplay: false }) }) }) }));
    expect(receipts.filter(event => event.msg.type === "warning" && event.msg.payload.details?.outcome === "recovered")).toHaveLength(2);
    expect(receipts).toContainEqual(expect.objectContaining({ msg: expect.objectContaining({ payload: expect.objectContaining({
      details: expect.objectContaining({ outcome: "interrupted", completedToolCallIds: "write-once" }),
    }) }) }));
    expect(JSON.stringify(state.history)).not.toContain("discard");
  });

  it("exhausts six generic EOF attempts with typed failure and no usable final answer", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchImpl = vi.fn(async () => sse(frame({ content: "partial" })));
    const provider = createProvider("openai-compatible", { model: "mock-model", extra: { fetchImpl, maxRetries: 0 } });
    const { session, events } = mkSession({ provider, services: services() });
    await drain(session.runTurn("finish", { ctx: mkCtx() }));
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(events).toContainEqual(expect.objectContaining({ msg: { type: "turn_failed", payload: expect.objectContaining({
      code: "transport_error", transportFailure: { category: "stream_truncated" }, durationMs: expect.any(Number), usableFinalAnswer: false,
    }) } }));
  });

  it("does not wait or retry when backoff cannot fit the remaining deadline", async () => {
    const failure = Object.assign(new LLMServerError("mock", 502, "upstream failure"), {
      retryAfterDirective: { classification: "valid", floorMs: 10_000 },
    });
    const chatStream = vi.fn(async () => { throw failure; });
    const { session, events } = mkSession({ provider: { ...mkProvider(), chatStream },
      services: { ...services(), runtimeOptions: { deadlineAt: Date.now() + 5_000 } } });
    await drain(runTurn(session, mkCtx(), "finish"));
    expect(chatStream).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ msg: { type: "turn_failed", payload: expect.objectContaining({
      code: "transport_error", transportFailure: { category: "http_5xx", status: 502 }, remainingDeadlineMs: expect.any(Number), usableFinalAnswer: false,
    }) } }));
  });

  it("bounds the slow outage ladder as well as the fast reconnect attempts", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const chatStream = vi.fn(async () => { throw new LLMServerError("mock", 502, "upstream failure"); });
    const { session, events } = mkSession({ provider: { ...mkProvider(), chatStream }, services: {
      ...services(), configStore: createTestConfigStore({ base: { provider_outage_wait_ms: 60_000, provider_outage_retry_ms: 1 } }),
    } });
    await drain(runTurn(session, mkCtx(), "finish"));
    expect(chatStream).toHaveBeenCalledTimes(11);
    expect(events).toContainEqual(expect.objectContaining({ msg: { type: "turn_failed", payload: expect.objectContaining({ code: "transport_error" }) } }));
  });

  it("retains the transport category when the deadline passes before the next dispatch", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let now = 0;
    setRunDeadlineClockForTests({ now: () => now, schedule: () => () => {} });
    const chatStream = vi.fn(async () => { now = 10_001; throw new LLMServerError("mock", 502, "upstream failure"); });
    const { session, events } = mkSession({ provider: { ...mkProvider(), chatStream },
      services: { ...services(), runtimeOptions: { deadlineAt: 10_000 } } });
    await drain(runTurn(session, mkCtx(), "finish"));
    expect(chatStream).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ msg: { type: "turn_failed", payload: expect.objectContaining({
      code: "deadline_reached", transportFailure: { category: "http_5xx", status: 502 }, remainingDeadlineMs: 0, usableFinalAnswer: false,
    }) } }));
  });
});
