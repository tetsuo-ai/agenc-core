import { describe, expect, it } from "vitest";

import { buildUserHookDefinitions } from "./user-config.js";

describe("buildUserHookDefinitions", () => {
  it("returns an empty set when the config is missing", () => {
    expect(buildUserHookDefinitions(undefined)).toEqual({
      definitions: [],
      warnings: [],
    });
    expect(buildUserHookDefinitions(null)).toEqual({
      definitions: [],
      warnings: [],
    });
  });

  it("warns when the config is not an object", () => {
    const result = buildUserHookDefinitions([]);
    expect(result.definitions).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/must be an object/);
  });

  it("parses the reference-runtime matcher-group shape for commands", () => {
    const result = buildUserHookDefinitions({
      PreToolUse: [
        {
          matcher: "system.bash",
          hooks: [
            { type: "command", command: "echo pre", timeout: 2 },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [{ type: "command", command: "echo post" }],
        },
      ],
    });

    expect(result.warnings).toEqual([]);
    expect(result.definitions).toEqual([
      {
        event: "PreToolUse",
        kind: "command",
        target: "echo pre",
        matcher: "system.bash",
        timeoutMs: 2000,
      },
      {
        event: "PostToolUse",
        kind: "command",
        target: "echo post",
      },
    ]);
  });

  it("parses http handler entries and drops unsupported handler types", () => {
    const result = buildUserHookDefinitions({
      Stop: [
        {
          matcher: "*",
          hooks: [
            { type: "http", url: "https://example.invalid/stop", timeout: 5 },
            { type: "agent", prompt: "verify" },
            { type: "prompt", prompt: "inspect" },
          ],
        },
      ],
    });

    expect(result.definitions).toEqual([
      {
        event: "Stop",
        kind: "http",
        target: "https://example.invalid/stop",
        matcher: "*",
        timeoutMs: 5000,
      },
    ]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join("\n")).toMatch(/not yet supported/);
  });

  it("warns and skips invalid entries instead of rejecting the config", () => {
    const result = buildUserHookDefinitions({
      PreToolUse: [
        {
          hooks: [
            { type: "command" },
            { type: "http", timeout: 1 },
            { type: "command", command: "" },
            { type: "command", command: "echo ok" },
          ],
        },
      ],
      Unknown: [],
      Stop: "oops",
    });

    expect(result.definitions).toEqual([
      { event: "PreToolUse", kind: "command", target: "echo ok" },
    ]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(4);
    expect(result.warnings.join("\n")).toMatch(/unsupported hook event/);
    expect(result.warnings.join("\n")).toMatch(/matcher groups/);
    expect(result.warnings.join("\n")).toMatch(/missing "command" field/);
    expect(result.warnings.join("\n")).toMatch(/missing "url" field/);
  });
});
