import { describe, expect, it } from "vitest";

import type { Session } from "../session/session.js";
import clearCommand from "../commands/clear.js";
import {
  emitLocalTuiEvent,
  emitLocalTuiPhaseEvent,
  emitLocalTuiSlashResult,
  type LocalTuiEventSubscriber,
} from "./tui-local-events.js";
import type { SlashCommandContext } from "../commands/types.js";

function mkctx(session: Session): SlashCommandContext {
  return { session, argsRaw: "", cwd: "/ws", home: "/home/test" };
}

describe("local TUI event fanout", () => {
  it("delivers /clear history_cleared before slash_result and isolates bad subscribers", async () => {
    const subscribers = new Set<LocalTuiEventSubscriber>();
    const observed: unknown[] = [];
    subscribers.add(() => {
      throw new Error("subscriber failed");
    });
    subscribers.add((event) => {
      observed.push(event);
    });
    const session = {
      emitPhaseEvent: (event) => emitLocalTuiEvent(subscribers, event),
    } as unknown as Session;

    const result = await clearCommand.execute(mkctx(session));
    emitLocalTuiSlashResult(subscribers, "/clear", result);

    expect(observed).toEqual([
      expect.objectContaining({
        type: "history_cleared",
        timestamp: expect.any(Number),
      }),
      expect.objectContaining({
        type: "slash_result",
        input: "/clear",
        result: expect.objectContaining({ kind: "text" }),
      }),
    ]);
  });

  it("forwards through a live phase emitter instead of locally double-broadcasting", () => {
    const subscribers = new Set<LocalTuiEventSubscriber>();
    const localEvents: unknown[] = [];
    const forwardedEvents: unknown[] = [];
    subscribers.add((event) => {
      localEvents.push(event);
    });
    const event = { type: "history_cleared", timestamp: 1 } as const;

    emitLocalTuiPhaseEvent(
      { emitPhaseEvent: (forwarded) => forwardedEvents.push(forwarded) },
      subscribers,
      event,
    );

    expect(localEvents).toEqual([]);
    expect(forwardedEvents).toEqual([event]);
  });
});
