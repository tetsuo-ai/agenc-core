import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkSession } from "../fixtures.js";
import { LiveApprovalBroker } from "../../src/app-server/live-approval-broker.js";
import { registerChildApprovalSession, revokeChildApprovalSession } from "../../src/agents/child-approval-context.js";
import { requestApproval } from "../../src/permissions/guardian/arbiter.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { parseRolloutLine, serializeRolloutItem, sessionStateUpdateAddressesSlot, type RolloutItem } from "../../src/session/rollout-item.js";
import type { Session } from "../../src/session/session.js";
import { isCanonicalRolloutPayload } from "../../src/state/recovery-journal-schema.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "agenc-stop-durability-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const session = mkSession({ cwd: directory }).session;
  cleanups.push(() => session.shutdown());
  const store = new RolloutStore({
    cwd: directory, sessionId: session.conversationId, agencHome: join(directory, "home"),
    sessionTempRoot: join(directory, "scratch"), agencVersion: "0.17.0", autoStartScheduler: false,
  });
  store.open({ sessionId: session.conversationId, timestamp: new Date().toISOString(), cwd: directory, originator: "user-stop-test", agencVersion: "0.17.0", model: "test-model", modelProvider: "test" });
  session.mountRolloutStore(store);
  cleanups.push(() => { session.mountRolloutStore(null); store.close(); });
  const read = (): RolloutItem[] => readFileSync(store.rolloutPath, "utf8").trim().split("\n").map(line => parseRolloutLine(line)!).filter(Boolean);
  const restored = (): Session => {
    const next = mkSession({ cwd: directory }).session;
    cleanups.push(() => next.shutdown());
    next.restoreUserStopFromRollout(read());
    return next;
  };
  return { session, store, read, restored };
}

