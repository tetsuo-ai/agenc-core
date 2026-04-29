import { describe, expect, it } from "vitest";

import { mergeUserStopHooksIntoConfig } from "./chat-executor-factory.js";
import type { HookDefinition } from "../llm/hooks/index.js";

describe("mergeUserStopHooksIntoConfig", () => {
  it("returns the existing config unchanged when no user Stop entries exist", () => {
    const existing = { enabled: true };
    const userDefinitions: HookDefinition[] = [
      {
        event: "PreToolUse",
        kind: "command",
        target: "echo pre",
      },
    ];
    expect(mergeUserStopHooksIntoConfig(existing, userDefinitions)).toBe(
      existing,
    );
  });

  it("folds user Stop command + http entries into stop-hook handlers", () => {
    const userDefinitions: HookDefinition[] = [
      {
        event: "Stop",
        kind: "command",
        target: "echo guard",
        matcher: "session-1",
        timeoutMs: 1500,
      },
      {
        event: "Stop",
        kind: "http",
        target: "https://example.invalid/stop",
      },
      {
        event: "PreToolUse",
        kind: "command",
        target: "echo pre",
      },
    ];
    const merged = mergeUserStopHooksIntoConfig(undefined, userDefinitions);
    expect(merged?.handlers).toEqual([
      {
        id: "user:stop:0",
        phase: "Stop",
        kind: "command",
        target: "echo guard",
        matcher: "session-1",
        timeoutMs: 1500,
      },
      {
        id: "user:stop:1",
        phase: "Stop",
        kind: "http",
        target: "https://example.invalid/stop",
      },
    ]);
  });

  it("appends user Stop entries after existing configured stop-hook handlers", () => {
    const existing = {
      enabled: true,
      handlers: [
        {
          id: "operator:primary",
          phase: "Stop" as const,
          kind: "command" as const,
          target: "./bin/primary-gate",
        },
      ],
    };
    const userDefinitions: HookDefinition[] = [
      {
        event: "Stop",
        kind: "command",
        target: "./bin/user-gate",
      },
    ];
    const merged = mergeUserStopHooksIntoConfig(existing, userDefinitions);
    expect(merged?.handlers).toEqual([
      existing.handlers[0],
      {
        id: "user:stop:0",
        phase: "Stop",
        kind: "command",
        target: "./bin/user-gate",
      },
    ]);
  });
});
