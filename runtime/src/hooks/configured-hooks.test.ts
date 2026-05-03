import { describe, expect, test } from "vitest";

import {
  ConfiguredHooksRuntime,
  matchesPattern,
  type HookInstallTarget,
} from "./configured-hooks.js";

describe("configured hooks runtime", () => {
  test("matches exact, pipe, wildcard, and regex patterns", () => {
    expect(matchesPattern("Read", "Read")).toBe(true);
    expect(matchesPattern("Read", "Grep|Read")).toBe(true);
    expect(matchesPattern("Read", "*")).toBe(true);
    expect(matchesPattern("Read", "^Re")).toBe(true);
    expect(matchesPattern("Read", "Write")).toBe(false);
  });

  test("loads config hooks into live tool hook arrays", async () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    const target = {
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      PreToolUse: [
        {
          matcher: "Read",
          hooks: [{ type: "command", command: "printf ok" }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: "printf done" }],
        },
      ],
    });

    expect(target.preToolUseHooks).toHaveLength(1);
    expect(target.stopHooks).toHaveLength(1);
    const hook = runtime.listHooks()[0]!;
    const diag = await runtime.testHook(hook);
    expect(diag.status).toBe("success");
    expect(diag.stdout).toBe("ok");
  });

  test("records blocking diagnostics for exit code 2", async () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    runtime.load({
      PreToolUse: [
        {
          hooks: [{ type: "command", command: "printf blocked >&2; exit 2" }],
        },
      ],
    });
    const diag = await runtime.testHook(runtime.listHooks()[0]!);
    expect(diag.status).toBe("blocking");
    expect(diag.stderr).toBe("blocked");
  });

  test("preserves hook stdin while redacting command diagnostics", async () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    runtime.load({
      PreToolUse: [
        {
          hooks: [
            {
              type: "command",
              command:
                "node -e \"let s=''; process.stdin.on('data', c => s += c); " +
                "process.stdin.on('end', () => process.stdout.write(s.includes('opaque-value-12345') ? 'saw-secret' : 'missing-secret'))\"",
            },
          ],
        },
      ],
    });
    const stdinDiag = await runtime.testHook(runtime.listHooks()[0]!, {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { apiKey: "opaque-value-12345" },
      tool_use_id: "secret-call",
    });

    expect(stdinDiag.stdout).toBe("saw-secret");

    runtime.load({
      PreToolUse: [
        {
          hooks: [
            {
              type: "command",
              command:
                "printf 'sk-proj-abcdefghijklmnopqrstuvwxyz123456-'; " +
                "printf 'Authorization: Bearer abcdefghijklmnop=' >&2; exit 2",
            },
          ],
        },
      ],
    });
    const outputDiag = await runtime.testHook(runtime.listHooks()[0]!);
    expect(outputDiag.status).toBe("blocking");
    expect(outputDiag.stdout).not.toContain(
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456-",
    );
    expect(outputDiag.stderr).not.toContain("abcdefghijklmnop=");
    expect(outputDiag.stdout).toContain("[REDACTED_SECRET]");
    expect(outputDiag.stderr).toContain("Bearer [REDACTED_SECRET]");
  });

  test("redacts hook-returned user and model facing strings", async () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    const target: HookInstallTarget = {
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      PreToolUse: [
        {
          hooks: [
            {
              type: "command",
              command:
                "printf 'Authorization: Bearer abcdefghijklmnop=' >&2; exit 2",
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            {
              type: "command",
              command:
                "node -e \"console.log(JSON.stringify({hookSpecificOutput:{additionalContext:'api_key=opaque-value-12345'}}))\"",
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "printf 'sk-proj-abcdefghijklmnopqrstuvwxyz123456-'; exit 2",
            },
          ],
        },
      ],
    });

    const preDecision = await target.preToolUseHooks[0]!({
      invocation: { callId: "call-1", toolName: "Read" } as never,
      tool: { name: "Read" } as never,
      args: {},
    });
    expect(preDecision.kind).toBe("deny");
    expect(preDecision.kind === "deny" ? preDecision.reason : "").not.toContain(
      "abcdefghijklmnop=",
    );
    expect(preDecision.kind === "deny" ? preDecision.reason : "").toContain(
      "Bearer [REDACTED_SECRET]",
    );

    const postDecision = await target.postToolUseHooks[0]!({
      invocation: { callId: "call-1", toolName: "Read" } as never,
      tool: { name: "Read" } as never,
      args: {},
      result: "ok",
    });
    expect(postDecision.kind).toBe("additionalContext");
    expect(
      postDecision.kind === "additionalContext" ? postDecision.content[0] : "",
    ).toBe("api_key=[REDACTED_SECRET]");

    const stopOutcome = await target.stopHooks[0]!.run({
      sessionId: "sess-1",
      turnId: "turn-1",
      cwd: process.cwd(),
      model: "test-model",
      permissionMode: "default",
      stopHookActive: false,
      lastAssistantMessage: "",
    });
    expect(stopOutcome.shouldBlock).toBe(true);
    expect(stopOutcome.blockReason).not.toContain(
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456-",
    );
    expect(stopOutcome.continuationFragments.join("\n")).toContain(
      "[REDACTED_SECRET]",
    );
  });

  test("preserves permission hook updated input while redacting diagnostics", async () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    const target: HookInstallTarget = {
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      PermissionRequest: [
        {
          hooks: [
            {
              type: "command",
              command:
                "node -e \"console.log(JSON.stringify({decision:{behavior:'allow',updatedInput:{token:'opaque-value-12345'}}}))\"",
            },
          ],
        },
      ],
    });

    const decision = await target.permissionDecisionHooks[0]!({
      toolName: "Read",
      args: {},
    });

    expect(decision).toEqual({
      kind: "allow",
      updatedArgs: { token: "opaque-value-12345" },
    });
    const diagnostic = runtime.latestDiagnostics()[0]!;
    expect(diagnostic.stdout).not.toContain("opaque-value-12345");
    expect(diagnostic.stdout).toContain("[REDACTED_SECRET]");
  });
});
