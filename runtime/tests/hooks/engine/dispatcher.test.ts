import { describe, expect, test } from "vitest";

import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HookEngine,
  matchesPattern,
} from "./dispatcher.js";
import { readHookSpecificOutput } from "./output-parser.js";
import type { HooksMap } from "../../config/schema.js";
import { explicitDangerBroker } from "../../helpers/explicit-danger-boundary.js";

function makeEngine(config: HooksMap): HookEngine {
  const engine = new HookEngine({
    cwd: process.cwd(),
    env: process.env,
    shellPath: process.env.SHELL ?? "/bin/sh",
    sourcePath: "/tmp/agenc-hooks-test/config.toml",
    sandboxExecutionBroker: explicitDangerBroker,
  });
  engine.load(config);
  return engine;
}

describe("HookEngine dispatcher", () => {
  test("uses donor default command-hook timeout", () => {
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(600_000);
  });

  test("matches exact, pipe, wildcard, and regex patterns", () => {
    expect(matchesPattern("Read", "Read")).toBe(true);
    expect(matchesPattern("Read", "Grep|Read")).toBe(true);
    expect(matchesPattern("Read", "*")).toBe(true);
    expect(matchesPattern("Read", "^Re")).toBe(true);
    expect(matchesPattern("Read", "Write")).toBe(false);
    expect(matchesPattern("aaaaaaaaaaaaaaaa!", "(a+)+$")).toBe(false);
  });

  test("selects each handler once when several matcher aliases match", () => {
    const engine = makeEngine({
      PreToolUse: [
        {
          matcher: "^apply_patch$",
          hooks: [{ type: "command", command: "printf apply" }],
        },
        {
          matcher: "^Write$",
          hooks: [{ type: "command", command: "printf write" }],
        },
        {
          matcher: "^Edit$",
          hooks: [{ type: "command", command: "printf edit" }],
        },
        {
          matcher: "apply_patch|Write|Edit",
          hooks: [{ type: "command", command: "printf combined" }],
        },
      ],
    });

    const selected = engine.selectHandlersForMatcherInputs("PreToolUse", [
      "apply_patch",
      "Write",
      "Edit",
    ]);

    expect(selected.map((hook) => hook.command.command)).toEqual([
      "printf apply",
      "printf write",
      "printf edit",
      "printf combined",
    ]);
  });

  test("selects UserPromptSubmit and Stop handlers without applying matchers", () => {
    const engine = makeEngine({
      UserPromptSubmit: [
        {
          matcher: "ship",
          hooks: [{ type: "command", command: "printf prompt" }],
        },
      ],
      Stop: [
        {
          matcher: "never",
          hooks: [{ type: "command", command: "printf stop" }],
        },
      ],
    });

    expect(
      engine.selectHandlersForMatcherInputs("UserPromptSubmit", ["skip"]),
    ).toHaveLength(1);
    expect(engine.selectHandlersForMatcherInputs("Stop", ["skip"])).toHaveLength(1);
  });

  test("selects SessionStart handlers by source matcher", () => {
    const engine = makeEngine({
      SessionStart: [
        {
          matcher: "resume",
          hooks: [{ type: "command", command: "printf resume" }],
        },
        {
          matcher: "startup",
          hooks: [{ type: "command", command: "printf startup" }],
        },
      ],
    });

    const selected = engine.selectHandlers("SessionStart", "startup");

    expect(selected.map((hook) => hook.command.command)).toEqual([
      "printf startup",
    ]);
  });

  test("dispatches matching command hooks with JSON stdin", async () => {
    const engine = makeEngine({
      PermissionRequest: [
        {
          matcher: "Read",
          hooks: [
            {
              type: "command",
              command:
                "node -e \"let s=''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => process.stdout.write(JSON.parse(s).tool_name));\"",
            },
          ],
        },
        {
          matcher: "Write",
          hooks: [{ type: "command", command: "printf wrong" }],
        },
      ],
    });

    const runs = await engine.dispatch(
      "PermissionRequest",
      ["Read"],
      { hook_event_name: "PermissionRequest", tool_name: "Read" },
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]?.run.status).toBe("success");
    expect(runs[0]?.run.stdout).toBe("Read");
  });

  test("records blocking, timeout, and disabled command diagnostics", async () => {
    const engine = makeEngine({
      PreToolUse: [
        {
          hooks: [
            { type: "command", command: "printf blocked >&2; exit 2" },
            {
              type: "command",
              command: "node -e \"setTimeout(() => {}, 1000)\"",
              timeout_ms: 20,
            },
          ],
        },
      ],
    });
    const [blocking, timeout] = engine.listHooks();

    const blocked = await engine.runCommandHook(blocking!, {});
    expect(blocked.status).toBe("blocking");
    expect(blocked.stderr).toBe("blocked");

    const timedOut = await engine.runCommandHook(timeout!, {});
    expect(timedOut.status).toBe("timeout");
    expect(timedOut.error).toContain("hook timed out");

    engine.setDisabled(true);
    const skipped = await engine.runCommandHook(blocking!, {});
    expect(skipped.status).toBe("skipped");
    expect(engine.latestDiagnostics()[0]?.status).toBe("skipped");
  });

  test("does not spawn hooks when the signal is already aborted", async () => {
    const engine = makeEngine({
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: "printf should-not-run" }],
        },
      ],
    });
    const controller = new AbortController();
    controller.abort("done");

    const result = await engine.runCommandHook(
      engine.listHooks()[0]!,
      {},
      controller.signal,
    );

    expect(result.status).toBe("skipped");
    expect(result.stdout).toBe("");
    expect(result.error).toBe("hook aborted");
  });

  test("escalates timed-out hooks that ignore SIGTERM", async () => {
    const engine = makeEngine({
      PreToolUse: [
        {
          hooks: [
            {
              type: "command",
              command:
                "node -e \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"",
              timeout_ms: 20,
            },
          ],
        },
      ],
    });

    const timedOut = await engine.runCommandHook(engine.listHooks()[0]!, {});

    expect(timedOut.status).toBe("timeout");
    expect(timedOut.error).toContain("hook timed out");
  });
});

