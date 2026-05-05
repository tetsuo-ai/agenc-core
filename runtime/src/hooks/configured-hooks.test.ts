import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
      userPromptSubmitHooks: [],
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
      userPromptSubmitHooks: [],
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
                "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'api_key=opaque-value-12345'}}))\"",
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

  test("rejects permission hook updated input while redacting diagnostics", async () => {
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
      userPromptSubmitHooks: [],
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
                "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow',updatedInput:{token:'opaque-value-12345'}}}}))\"",
            },
          ],
        },
      ],
    });

    const decision = await target.permissionDecisionHooks[0]!({
      toolName: "Read",
      args: {},
    });

    expect(decision).toEqual({ kind: "pass" });
    const diagnostic = runtime.latestDiagnostics()[0]!;
    expect(diagnostic.error).toContain(
      "PermissionRequest hook returned unsupported updatedInput",
    );
    expect(diagnostic.stdout).not.toContain("opaque-value-12345");
    expect(diagnostic.stdout).toContain("[REDACTED_SECRET]");
  });

  test("permission hook denies with sanitized reason", async () => {
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
      userPromptSubmitHooks: [],
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
                "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'deny',message:'api_key=opaque-value-12345'}}}))\"",
            },
          ],
        },
      ],
    });

    const decision = await target.permissionDecisionHooks[0]!({
      toolName: "Write",
      args: {},
    });

    expect(decision).toEqual({
      kind: "deny",
      reason: "api_key=[REDACTED_SECRET]",
    });
  });

  test("permission hook exit code 2 denies with stderr reason", async () => {
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
      userPromptSubmitHooks: [],
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
              command: "printf 'deny from stderr' >&2; exit 2",
            },
          ],
        },
      ],
    });

    const decision = await target.permissionDecisionHooks[0]!({
      toolName: "Write",
      args: {},
    });

    expect(decision).toEqual({
      kind: "deny",
      reason: "deny from stderr",
    });
  });

  test("permission hook records missing exit-code-2 denial reason", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      PermissionRequest: [
        {
          hooks: [{ type: "command", command: "exit 2" }],
        },
      ],
    });

    const decision = await target.permissionDecisionHooks[0]!({
      toolName: "Write",
      args: {},
    });

    expect(decision).toEqual({ kind: "pass" });
    expect(runtime.latestDiagnostics()[0]?.error).toContain(
      "did not write a denial reason to stderr",
    );
  });

  test("permission hook exit code 2 ignores stdout-only denial text", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      PermissionRequest: [
        {
          hooks: [{ type: "command", command: "printf stdout-only; exit 2" }],
        },
      ],
    });

    const decision = await target.permissionDecisionHooks[0]!({
      toolName: "Write",
      args: {},
    });

    expect(decision).toEqual({ kind: "pass" });
    expect(runtime.latestDiagnostics()[0]?.error).toContain(
      "did not write a denial reason to stderr",
    );
  });

  test("permission hook deny wins over earlier allow", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      PermissionRequest: [
        {
          matcher: "Write",
          hooks: [
            {
              type: "command",
              command:
                "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow'}}}))\"",
            },
            {
              type: "command",
              command:
                "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'deny',message:'later deny'}}}))\"",
            },
          ],
        },
      ],
    });

    const decision = await target.permissionDecisionHooks[0]!({
      toolName: "Write",
      args: {},
    });

    expect(decision).toEqual({ kind: "deny", reason: "later deny" });
    expect(runtime.latestDiagnostics()).toHaveLength(2);
  });

  test("permission hook matcher aliases select handlers through runtime wiring", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      PermissionRequest: [
        {
          matcher: "Edit",
          hooks: [
            {
              type: "command",
              command:
                "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'deny',message:'alias denied'}}}))\"",
            },
          ],
        },
      ],
    });

    const decision = await target.permissionDecisionHooks[0]!({
      toolName: "apply_patch",
      matcherAliases: ["Edit"],
      args: {},
    });

    expect(decision).toEqual({ kind: "deny", reason: "alias denied" });
  });

  test("permission hook stdin includes approval context fields", async () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: "/tmp",
      env: process.env,
      agencHome: "/tmp/agenc-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    const target: HookInstallTarget = {
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      userPromptSubmitHooks: [],
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
                "node -e 'let s=\"\"; process.stdin.on(\"data\", c => s += c); process.stdin.on(\"end\", () => { const x = JSON.parse(s); if (x.session_id === \"sess-1\" && x.turn_id === \"turn-1\" && x.cwd === \"/tmp\" && x.transcript_path === \"/tmp/transcript.jsonl\" && x.model === \"model-a\" && x.permission_mode === \"plan\") { console.error(\"context checked\"); process.exit(2); } })'",
            },
          ],
        },
      ],
    });

    const decision = await target.permissionDecisionHooks[0]!({
      toolName: "Write",
      args: {},
      sessionId: "sess-1",
      turnId: "turn-1",
      cwd: "/tmp",
      transcriptPath: "/tmp/transcript.jsonl",
      model: "model-a",
      permissionMode: "plan",
    });

    expect(decision).toEqual({ kind: "deny", reason: "context checked" });
  });

  test("permission hook records unsupported structured output and passes", async () => {
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
      userPromptSubmitHooks: [],
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
                "node -e \"console.log(JSON.stringify({continue:false,hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'deny',message:'blocked'}}}))\"",
            },
          ],
        },
      ],
    });

    const decision = await target.permissionDecisionHooks[0]!({
      toolName: "Write",
      args: {},
    });

    expect(decision).toEqual({ kind: "pass" });
    expect(runtime.latestDiagnostics()[0]?.error).toContain(
      "PermissionRequest hook returned unsupported continue:false",
    );
  });

  test("permission hook ignores deny with invalid hookSpecificOutput tag", async () => {
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
      userPromptSubmitHooks: [],
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
                "node -e \"console.log(JSON.stringify({hookSpecificOutput:{decision:{behavior:'deny',message:'must ignore'}}}))\"",
            },
          ],
        },
      ],
    });

    const decision = await target.permissionDecisionHooks[0]!({
      toolName: "Write",
      args: {},
    });

    expect(decision).toEqual({ kind: "pass" });
    expect(runtime.latestDiagnostics()[0]?.error).toContain(
      "hookSpecificOutput.hookEventName must be PermissionRequest",
    );
  });

  test("permission hook rejects root-level decisions", async () => {
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
      userPromptSubmitHooks: [],
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
                "node -e \"console.log(JSON.stringify({decision:{behavior:'deny',message:'root deny'}}))\"",
            },
          ],
        },
      ],
    });

    const decision = await target.permissionDecisionHooks[0]!({
      toolName: "Write",
      args: {},
    });

    expect(decision).toEqual({ kind: "pass" });
    expect(runtime.latestDiagnostics()[0]?.error).toContain(
      "PermissionRequest hook returned unsupported root decision",
    );
  });

  test("permission hook records JSON array output as invalid structured output", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      PermissionRequest: [
        {
          hooks: [{ type: "command", command: "printf '[]'" }],
        },
      ],
    });

    const decision = await target.permissionDecisionHooks[0]!({
      toolName: "Write",
      args: {},
    });

    expect(decision).toEqual({ kind: "pass" });
    expect(runtime.latestDiagnostics()[0]?.error).toContain(
      "hook output JSON must be an object",
    );
  });

  test("wires UserPromptSubmit hooks with prompt and permission mode input", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command:
                "node -e \"let s=''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => { const x = JSON.parse(s); console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'mode=' + x.permission_mode + ' prompt=' + x.prompt}})); })\"",
            },
          ],
        },
      ],
    });

    expect(target.userPromptSubmitHooks).toHaveLength(1);
    const decision = await target.userPromptSubmitHooks[0]!({
      prompt: "ship PE-06",
      permissionMode: "plan",
      cwd: process.cwd(),
    });

    expect(decision?.additionalContexts).toEqual([
      "mode=plan prompt=ship PE-06",
    ]);
  });

  test("runs UserPromptSubmit hooks regardless of matcher", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      UserPromptSubmit: [
        {
          matcher: "ship",
          hooks: [{ type: "command", command: "printf matcher-ignored" }],
        },
      ],
    });

    const decision = await target.userPromptSubmitHooks[0]!({
      prompt: "skip this",
      permissionMode: "default",
      cwd: process.cwd(),
    });

    expect(decision?.additionalContexts).toEqual(["matcher-ignored"]);
    expect(runtime.latestDiagnostics()).toHaveLength(1);
  });

  test("ignores malformed UserPromptSubmit hook output", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: "printf '{not-json'" }],
        },
      ],
    });

    const decision = await target.userPromptSubmitHooks[0]!({
      prompt: "ship PE-06",
      permissionMode: "default",
      cwd: process.cwd(),
    });

    expect(decision).toBeUndefined();
    expect(runtime.latestDiagnostics()[0]?.error).toContain(
      "could not be parsed",
    );
  });

  test("ignores invalid UserPromptSubmit hookSpecificOutput shape", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command:
                "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:{bad:true}}}))\"",
            },
          ],
        },
      ],
    });

    const decision = await target.userPromptSubmitHooks[0]!({
      prompt: "ship PE-06",
      permissionMode: "default",
      cwd: process.cwd(),
    });

    expect(decision).toBeUndefined();
    expect(runtime.latestDiagnostics()[0]?.error).toContain(
      "additionalContext must be a string",
    );
  });

  test("treats UserPromptSubmit exit code 1 as non-blocking", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: "printf no-op; exit 1" }],
        },
      ],
    });

    const decision = await target.userPromptSubmitHooks[0]!({
      prompt: "ship PE-06",
      permissionMode: "default",
      cwd: process.cwd(),
    });

    expect(decision).toBeUndefined();
    expect(runtime.latestDiagnostics()[0]?.status).toBe("non_blocking_error");
  });

  test("records malformed PostToolUse structured output", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      PostToolUse: [
        {
          hooks: [{ type: "command", command: "printf '{not-json'" }],
        },
      ],
    });

    const decision = await target.postToolUseHooks[0]!({
      invocation: { callId: "c-post" } as never,
      tool: { name: "Read" } as never,
      args: {},
      result: "ok",
    });

    expect(decision).toEqual({ kind: "continue" });
    expect(runtime.latestDiagnostics()[0]?.error).toContain(
      "could not be parsed",
    );
  });

  test("records invalid PostToolUse hookSpecificOutput shape", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      PostToolUse: [
        {
          hooks: [
            {
              type: "command",
              command:
                "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:{bad:true}}}))\"",
            },
          ],
        },
      ],
    });

    const decision = await target.postToolUseHooks[0]!({
      invocation: { callId: "c-post" } as never,
      tool: { name: "Read" } as never,
      args: {},
      result: "ok",
    });

    expect(decision).toEqual({ kind: "continue" });
    expect(runtime.latestDiagnostics()[0]?.error).toContain(
      "additionalContext must be a string",
    );
  });

  test("ignores PostToolUse additionalContext when structured output has unsupported fields", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      PostToolUse: [
        {
          hooks: [
            {
              type: "command",
              command:
                "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'ignore me',extra:true}}))\"",
            },
          ],
        },
      ],
    });

    const decision = await target.postToolUseHooks[0]!({
      invocation: { callId: "c-post" } as never,
      tool: { name: "Read" } as never,
      args: {},
      result: "ok",
    });

    expect(decision).toEqual({ kind: "continue" });
    expect(runtime.latestDiagnostics()[0]?.error).toContain(
      "hookSpecificOutput returned unsupported field extra",
    );
  });

  test("ignores invalid PreToolUse permissionDecision output", async () => {
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
      userPromptSubmitHooks: [],
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
                "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'block',updatedInput:{redacted:true}}}))\"",
            },
          ],
        },
      ],
    });

    const decision = await target.preToolUseHooks[0]!({
      invocation: { callId: "c-pre" } as never,
      tool: { name: "Write" } as never,
      args: { original: true },
    });

    if (decision.kind !== "continue") {
      throw new Error(`unexpected PreToolUse decision: ${decision.kind}`);
    }
    expect(decision.args).toBeUndefined();
    expect(decision.hookPermissionResult).toBeUndefined();
    expect(runtime.latestDiagnostics()[0]?.error).toContain(
      "permissionDecision must be allow, deny, or ask",
    );
  });

  test("PreToolUse stdin includes invocation context fields", async () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: "/tmp",
      env: process.env,
      agencHome: "/tmp/agenc-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    const target: HookInstallTarget = {
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      userPromptSubmitHooks: [],
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
                "node -e 'let s=\"\"; process.stdin.on(\"data\", c => s += c); process.stdin.on(\"end\", () => { const x = JSON.parse(s); process.stdout.write([x.session_id,x.turn_id,x.cwd,x.transcript_path,x.model,x.permission_mode].join(\"|\")); })'",
            },
          ],
        },
      ],
    });

    await target.preToolUseHooks[0]!({
      invocation: {
        callId: "call-1",
        session: { conversationId: "sess-1", transcriptPath: "/tmp/t.jsonl" },
        turn: {
          subId: "turn-1",
          cwd: "/tmp",
          modelInfo: { slug: "model-a" },
          permissionMode: "plan",
        },
      } as never,
      tool: { name: "Read" } as never,
      args: {},
    });

    expect(runtime.latestDiagnostics()[0]?.stdout).toBe(
      "sess-1|turn-1|/tmp|/tmp/t.jsonl|model-a|plan",
    );
  });

  test("command hook subprocess uses per-request cwd", async () => {
    const requestCwd = await mkdtemp(join(tmpdir(), "agenc-hook-cwd-"));
    const runtime = new ConfiguredHooksRuntime({
      cwd: tmpdir(),
      env: process.env,
      agencHome: "/tmp/agenc-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    const target: HookInstallTarget = {
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      userPromptSubmitHooks: [],
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
              command: "node -e \"process.stdout.write(process.cwd())\"",
            },
          ],
        },
      ],
    });

    await target.preToolUseHooks[0]!({
      invocation: {
        callId: "call-1",
        session: {},
        turn: { cwd: requestCwd },
      } as never,
      tool: { name: "Read" } as never,
      args: {},
    });

    expect(runtime.latestDiagnostics()[0]?.stdout).toBe(requestCwd);
  });

  test("runs Stop hooks regardless of matcher", async () => {
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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      Stop: [
        {
          matcher: "never-matches",
          hooks: [{ type: "command", command: "printf stop-blocked; exit 2" }],
        },
      ],
    });

    const outcome = await target.stopHooks[0]!.run({
      sessionId: "sess-1",
      turnId: "turn-1",
      cwd: process.cwd(),
      model: "test-model",
      permissionMode: "default",
      stopHookActive: false,
      lastAssistantMessage: "",
    });

    expect(outcome.shouldBlock).toBe(true);
    expect(outcome.blockReason).toBe("stop-blocked");
    expect(runtime.latestDiagnostics()).toHaveLength(1);
  });

  test("uses permission_mode in default UserPromptSubmit test input", async () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    runtime.load({
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command:
                "node -e \"let s=''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => { const x = JSON.parse(s); process.stdout.write(String(x.permission_mode)); })\"",
            },
          ],
        },
      ],
    });

    const diag = await runtime.testHook(runtime.listHooks()[0]!);

    expect(diag.stdout).toBe("default");
  });

  test("removes abort listeners after successful command hooks", async () => {
    class CountingSignal extends EventTarget {
      aborted = false;
      reason: unknown;
      listenerCount = 0;

      override addEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ): void {
        if (type === "abort" && callback !== null) this.listenerCount += 1;
        super.addEventListener(type, callback, options);
      }

      override removeEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ): void {
        if (type === "abort" && callback !== null) this.listenerCount -= 1;
        super.removeEventListener(type, callback, options);
      }
    }

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
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: "printf hook-ok" }],
        },
      ],
    });
    const signal = new CountingSignal();

    await target.userPromptSubmitHooks[0]!({
      prompt: "ship PE-06",
      permissionMode: "default",
      cwd: process.cwd(),
      signal: signal as AbortSignal,
    });

    expect(signal.listenerCount).toBe(0);
  });
});
