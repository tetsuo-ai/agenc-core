/**
 * Wave 2 useQuery hook tests.
 *
 * The hook is a thin adapter around a structural SessionLike; tests
 * drive it with a stub that implements `subscribeToEvents`, `submit`,
 * and `abortTerminal`.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import type { PhaseEvent } from "../../phases/events.js";
import {
  __resetWarnOnceForTests,
  useQuery,
  type SessionLike,
} from "./useQuery.js";
import type { Event } from "../../session/event-log.js";
import type { TranscriptSourceEvent } from "../state/events-to-messages.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(
  element: React.ReactElement,
): Promise<{ unmount: () => void }> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((r) => setTimeout(r, 20));
  return {
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

interface FakeSession extends SessionLike {
  emit: (event: PhaseEvent) => void;
  emitEventLog: (event: Event) => void;
}

function createFakeSession(options?: {
  withSubscribe?: boolean;
  withSubmit?: boolean;
  withEventLog?: boolean;
  initialTranscriptEvents?: readonly TranscriptSourceEvent[];
  activeTurnId?: string | null;
}): FakeSession {
  const withSubscribe = options?.withSubscribe ?? true;
  const withSubmit = options?.withSubmit ?? true;
  const withEventLog = options?.withEventLog ?? false;
  const listeners = new Set<(e: PhaseEvent) => void>();
  const eventLogListeners = new Set<(event: Event) => void>();
  return {
    activeTurn:
      options?.activeTurnId === undefined || options.activeTurnId === null
        ? null
        : {
            unsafePeek: () => ({ turnId: options.activeTurnId! }),
          },
    ...(withSubscribe
      ? {
          subscribeToEvents(cb: (e: PhaseEvent) => void) {
            listeners.add(cb);
            return () => listeners.delete(cb);
          },
        }
      : {}),
    ...(withEventLog
      ? {
          eventLog: {
            subscribe(cb: (event: Event) => void) {
              eventLogListeners.add(cb);
              return () => eventLogListeners.delete(cb);
            },
          },
        }
      : {}),
    ...(options?.initialTranscriptEvents
      ? {
          initialTranscriptEvents: options.initialTranscriptEvents,
        }
      : {}),
    ...(withSubmit
      ? {
          submit: vi.fn(async (_msg: string) => undefined),
        }
      : {}),
    abortTerminal: () => undefined,
    emit(event: PhaseEvent) {
      for (const cb of Array.from(listeners)) cb(event);
    },
    emitEventLog(event: Event) {
      for (const cb of Array.from(eventLogListeners)) cb(event);
    },
  };
}

describe("useQuery", () => {
  afterEach(() => {
    __resetWarnOnceForTests();
  });

  test("starts empty and not streaming", async () => {
    const session = createFakeSession();
    let observed: ReturnType<typeof useQuery> | null = null;
    function Consumer(): null {
      observed = useQuery(session);
      return null;
    }
    const { unmount } = await mount(<Consumer />);
    expect(observed).not.toBeNull();
    expect(observed!.events).toEqual([]);
    expect(observed!.isStreaming).toBe(false);
    unmount();
  });

  test("turn_start flips isStreaming true and resets events", async () => {
    const session = createFakeSession();
    let latest: ReturnType<typeof useQuery> | null = null;
    function Consumer(): null {
      latest = useQuery(session);
      return null;
    }
    const { unmount } = await mount(<Consumer />);
    session.emit({ type: "turn_start", turnIndex: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(latest!.isStreaming).toBe(true);
    expect(latest!.events.length).toBeGreaterThan(0);
    unmount();
  });

  test("turn_complete flips isStreaming back to false", async () => {
    const session = createFakeSession();
    let latest: ReturnType<typeof useQuery> | null = null;
    function Consumer(): null {
      latest = useQuery(session);
      return null;
    }
    const { unmount } = await mount(<Consumer />);
    session.emit({ type: "turn_start", turnIndex: 0 });
    session.emit({
      type: "turn_complete",
      content: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      } as never,
      stopReason: "completed",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(latest!.isStreaming).toBe(false);
    unmount();
  });

  test("hydrates initial transcript events for resumed sessions", async () => {
    const session = createFakeSession({
      initialTranscriptEvents: [
        { type: "turn_started", payload: { turnId: "turn-resume" } },
        { type: "user_message", payload: { message: "resume me" } },
      ],
    });
    let latest: ReturnType<typeof useQuery> | null = null;
    function Consumer(): null {
      latest = useQuery(session);
      return null;
    }
    const { unmount } = await mount(<Consumer />);
    expect(latest).not.toBeNull();
    expect(latest!.events).toHaveLength(2);
    expect(latest!.currentTurnId).toBe("turn-resume");
    expect(latest!.isStreaming).toBe(false);
    unmount();
  });

  test("keeps hydrated replay non-streaming until a live active turn exists", async () => {
    const session = createFakeSession({
      initialTranscriptEvents: [
        { type: "turn_started", payload: { turnId: "turn-replay" } },
        { type: "agent_message_delta", payload: { delta: "partial" } },
      ],
    });
    let latest: ReturnType<typeof useQuery> | null = null;
    function Consumer(): null {
      latest = useQuery(session);
      return null;
    }
    const { unmount } = await mount(<Consumer />);
    expect(latest).not.toBeNull();
    expect(latest!.currentTurnId).toBe("turn-replay");
    expect(latest!.isStreaming).toBe(false);
    unmount();
  });

  test("hydrates an active resumed turn as streaming when the session still owns it", async () => {
    const session = createFakeSession({
      activeTurnId: "turn-live",
      initialTranscriptEvents: [
        { type: "turn_started", payload: { turnId: "turn-live" } },
      ],
    });
    let latest: ReturnType<typeof useQuery> | null = null;
    function Consumer(): null {
      latest = useQuery(session);
      return null;
    }
    const { unmount } = await mount(<Consumer />);
    expect(latest).not.toBeNull();
    expect(latest!.currentTurnId).toBe("turn-live");
    expect(latest!.isStreaming).toBe(true);
    unmount();
  });

  test("prefers eventLog transcript events when available", async () => {
    const session = createFakeSession({
      withEventLog: true,
      withSubscribe: false,
    });
    let latest: ReturnType<typeof useQuery> | null = null;
    function Consumer(): null {
      latest = useQuery(session);
      return null;
    }
    const { unmount } = await mount(<Consumer />);
    session.emitEventLog({
      id: "evt-1",
      msg: {
        type: "session_configured",
        payload: {
          sessionId: "sess-1",
          forkedFromId: "sess-0",
          model: "gpt",
          modelProviderId: "openai",
          cwd: "/tmp",
          historyLogId: 1,
          historyEntryCount: 2,
          initialMessages: [],
        },
      },
      seq: 1,
    });
    session.emitEventLog({
      id: "evt-2",
      msg: {
        type: "turn_started",
        payload: { turnId: "turn-eventlog" },
      },
      seq: 2,
    });
    session.emitEventLog({
      id: "evt-3",
      msg: {
        type: "user_message",
        payload: { message: "hello from event log" },
      },
      seq: 3,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(latest!.events).toHaveLength(3);
    expect(latest!.events[0]).toMatchObject({
      type: "session_configured",
      payload: { forkedFromId: "sess-0" },
    });
    expect(latest!.isStreaming).toBe(true);
    expect(latest!.currentTurnId).toBe("turn-eventlog");
    unmount();
  });

  test("still consumes phase-only slash results when eventLog is present", async () => {
    const session = createFakeSession({
      withEventLog: true,
      withSubscribe: true,
    });
    let latest: ReturnType<typeof useQuery> | null = null;
    function Consumer(): null {
      latest = useQuery(session);
      return null;
    }
    const { unmount } = await mount(<Consumer />);
    session.emit({
      type: "slash_result",
      input: "/permissions",
      result: { kind: "text", text: "Mode: default" },
      timestamp: Date.now(),
      turnId: null,
    } as PhaseEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(
      latest!.events.some(
        (event) =>
          event.type === "slash_result" &&
          "result" in event &&
          event.result.kind === "text" &&
          event.result.text.includes("Mode: default"),
      ),
    ).toBe(true);
    unmount();
  });

  test("submit forwards to session.submit when available", async () => {
    const session = createFakeSession();
    let latest: ReturnType<typeof useQuery> | null = null;
    function Consumer(): null {
      latest = useQuery(session);
      return null;
    }
    const { unmount } = await mount(<Consumer />);
    await latest!.submit("hello");
    expect(session.submit).toHaveBeenCalledWith("hello");
    unmount();
  });

  test("missing subscribeToEvents keeps events empty without throwing", async () => {
    const session = createFakeSession({ withSubscribe: false });
    let latest: ReturnType<typeof useQuery> | null = null;
    function Consumer(): null {
      latest = useQuery(session);
      return null;
    }
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (chunk: string) => boolean) = ((
      chunk: string,
    ) => {
      stderrWrites.push(chunk);
      return true;
    }) as never;
    try {
      const { unmount } = await mount(<Consumer />);
      expect(latest!.events).toEqual([]);
      expect(latest!.isStreaming).toBe(false);
      expect(
        stderrWrites.some((line) => line.includes("transcript stream")),
      ).toBe(true);
      unmount();
    } finally {
      process.stderr.write = origWrite as never;
    }
  });
});
