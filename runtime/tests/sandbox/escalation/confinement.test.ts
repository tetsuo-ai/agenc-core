import { describe, expect, test } from "vitest";

import { escalationStaysConfined } from "../../../src/sandbox/escalation/confinement.js";

describe("escalationStaysConfined", () => {
  test("ordinary sessions can still be offered a sandbox escape", () => {
    expect(escalationStaysConfined(undefined)).toBe(false);
    expect(escalationStaysConfined(null)).toBe(false);
    expect(escalationStaysConfined({})).toBe(false);
    expect(escalationStaysConfined({ services: {} })).toBe(false);
    expect(escalationStaysConfined({
      services: { sandboxExecutionBroker: {} },
    })).toBe(false);
  });

  test("worktree and read-only children stay confined after escalation", () => {
    expect(escalationStaysConfined({
      services: {
        sandboxExecutionBroker: { worktreeConfinement: { root: "/worktree" } },
      },
    })).toBe(true);
    expect(escalationStaysConfined({
      services: { readOnlyDelegation: { parentSessionId: "parent" } },
    })).toBe(true);
    expect(escalationStaysConfined({
      services: {
        sandboxExecutionBroker: { worktreeConfinement: { root: "/worktree" } },
        readOnlyDelegation: { parentSessionId: "parent" },
      },
    })).toBe(true);
  });
});
