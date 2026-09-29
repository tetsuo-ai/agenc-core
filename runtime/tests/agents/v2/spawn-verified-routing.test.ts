import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../src/agents/delegate.js", () => ({ delegate: vi.fn() }));
vi.mock("../../../src/agents/child-routing-supervisor.js", () => ({ observeChildRoutingAttempt: vi.fn() }));
import { args, fixture, mockDelegate, mockObserve } from "./spawn-routing.fixture.js";
import type { ChildTerminalOutcome } from "../../../src/agents/child-terminal.js";

beforeEach(() => { mockDelegate.mockReset(); mockObserve.mockReset(); });
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
    const pairs = ["deepseek/deepseek-flash", "deepseek/deepseek-v4-flash", "openai/gpt-6-luna", "openai/gpt-5.4-nano"];
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
  it("does not accept a model-supplied verifier or relax explicit inheritance", async () => {
    const value = await fixture();
    expect((await value.tool.execute({ ...args, verification: { passed: true } })).isError).toBe(true);
    const prepare = vi.fn();
    Object.assign(value.session.services, { childRoutingVerifier: { prepare } });
    await value.tool.execute({ ...args, routing: "inherit" });
    expect(prepare).not.toHaveBeenCalled();
  });
});
