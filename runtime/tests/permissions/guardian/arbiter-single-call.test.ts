import { afterEach, describe, expect, test, vi } from "vitest";

import { LiveApprovalBroker } from "../../../src/app-server/live-approval-broker.js";
import { ApprovalStore } from "../../../src/permissions/approval-cache.js";
import { requestApproval, type ApprovalCtx } from "../../../src/permissions/guardian/arbiter.js";
import { formatPendingToolApprovals } from "../../../src/permissions/pending-approval-display.js";
import { APPROVED, APPROVED_FOR_SESSION } from "../../../src/permissions/review-decision.js";
import { EventLog, type Event } from "../../../src/session/event-log.js";
import type { Session } from "../../../src/session/session.js";
import type { ToolInvocation } from "../../../src/tools/context.js";

/**
 * A call the permission layer asked about because of a safety check (a
 * protected path or an ambiguous path shape) is answered by a person each
 * time: no session grant answers or records it. The journaled request and
 * every pending listing say so, so a client's "approve for session" choice
 * can read as what it does.
 */

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function journaledSession(conversationId: string): { readonly session: Session; readonly events: Event[] } {
  const events: Event[] = [];
  const eventLog = new EventLog();
  const closeListeners = new Set<() => void | Promise<void>>();
  const session = {
    conversationId,
    eventLog,
    abortController: new AbortController(),
    services: { admissionRequired: false, toolApprovals: new ApprovalStore() },
    rolloutStore: {
      readAll: () => events.map((event) => ({ type: "event_msg" as const, payload: event })),
    },
    emit: (event: Event): Event => {
      const stamped = { ...event, eventId: `${conversationId}:${events.length + 1}`, seq: events.length + 1 };
      events.push(stamped);
      eventLog.emit(stamped);
      return stamped;
    },
    onBeforeDurableClose: (listener: () => void | Promise<void>) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  } as unknown as Session;
  cleanups.push(async () => {
    session.abortController.abort();
    for (const listener of closeListeners) await listener();
  });
  return { session, events };
}

function editCtx(session: Session, safetyCheck: boolean): ApprovalCtx {
  const args = { file_path: "/repo/.git/config", old_string: "a", new_string: "b" };
  return {
    callId: "call-edit", toolName: "Edit", turnId: "turn-1",
    invocation: {
      callId: "call-edit", session, source: "direct",
      toolName: { name: "Edit" },
      payload: { kind: "function", arguments: JSON.stringify(args) },
      turn: {
        subId: "turn-1", cwd: "/repo",
        approvalPolicy: { value: "on_request" },
        sandboxPolicy: { value: "workspace_write" },
        config: {},
      },
      tracker: { appendFileDiff() {}, snapshot: () => [], clear() {} },
    } as unknown as ToolInvocation,
    ...(safetyCheck ? { safetyCheck } : {}),
  };
}

const editArgs = { file_path: "/repo/.git/config", old_string: "a", new_string: "b" };

describe("a safety-check approval", () => {
  test("is journaled as a request no session grant covers", async () => {
    const { session, events } = journaledSession("run-single-call");
    const resolver = { request: vi.fn(async () => APPROVED) };
    await requestApproval({ ctx: editCtx(session, true), args: editArgs, resolver });
    await requestApproval({ ctx: editCtx(session, false), args: editArgs, resolver });
    expect(events.filter((event) => event.msg.type === "request_permissions")
      .map((event) => (event.msg.payload as { permissions: unknown }).permissions)).toEqual([
      ["tool.use", "single_call"],
      ["tool.use"],
    ]);
  });

  test("is listed as a request a session grant approves once", async () => {
    const { session } = journaledSession("owner-single-call");
    const broker = new LiveApprovalBroker();
    cleanups.push(broker.register(session, { isActive: () => true }));
    const decision = requestApproval({
      ctx: editCtx(session, true), args: editArgs, resolver: session.services.approvalResolver,
    });
    await vi.waitFor(() => expect(broker.list(session.conversationId)).toHaveLength(1));
    const [pending] = broker.list(session.conversationId);
    expect(pending?.permissions).toEqual(["tool.use", "single_call"]);
    expect(formatPendingToolApprovals([pending!])).toContain("session grant covers this call only, safety check");
    expect(broker.resolve(session.conversationId, pending!.requestId, APPROVED_FOR_SESSION)).toBe(true);
    expect((await decision).decision).toEqual(APPROVED_FOR_SESSION);
  });
});
