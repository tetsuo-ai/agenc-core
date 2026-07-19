import { describe, expect, it } from "vitest";

import {
  collectHelloSnapshot,
  formatHelloCard,
  helloCommand,
} from "./hello.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

function mkctx(session: Session, cwd = "/ws"): SlashCommandContext {
  return {
    session,
    argsRaw: "",
    cwd,
    home: "/home/test",
  };
}

function stubSession(opts: {
  model?: string;
  cwd?: string;
  useBridgeConfig?: boolean;
} = {}): Session {
  const sessionConfiguration = {
    cwd: opts.cwd ?? "/project",
    collaborationMode: { model: opts.model ?? "grok-4" },
  };
  if (opts.useBridgeConfig) {
    return { sessionConfiguration } as unknown as Session;
  }
  return {
    state: { unsafePeek: () => ({ sessionConfiguration }) },
  } as unknown as Session;
}

describe("helloCommand", () => {
  it("is an immediate utility command named hello", () => {
    expect(helloCommand.name).toBe("hello");
    expect(helloCommand.immediate).toBe(true);
    expect(helloCommand.supportsNonInteractive).toBe(true);
    expect(helloCommand.description).toMatch(/greeting card/i);
  });

  it("collects model and workspace from session state", () => {
    const snapshot = collectHelloSnapshot(
      stubSession({ model: "grok-4.5", cwd: "/repo" }),
      "/fallback",
    );
    expect(snapshot).toEqual({ model: "grok-4.5", workspace: "/repo" });
  });

  it("falls back to dispatch cwd and unknown model when config is missing", () => {
    const snapshot = collectHelloSnapshot({} as Session, "/ws-only");
    expect(snapshot).toEqual({ model: "unknown", workspace: "/ws-only" });
  });

  it("reads bridge sessionConfiguration when state is unavailable", () => {
    const snapshot = collectHelloSnapshot(
      stubSession({
        model: "bridge-model",
        cwd: "/bridge-ws",
        useBridgeConfig: true,
      }),
      "/fallback",
    );
    expect(snapshot).toEqual({
      model: "bridge-model",
      workspace: "/bridge-ws",
    });
  });

  it("formats a framed greeting card with model and workspace", () => {
    const card = formatHelloCard({
      model: "grok-4",
      workspace: "/home/paul/project",
    });
    expect(card).toContain("Hello from AgenC");
    expect(card).toContain("Model     : grok-4");
    expect(card).toContain("Workspace : /home/paul/project");
    expect(card.startsWith("┌")).toBe(true);
    expect(card.endsWith("┘")).toBe(true);
    expect(card.split("\n")).toHaveLength(5);
  });

  it("returns a text result with the greeting card", async () => {
    const res = await helloCommand.execute(
      mkctx(stubSession({ model: "test-model", cwd: "/tmp/ws" }), "/tmp/ws"),
    );
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toContain("Hello from AgenC");
      expect(res.text).toContain("test-model");
      expect(res.text).toContain("/tmp/ws");
    }
  });
});
