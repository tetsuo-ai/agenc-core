import { describe, expect, test, vi } from "vitest";
import { buildDefaultRegistry } from "../src/commands/registry.js";
import {
  mkProvider,
  mkSession,
} from "./fixtures.js";

describe("slash /compact contract", () => {
  test("default registry exposes /compact", () => {
    const registry = buildDefaultRegistry();

    expect(registry.has("compact")).toBe(true);
    expect(registry.find("compact")?.immediate).toBe(true);
  });

  test("daemon-backed compact routes to session.partialCompactFromMessage", async () => {
    const registry = buildDefaultRegistry();
    const command = registry.find("compact");
    const partialCompactFromMessage = vi.fn(async () => ({
      sessionId: "session_1",
      ok: true,
      eventAlreadyEmitted: true,
    }));
    // A daemon bridge session: no in-process turn allocation, but the
    // daemon-forwarder method is present. This mirrors props.session in
    // the live daemon-backed TUI.
    const daemonSession = {
      conversationId: "session_1",
      services: {},
      activeTurn: { unsafePeek: () => null },
      partialCompactFromMessage,
    };

    const result = await command?.execute({
      session: daemonSession as never,
      argsRaw: "focus on the goal",
      cwd: "/tmp",
      home: "/tmp",
    });

    expect(result).toEqual({ kind: "compact", text: "Conversation compacted." });
    expect(partialCompactFromMessage).toHaveBeenCalledWith({
      messageOrdinal: 0,
      direction: "from",
      feedback: "focus on the goal",
    });
  });

  test("daemon-backed compact surfaces an RPC failure as an error", async () => {
    const registry = buildDefaultRegistry();
    const command = registry.find("compact");
    const partialCompactFromMessage = vi.fn(async () => ({
      sessionId: "session_1",
      ok: false,
      eventAlreadyEmitted: true,
      message: "nothing to compact",
    }));
    const daemonSession = {
      conversationId: "session_1",
      services: {},
      activeTurn: { unsafePeek: () => null },
      partialCompactFromMessage,
    };

    const result = await command?.execute({
      session: daemonSession as never,
      argsRaw: "",
      cwd: "/tmp",
      home: "/tmp",
    });

    expect(result).toEqual({
      kind: "error",
      message: "nothing to compact",
    });
    expect(partialCompactFromMessage).toHaveBeenCalledWith({
      messageOrdinal: 0,
      direction: "from",
    });
  });

  test("manual compact refuses active-turn mutation", async () => {
    const registry = buildDefaultRegistry();
    const command = registry.find("compact");
    const { session } = mkSession({
      provider: mkProvider({ content: "summary" }),
      history: [{ role: "user", content: "hello" }],
    });
    await session.activeTurn.swap({ turnId: "busy" } as never);

    const result = await command?.execute({
      session,
      argsRaw: "",
      cwd: "/tmp",
      home: "/tmp",
    });

    expect(result).toEqual({
      kind: "error",
      message:
        "Cannot compact right now: a turn is currently in flight; wait for it to complete before running /compact.",
    });
  });

  test("manual compact succeeds while idle and replaces session history", async () => {
    const registry = buildDefaultRegistry();
    const command = registry.find("compact");
    const { session, state } = mkSession({
      provider: mkProvider({ content: "slash compact summary" }),
      history: [
        { role: "user", content: "large request" },
        { role: "assistant", content: "large answer" },
        { role: "user", content: "latest request" },
      ],
    });
    const compactLifecycle: unknown[] = [];
    const setStreamMode = vi.fn((mode) => {
      compactLifecycle.push({ type: "stream_mode", mode });
    });
    const setResponseLength = vi.fn((updater) => {
      compactLifecycle.push({
        type: "response_length",
        length: updater(123),
      });
    });
    const onCompactProgress = vi.fn((event) => {
      compactLifecycle.push(event);
    });
    const setSDKStatus = vi.fn((status) => {
      compactLifecycle.push({ type: "sdk_status", status });
    });
    Object.assign(session, {
      setStreamMode,
      setResponseLength,
      onCompactProgress,
      setSDKStatus,
    });

    const result = await command?.execute({
      session,
      argsRaw: "focus on the latest request",
      cwd: "/tmp",
      home: "/tmp",
    });

    expect(result).toEqual({
      kind: "compact",
      text: "Conversation compacted",
    });
    expect(state.history[0]?.content).toContain("<compact>");
    expect(state.history.map((message) => message.content).join("\n")).toContain(
      "slash compact summary",
    );
    expect(state.history.map((message) => message.content).join("\n")).toContain(
      "focus on the latest request",
    );
    expect(setSDKStatus).toHaveBeenNthCalledWith(1, "compacting");
    expect(setSDKStatus).toHaveBeenLastCalledWith(null);
    expect(setStreamMode).toHaveBeenCalledWith("requesting");
    expect(setResponseLength).toHaveBeenCalledWith(expect.any(Function));
    expect(onCompactProgress).toHaveBeenNthCalledWith(1, {
      type: "hooks_start",
      hookType: "pre_compact",
    });
    expect(onCompactProgress).toHaveBeenNthCalledWith(2, {
      type: "compact_start",
    });
    expect(onCompactProgress).toHaveBeenNthCalledWith(3, {
      type: "compact_end",
    });
    expect(compactLifecycle).toEqual([
      { type: "hooks_start", hookType: "pre_compact" },
      { type: "sdk_status", status: "compacting" },
      { type: "stream_mode", mode: "requesting" },
      { type: "response_length", length: 0 },
      { type: "compact_start" },
      { type: "stream_mode", mode: "requesting" },
      { type: "response_length", length: 0 },
      { type: "compact_end" },
      { type: "sdk_status", status: null },
    ]);
  });
});
