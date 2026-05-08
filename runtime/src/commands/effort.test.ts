import { describe, expect, it } from "vitest";
import {
  applyReasoningEffort,
  clearReasoningEffort,
  effortCommand,
  formatReasoningEffortStatus,
  parseEffort,
  readReasoningEffort,
} from "./effort.js";
import type { Session } from "../session/session.js";

function stubSession(initialEffort: string | undefined): Session {
  const cfg: { collaborationMode: Record<string, unknown> } = {
    collaborationMode: {
      model: "grok-4-fast",
      ...(initialEffort !== undefined ? { reasoningEffort: initialEffort } : {}),
    },
  };
  return {
    state: {
      unsafePeek: () => ({ sessionConfiguration: cfg }),
      with: async (fn: (state: { sessionConfiguration: typeof cfg }) => void) => {
        fn({ sessionConfiguration: cfg });
      },
    },
  } as unknown as Session;
}

describe("parseEffort", () => {
  it.each([
    ["minimal", "minimal"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "xhigh"], // alias
    ["MEDIUM", "medium"], // case-insensitive
    ["  low  ", "low"], // trimming
  ])("parses %j → %j", (input, expected) => {
    expect(parseEffort(input)).toBe(expected);
  });

  it("rejects unknown values", () => {
    expect(parseEffort("nope")).toBeNull();
    expect(parseEffort("")).toBeNull();
    expect(parseEffort("turbo")).toBeNull();
  });
});

describe("readReasoningEffort", () => {
  it("returns null when no effort is set", () => {
    expect(readReasoningEffort(stubSession(undefined))).toBeNull();
  });

  it("reads the effort from sessionConfiguration", () => {
    expect(readReasoningEffort(stubSession("medium"))).toBe("medium");
  });
});

describe("applyReasoningEffort + clearReasoningEffort", () => {
  it("apply sets the effort and reports the previous value", async () => {
    const session = stubSession(undefined);
    const text = await applyReasoningEffort(session, "high");
    expect(text).toBe("Reasoning effort set to high (was unset).");
    expect(readReasoningEffort(session)).toBe("high");
  });

  it("apply preserves the prior value in its message", async () => {
    const session = stubSession("low");
    const text = await applyReasoningEffort(session, "xhigh");
    expect(text).toBe("Reasoning effort set to xhigh (was low).");
    expect(readReasoningEffort(session)).toBe("xhigh");
  });

  it("clear removes the override and reports the previous value", async () => {
    const session = stubSession("medium");
    const text = await clearReasoningEffort(session);
    expect(text).toBe("Reasoning effort reset to model default (was medium).");
    expect(readReasoningEffort(session)).toBeNull();
  });
});

describe("formatReasoningEffortStatus", () => {
  it("renders 'model default' when nothing is set", () => {
    expect(formatReasoningEffortStatus(stubSession(undefined))).toContain(
      "model default",
    );
  });

  it("renders the active effort", () => {
    expect(formatReasoningEffortStatus(stubSession("xhigh"))).toContain("xhigh");
  });
});

describe("effortCommand.execute", () => {
  const baseCtx = {
    cwd: "/tmp/ws",
    home: "/tmp/home",
  };

  it("status with no args returns text with current effort", async () => {
    const result = await effortCommand.execute({
      ...baseCtx,
      session: stubSession("medium"),
      argsRaw: "",
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("medium");
    }
  });

  it("'help' returns the help text", async () => {
    const result = await effortCommand.execute({
      ...baseCtx,
      session: stubSession(undefined),
      argsRaw: "help",
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("Usage: /effort");
    }
  });

  it("invalid value returns an error", async () => {
    const result = await effortCommand.execute({
      ...baseCtx,
      session: stubSession(undefined),
      argsRaw: "ludicrous",
    });
    expect(result.kind).toBe("error");
  });

  it("'auto' clears the override", async () => {
    const session = stubSession("high");
    const result = await effortCommand.execute({
      ...baseCtx,
      session,
      argsRaw: "auto",
    });
    expect(result.kind).toBe("text");
    expect(readReasoningEffort(session)).toBeNull();
  });

  it("'high' applies the effort", async () => {
    const session = stubSession(undefined);
    const result = await effortCommand.execute({
      ...baseCtx,
      session,
      argsRaw: "high",
    });
    expect(result.kind).toBe("text");
    expect(readReasoningEffort(session)).toBe("high");
  });
});
