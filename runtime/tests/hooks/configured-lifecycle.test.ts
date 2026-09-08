import { getEventListeners } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ConfiguredHooksRuntime, hookDisplayText, type HookInstallTarget } from "../../src/hooks/configured-hooks.js";
import { createHookExecutionAuthority } from "../../src/hooks/execution-authority.js";
import { HookEngine } from "../../src/hooks/engine/dispatcher.js";
import type { HookInput, HookResult } from "../../src/llm/hooks/types.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";

const SECRET = "sk-proj-abcdefghijklmnopqrstuvwxyz123456-";
const commonInput = {
  session_id: "session-1",
  transcript_path: "",
  cwd: process.cwd(),
  permission_mode: "default",
};
const events = [
  {
    register: "addPreCompactHook",
    input: { ...commonInput, hook_event_name: "PreCompact", trigger: "manual", custom_instructions: null },
    matcher: "manual",
  },
  {
    register: "addPostCompactHook",
    input: { ...commonInput, hook_event_name: "PostCompact", trigger: "manual", compact_summary: "" },
    matcher: "manual",
  },
  {
    register: "addSessionStartHook",
    input: { hook_event_name: "SessionStart", source: "startup" },
    matcher: "startup",
  },
  {
    register: "addSubagentStopHook",
    input: { hook_event_name: "SubagentStop", agent_id: "agent-1", task_name: "task", agent_type: "reviewer", outcome: "completed", final_message: "" },
    matcher: "reviewer",
  },
  {
    register: "addSessionEndHook",
    input: { hook_event_name: "SessionEnd", reason: "exit" },
    matcher: "exit",
  },
  {
    register: "addNotificationHook",
    input: { hook_event_name: "Notification", notification_type: "permission_request", message: "approve" },
    matcher: "permission_request",
  },
] as const satisfies readonly {
  readonly register: keyof HookInstallTarget;
  readonly input: HookInput;
  readonly matcher: string;
}[];

type LifecycleCallback = (input: HookInput, signal?: AbortSignal) => Promise<HookResult>;

function configuredLifecycle(
  event: (typeof events)[number],
  options: {
    readonly command?: string;
    readonly matcher?: string;
    readonly simpleMode?: boolean;
    readonly trusted?: boolean;
  } = {},
) {
  const runtime = new ConfiguredHooksRuntime({
    cwd: process.cwd(),
    env: process.env,
    agencHome: "/tmp/agenc-lifecycle-tests",
    shellPath: process.env.SHELL ?? "/bin/sh",
    admissionRequired: false,
    executionAuthority: createHookExecutionAuthority({
      runtimeOptions: { simpleMode: options.simpleMode ?? false, allowUntrustedHooks: false },
      isWorkspaceTrusted: () => options.trusted ?? true,
    }),
    runtimeOptions: { simpleMode: options.simpleMode ?? false },
    sandboxExecutionBroker: new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: process.cwd(),
    }),
  });
  let callback: LifecycleCallback | undefined;
  runtime.attachTarget({
    preToolUseHooks: [],
    postToolUseHooks: [],
    failureToolUseHooks: [],
    permissionDecisionHooks: [],
    userPromptSubmitHooks: [],
    stopHooks: [],
    stopFailureHooks: [],
    [event.register]: (hook: LifecycleCallback) => {
      callback = hook;
      return () => {};
    },
  });
  runtime.loadForTesting({
    [event.input.hook_event_name]: [{
      matcher: options.matcher ?? event.matcher,
      hooks: [{
        type: "command",
        command: options.command ?? `printf '%s' '${SECRET}'`,
        statusMessage: `lifecycle ${SECRET}`,
      }],
    }],
  });
  expect(callback).toBeDefined();
  return {
    runtime,
    invoke: (signal?: AbortSignal) => callback!(event.input, signal),
    label: hookDisplayText(runtime.listHooks()[0]!),
  };
}

