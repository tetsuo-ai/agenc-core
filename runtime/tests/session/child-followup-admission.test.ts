import { afterEach, describe, expect, it, vi } from "vitest";
import { mkSession } from "../fixtures.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("child follow-up admission", () => {
  it("keeps the stop fence through default, edit, plan, and YOLO mode transitions", async () => {
    const { session } = mkSession();
    cleanups.push(() => session.shutdown());
    const submit = vi.fn(async () => {});
    session.installTurnDriverHooks({ submit });
    session.markStoppedByUser();
    for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions", "default"] as const) {
      await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode });
      expect(await session.submitChildFollowup()).toBe(false);
      expect(session.stoppedByUserSinceLastPrompt).toBe(true);
    }
    expect(submit).not.toHaveBeenCalled();
    session.clearUserStop();
    expect(await session.submitChildFollowup()).toBe(true);
  });

  it("rejects old-instance followups after shutdown without affecting a fresh session", async () => {
    const original = mkSession().session;
    const restored = mkSession().session;
    cleanups.push(() => restored.shutdown());
    const oldSubmit = vi.fn(async () => {});
    const newSubmit = vi.fn(async () => {});
    original.installTurnDriverHooks({ submit: oldSubmit });
    restored.installTurnDriverHooks({ submit: newSubmit });
    await original.shutdown();
    expect(await original.submitChildFollowup()).toBe(false);
    await expect(original.submit("ordinary input")).rejects.toThrow("shutting down");
    expect(oldSubmit).not.toHaveBeenCalled();
    expect(newSubmit).not.toHaveBeenCalled();
    expect(await restored.submitChildFollowup()).toBe(true);
  });

  it.each([false, true])("restores a denied owner without replaying receipts until a fresh human admission (%s)", async (freshAdmission) => {
    const { session } = mkSession();
    cleanups.push(() => session.shutdown());
    const items: RolloutItem[] = [{ type: "event_msg", payload: { id: "denial", msg: { type: "permission_decision", payload: {
      runId: session.conversationId, callId: "denied", toolName: "exec_command", turnId: "turn-denied", requestEventId: "request-denied", requestEventSeq: 1,
      decision: "denied", source: "resolver", recordedAt: "2026-09-10T00:00:00.000Z",
    } } } }];
    items.push({ type: "response_item", payload: { role: "user", content: "child receipt represented as context" } });
    items.push({ type: "event_msg", payload: { id: "hidden-shell", msg: { type: "message_submission", payload: {
      messageId: "shell", streamId: "session.shell.execute", acceptedAt: "2026-09-10T00:00:01.000Z", contentFingerprint: "shell-context",
    } } } });
    if (freshAdmission) items.push({ type: "event_msg", payload: { id: "new-human", msg: { type: "user_message", payload: {
      message: "New instructions", messageId: "new-human", acceptedAt: "2026-09-10T00:00:02.000Z", streamId: "human-client-stream",
    } } } });
    session.restoreUserStopFromRollout(items);
    expect(session.stoppedByUserSinceLastPrompt).toBe(!freshAdmission);
    const submit = vi.fn(async () => {});
    session.installTurnDriverHooks({ submit });
    expect(submit).not.toHaveBeenCalled();
    expect(await session.submitChildFollowup()).toBe(freshAdmission);
    expect(submit).toHaveBeenCalledTimes(freshAdmission ? 1 : 0);
  });

  it.each([false, true])("rejects a queued receipt after a stop even if fresh input clears the latch (%s)", async (clearStop) => {
    const { session } = mkSession();
    cleanups.push(() => session.shutdown());
    const first = Promise.withResolvers<void>();
    const submit = vi.fn(async () => { await first.promise; });
    session.installTurnDriverHooks({ submit });
    const active = session.submit("first user prompt");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const receipt = session.submitChildFollowup();
    session.markStoppedByUser();
    if (clearStop) session.clearUserStop();
    first.resolve();
    await active;
    expect(await receipt).toBe(false);
    expect(submit).toHaveBeenCalledOnce();
    await session.submit("fresh user prompt");
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("does not clear a stop for cron, autonomous ticks, or anonymous submissions", async () => {
    const { session } = mkSession();
    cleanups.push(() => session.shutdown());
    const submit = vi.fn(async () => {});
    session.installTurnDriverHooks({ submit });
    session.markStoppedByUser();
    await session.submit("cron", { displayUserMessage: null });
    await session.submit("tick", { source: "autonomous_tick" });
    await session.submit("unspecified source");
    expect(session.stoppedByUserSinceLastPrompt).toBe(true);
    expect(await session.submitChildFollowup()).toBe(false);
    expect(submit).toHaveBeenCalledTimes(3);
  });

  it("suppresses queued child followups when shutdown closes ingress", async () => {
    const { session } = mkSession();
    cleanups.push(() => session.shutdown());
    const activeTurn = Promise.withResolvers<void>();
    const submit = vi.fn(async () => { await activeTurn.promise; });
    session.installTurnDriverHooks({ submit });
    const active = session.submit("active human prompt");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const receipt = session.submitChildFollowup();
    session.beginShutdown();
    activeTurn.resolve();
    await active;
    expect(await receipt).toBe(false);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("checks a stop after asynchronous turn preparation before sampling", async () => {
    const { session, events } = mkSession();
    cleanups.push(() => session.shutdown());
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    const sample = vi.spyOn(session.services.provider, "chatStream");
    session.installTurnDriverHooks({ submit: async () => {
      preparing.resolve();
      await prepared.promise;
      for await (const event of session.runTurn("child result", { displayUserMessage: null })) void event;
    } });
    const receipt = session.submitChildFollowup();
    await preparing.promise;
    session.markStoppedByUser();
    session.clearUserStop();
    prepared.resolve();
    expect(await receipt).toBe(false);
    expect(sample).not.toHaveBeenCalled();
    expect(events.some((event) => event.msg.type === "turn_started")).toBe(false);
  });

  it("does not carry child generation authority into an independent automatic submission", async () => {
    const { session } = mkSession();
    cleanups.push(() => session.shutdown());
    const timerReady = Promise.withResolvers<void>();
    const timerCompleted = Promise.withResolvers<void>();
    const sample = vi.spyOn(session.services.provider, "chatStream");
    session.installTurnDriverHooks({ submit: async (message) => {
      if (message === "") {
        void timerReady.promise.then(async () => {
          await session.submit("independent scheduled turn", { source: "autonomous_tick" });
        }).then(timerCompleted.resolve, timerCompleted.reject);
        return;
      }
      for await (const event of session.runTurn(message, { displayUserMessage: null })) void event;
    } });
    expect(await session.submitChildFollowup()).toBe(true);
    session.markStoppedByUser();
    timerReady.resolve();
    await timerCompleted.promise;
    expect(sample).toHaveBeenCalledOnce();
    expect(session.stoppedByUserSinceLastPrompt).toBe(true);
  });
});
