import { describe, expect, test } from "vitest";
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
  });
});