function jsonCommand(output: unknown): string {
  return `printf '%s' '${JSON.stringify(output).replace(/'/gu, `'\\''`)}'`;
}

describe.each(events)("configured lifecycle $input.hook_event_name", (event) => {
  const sessionStart = event.input.hook_event_name === "SessionStart";

  it.each(["disabled", "bare", "mismatch"] as const)("uses the redacted display label when %s", async (mode) => {
    const fixture = configuredLifecycle(event, {
      simpleMode: mode === "bare",
      ...(mode === "mismatch" ? { matcher: "does-not-match" } : {}),
    });
    if (mode === "disabled") fixture.runtime.setDisabled(true);
    const result = await fixture.invoke();
    expect(result).toEqual({ succeeded: true, output: "", command: fixture.label });
    expect(result.command).not.toContain(SECRET);
    expect(fixture.runtime.latestDiagnostics()).toHaveLength(0);
  });

  it("converts successful text with redaction", async () => {
    const fixture = configuredLifecycle(event);
    const result = await fixture.invoke();
    expect(result.succeeded).toBe(true);
    expect(result.command).toBe(fixture.label);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    if (sessionStart) {
      expect(result.output).toBe("");
      expect(result.additionalContexts).toEqual(["[REDACTED_SECRET]"]);
    } else {
      expect(result.output).toBe("[REDACTED_SECRET]");
      expect(result.additionalContexts).toBeUndefined();
    }
    expect(fixture.runtime.latestDiagnostics()[0]?.status).toBe("success");
  });

  it("suppresses output without losing structured additional context", async () => {
    const fixture = configuredLifecycle(event, {
      command: jsonCommand({
        suppressOutput: true,
        hookSpecificOutput: { hookEventName: event.input.hook_event_name, additionalContext: SECRET },
      }),
    });
    const result = await fixture.invoke();
    expect(result).toEqual({
      succeeded: true,
      output: "",
      command: fixture.label,
      additionalContexts: ["[REDACTED_SECRET]"],
    });
  });

  it("preserves stop-processing and context conversion", async () => {
    const fixture = configuredLifecycle(event, {
      command: jsonCommand({
        continue: false,
        stopReason: "pause",
        hookSpecificOutput: { hookEventName: event.input.hook_event_name, additionalContext: SECRET },
      }),
    });
    const result = await fixture.invoke();
    expect(result.succeeded).toBe(false);
    expect(result.additionalContexts).toEqual(["[REDACTED_SECRET]"]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    if (sessionStart) {
      expect(result.output).toBe("pause");
      expect(result.message).toMatchObject({ type: "hook_stopped_continuation", message: "pause" });
    } else {
      expect(result.message).toBeUndefined();
      expect(result.output).toContain('"continue":false');
    }
  });

  it.each([1, 2])("reports exit code %i with stderr first", async (exitCode) => {
    const fixture = configuredLifecycle(event, {
      command: `printf ignored; printf '%s' '${SECRET}' >&2; exit ${exitCode}`,
    });
    const result = await fixture.invoke();
    expect(result).toEqual({
      succeeded: false,
      output: "[REDACTED_SECRET]",
      command: fixture.label,
    });
    expect(fixture.runtime.latestDiagnostics()[0]?.status).toBe(exitCode === 2 ? "blocking" : "non_blocking_error");
  });

  it("preserves cancellation without executing the command", async () => {
    const fixture = configuredLifecycle(event);
    const controller = new AbortController();
    controller.abort();
    const result = await fixture.invoke(controller.signal);
    expect(result).toEqual({ succeeded: false, output: "", command: fixture.label });
    expect(fixture.runtime.latestDiagnostics()[0]).toMatchObject({
      status: "skipped",
      error: "hook aborted",
    });
  });

  it("does not execute commands without workspace trust", async () => {
    const fixture = configuredLifecycle(event, { trusted: false });
    expect(await fixture.invoke()).toEqual({
      succeeded: false,
      output: "",
      command: fixture.label,
    });
    expect(fixture.runtime.latestDiagnostics()).toHaveLength(0);
  });

  it("cancels a running command without retaining abort listeners", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenc-lifecycle-cancel-"));
    const marker = join(directory, "started");
    const fixture = configuredLifecycle(event, {
      command: `printf started > ${JSON.stringify(marker)}; sleep 10`,
    });
    const controller = new AbortController();
    const pending = fixture.invoke(controller.signal);
    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      controller.abort();
      expect((await pending).succeeded).toBe(false);
      expect(fixture.runtime.latestDiagnostics()[0]).toMatchObject({
        status: "skipped",
        error: "hook aborted",
      });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      controller.abort();
      try {
        await pending;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("propagates engine failures to the lifecycle dispatcher", async () => {
    const fixture = configuredLifecycle(event);
    const error = new Error("hook execution failed");
    const run = vi.spyOn(HookEngine.prototype, "runCommandHook").mockRejectedValueOnce(error);
    try {
      await expect(fixture.invoke()).rejects.toBe(error);
    } finally {
      run.mockRestore();
    }
  });
});
