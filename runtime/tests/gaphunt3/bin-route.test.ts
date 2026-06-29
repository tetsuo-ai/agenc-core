/**
 * gaphunt3 #37 regression: route.ts STARTUP_VALUE_FLAGS must not list value
 * flags that no downstream consumer honors (--fork/--config/--sandbox/
 * --approval-policy). Previously stripRoutingFlags removed each such flag AND
 * its following value before the residue became the prompt, so the user's
 * intent (e.g. the fork target) silently vanished with no behavior change and
 * no feedback. After the fix these flags fall through as visible prompt text.
 *
 * Each test below fails if the fix is reverted (the flag+value is swallowed,
 * leaving an empty prompt) and passes with it (the flag text is preserved).
 */

import { describe, expect, it } from "vitest";

import { classifyCLI, stripRoutingFlags } from "src/bin/route";

const NODE = "/usr/bin/node";
const SCRIPT = "/opt/agenc/bin/agenc.js";

describe("gaphunt3 #37: unconsumed value flags are no longer silently swallowed", () => {
  it("stripRoutingFlags keeps --fork and its value (no consumer to honor it)", () => {
    // Before the fix --fork was in STARTUP_VALUE_FLAGS, so both the flag and
    // its value were stripped, leaving [] -> empty prompt.
    expect(stripRoutingFlags(["--fork", "conv-abc123"])).toEqual([
      "--fork",
      "conv-abc123",
    ]);
  });

  it.each([
    ["--config", "/tmp/x.json"],
    ["--sandbox", "strict"],
    ["--approval-policy", "untrusted"],
  ])("stripRoutingFlags keeps %s and its value", (flag, value) => {
    expect(stripRoutingFlags([flag, value])).toEqual([flag, value]);
  });

  it("classifyCLI('agenc --fork <id>') preserves the fork id as prompt text instead of dropping it", () => {
    const plan = classifyCLI({
      argv: [NODE, SCRIPT, "--fork", "conv-abc123"],
      isTTY: true,
      isStdoutTTY: true,
    });
    // Must be a bootTUI plan that still carries the user's intent. Before the
    // fix this was a bootTUI plan with NO initialPrompt (fork id swallowed).
    expect(plan.kind).toBe("bootTUI");
    if (plan.kind !== "bootTUI") throw new Error("expected bootTUI plan");
    expect(plan.args.initialPrompt).toBe("--fork conv-abc123");
  });

  it("classifyCLI('agenc --sandbox strict \"do X\"') keeps both the flag/value and the real prompt", () => {
    const plan = classifyCLI({
      argv: [NODE, SCRIPT, "--sandbox", "strict", "do", "X"],
      isTTY: true,
      isStdoutTTY: true,
    });
    expect(plan.kind).toBe("bootTUI");
    if (plan.kind !== "bootTUI") throw new Error("expected bootTUI plan");
    // Before the fix "--sandbox strict" was swallowed, leaving "do X".
    expect(plan.args.initialPrompt).toBe("--sandbox strict do X");
  });

  it("still strips genuinely-consumed value flags (--model, --provider, --resume)", () => {
    // Guard against an over-broad fix: flags that DO have consumers must keep
    // being stripped so they don't leak into the prompt text.
    expect(stripRoutingFlags(["--model", "gpt-x", "hello"])).toEqual(["hello"]);
    expect(stripRoutingFlags(["--provider", "openai", "hi"])).toEqual(["hi"]);
    expect(stripRoutingFlags(["--resume", "id123", "go"])).toEqual(["go"]);
  });

  it("strips consumed headless I/O format flags so they do not leak into prompt text", () => {
    expect(
      stripRoutingFlags([
        "--output-format",
        "stream-json",
        "--input-format=stream-json",
        "hello",
      ]),
    ).toEqual(["hello"]);
    expect(
      stripRoutingFlags([
        "--output-format=json",
        "--input-format",
        "stream-json",
        "hello",
      ]),
    ).toEqual(["hello"]);
  });

  it("errors when a headless I/O format flag is missing its value", () => {
    const plan = classifyCLI({
      argv: [NODE, SCRIPT, "-p", "--output-format"],
      isTTY: true,
      isStdoutTTY: true,
    });
    expect(plan).toEqual({
      kind: "errorAndExit",
      message:
        "agenc --output-format requires a value (usage: agenc -p --output-format <text|json|stream-json>)",
      exitCode: 2,
    });

    const inputPlan = classifyCLI({
      argv: [NODE, SCRIPT, "-p", "--input-format"],
      isTTY: true,
      isStdoutTTY: true,
    });
    expect(inputPlan).toEqual({
      kind: "errorAndExit",
      message:
        "agenc --input-format requires a value (usage: agenc -p --input-format <stream-json>)",
      exitCode: 2,
    });
  });
});
