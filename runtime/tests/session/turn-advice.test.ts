import { describe, expect, it } from "vitest";

import {
  contextFullAdvice,
  setTurnAdviceReader,
  turnAdviceReader,
} from "../../src/session/turn-advice.js";

describe("turn advice readers", () => {
  it("keeps the TUI's words byte for byte", () => {
    expect(contextFullAdvice("tui", "full")).toBe(
      " Run /compact to retry, start a new conversation with /clear, or use a model with a larger context window.",
    );
    expect(contextFullAdvice("tui", "short")).toBe(
      "Run /compact to retry, or start a new conversation with /clear.",
    );
  });

  it("tells another daemon client the same thing without slash commands", () => {
    expect(contextFullAdvice("client", "full")).toBe(
      " Compact the conversation and retry, start a new conversation, or use a model with a larger context window.",
    );
    expect(contextFullAdvice("client", "short")).toBe(
      "Compact the conversation and retry, or start a new conversation.",
    );
    for (const form of ["full", "short"] as const) {
      expect(contextFullAdvice("client", form)).not.toMatch(/\/compact|\/clear/u);
    }
  });

  it("gives no advice to a client that offers Compact itself, or to a session nobody answers", () => {
    for (const form of ["full", "short"] as const) {
      expect(contextFullAdvice("client_with_compact", form)).toBe("");
      expect(contextFullAdvice("none", form)).toBe("");
    }
  });

  it("reads the session's recorded reader, the TUI for an in-process session, and none when nobody answers", () => {
    const inProcess = { services: { runtimeOptions: { nonInteractive: false } } };
    expect(turnAdviceReader(inProcess)).toBe("tui");

    const daemonSession = { services: { runtimeOptions: { nonInteractive: false } } };
    setTurnAdviceReader(daemonSession, "client");
    expect(turnAdviceReader(daemonSession)).toBe("client");
    setTurnAdviceReader(daemonSession, "client_with_compact");
    expect(turnAdviceReader(daemonSession)).toBe("client_with_compact");

    const oneShot = { services: { runtimeOptions: { nonInteractive: true } } };
    setTurnAdviceReader(oneShot, "tui");
    expect(turnAdviceReader(oneShot)).toBe("none");
  });
});
