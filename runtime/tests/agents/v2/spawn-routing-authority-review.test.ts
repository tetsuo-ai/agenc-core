import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/agents/delegate.js", () => ({ delegate: vi.fn() }));
vi.mock("../../../src/agents/child-routing-supervisor.js", () => ({ observeChildRoutingAttempt: vi.fn() }));

import type { Session } from "../../../src/session/session.js";
import { args, fixture, mockDelegate, mockObserve } from "./spawn-routing.fixture.js";

beforeEach(() => { mockDelegate.mockReset(); mockObserve.mockReset(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("initial automatic selection authority", () => {
  it("retains a hidden original signal while retry consent is pending", async () => {
    const value = await fixture();
    const cancelled = new AbortController();
    const callArgs = { ...args };
    Object.defineProperty(callArgs, "__abortSignal", { value: cancelled.signal });
    expect((await value.tool.execute(callArgs)).isError).not.toBe(true);
    const originalRequest = value.requestConsent.getMockImplementation()!;
    let consentReady!: () => void;
    const pending = new Promise<void>(resolve => { consentReady = resolve; });
    value.requestConsent.mockImplementation(async (...requestArgs) => {
      await pending;
      return originalRequest(...requestArgs);
    });
    value.finishFirst("rate_limited");
    // The first child runs on the parent's provider; the retry is the first to ask.
    await vi.waitFor(() => expect(value.requestConsent).toHaveBeenCalledOnce());
    cancelled.abort();
    consentReady();
    await vi.waitFor(() => expect(value.queuedMessages.some(message =>
      (message as { content: string }).content.includes("Stopped automatic fallback"))).toBe(true));
    expect(mockDelegate).toHaveBeenCalledOnce();
  });

  it("retains the original signal in the retry delegate's post-await authority guard", async () => {
    const value = await fixture();
    const cancelled = new AbortController();
    const callArgs = { ...args };
    Object.defineProperty(callArgs, "__abortSignal", { value: cancelled.signal });
    expect((await value.tool.execute(callArgs)).isError).not.toBe(true);
    let resumeDelegate!: () => void;
    const pending = new Promise<void>(resolve => { resumeDelegate = resolve; });
    let guardedFailure: unknown;
    mockDelegate.mockImplementationOnce(async options => {
      options.assertParentSessionActive?.();
      await pending;
      try { options.assertParentSessionActive?.(); }
      catch (error) { guardedFailure = error; }
      throw new Error("delegation boundary finished");
    });
    value.finishFirst("rate_limited");
    await vi.waitFor(() => expect(mockDelegate).toHaveBeenCalledTimes(2));
    cancelled.abort();
    resumeDelegate();
    await vi.waitFor(() => expect(value.queuedMessages.some(message =>
      (message as { content: string }).content.includes("Stopped automatic fallback"))).toBe(true));
    expect(guardedFailure).toBeInstanceOf(Error);
    expect((guardedFailure as Error).message).toContain("no longer live");
    expect(value.threads).toHaveLength(1);
  });

  it.each(["new-human-turn", undefined])("refuses selection resumed after parent turn becomes %s", async turn => {
    const value = await fixture();
    let ready!: (result: { connected: boolean; billingSource: "byok" }) => void;
    const pending = new Promise<{ connected: boolean; billingSource: "byok" }>(resolve => { ready = resolve; });
    const readiness = vi.fn(() => pending);
    Object.assign(value.session.providerService, { childProviderRoutingInfo: readiness });
    const result = value.tool.execute(args);
    await vi.waitFor(() => expect(readiness).toHaveBeenCalled());
    value.changeTurn(turn);
    ready({ connected: true, billingSource: "byok" });
    expect((await result).isError).toBe(true);
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it("refuses selection resumed after the originating tool signal is cancelled", async () => {
    const value = await fixture();
    const cancelled = new AbortController();
    let ready!: (result: { connected: boolean; billingSource: "byok" }) => void;
    const pending = new Promise<{ connected: boolean; billingSource: "byok" }>(resolve => { ready = resolve; });
    const readiness = vi.fn(() => pending);
    Object.assign(value.session.providerService, { childProviderRoutingInfo: readiness });
    const callArgs = { ...args };
    Object.defineProperty(callArgs, "__abortSignal", { value: cancelled.signal });
    const result = value.tool.execute(callArgs);
    await vi.waitFor(() => expect(readiness).toHaveBeenCalled());
    cancelled.abort();
    ready({ connected: true, billingSource: "byok" });
    expect((await result).isError).toBe(true);
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it.each(["root_replaced", "user_stopped"] as const)("refuses selection after %s", async change => {
    const value = await fixture();
    let ready!: (result: { connected: boolean; billingSource: "byok" }) => void;
    const pending = new Promise<{ connected: boolean; billingSource: "byok" }>(resolve => { ready = resolve; });
    const readiness = vi.fn(() => pending);
    Object.assign(value.session.providerService, { childProviderRoutingInfo: readiness });
    const result = value.tool.execute(args);
    await vi.waitFor(() => expect(readiness).toHaveBeenCalled());
    if (change === "root_replaced") value.replaceSession();
    else Object.assign(value.session, { userStopGeneration: 1, stoppedByUserSinceLastPrompt: true });
    ready({ connected: true, billingSource: "byok" });
    expect((await result).isError).toBe(true);
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it("rechecks the originating turn after consent resolves", async () => {
    const value = await fixture();
    const originalRequest = value.requestConsent.getMockImplementation()!;
    let consentReady!: () => void;
    const pending = new Promise<void>(resolve => { consentReady = resolve; });
    value.requestConsent.mockImplementation(async (...requestArgs) => {
      await pending;
      return originalRequest(...requestArgs);
    });
    // The parent model's 500k window cannot hold this context, so the
    // initial choice is another provider and needs consent.
    const result = value.tool.execute({ ...args, context_tokens: 600_000 });
    await vi.waitFor(() => expect(value.requestConsent).toHaveBeenCalled());
    value.changeTurn("new-human-turn");
    consentReady();
    expect((await result).isError).toBe(true);
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it("retains support for callers without an active-turn identity", async () => {
    const value = await fixture();
    value.changeTurn(undefined);
    expect((await value.tool.execute(args)).isError).not.toBe(true);
    expect(mockDelegate).toHaveBeenCalledOnce();
  });
});
