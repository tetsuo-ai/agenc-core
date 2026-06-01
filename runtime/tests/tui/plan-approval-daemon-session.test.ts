import { afterEach, describe, expect, it } from "vitest";

import {
  createDaemonTuiSession,
  type AgenCDaemonConnectionState,
  type AgenCDaemonTuiClient,
  type AgenCTuiBridgeSession,
} from "../../src/tui/daemon-session.js";
import type {
  AgenCDaemonInternalMethod,
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
  SessionPartialCompactFromMessageResult,
  SessionRewindConversationToMessageResult,
} from "../../src/app-server/protocol/index.js";
import type { ApprovalCtx } from "../../src/tools/orchestrator.js";
import type { ReviewDecision } from "../../src/permissions/review-decision.js";
import { APPROVED } from "../../src/permissions/review-decision.js";
import {
  clearPlanApprovalChoicesForTest,
  setPlanApprovalChoice,
} from "../../src/tui/plan-approval-choice.js";
import { notificationFromDaemonEvent } from "../../src/app-server/background-agent-runner.js";

function createBaseSession(): AgenCTuiBridgeSession {
  return {
    conversationId: "local_session",
    services: {
      permissionModeRegistry: {
        current: () =>
          ({
            mode: "default",
            plan: null,
            network: null,
          }) as never,
      },
    },
  } as AgenCTuiBridgeSession;
}

interface FakeClient extends AgenCDaemonTuiClient {
  readonly requests: Array<{
    readonly method: AgenCDaemonMethod | AgenCDaemonInternalMethod;
    readonly params?: JsonObject;
  }>;
  connectionState: AgenCDaemonConnectionState | null;
  emit(sessionId: string, event: JsonObject): void;
}

