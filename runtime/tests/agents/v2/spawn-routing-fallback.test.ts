import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/agents/delegate.js", () => ({ delegate: vi.fn() }));
vi.mock("../../../src/agents/child-routing-supervisor.js", () => ({ observeChildRoutingAttempt: vi.fn() }));

import type { Session } from "../../../src/session/session.js";
import { args, fixture, mockDelegate, mockObserve } from "./spawn-routing.fixture.js";
import { requestParentFollowupTurn } from "../../../src/agents/run-agent.js";

beforeEach(() => { mockDelegate.mockReset(); mockObserve.mockReset(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("automatic fallback through spawn_agent", () => {
  it.each(["rate_limited", "provider_unavailable", "timeout"] as const)(
    "creates exactly one fresh allowed-provider retry after %s", async reason => {
      const value = await fixture();
      const result = await value.tool.execute(args);
      expect(result.isError).not.toBe(true);
      expect(mockDelegate).toHaveBeenCalledOnce();
      const firstProvider = mockDelegate.mock.calls[0]![0].plan?.destination.provider;
      expect(["deepseek", "openai"]).toContain(firstProvider);
      value.finishFirst(reason);
      await vi.waitFor(() => expect(mockDelegate).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(value.send.mock.calls.some(([message]) => message.content.includes("Finished after 2 attempt(s)"))).toBe(true));
      const [initial, retry] = mockDelegate.mock.calls.map(([request]) => request);
      expect(retry?.plan?.destination.provider).not.toBe(firstProvider);
      expect(["deepseek", "openai"]).toContain(retry?.plan?.destination.provider);
      expect(retry?.plan).toMatchObject({ budgetAllocation: { maxModelCalls: 4, maxCostUsd: 0.48 } });
      expect(retry?.agentName).not.toBe(initial?.agentName);
      expect(retry?.plan?.task.id).not.toBe(initial?.plan?.task.id);
      const began = value.events.filter(event => event.msg?.type === "collab_agent_spawn_begin").map(event => event.msg?.payload?.callId);
      expect(new Set(began).size).toBe(2);
      expect(value.requestConsent).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["new-human-turn", undefined])("does not retry after the parent turn changes to %s", async nextTurn => {
    const value = await fixture();
    await value.tool.execute(args);
    value.changeTurn(nextTurn);
    value.finishFirst("timeout");
    await vi.waitFor(() => expect(value.send.mock.calls.some(([message]) => message.content.includes("Stopped automatic fallback"))).toBe(true));
    expect(mockDelegate).toHaveBeenCalledOnce();
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
    await vi.waitFor(() => expect(value.requestConsent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(value.send.mock.calls.some(([message]) => message.content.includes("Stopped automatic fallback"))).toBe(true));
    expect(mockDelegate).toHaveBeenCalledOnce();
  });

  it("does not retry work after any child tool ran", async () => {
    const value = await fixture();
    await value.tool.execute(args);
    value.finishFirst("timeout", { toolCalls: 1 });
    await vi.waitFor(() => expect(value.send.mock.calls.some(([message]) => message.content.includes("tools_already_run"))).toBe(true));
    expect(mockDelegate).toHaveBeenCalledOnce();
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
      content: expect.stringContaining("Finished after 2 attempt(s)") });
  });

  it("holds the routing notice without scheduling when the user stopped the parent", async () => {
    const value = await fixture();
    vi.useFakeTimers();
    await value.tool.execute(args);
    Object.assign(value.session, { stoppedByUserSinceLastPrompt: true, userStopGeneration: 1 });
    value.changeTurn(undefined);
    value.finishFirst("timeout");
    await vi.advanceTimersByTimeAsync(500);
    expect(mockDelegate).toHaveBeenCalledOnce();
    expect(value.send.mock.calls.at(-1)?.[0]).toMatchObject({ triggerTurn: true,
      content: expect.stringContaining("Stopped automatic fallback") });
    expect(value.submitChildFollowup).not.toHaveBeenCalled();
    expect(value.queuedMessages).toHaveLength(1);
  });

  it("does not schedule a followup when the routing notice was refused by the mailbox", async () => {
    const value = await fixture();
    vi.useFakeTimers();
    await value.tool.execute(args);
    value.send.mockReturnValue(-1);
    value.finishFirst("timeout", { toolCalls: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(value.send).toHaveBeenCalled();
    expect(value.submitChildFollowup).not.toHaveBeenCalled();
  });
});