describe("hook output parser", () => {
  test("normalizes nested hookSpecificOutput fields", () => {
    const parsed = readHookSpecificOutput(
      JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "blocked by policy",
          updatedInput: { path: "safe.txt" },
          additionalContext: "lint passed",
        },
      }),
    );

    expect(parsed.invalid).toBeUndefined();
    expect(parsed.output?.permissionDecision).toBe("deny");
    expect(parsed.output?.permissionDecisionReason).toBe("blocked by policy");
    expect(parsed.output?.updatedInput).toEqual({ path: "safe.txt" });
    expect(parsed.output?.additionalContext).toBe("lint passed");
  });

  test("reports malformed structured output without throwing", () => {
    expect(readHookSpecificOutput("{not-json").invalid).toContain(
      "could not be parsed",
    );
    expect(readHookSpecificOutput("[]").invalid).toBe(
      "hook output JSON must be an object",
    );
    expect(
      readHookSpecificOutput(JSON.stringify({ hookSpecificOutput: [] })).invalid,
    ).toBe("hookSpecificOutput must be an object");
    expect(
      readHookSpecificOutput(
        JSON.stringify({ hookSpecificOutput: { permissionDecision: "block" } }),
      ).invalid,
    ).toBe("permissionDecision must be allow, deny, or ask");
  });

  test("merges universal fields with nested hookSpecificOutput", () => {
    const parsed = readHookSpecificOutput(
      JSON.stringify({
        continue: false,
        stopReason: "halt",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "details",
        },
      }),
    );

    expect(parsed.output?.continueProcessing).toBe(false);
    expect(parsed.output?.stopReason).toBe("halt");
    expect(parsed.output?.additionalContext).toBe("details");
  });

  test("validates event-specific hookSpecificOutput tag and unknown fields", () => {
    expect(
      readHookSpecificOutput(
        JSON.stringify({
          hookSpecificOutput: {
            decision: { behavior: "allow" },
          },
        }),
        "PermissionRequest",
      ).invalid,
    ).toContain("hookSpecificOutput.hookEventName must be PermissionRequest");

    expect(
      readHookSpecificOutput(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            decision: { behavior: "allow" },
          },
        }),
        "PermissionRequest",
      ).invalid,
    ).toContain("hookSpecificOutput.hookEventName must be PermissionRequest");

    expect(
      readHookSpecificOutput(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow" },
            extra: true,
          },
        }),
        "PermissionRequest",
      ).invalid,
    ).toContain("hookSpecificOutput returned unsupported field extra");
  });
});
