import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __createDeferredDaemonPromptTuiSessionForTest,
  __wrapDaemonTuiSessionWithPromptPreparationForTest,
} from "./agenc-main.js";
import { ConfigStore } from "../config/store.js";
import type { IdleInputAdmission } from "../session/session.js";

interface DeferredInputSession {
  submit(
    message: string,
    opts?: { readonly displayUserMessage?: string | null },
  ): Promise<void>;
  enqueueIdleInput(input: unknown): number;
  enqueueIdleInputBatch(inputs: readonly unknown[]): number;
  enqueueIdleInputBatchOwned(
    inputs: readonly unknown[],
  ): IdleInputAdmission;
  rollbackIdleInputAdmission(token: string): boolean;
  commitIdleInputAdmission(token: string): boolean;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function createDeferredInputSession(
  options: {
    readonly baseSession?: unknown;
    readonly configStore?: ConfigStore;
    readonly deps?: unknown;
    readonly preparePrompt?: (
      params: Readonly<{ message: string }>,
    ) => Promise<string | null>;
  } = {},
): Promise<DeferredInputSession> {
  const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
    baseSession: options.baseSession ?? {},
    configStore: options.configStore ?? new ConfigStore({ env: {} }),
    deps: (options.deps ?? {}) as never,
    agencHome: process.cwd(),
    env: {},
    cwd: process.cwd(),
    clientId: "deferred-input-test",
    ...(options.preparePrompt !== undefined
      ? { preparePrompt: options.preparePrompt }
      : {}),
  });
  cleanups.push(deferred.close);
  return deferred.session as DeferredInputSession;
}

function queuedText(text: string): {
  readonly role: "user";
  readonly content: string;
} {
  return { role: "user", content: text };
}

function daemonHarness(options: {
  readonly rejectFirstAttach?: boolean;
  readonly rejectMessageStream?: boolean;
} = {}) {
  let attachAttempts = 0;
  const requests: Array<{
    readonly method: string;
    readonly params: Record<string, unknown> | undefined;
  }> = [];
  const client = {
    request: vi.fn(
      async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params });
        if (method === "agent.attach") {
          attachAttempts += 1;
          if (options.rejectFirstAttach === true && attachAttempts === 1) {
            throw new Error("intentional attach rejection");
          }
          const agentId =
            typeof params?.agentId === "string" ? params.agentId : "agent-1";
          return {
            agentId,
            attachmentId: `attachment-${attachAttempts}`,
            sessionIds: [`session-${attachAttempts}`],
            runtimeSessionId: agentId,
          };
        }
        if (method === "message.stream") {
          if (options.rejectMessageStream === true) {
            throw new Error(
              "AgenC daemon session not found or closed: session-1",
            );
          }
          return {};
        }
        if (method === "agent.stop") {
          return {
            agentId:
              typeof params?.agentId === "string" ? params.agentId : "agent-1",
            stopped: true,
          };
        }
        return {};
      },
    ),
    subscribeToSessionEvents: vi.fn(() => () => undefined),
    subscribeToConnectionState: vi.fn(() => () => undefined),
    getConnectionState: vi.fn(() => ({ status: "connected" as const })),
    close: vi.fn(async () => undefined),
  };
  let nextAgent = 0;
  const startPromptAgent = vi.fn(async (_params: unknown) => {
    nextAgent += 1;
    return { agentId: `agent-${nextAgent}` };
  });
  return {
    baseSession: {
      activeTurn: { unsafePeek: () => null },
      conversationId: "deferred-input-base",
      services: {},
      sessionConfiguration: { cwd: process.cwd() },
    },
    client,
    deps: {
      startPromptAgent,
      stopPromptAgent: vi.fn(async () => undefined),
      createConnectedTuiClient: vi.fn(async () => client),
    },
    requests,
    startPromptAgent,
  };
}

