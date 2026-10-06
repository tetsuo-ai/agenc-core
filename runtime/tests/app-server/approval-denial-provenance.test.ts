import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkSession } from "../fixtures.js";
import { LiveApprovalBroker } from "../../src/app-server/live-approval-broker.js";
import { requestApproval } from "../../src/permissions/guardian/arbiter.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { parseRolloutLine, type RolloutItem } from "../../src/session/rollout-item.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Session } from "../../src/session/session.js";
import { ApprovalRejectedError, approvalDenialEndsTurn } from "../../src/tools/orchestrator.js";

/**
 * Only a person answering the permission card may end a turn as "you
 * denied". The broker also refuses requests on its own (inactive or
 * mismatched owner, duplicate occurrence) and a non-interactive client
 * auto-denies; those carry resolver provenance but are not user decisions.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(options: { readonly nonInteractive?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agenc-denial-provenance-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const session = mkSession({
    cwd: directory,
    ...(options.nonInteractive === true
      ? { services: { runtimeOptions: resolveAgentRuntimeOptions({}, { nonInteractive: true }) } }
      : {}),
  }).session;
  cleanups.push(() => session.shutdown());
  const store = new RolloutStore({
    cwd: directory, sessionId: session.conversationId, agencHome: join(directory, "home"),
    sessionTempRoot: join(directory, "scratch"), agencVersion: "0.17.0", autoStartScheduler: false,
  });
  store.open({ sessionId: session.conversationId, timestamp: new Date().toISOString(), cwd: directory, originator: "denial-provenance-test", agencVersion: "0.17.0", model: "test-model", modelProvider: "test" });
  session.mountRolloutStore(store);
  cleanups.push(() => { session.mountRolloutStore(null); store.close(); });
  let active = true;
  const broker = new LiveApprovalBroker();
  cleanups.push(broker.register(session, { isActive: () => active }));
  const read = (): RolloutItem[] => readFileSync(store.rolloutPath, "utf8").trim().split("\n").map(line => parseRolloutLine(line)!).filter(Boolean);
  const decisions = () => read().flatMap((item) =>
    item.type === "event_msg" && item.payload.msg.type === "permission_decision" ? [item.payload.msg.payload] : []);
  const restored = (): Session => {
    const next = mkSession({ cwd: directory }).session;
    cleanups.push(() => next.shutdown());
    next.restoreUserStopFromRollout(read());
    return next;
  };
  const request = (callId: string) => requestApproval({
    ctx: { callId, toolName: "Write", turnId: "turn-1", invocation: { callId, session, payload: { kind: "function", name: "Write", arguments: '{"file_path":"/w/x.txt"}' }, turn: { subId: "turn-1" } } as never },
    resolver: session.services.approvalResolver,
    args: { file_path: "/w/x.txt" },
    getActiveTurnId: () => "turn-1",
  });
  return { session, broker, decisions, restored, request, deactivate: () => { active = false; } };
}

describe("approval denial provenance", () => {
  it("marks a denial answered on the permission card as the user's decision", async () => {
    const state = fixture();
    const pending = state.request("call-user");
    await vi.waitFor(() => expect(state.broker.list(state.session.conversationId)).toHaveLength(1));
    const requestId = state.broker.list(state.session.conversationId)[0]!.requestId;
    expect(state.broker.resolve(state.session.conversationId, requestId, { kind: "denied", reason: "denied in AgenC Desktop" })).toBe(true);
    const result = await pending;
    expect(result.decision).toEqual({ kind: "denied", reason: "denied in AgenC Desktop", decidedBy: "user" });
    expect(state.session.stoppedByUserSinceLastPrompt).toBe(true);
    expect(state.decisions()).toContainEqual(expect.objectContaining({ callId: "call-user", decision: "denied", source: "resolver", decidedBy: "user" }));
    expect(approvalDenialEndsTurn(new ApprovalRejectedError("denied", result.decision, result.source))).toBe(true);
    expect(state.restored().stoppedByUserSinceLastPrompt).toBe(true);
  });

  it("does not treat the broker's own refusal as a user decision", async () => {
    const state = fixture();
    state.deactivate();
    const result = await state.request("call-guard");
    expect(result.decision).toEqual({ kind: "denied" });
    expect(result.source).toBe("resolver");
    expect(state.session.stoppedByUserSinceLastPrompt).toBe(false);
    expect(approvalDenialEndsTurn(new ApprovalRejectedError("denied", result.decision, result.source))).toBe(false);
    expect(state.decisions()).toContainEqual(expect.objectContaining({ callId: "call-guard", decision: "denied", source: "resolver", decidedBy: "runtime" }));
    // A restored session does not invent a user stop from it either.
    expect(state.restored().stoppedByUserSinceLastPrompt).toBe(false);
  });

  it("does not treat a non-interactive client's auto-denial as a user decision", async () => {
    const state = fixture({ nonInteractive: true });
    const pending = state.request("call-auto");
    await vi.waitFor(() => expect(state.broker.list(state.session.conversationId)).toHaveLength(1));
    const requestId = state.broker.list(state.session.conversationId)[0]!.requestId;
    expect(state.broker.resolve(state.session.conversationId, requestId, { kind: "denied", reason: "non-interactive one-shot: no approver" })).toBe(true);
    const result = await pending;
    expect(result.decision).toEqual({ kind: "denied", reason: "non-interactive one-shot: no approver" });
    expect(state.session.stoppedByUserSinceLastPrompt).toBe(false);
    expect(approvalDenialEndsTurn(new ApprovalRejectedError("denied", result.decision, result.source))).toBe(false);
  });
});