function createClient(): FakeClient {
  const listeners = new Map<string, Set<(event: JsonObject) => void>>();
  const requests: FakeClient["requests"] = [];
  return {
    requests,
    connectionState: null,
    async request(
      method: AgenCDaemonMethod | AgenCDaemonInternalMethod,
      params?: JsonObject,
    ): Promise<
      | AgenCDaemonResultByMethod[AgenCDaemonMethod]
      | SessionPartialCompactFromMessageResult
      | SessionRewindConversationToMessageResult
    > {
      requests.push({ method, ...(params !== undefined ? { params } : {}) });
      return {} as AgenCDaemonResultByMethod[AgenCDaemonMethod];
    },
    subscribeToSessionEvents: (sessionId, cb) => {
      let sessionListeners = listeners.get(sessionId);
      if (sessionListeners === undefined) {
        sessionListeners = new Set();
        listeners.set(sessionId, sessionListeners);
      }
      sessionListeners.add(cb);
      return () => {
        sessionListeners?.delete(cb);
      };
    },
    getConnectionState() {
      return this.connectionState;
    },
    emit: (sessionId, event) => {
      for (const listener of listeners.get(sessionId) ?? []) {
        listener(event);
      }
    },
  };
}

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("daemon-session plan-approval bridge (contract #5)", () => {
  afterEach(() => clearPlanApprovalChoicesForTest());

  it("threads planContent/planFilePath into the approval ctx", async () => {
    const client = createClient();
    const seenCtx: ApprovalCtx[] = [];
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          approvalResolver: {
            request: async (ctx: ApprovalCtx): Promise<ReviewDecision> => {
              seenCtx.push(ctx);
              return APPROVED;
            },
          },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const unsubscribe = session.subscribeToEvents(() => {});

    client.emit("session_1", {
      type: "daemon.event",
      msg: {
        type: "request_permissions",
        payload: {
          callId: "call_plan",
          toolName: "ExitPlanMode",
          planContent: "# Plan\n\nship it",
          planFilePath: "/plans/quiet-harbor.md",
        },
      },
    });
    await flush();
    unsubscribe();

    expect(seenCtx).toHaveLength(1);
    expect(seenCtx[0]?.planContent).toBe("# Plan\n\nship it");
    expect(seenCtx[0]?.planFilePath).toBe("/plans/quiet-harbor.md");
  });

  it("threads planContent/planFilePath through the REAL daemon wire serializer", async () => {
    // Regression for the daemon->TUI serializer drop: the daemon emits the flat
    // JSON-RPC `event.permission_request` shape produced by
    // notificationFromDaemonEvent, NOT the {type:'daemon.event', msg:{...}}
    // envelope. Drive the real serializer end to end so a revert of the
    // serializer forwarding makes ctx.planContent come back undefined.
    const client = createClient();
    const seenCtx: ApprovalCtx[] = [];
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          approvalResolver: {
            request: async (ctx: ApprovalCtx): Promise<ReviewDecision> => {
              seenCtx.push(ctx);
              return APPROVED;
            },
          },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const unsubscribe = session.subscribeToEvents(() => {});

    const wireEvent = notificationFromDaemonEvent("session_1", "agent_1", {
      id: "evt_plan",
      type: "request_permissions",
      payload: {
        callId: "call_plan",
        toolName: "ExitPlanMode",
        turnId: "turn_1",
        permissions: ["tool.use"],
        input: {},
        planContent: "# Plan\n\nship it",
        planFilePath: "/plans/quiet-harbor.md",
      },
    });
    client.emit("session_1", wireEvent as unknown as JsonObject);
    await flush();
    unsubscribe();

    expect(seenCtx).toHaveLength(1);
    expect(seenCtx[0]?.planContent).toBe("# Plan\n\nship it");
    expect(seenCtx[0]?.planFilePath).toBe("/plans/quiet-harbor.md");
  });

  it("includes exitPlan in tool.approve when a choice is preset for the callId", async () => {
    const client = createClient();
    // Container would have stashed the user's choice keyed by request id (=callId).
    setPlanApprovalChoice("call_plan", {
      action: "approve",
      mode: "acceptEdits",
      applyAllowedPrompts: true,
    });
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          approvalResolver: { request: async () => APPROVED },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const unsubscribe = session.subscribeToEvents(() => {});

    client.emit("session_1", {
      type: "daemon.event",
      msg: {
        type: "request_permissions",
        payload: { callId: "call_plan", toolName: "ExitPlanMode" },
      },
    });
    await flush();
    unsubscribe();

    expect(client.requests).toEqual([
      {
        method: "tool.approve",
        params: {
          sessionId: "session_1",
          requestId: "call_plan",
          scope: "once",
          exitPlan: {
            action: "approve",
            mode: "acceptEdits",
            applyAllowedPrompts: true,
          },
        },
      },
    ]);
  });

  it("fails safe: an ExitPlanMode allow with no recorded choice defaults to a revise record (stay in plan)", async () => {
    // Only interactive approvals reach this bridge; daemon-side policy
    // auto-approvals never do. So a missing choice on an ExitPlanMode allow
    // must default to revise — keeping the session in plan mode rather than
    // silently exiting it (fail-safe, not fail-open).
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          approvalResolver: { request: async () => APPROVED },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const unsubscribe = session.subscribeToEvents(() => {});

    client.emit("session_1", {
      type: "daemon.event",
      msg: {
        type: "request_permissions",
        payload: { callId: "call_plan_nochoice", toolName: "ExitPlanMode" },
      },
    });
    await flush();
    unsubscribe();

    expect(client.requests).toEqual([
      {
        method: "tool.approve",
        params: {
          sessionId: "session_1",
          requestId: "call_plan_nochoice",
          scope: "once",
          exitPlan: { action: "revise" },
        },
      },
    ]);
  });

  it("omits exitPlan when no choice is set for the callId", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          approvalResolver: { request: async () => APPROVED },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const unsubscribe = session.subscribeToEvents(() => {});

    client.emit("session_1", {
      type: "daemon.event",
      msg: {
        type: "request_permissions",
        payload: { callId: "call_plain", toolName: "Bash" },
      },
    });
    await flush();
    unsubscribe();

    expect(client.requests).toEqual([
      {
        method: "tool.approve",
        params: { sessionId: "session_1", requestId: "call_plain", scope: "once" },
      },
    ]);
  });
});