describe("deferred daemon input ownership", () => {
  it("bounds queued records atomically and rolls back only the owned batch", async () => {
    const session = await createDeferredInputSession();
    const first = session.enqueueIdleInputBatchOwned([queuedText("first")]);
    const remainder = session.enqueueIdleInputBatchOwned(
      Array.from({ length: 511 }, (_, index) =>
        queuedText(`remainder-${index}`),
      ),
    );

    expect(() =>
      session.enqueueIdleInputBatchOwned([queuedText("overflow")]),
    ).toThrow("Session mailbox is full");
    expect(session.rollbackIdleInputAdmission(first.token)).toBe(true);

    const replacement = session.enqueueIdleInputBatchOwned([
      queuedText("replacement"),
    ]);
    expect(() =>
      session.enqueueIdleInputBatchOwned([queuedText("still-full")]),
    ).toThrow("Session mailbox is full");
    expect(session.commitIdleInputAdmission(remainder.token)).toBe(true);
    expect(session.commitIdleInputAdmission(replacement.token)).toBe(true);
  });

  it("rejects an oversized batch without advancing admission state", async () => {
    const session = await createDeferredInputSession();
    const oversized = "x".repeat(16 * 1_024 * 1_024);

    expect(() =>
      session.enqueueIdleInputBatchOwned([queuedText(oversized)]),
    ).toThrow("Session mailbox is full");

    const accepted = session.enqueueIdleInputBatchOwned([
      queuedText("accepted"),
    ]);
    expect(accepted).toMatchObject({
      firstSequence: 1,
      lastSequence: 1,
      count: 1,
    });
    expect(session.rollbackIdleInputAdmission(accepted.token)).toBe(true);
  });

  it("rejects a blocked first prompt so its owned context can roll back", async () => {
    const session = await createDeferredInputSession({
      preparePrompt: async () => null,
    });
    const admission = session.enqueueIdleInputBatchOwned([
      queuedText("owned attachment"),
    ]);

    await expect(session.submit("blocked prompt")).rejects.toThrow(
      "pending input was not consumed",
    );
    expect(session.rollbackIdleInputAdmission(admission.token)).toBe(true);
  });

  it("rejects a blocked live prompt instead of resolving without submission", async () => {
    const submit = vi.fn(async () => undefined);
    const wrapped = __wrapDaemonTuiSessionWithPromptPreparationForTest(
      { submit },
      {
        configStore: new ConfigStore({ env: {} }),
        agencHome: process.cwd(),
        cwd: process.cwd(),
        env: {},
        stderr: process.stderr,
        preparePrompt: async () => null,
      },
    );

    await expect(wrapped.submit?.("blocked prompt")).rejects.toThrow(
      "pending input was not consumed",
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("serializes prompt preparation before admitting any later context", async () => {
    let releasePreparation!: () => void;
    const preparationReleased = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let markPreparationEntered!: () => void;
    const preparationEntered = new Promise<void>((resolve) => {
      markPreparationEntered = resolve;
    });
    const startPromptAgent = vi.fn(async (_params: unknown) => {
      throw new Error("intentional startup stop");
    });
    const session = await createDeferredInputSession({
      deps: { startPromptAgent },
      preparePrompt: async ({ message }) => {
        markPreparationEntered();
        await preparationReleased;
        return message;
      },
    });
    const first = session.enqueueIdleInputBatchOwned([
      queuedText("admitted before preparation"),
    ]);
    const submission = session.submit("first prompt");

    await preparationEntered;
    expect(() =>
      session.enqueueIdleInputBatchOwned([
        queuedText("must not join in-flight startup"),
      ]),
    ).toThrow("Deferred session startup is in progress");
    releasePreparation();
    await expect(submission).rejects.toThrow("intentional startup stop");

    expect(startPromptAgent).toHaveBeenCalledTimes(1);
    expect(startPromptAgent.mock.calls[0]?.[0]).toMatchObject({
      initialContent: [
        { type: "text", text: "admitted before preparation" },
        { type: "text", text: "first prompt" },
      ],
    });
    expect(session.rollbackIdleInputAdmission(first.token)).toBe(true);
  });

  it("rolls back exact pre-start context after attach failure and excludes it from retry", async () => {
    const harness = daemonHarness({ rejectFirstAttach: true });
    const session = await createDeferredInputSession({
      baseSession: harness.baseSession,
      deps: harness.deps,
    });
    const admission = session.enqueueIdleInputBatchOwned([
      queuedText("stale attachment"),
    ]);

    await expect(session.submit("first prompt")).rejects.toThrow(
      "intentional attach rejection",
    );
    expect(session.rollbackIdleInputAdmission(admission.token)).toBe(true);

    await session.submit("retry prompt");
    expect(harness.startPromptAgent).toHaveBeenCalledTimes(2);
    expect(harness.startPromptAgent.mock.calls[0]?.[0]).toMatchObject({
      initialContent: [
        { type: "text", text: "stale attachment" },
        { type: "text", text: "first prompt" },
      ],
    });
    expect(harness.startPromptAgent.mock.calls[1]?.[0]).toMatchObject({
      initialContent: "retry prompt",
    });
  });

  it("binds live proxy tokens to their origin and never retries text alone after daemon loss", async () => {
    const harness = daemonHarness({ rejectMessageStream: true });
    const session = await createDeferredInputSession({
      baseSession: harness.baseSession,
      deps: harness.deps,
    });
    await session.submit("initial prompt");

    const admission = session.enqueueIdleInputBatchOwned([
      queuedText("live attachment"),
    ]);
    expect(admission.token).toMatch(/^deferred-live:/);
    expect(() =>
      session.enqueueIdleInputBatchOwned([queuedText("second live bundle")]),
    ).toThrow("already pending");

    await expect(session.submit("follow-up prompt")).rejects.toThrow(
      "session not found or closed",
    );
    expect(harness.startPromptAgent).toHaveBeenCalledTimes(1);
    const streamRequest = harness.requests.find(
      ({ method }) => method === "message.stream",
    );
    expect(streamRequest?.params).toMatchObject({
      content: [
        { type: "text", text: "live attachment" },
        { type: "text", text: "follow-up prompt" },
      ],
    });
    expect(session.rollbackIdleInputAdmission(admission.token)).toBe(true);

    const afterRollback = session.enqueueIdleInputBatchOwned([
      queuedText("new-session attachment"),
    ]);
    expect(session.rollbackIdleInputAdmission(afterRollback.token)).toBe(true);
  });
});
