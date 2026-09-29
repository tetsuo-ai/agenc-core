import { describe, expect, it, vi } from "vitest";
import { LLMRateLimitError, LLMServerError, LLMTimeoutError } from "../../src/llm/errors.js";
import { runTurn } from "../../src/session/run-turn.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

describe("automatic child routing owns provider retries", () => {
  it.each([
    ["429", () => new LLMRateLimitError("test", 600_000)],
    ["503", () => new LLMServerError("test", 503, "unavailable")],
    ["timeout", () => new LLMTimeoutError("test", 1_000)],
  ] as const)("returns %s after one attempt without the outage ladder", async (_name, error) => {
    const chatStream = vi.fn(async () => { throw error(); });
    const { session, events } = mkSession({ provider: { ...mkProvider(), chatStream } });
    await drain(runTurn(session, mkCtx(), "review this task", { automaticChildRouting: true }));
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.msg.type === "turn_failed")).toHaveLength(1);
    expect(events.some((event) => event.msg.type === "turn_complete")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("provider_outage_wait");
  });
});
