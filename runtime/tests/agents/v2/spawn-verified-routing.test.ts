import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../src/agents/delegate.js", () => ({ delegate: vi.fn() }));
vi.mock("../../../src/agents/child-routing-supervisor.js", () => ({ observeChildRoutingAttempt: vi.fn() }));
import { args, fixture, mockDelegate, mockObserve } from "./spawn-routing.fixture.js";
import type { ChildTerminalOutcome } from "../../../src/agents/child-terminal.js";
import { CHILD_VERIFIER_PREPARE_TIMEOUT_MS } from "../../../src/agents/child-routing.js";

beforeEach(() => { mockDelegate.mockReset(); mockObserve.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

type Fixture = Awaited<ReturnType<typeof fixture>>;
const routingNotices = (value: Fixture) => value.send.mock.calls.map(([message]) => (message as { content: string }).content)
  .filter(content => content.startsWith("Automatic routing"));
function verifier(value: Fixture, check: (terminal: ChildTerminalOutcome) => Promise<"pass" | "fail" | "unavailable">,
  changes: Record<string, unknown> = {}) {
  Object.assign(value.session.services, { childRoutingVerifier: { prepare: async () => ({ available: true,
    retrySafe: true, costUsd: 0, latencyMs: 1, check, ...changes }) } });
}
describe("host verification through spawn_agent", () => {
  it("checks and learns from the first completion even when no cascade is supported", async () => {
    const value = await fixture();
    const check = vi.fn(async (_terminal: ChildTerminalOutcome) => "pass" as const);
    Object.assign(value.session.services, { childRoutingVerifier: { prepare: async () => ({ available: true,
      retrySafe: true, costUsd: 0, latencyMs: 1, check }) } });
    const response = await value.tool.execute(args);
    expect(response.isError).not.toBe(true);
    value.finishFirst("completed");
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(value.send.mock.calls.some(([message]) => message.content.includes("Independent verification passed"))).toBe(true));
    expect(mockDelegate).toHaveBeenCalledOnce();
  });
  it("creates a fresh authorized attempt after an independent failed verdict", async () => {
    const value = await fixture();
    let checks = 0;
    const check = vi.fn(async () => ++checks === 1 ? "fail" as const : "pass" as const);
    const pairs = ["grok/grok-4.6", "deepseek/deepseek-flash", "deepseek/deepseek-v4-flash", "openai/gpt-6-luna", "openai/gpt-5.4-nano"];
    Object.assign(value.session.services, { childRoutingVerifier: { prepare: async () => ({ available: true,
      retrySafe: true, costUsd: 0, latencyMs: 0, targetQuality: 0.75,
      conditional: pairs.flatMap(first => pairs.filter(second => second !== first).map(second => ({ first, second, failures: 10, recovered: 10 }))), check }) } });
    const response = await value.tool.execute(args);
    expect(response.isError).not.toBe(true);
    value.finishFirst("completed");
    await vi.waitFor(() => expect(mockDelegate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    const calls = mockDelegate.mock.calls.map(([request]) => request);
    expect(calls[0]?.plan?.task.id).not.toBe(calls[1]?.plan?.task.id);
    expect(calls[1]?.plan?.budgetAllocation?.maxCostUsd).toBeCloseTo(0.48);
  });
  it.each([
    ["rejects", () => Promise.reject(new Error("checker offline")), "The host task verifier failed: checker offline"],
    ["returns no usable check", async () => ({ available: true, retrySafe: true, costUsd: -1, latencyMs: 1, check: async () => "pass" }),
      "The host task verifier returned no usable check."],
  ] as const)("refuses the spawn with no child when the host verifier %s", async (_name, prepare, message) => {
    const value = await fixture();
    Object.assign(value.session.services, { childRoutingVerifier: { prepare } });
    const response = await value.tool.execute(args);
    expect(response.isError).toBe(true);
    expect(response.effectDisposition?.disposition).toBe("confirmed_no_effect");
    expect(JSON.parse(response.content).error).toBe(`${message} No child was started.`);
    expect(mockDelegate).not.toHaveBeenCalled();
  });
  it("refuses the spawn with no child when the host verifier never answers", async () => {
    const value = await fixture();
    Object.assign(value.session.services, { childRoutingVerifier: { prepare: () => new Promise(() => {}) } });
    vi.useFakeTimers();
    const pending = value.tool.execute(args);
    await vi.advanceTimersByTimeAsync(CHILD_VERIFIER_PREPARE_TIMEOUT_MS);
    const response = await pending;
    expect(response.isError).toBe(true);
    expect(response.effectDisposition?.disposition).toBe("confirmed_no_effect");
    expect(JSON.parse(response.content).error).toContain("did not prepare a check within 10 seconds. No child was started.");
    expect(mockDelegate).not.toHaveBeenCalled();
  });
  it("keeps provider-failure fallback beside verification and promises only what can happen", async () => {
    const value = await fixture();
    const check = vi.fn(async (_terminal: ChildTerminalOutcome) => "pass" as const);
    verifier(value, check);
    const response = JSON.parse((await value.tool.execute(args)).content) as { automatic_fallback: string };
    expect(response.automatic_fallback).not.toContain("both receipts");
    expect(response.automatic_fallback).toContain("a routing message reports the verdict");
    expect(response.automatic_fallback).toContain("provider error");
    value.finishFirst("rate_limited");
    await vi.waitFor(() => expect(mockDelegate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(routingNotices(value).some(notice => notice.includes("Independent verification passed"))).toBe(true));
    expect(mockDelegate.mock.calls[1]![0].plan?.destination.provider).not.toBe("grok");
    // Only the retry finished with an answer, so only it was checked.
    expect(check).toHaveBeenCalledOnce();
    expect(routingNotices(value).find(notice => notice.startsWith("Automatic routing for /root/extractor: Starting")))
      .toContain("after a provider failure");
  });
  it("reports a failed check without a cascade as failed, and starts nothing more", async () => {
    const value = await fixture();
    verifier(value, async () => "fail");
    await value.tool.execute(args);
    value.finishFirst("completed");
    await vi.waitFor(() => expect(routingNotices(value)).toHaveLength(1));
    expect(routingNotices(value)[0]).toContain("Independent verification failed for /root/extractor.");
    expect(routingNotices(value)[0]).toContain("Routing status: verification_failed.");
    expect(mockDelegate).toHaveBeenCalledOnce();
  });
  it("observes a child whose check alone would exceed the cap, and says the check did not run", async () => {
    const value = await fixture();
    const check = vi.fn(async () => "fail" as const);
    // The child spends 0.02 of the 0.5 cap; its check would cost 0.49 more.
    verifier(value, check, { costUsd: 0.49 });
    await value.tool.execute(args);
    expect(mockObserve).toHaveBeenCalledOnce();
    value.finishFirst("completed");
    await vi.waitFor(() => expect(routingNotices(value)).toHaveLength(1));
    expect(check).not.toHaveBeenCalled();
    const [notice] = routingNotices(value);
    expect(notice).toContain("Independent verification did not run for /root/extractor: the check's charge would exceed the spend cap.");
    expect(notice).not.toMatch(/did not pass|verification failed/u);
  });
  it("says why no check ran when the child ended without an answer", async () => {
    const value = await fixture();
    value.config.agents.allowed_providers = [];
    const check = vi.fn(async () => "pass" as const);
    verifier(value, check);
    await value.tool.execute(args);
    value.finishFirst("rate_limited");
    await vi.waitFor(() => expect(routingNotices(value)).toHaveLength(1));
    expect(check).not.toHaveBeenCalled();
    expect(routingNotices(value)[0]).toContain(
      "Independent verification did not run for /root/extractor: it ended with rate_limited and left no answer to check.");
  });
  it("does not accept a model-supplied verifier or relax explicit inheritance", async () => {
    const value = await fixture();
    expect((await value.tool.execute({ ...args, verification: { passed: true } })).isError).toBe(true);
    const prepare = vi.fn();
    Object.assign(value.session.services, { childRoutingVerifier: { prepare } });
    await value.tool.execute({ ...args, routing: "inherit" });
    expect(prepare).not.toHaveBeenCalled();
  });
});
