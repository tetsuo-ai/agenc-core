import { expect, test, vi } from "vitest";

import { createAgentRoleWorkspace } from "../../src/agents/role.js";
import { ConversationThreadManager } from "../../src/conversation/thread-manager.js";
import type { LLMContentPart, LLMMessage } from "../../src/llm/types.js";
import {
  rememberPreparedContextImages,
  rememberSentContextImages,
  unseenImageSourcesRemovedByCompaction,
} from "../../src/session/query-image-budget.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
import type { Session, SessionState } from "../../src/session/session.js";
import { AsyncLock } from "../../src/utils/async-lock.js";

const ROLE_WORKSPACE = createAgentRoleWorkspace(process.cwd());

function screen(name: string): LLMMessage {
  return { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${name}` } }] };
}

/** The source session object a forked thread runs its turns on. */
function sourceSession(runTurn: (input: string | readonly LLMContentPart[]) => AsyncGenerator<never>) {
  const rolloutItems: RolloutItem[] = [
    { type: "response_item", payload: { role: "user", content: "first ask" } },
    { type: "response_item", payload: { role: "assistant", content: "first answer" } },
  ];
  let suspended = 0;
  return {
    conversationId: "root-thread",
    seedInternalSubId: vi.fn(),
    restoreUserStopFromRollout: vi.fn(),
    roleWorkspace: ROLE_WORKSPACE,
    state: new AsyncLock<SessionState>({
      sessionConfiguration: { cwd: ROLE_WORKSPACE.cwd } as SessionState["sessionConfiguration"],
      history: [],
    }),
    agentStatus: { value: { status: "pending_init" }, subscribe: vi.fn(() => vi.fn()) },
    submit: vi.fn(async () => {}),
    settleInterruptedTurnHandoff: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    abortTerminal: vi.fn(),
    mailbox: { send: vi.fn(() => 1) },
    services: {
      mcpManager: { refreshFromAuthority: vi.fn(async () => ({ configuredServers: [], requiredServers: [] })) },
      provider: { name: "stub" },
    },
    emit: vi.fn(),
    emitPhaseEvent: vi.fn(),
    nextInternalSubId: vi.fn(() => "sub-root-thread-1"),
    newDefaultTurn: vi.fn(() => ({ subId: "sub-root-thread-0" })),
    newDefaultTurnWithSubId: vi.fn((subId: string) => ({ subId })),
    isRolloutPersistenceSuspended: vi.fn(() => suspended > 0),
    withRolloutPersistenceSuspended: vi.fn(async (fn: () => Promise<unknown>) => {
      suspended += 1;
      try { return await fn(); } finally { suspended -= 1; }
    }),
    rolloutStore: { readAll: () => rolloutItems, rolloutPath: "/tmp/root-rollout.jsonl" },
    runTurn,
  } as unknown as Session;
}

/**
 * The source conversation's last request showed screens A and B. A fork from
 * before B then runs one turn on the same session object; its request shows
 * only A. `inFork` runs inside the fork's turn before that request.
 */
async function runFork(inFork: (session: Session) => void): Promise<Session> {
  const [a, b] = [screen("A"), screen("B")];
  let session: Session;
  const forkTurn = vi.fn(async function* (_input: string | readonly LLMContentPart[]) {
    inFork(session);
    rememberPreparedContextImages(session, [a], [a], [a]);
    rememberSentContextImages(session, [a]);
    yield* [] as never[];
  });
  session = sourceSession(forkTurn);
  rememberPreparedContextImages(session, [a, b], [a, b], [a, b]);
  rememberSentContextImages(session, [a, b]);
  const manager = new ConversationThreadManager({ now: () => 45 });
  await manager.registerConversationRootSession(session, { prewarm: false });
  const forked = await manager.forkThread(session, { kind: "truncate_before_nth_user_message", n: 1 });
  await manager.submitTurn(forked.threadId, { type: "user_input", input: "continue fork" });
  expect(forkTurn).toHaveBeenCalledTimes(1);
  return session;
}

test("a forked turn starts without the source session's image evidence", async () => {
  const [a, c] = [screen("A"), screen("C")];
  let named: string[] | undefined;
  await runFork((session) => {
    // A compaction in the fork before its first request: the source
    // conversation's requests are no evidence about the fork's history.
    rememberPreparedContextImages(session, [a, c], [a, c], [a, c]);
    named = unseenImageSourcesRemovedByCompaction(session, [a, c], []);
  });
  expect(named).toEqual([]);
});

test("the source session's image evidence survives a forked turn", async () => {
  const [a, b, c] = [screen("A"), screen("B"), screen("C")];
  const session = await runFork(() => {});
  // Back in the source conversation, the next request prepares A, B and the
  // new screen C, and a compaction runs before it is sent. B was shown by the
  // source's last request, so only C is unseen.
  rememberPreparedContextImages(session, [a, b, c], [a, b, c], [a, b, c]);
  expect(unseenImageSourcesRemovedByCompaction(session, [a, b, c], [])).toEqual(["the newly attached image"]);
});

test.each(["throws", "is interrupted"] as const)("the source session's image evidence comes back when a forked turn %s", async (ending) => {
  const [a, b, c] = [screen("A"), screen("B"), screen("C")];
  let session: Session;
  let entered!: () => void;
  const inTurn = new Promise<void>((resolve) => { entered = resolve; });
  const forkTurn = vi.fn(async function* (
    _input: string | readonly LLMContentPart[],
    options: { readonly signal: AbortSignal },
  ) {
    // The fork's request shows only A, then its turn ends without completing.
    rememberPreparedContextImages(session, [a], [a], [a]);
    rememberSentContextImages(session, [a]);
    if (ending === "throws") throw new Error("provider stream failed");
    entered();
    await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("aborted by the user");
    yield* [] as never[];
  });
  session = sourceSession(forkTurn as never);
  rememberPreparedContextImages(session, [a, b], [a, b], [a, b]);
  rememberSentContextImages(session, [a, b]);
  const manager = new ConversationThreadManager({ now: () => 45 });
  await manager.registerConversationRootSession(session, { prewarm: false });
  const forked = await manager.forkThread(session, { kind: "truncate_before_nth_user_message", n: 1 });
  const turn = manager.submitTurn(forked.threadId, { type: "user_input", input: "continue fork" });
  if (ending === "is interrupted") {
    await inTurn;
    await manager.submitTurn(forked.threadId, { type: "interrupt", reason: "user stop" });
  }
  await expect(turn).rejects.toThrow(ending === "throws" ? "provider stream failed" : "aborted by the user");
  expect(forkTurn).toHaveBeenCalledTimes(1);
  // As after a completed fork turn: B was shown by the source's last request,
  // so only the new screen C is unseen, and the fork's request left nothing.
  rememberPreparedContextImages(session, [a, b, c], [a, b, c], [a, b, c]);
  expect(unseenImageSourcesRemovedByCompaction(session, [a, b, c], [])).toEqual(["the newly attached image"]);
});