describe("durable user-stop authority", () => {
  it("commits a child denial to the owner journal before resolving the request", async () => {
    const state = fixture();
    const child = mkSession({ cwd: state.session.sessionConfiguration.cwd }).session;
    Object.defineProperty(child, "conversationId", { value: "child-stop-fixture" });
    cleanups.push(() => child.shutdown());
    const childStore = new RolloutStore({ cwd: state.session.sessionConfiguration.cwd, sessionId: child.conversationId, agencHome: state.store.store.agencHome, sessionTempRoot: join(state.session.sessionConfiguration.cwd, "child-scratch"), agencVersion: "0.17.0", autoStartScheduler: false });
    childStore.open({ sessionId: child.conversationId, timestamp: new Date().toISOString(), cwd: child.sessionConfiguration.cwd, originator: "child-stop-test", agencVersion: "0.17.0", model: "test-model", modelProvider: "test" });
    child.mountRolloutStore(childStore);
    cleanups.push(() => { child.mountRolloutStore(null); childStore.close(); });
    const broker = new LiveApprovalBroker();
    cleanups.push(broker.register(state.session, { isActive: () => true }));
    registerChildApprovalSession(child, state.session);
    cleanups.push(() => revokeChildApprovalSession(child));
    const pending = requestApproval({ ctx: { callId: "child-call", toolName: "exec_command", turnId: "child-turn", invocation: { callId: "child-call", session: child, payload: { kind: "function", name: "exec_command", arguments: '{"cmd":"git commit"}' }, turn: { subId: "child-turn" } } as never }, resolver: state.session.services.approvalResolver, args: { cmd: "git commit" }, getActiveTurnId: () => "child-turn" });
    await vi.waitFor(() => expect(broker.list(state.session.conversationId)).toHaveLength(1));
    expect(broker.resolve(state.session.conversationId, broker.list(state.session.conversationId)[0]!.requestId, { kind: "denied" })).toBe(true);
    expect(state.read()).toContainEqual(expect.objectContaining({ type: "session_state", payload: { userStop: { stopped: true, generation: 1 } } }));
    expect((await pending).decision.kind).toBe("denied");
    const resumed = state.restored();
    resumed.installTurnDriverHooks({ submit: vi.fn(async () => {}) });
    expect(resumed.stoppedByUserSinceLastPrompt).toBe(true);
    expect(await resumed.submitChildFollowup()).toBe(false);
  });

  it("records an accepted local human release without relying on daemon message IDs", () => {
    const state = fixture();
    state.session.markStoppedByUser();
    state.session.clearUserStop();
    expect(state.restored().stoppedByUserSinceLastPrompt).toBe(false);
    expect(state.read()).toContainEqual(expect.objectContaining({ type: "session_state", payload: { userStop: { stopped: false, generation: 1 } } }));
  });

  it("restores stop generations without appending state during replay", () => {
    const state = fixture();
    state.session.markStoppedByUser();
    state.session.clearUserStop();
    state.session.markStoppedByUser();
    const append = vi.spyOn(state.store, "appendRollout");
    const items = state.read();
    state.session.restoreUserStopFromRollout(items);
    expect(state.session.userStopGeneration).toBe(2);
    expect(append).not.toHaveBeenCalled();
    expect(state.restored().userStopGeneration).toBe(2);
  });

  it.each(["user_message", "message_submission"] as const)("does not release an explicit stop for a merely journaled %s", (eventType) => {
    const state = fixture();
    state.session.markStoppedByUser();
    const admission = {
      type: "event_msg", payload: { id: "unadmitted", msg: { type: eventType, payload: {
        message: "continue", contentFingerprint: "test-fingerprint", messageId: "unadmitted",
        streamId: "stream_1", acceptedAt: "2026-09-10T00:00:00.000Z",
      } } },
    } as unknown as RolloutItem;
    const restored = state.restored();
    restored.restoreUserStopFromRollout([...state.read(), admission]);
    expect(restored.stoppedByUserSinceLastPrompt).toBe(true);
    expect(restored.userStopGeneration).toBe(1);
    state.session.clearUserStop();
    restored.restoreUserStopFromRollout([...state.read(), admission]);
    expect(restored.stoppedByUserSinceLastPrompt).toBe(false);
  });

  it("retains implicit human release for legacy journals without explicit stop state", () => {
    const state = fixture();
    const items = [
      { type: "event_msg", payload: { id: "stop", msg: { type: "turn_aborted", payload: { reason: "interrupted" } } } },
      { type: "event_msg", payload: { id: "human", msg: { type: "user_message", payload: {
        message: "continue", messageId: "human", streamId: "stream_1", acceptedAt: "2026-09-10T00:00:00.000Z",
      } } } },
    ] as unknown as RolloutItem[];
    state.session.restoreUserStopFromRollout(items);
    expect(state.session.stoppedByUserSinceLastPrompt).toBe(false);
    expect(state.session.userStopGeneration).toBe(1);
  });

  it.each(["stop", "clear"])("keeps a stop effective when its %s durability boundary fails", (operation) => {
    const state = fixture();
    if (operation === "clear") state.session.markStoppedByUser();
    vi.spyOn(state.store, "appendRollout").mockImplementation(() => { throw new Error("fsync failed"); });
    expect(() => operation === "stop" ? state.session.markStoppedByUser() : state.session.clearUserStop()).toThrow("fsync failed");
    expect(state.session.stoppedByUserSinceLastPrompt).toBe(true);
  });

  it.each([null, {}, { stopped: "false", generation: 1 }, { stopped: false, generation: -1 }, { stopped: false, generation: 1.5 }, { stopped: false, generation: Number.MAX_SAFE_INTEGER + 1 }])("fails closed on a malformed persisted stop slot: %j", (userStop) => {
    const session = mkSession().session;
    cleanups.push(() => session.shutdown());
    const item = { type: "session_state", payload: { userStop } } as unknown as RolloutItem;
    expect(isCanonicalRolloutPayload("session_state", item.payload)).toBe(false);
    expect(() => session.restoreUserStopFromRollout([item])).toThrow(/user.stop/i);
    expect(session.stoppedByUserSinceLastPrompt).toBe(true);
  });

  it("round-trips stop state without clearing unrelated session slots", () => {
    const item = { type: "session_state", payload: { userStop: { stopped: true, generation: 2 } } } as unknown as RolloutItem;
    const parsed = parseRolloutLine(serializeRolloutItem(item))!;
    expect(parsed).toMatchObject(item);
    expect(isCanonicalRolloutPayload("session_state", parsed.payload)).toBe(true);
    if (parsed.type !== "session_state") throw new Error("Wrong rollout item type");
    expect(sessionStateUpdateAddressesSlot(parsed.payload, "agentTask")).toBe(false);
    expect(sessionStateUpdateAddressesSlot(parsed.payload, "memoryExtraction")).toBe(false);
  });
});
