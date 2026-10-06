import { describe, expect, test } from "vitest";

import type { LiveAgent } from "../../src/agents/control.js";
import {
  bindLiveAgentSession,
  liveAgentSession,
} from "../../src/agents/live-session.js";
import type { Session } from "../../src/session/session.js";

interface SessionStub {
  conversationId: string;
  abortController: AbortController;
  isShuttingDown: boolean;
  onBeforeDurableClose: (listener: () => void) => () => void;
  fireClose: () => void;
}

function makeLive(id = "agent-1", agentPath = "/root/agent"): LiveAgent {
  return {
    agentId: id,
    agentPath,
    abortController: new AbortController(),
  } as LiveAgent;
}

function makeSession(id = "agent-1"): Session & SessionStub {
  let close: (() => void) | undefined;
  const stub: SessionStub = {
    conversationId: id,
    abortController: new AbortController(),
    isShuttingDown: false,
    onBeforeDurableClose(listener) {
      close = listener;
      return () => {
        if (close === listener) close = undefined;
      };
    },
    fireClose() {
      close?.();
    },
  };
  return stub as Session & SessionStub;
}

const BIND_ERROR =
  /already bound, does not match, or is shutting down/;

describe("live agent session identity", () => {
  test("binds the exact live handle and refuses a second owner or a mismatched session", () => {
    const live = makeLive();
    const session = makeSession();
    const revoke = bindLiveAgentSession(live, session);
    expect(liveAgentSession(live)).toBe(session);
    expect(() => bindLiveAgentSession(live, session)).toThrow(BIND_ERROR);
    expect(() =>
      bindLiveAgentSession(makeLive("sibling"), session),
    ).toThrow(BIND_ERROR);
    revoke();
    expect(liveAgentSession(live)).toBeUndefined();
  });

  test("refuses bind when the live handle or session is already aborting or closing", () => {
    const abortedLive = makeLive();
    abortedLive.abortController.abort();
    expect(() => bindLiveAgentSession(abortedLive, makeSession())).toThrow(BIND_ERROR);

    const abortedSession = makeSession();
    abortedSession.abortController.abort();
    expect(() => bindLiveAgentSession(makeLive(), abortedSession)).toThrow(BIND_ERROR);

    const closing = makeSession();
    closing.isShuttingDown = true;
    expect(() => bindLiveAgentSession(makeLive(), closing)).toThrow(BIND_ERROR);
  });

  test("lookup fails closed after close, abort, or identity drift", () => {
    const live = makeLive();
    const session = makeSession();
    bindLiveAgentSession(live, session);
    session.fireClose();
    expect(liveAgentSession(live)).toBeUndefined();

    const liveAbort = makeLive();
    const sessionAbort = makeSession();
    bindLiveAgentSession(liveAbort, sessionAbort);
    liveAbort.abortController.abort();
    expect(liveAgentSession(liveAbort)).toBeUndefined();

    const livePath = makeLive();
    const sessionPath = makeSession();
    bindLiveAgentSession(livePath, sessionPath);
    Object.defineProperty(livePath, "agentPath", { value: "/root/sibling" });
    expect(liveAgentSession(livePath)).toBeUndefined();

    const liveId = makeLive();
    const sessionId = makeSession();
    bindLiveAgentSession(liveId, sessionId);
    sessionId.conversationId = "replaced";
    expect(liveAgentSession(liveId)).toBeUndefined();
  });

  test("a stale revoke does not drop a replacement binding", () => {
    const live = makeLive();
    const first = makeSession();
    const revokeFirst = bindLiveAgentSession(live, first);
    revokeFirst();
    const replacement = makeSession();
    bindLiveAgentSession(live, replacement);
    revokeFirst();
    expect(liveAgentSession(live)).toBe(replacement);
  });
});
