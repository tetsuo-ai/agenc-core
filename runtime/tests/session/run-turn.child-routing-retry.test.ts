import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMRateLimitError, LLMServerError, LLMTimeoutError } from "../../src/llm/errors.js";
import { runTurn } from "../../src/session/run-turn.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("automatic child routing owns provider retries", () => {
  it.each([
    ["429", () => new LLMRateLimitError("test", 600_000)],
    ["503", () => new LLMServerError("test", 503, "unavailable")],
    ["timeout", () => new LLMTimeoutError("test", 1_000)],
  ] as const)("returns %s after one attempt without the outage ladder", async (_name, error) => {
    const chatStream = vi.fn(async () => { throw error(); });
    const { session, events } = mkSession({ provider: { ...mkProvider(), chatStream } });
    await drain(runTurn(session, mkCtx(), "review this task", { childRoutingOwnsRetries: () => true }));
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.msg.type === "turn_failed")).toHaveLength(1);
    expect(events.some((event) => event.msg.type === "turn_complete")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("provider_outage_wait");
    expect(JSON.stringify(events)).not.toContain("stream_disconnected");
  });

  it("keeps the ordinary retry when no supervisor can act", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const owns = vi.fn(() => false);
    let calls = 0;
    const provider = mkProvider({ content: "recovered" });
    const chatStream = vi.fn(async (...request: Parameters<typeof provider.chatStream>) => {
      calls += 1;
      if (calls === 1) throw new LLMServerError("test", 503, "unavailable");
      return provider.chatStream(...request);
    });
    const { session, events } = mkSession({ provider: { ...provider, chatStream } });
    await drain(runTurn(session, mkCtx(), "review this task", { childRoutingOwnsRetries: owns }));
    expect(chatStream).toHaveBeenCalledTimes(2);
    // The decision is read when the provider fails, not when the turn starts.
    expect(owns).toHaveBeenCalled();
    expect(events.some((event) => event.msg.type === "turn_complete")).toBe(true);
    expect(events.some((event) => event.msg.type === "turn_failed")).toBe(false);
  });

  it("reads ownership at the failure, so a supervisor that lost authority mid-request leaves retries on", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let supervised = true;
    let calls = 0;
    const provider = mkProvider({ content: "recovered" });
    const chatStream = vi.fn(async (...request: Parameters<typeof provider.chatStream>) => {
      calls += 1;
      if (calls === 1) {
        // The parent turn ends while this request is in flight.
        supervised = false;
        throw new LLMServerError("test", 503, "unavailable");
      }
      return provider.chatStream(...request);
    });
    const { session, events } = mkSession({ provider: { ...provider, chatStream } });
    await drain(runTurn(session, mkCtx(), "review this task", { childRoutingOwnsRetries: () => supervised }));
    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.msg.type === "turn_complete")).toBe(true);
  });
});
