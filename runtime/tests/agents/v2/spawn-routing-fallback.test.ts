import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/agents/delegate.js", () => ({ delegate: vi.fn() }));
vi.mock("../../../src/agents/child-routing-supervisor.js", () => ({ observeChildRoutingAttempt: vi.fn() }));

import type { Session } from "../../../src/session/session.js";
import { args, fixture, mockDelegate, mockObserve } from "./spawn-routing.fixture.js";
import { requestParentFollowupTurn } from "../../../src/agents/run-agent.js";
import { childRoutingSupervisorCanFallback } from "../../../src/agents/child-routing-retries.js";
import { routeChildTask } from "../../../src/agents/child-routing.js";

beforeEach(() => { mockDelegate.mockReset(); mockObserve.mockReset(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const routingNotices = (send: ReturnType<typeof vi.fn>) => send.mock.calls
  .map(([message]) => (message as { content: string }).content).filter(content => content.startsWith("Automatic routing"));

describe("automatic fallback through spawn_agent", () => {
  it.each(["rate_limited", "provider_unavailable", "timeout"] as const)(
    "creates exactly one fresh allowed-provider retry after %s", async reason => {
      const value = await fixture();
      const result = await value.tool.execute(args);
      expect(result.isError).not.toBe(true);
      expect(mockDelegate).toHaveBeenCalledOnce();
      // Parent first: the child starts on the parent's own model.
      const firstProvider = mockDelegate.mock.calls[0]![0].plan?.destination.provider;
      expect(firstProvider).toBe("grok");
      value.finishFirst(reason);
      await vi.waitFor(() => expect(mockDelegate).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(value.send.mock.calls.some(([message]) => message.content.includes("Finished after 2 attempts"))).toBe(true));
      const [initial, retry] = mockDelegate.mock.calls.map(([request]) => request);
      expect(retry?.plan?.destination.provider).not.toBe(firstProvider);
      expect(["deepseek", "openai"]).toContain(retry?.plan?.destination.provider);
      expect(retry?.plan).toMatchObject({ budgetAllocation: { maxModelCalls: 4, maxCostUsd: 0.48 } });
      expect(retry?.agentName).not.toBe(initial?.agentName);
      expect(retry?.plan?.task.id).not.toBe(initial?.plan?.task.id);
      const began = value.events.filter(event => event.msg?.type === "collab_agent_spawn_begin").map(event => event.msg?.payload?.callId);
      expect(new Set(began).size).toBe(2);
      // Only the retry leaves the parent's provider, so only it asks.
      expect(value.requestConsent).toHaveBeenCalledOnce();
    },
  );

  it.each(["new-human-turn", undefined])("does not retry after the parent turn changes to %s", async nextTurn => {
    const value = await fixture();
    await value.tool.execute(args);
    value.changeTurn(nextTurn);
    value.finishFirst("timeout");
    await settle();
    expect(mockDelegate).toHaveBeenCalledOnce();
    // No retry was announced, so the child's own receipt is the whole story.
    expect(routingNotices(value.send)).toEqual([]);
  });

  it("does not enable fallback for a user's explicit provider/model override", async () => {
    const value = await fixture();
    const result = await value.tool.execute({ ...args, provider: "deepseek", model: "deepseek-v4-pro" });
    expect(result.isError).not.toBe(true);
    expect(mockDelegate).toHaveBeenCalledOnce();
    expect(mockObserve).not.toHaveBeenCalled();
    expect(JSON.parse(result.content).automatic_fallback).toBeUndefined();
  });

  it("does not enable fallback for routing=inherit", async () => {
    const value = await fixture();
    const result = await value.tool.execute({ ...args, routing: "inherit" });
    expect(result.isError).not.toBe(true);
    expect(mockDelegate).toHaveBeenCalledOnce();
    expect(mockObserve).not.toHaveBeenCalled();
  });

  it("does not bypass fresh funds-stop consent", async () => {
    const value = await fixture();
    await value.tool.execute(args);
    value.denyConsent();
    value.finishFirst("insufficient_funds");
    await vi.waitFor(() => expect(value.requestConsent).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(value.send.mock.calls.some(([message]) => message.content.includes("Stopped automatic fallback"))).toBe(true));
    expect(mockDelegate).toHaveBeenCalledOnce();
  });

  it("does not retry work after any child tool ran", async () => {
    const value = await fixture();
    await value.tool.execute(args);
    value.finishFirst("timeout", { toolCalls: 1 });
    await settle();
    expect(mockDelegate).toHaveBeenCalledOnce();
    expect(routingNotices(value.send)).toEqual([]);
  });

  it.each(["completed", "terminal_failure"] as const)("sends no extra wake-up for a single %s attempt", async outcome => {
    const value = await fixture();
    await value.tool.execute(args);
    value.finishFirst(outcome === "completed" ? "completed" : "auth_required");
    await settle();
    expect(mockDelegate).toHaveBeenCalledOnce();
    expect(routingNotices(value.send)).toEqual([]);
    expect(value.submitChildFollowup).not.toHaveBeenCalled();
  });

  it("hands provider retries to the supervisor only while it can still act", async () => {
    const value = await fixture();
    await value.tool.execute(args);
    const child = value.threads[0]!.live as { toolCallCount: number };
    expect(childRoutingSupervisorCanFallback(value.threads[0]!.live)).toBe(true);
    child.toolCallCount = 1;
    expect(childRoutingSupervisorCanFallback(value.threads[0]!.live)).toBe(false);
    child.toolCallCount = 0;
    value.changeTurn("new-human-turn");
    expect(childRoutingSupervisorCanFallback(value.threads[0]!.live)).toBe(false);
    value.changeTurn("human-turn-a");
    expect(childRoutingSupervisorCanFallback(value.threads[0]!.live)).toBe(true);
    // The runner retries on the next ranked candidate. Once its provider is no
    // longer allowed no retry can start, so the child keeps its own retries.
    const first = mockDelegate.mock.calls[0]![0].plan!.destination.provider;
    const { result: ranking } = await routeChildTask(value.session, { prompt: args.message, maxCostUsd: args.max_cost_usd });
    const next = ranking.ranked.find(candidate => candidate.provider !== first)!;
    const allowed = [...value.config.agents.allowed_providers];
    value.config.agents.allowed_providers = allowed.filter(provider => provider !== next.provider);
    expect(childRoutingSupervisorCanFallback(value.threads[0]!.live)).toBe(next.provider === "grok");
    value.config.agents.allowed_providers = allowed;
    expect(childRoutingSupervisorCanFallback(value.threads[0]!.live)).toBe(true);
    value.finishFirst("completed");
    await vi.waitFor(() => expect(childRoutingSupervisorCanFallback(value.threads[0]!.live)).toBe(false));
  });

  it("leaves provider retries with a routed child that has no other candidate", async () => {
    const value = await fixture();
    value.config.agents.allowed_providers = [];
    const result = await value.tool.execute(args);
    expect(result.isError).not.toBe(true);
    expect(mockDelegate.mock.calls[0]![0].plan?.destination).toMatchObject({ provider: "grok", model: "grok-4.6" });
    expect(childRoutingSupervisorCanFallback(value.threads[0]!.live)).toBe(false);
  });

  it("rechecks current allowed providers before creating a retry", async () => {
    const value = await fixture();
    await value.tool.execute(args);
    value.config.agents.allowed_providers = [mockDelegate.mock.calls[0]![0].plan!.destination.provider];
    value.finishFirst("timeout");
    await vi.waitFor(() => expect(value.send.mock.calls.some(([message]) => message.content.includes("Stopped automatic fallback"))).toBe(true));
    expect(mockDelegate).toHaveBeenCalledOnce();
  });

  it("schedules a delayed final routing notice after earlier receipt and retry notices were drained", async () => {
    const value = await fixture({ deferRetry: true });
    vi.useFakeTimers();
    await value.tool.execute(args);
    value.send({ content: "Initial child failure receipt", triggerTurn: true });
    requestParentFollowupTurn({ parent: value.session, live: value.threads[0]!.live });
    await vi.advanceTimersByTimeAsync(200);
    expect(value.submitChildFollowup).toHaveBeenCalledOnce();
    expect(value.queuedMessages).toEqual([]);

    value.finishFirst("timeout");
    await vi.advanceTimersByTimeAsync(200);
    expect(mockDelegate).toHaveBeenCalledTimes(2);
    expect(value.submitChildFollowup).toHaveBeenCalledTimes(2);
    expect(value.queuedMessages).toEqual([]);
    value.finishRetry();
    await vi.advanceTimersByTimeAsync(200);
    expect(value.submitChildFollowup).toHaveBeenCalledTimes(3);
    expect(value.send.mock.calls.at(-1)?.[0]).toMatchObject({ triggerTurn: true,
      content: expect.stringContaining("Finished after 2 attempts") });
  });

  it("holds the routing notice without scheduling when the user stopped the parent", async () => {
    const value = await fixture({ deferRetry: true });
    vi.useFakeTimers();
    await value.tool.execute(args);
    value.finishFirst("timeout");
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDelegate).toHaveBeenCalledTimes(2);
    Object.assign(value.session, { stoppedByUserSinceLastPrompt: true, userStopGeneration: 1 });
    value.finishRetry();
    await vi.advanceTimersByTimeAsync(500);
    expect(value.send.mock.calls.at(-1)?.[0]).toMatchObject({ triggerTurn: true,
      content: expect.stringContaining("Finished after 2 attempts") });
    expect(value.submitChildFollowup).not.toHaveBeenCalled();
    expect(value.queuedMessages).toHaveLength(2);
  });

  it("says why an announced retry did not start", async () => {
    const value = await fixture();
    await value.tool.execute(args);
    value.denyConsent();
    value.finishFirst("rate_limited");
    await vi.waitFor(() => expect(routingNotices(value.send).some(content => content.includes("Stopped automatic fallback"))).toBe(true));
    const stopped = routingNotices(value.send).find(content => content.includes("Stopped automatic fallback"))!;
    expect(stopped).toContain("could not start with the current consent, settings and budget");
    expect(stopped).not.toContain("lacked current authority");
  });

  it("does not schedule a followup when the routing notice was refused by the mailbox", async () => {
    const value = await fixture({ deferRetry: true });
    vi.useFakeTimers();
    await value.tool.execute(args);
    value.send.mockReturnValue(-1);
    value.finishFirst("timeout");
    await vi.advanceTimersByTimeAsync(500);
    expect(routingNotices(value.send)).toHaveLength(1);
    expect(value.submitChildFollowup).not.toHaveBeenCalled();
  });

  it("does not promise routing updates that may never come", async () => {
    const value = await fixture();
    const result = JSON.parse((await value.tool.execute(args)).content) as { automatic_fallback: string };
    expect(result.automatic_fallback).not.toContain("Wait for routing updates");
    expect(result.automatic_fallback).toContain("Without such a message, this child's own result is final.");
  });
});
