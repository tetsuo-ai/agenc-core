import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import { EventLog } from "../../session/event-log.js";
import type { LLMToolCall } from "../../llm/types.js";
import { ToolRouter } from "../router.js";
import type { Tool } from "../types.js";
import { EXCLUSIVE, SHARED_READ } from "../concurrency.js";
import { createApplyPatchTool } from "../apply-patch/tool.js";
import { createExecCommandTool } from "../system/exec-command.js";
import { createFileWriteTool } from "../system/file-write.js";
import { createWriteStdinTool } from "../system/write-stdin.js";
import {
  enforceRuntimeSandboxAttempt,
  permissionProfileForSandboxMode,
} from "./sandboxing.js";
import {
  readToolRuntimeContext,
  type ToolRuntimeCallContext,
} from "./context.js";
import { createToolExecutionRuntime } from "./parallel.js";

function callContext(
  callId: string,
  classification: ToolRuntimeCallContext["classification"],
  supportsParallelToolCalls = classification.kind === "shared_read",
): ToolRuntimeCallContext {
  return {
    callId,
    toolName: "RuntimeProbe",
    runtimeKind: "function",
    classification,
    supportsParallelToolCalls,
    source: "direct",
    submittedAtMs: performance.now(),
  };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function tracker() {
  return {
    appendFileDiff: () => {},
    snapshot: () => [],
    clear: () => {},
  };
}

describe("tools/runtimes", () => {
  test("ToolExecutionRuntime schedules each call through its runtime context", async () => {
    const runtime = createToolExecutionRuntime();
    const started: string[] = [];
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    const readA = runtime.runToolCall(callContext("read-a", SHARED_READ), async () => {
      started.push("read-a");
      await readGate;
      return "read-a";
    });
    const readB = runtime.runToolCall(callContext("read-b", SHARED_READ), async () => {
      started.push("read-b");
      await readGate;
      return "read-b";
    });

    await tick();
    expect(started.sort()).toEqual(["read-a", "read-b"]);
    releaseRead();
    await expect(Promise.all([readA, readB])).resolves.toEqual([
      "read-a",
      "read-b",
    ]);

    started.length = 0;
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const write = runtime.runToolCall(callContext("write", EXCLUSIVE), async () => {
      started.push("write");
      await writeGate;
      return "write";
    });
    const readAfterWrite = runtime.runToolCall(
      callContext("read-after-write", SHARED_READ),
      async () => {
        started.push("read-after-write");
        return "read-after-write";
      },
    );

    await tick();
    expect(started).toEqual(["write"]);
    releaseWrite();
    await expect(Promise.all([write, readAfterWrite])).resolves.toEqual([
      "write",
      "read-after-write",
    ]);
    expect(started).toEqual(["write", "read-after-write"]);

    started.length = 0;
    let releaseNonParallel!: () => void;
    const nonParallelGate = new Promise<void>((resolve) => {
      releaseNonParallel = resolve;
    });
    const nonParallelA = runtime.runToolCall(
      callContext("shared-but-not-advertised-a", SHARED_READ, false),
      async () => {
        started.push("shared-but-not-advertised-a");
        await nonParallelGate;
        return "a";
      },
    );
    const nonParallelB = runtime.runToolCall(
      callContext("shared-but-not-advertised-b", SHARED_READ, false),
      async () => {
        started.push("shared-but-not-advertised-b");
        return "b";
      },
    );
    await tick();
    expect(started).toEqual(["shared-but-not-advertised-a"]);
    releaseNonParallel();
    await expect(Promise.all([nonParallelA, nonParallelB])).resolves.toEqual([
      "a",
      "b",
    ]);
    expect(started).toEqual([
      "shared-but-not-advertised-a",
      "shared-but-not-advertised-b",
    ]);
  });

  test("sandbox mode profiles map onto the sandbox engine policy model", () => {
    const readOnly = permissionProfileForSandboxMode("read_only", {
      cwd: "/repo",
    });
    expect(readOnly.fileSystem.kind).toBe("restricted");
    expect(readOnly.fileSystem.entries.every((entry) => entry.access !== "write"))
      .toBe(true);

    const workspaceWrite = permissionProfileForSandboxMode("workspace_write", {
      cwd: "/repo",
    });
    expect(workspaceWrite.fileSystem.kind).toBe("restricted");
    expect(workspaceWrite.fileSystem.entries.some((entry) => entry.access === "write"))
      .toBe(true);

    const full = permissionProfileForSandboxMode("danger_full_access", {
      cwd: "/repo",
    });
    expect(full.fileSystem.kind).toBe("unrestricted");

    const external = permissionProfileForSandboxMode("external_sandbox", {
      cwd: "/repo",
    });
    expect(external.fileSystem.kind).toBe("external_sandbox");
  });

  test("runtime sandbox enforcement denies read-only writes and outside-workspace writes", () => {
    const mutatingTool: Tool = {
      name: "Write",
      description: "",
      inputSchema: { type: "object" },
      metadata: { mutating: true },
      execute: async () => ({ content: "not reached" }),
    };
    const invocation = {
      session: {} as never,
      turn: { cwd: "/repo" } as never,
      tracker: tracker() as never,
      callId: "call-sandbox-enforce",
      toolName: { name: "Write" },
      payload: { kind: "function", arguments: "{}" },
      source: "direct",
    } as const;
    const base = callContext("call-sandbox-enforce", EXCLUSIVE, false);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: mutatingTool,
        args: { file_path: "README.md" },
      }),
    ).toThrow(/read_only blocked/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "workspace_write",
          sandboxMode: "workspace_write",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: mutatingTool,
        args: { file_path: "src/file.txt" },
      }),
    ).not.toThrow();

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "workspace_write",
          sandboxMode: "workspace_write",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: mutatingTool,
        args: { file_path: "/etc/passwd" },
      }),
    ).toThrow(/workspace_write blocked/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "workspace_write",
          sandboxMode: "workspace_write",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: mutatingTool,
        args: { destination: { path: "src/nested-file.txt" } },
      }),
    ).not.toThrow();

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "workspace_write",
          sandboxMode: "workspace_write",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: mutatingTool,
        args: { contents: "no target arg" },
      }),
    ).toThrow(/could not verify write targets/);

    const shellTool: Tool = {
      name: "exec_command",
      description: "",
      inputSchema: { type: "object" },
      metadata: { mutating: true },
      execute: async () => ({ content: "not reached" }),
    };
    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: "ls -la" },
      }),
    ).not.toThrow();

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: "echo blocked > README.md" },
      }),
    ).toThrow(/could not verify read targets|read_only blocked/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "workspace_write",
          sandboxMode: "workspace_write",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: "echo blocked > /etc/agenc-outside" },
      }),
    ).toThrow(/workspace_write blocked/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "workspace_write",
          sandboxMode: "workspace_write",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: "echo allowed > src/generated.txt" },
      }),
    ).not.toThrow();

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "workspace_write",
          sandboxMode: "workspace_write",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: "echo allowed > /tmp/agenc-runtime-ok" },
      }),
    ).toThrow(/workspace_write blocked/);

    const originalTmpdir = process.env["TMPDIR"];
    process.env["TMPDIR"] = "/tmp/agenc-runtime-tmpdir";
    try {
      expect(() =>
        enforceRuntimeSandboxAttempt({
          context: {
            ...base,
            approvalPolicy: "never",
            requestedSandboxMode: "workspace_write",
            sandboxMode: "workspace_write",
            approvalResolved: false,
            rawArgs: "{}",
            invocation,
          },
          tool: shellTool,
          args: { cmd: "echo allowed > /tmp/agenc-runtime-tmpdir/file.txt" },
        }),
      ).not.toThrow();
    } finally {
      if (originalTmpdir === undefined) {
        delete process.env["TMPDIR"];
      } else {
        process.env["TMPDIR"] = originalTmpdir;
      }
    }

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: "node -e \"require('fs').writeFileSync('/etc/agenc-outside','x')\"" },
      }),
    ).toThrow(/could not verify (read|write) targets/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "workspace_write",
          sandboxMode: "workspace_write",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: "python -c \"open('/etc/agenc-outside', 'w').write('x')\"" },
      }),
    ).toThrow(/could not verify write targets/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: "cat /etc/passwd" },
      }),
    ).toThrow(/read outside workspace/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: 'cat "/etc/passwd"' },
      }),
    ).toThrow(/read outside workspace/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: "cat $HOME/.ssh/id_rsa" },
      }),
    ).toThrow(/could not verify read targets/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: "sh -c 'cat /etc/passwd'" },
      }),
    ).toThrow(/could not verify read targets/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: "find . -exec cat /etc/passwd ;" },
      }),
    ).toThrow(/could not verify read targets/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: 'awk "BEGIN{system(\\"cat /etc/passwd\\")}"' },
      }),
    ).toThrow(/could not verify read targets/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation,
        },
        tool: shellTool,
        args: { cmd: "ls", workdir: "/etc" },
      }),
    ).toThrow(/read outside workspace/);

    const applyPatchTool: Tool = {
      name: "apply_patch",
      description: "",
      inputSchema: { type: "object" },
      metadata: { mutating: true },
      execute: async () => ({ content: "not reached" }),
    };
    const applyPatchAttempt = (sandboxMode: "read_only" | "workspace_write") => ({
      ...base,
      approvalPolicy: "never" as const,
      requestedSandboxMode: sandboxMode,
      sandboxMode,
      approvalResolved: false,
      rawArgs: "{}",
      invocation,
    });
    const insidePatch = [
      "*** Begin Patch",
      "*** Add File: generated/runtime-patch.txt",
      "+hello",
      "*** End Patch",
      "",
    ].join("\n");
    const outsidePatch = [
      "*** Begin Patch",
      "*** Add File: /etc/agenc-runtime-patch",
      "+blocked",
      "*** End Patch",
      "",
    ].join("\n");
    const moveOutsidePatch = [
      "*** Begin Patch",
      "*** Update File: generated/runtime-patch.txt",
      "*** Move to: /etc/agenc-runtime-patch",
      "@@",
      "-hello",
      "+hello",
      "*** End Patch",
      "",
    ].join("\n");

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: applyPatchAttempt("read_only"),
        tool: applyPatchTool,
        args: { input: insidePatch },
      }),
    ).toThrow(/read_only blocked/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: applyPatchAttempt("workspace_write"),
        tool: applyPatchTool,
        args: { input: insidePatch },
      }),
    ).not.toThrow();

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: applyPatchAttempt("workspace_write"),
        tool: applyPatchTool,
        args: { input: outsidePatch },
      }),
    ).toThrow(/workspace_write blocked/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: applyPatchAttempt("workspace_write"),
        tool: applyPatchTool,
        args: { input: moveOutsidePatch },
      }),
    ).toThrow(/workspace_write blocked/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: applyPatchAttempt("workspace_write"),
        tool: applyPatchTool,
        args: { input: "*** Begin Patch\n*** End Patch\n" },
      }),
    ).toThrow(/could not verify write targets/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: applyPatchAttempt("workspace_write"),
        tool: applyPatchTool,
        args: { input: "*** Begin Patch\nnot a hunk\n*** End Patch\n" },
      }),
    ).toThrow(/could not verify write targets/);
  });

  test("actual exec_command handler is preflighted by selected runtime sandbox", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-runtime-exec-"));
    const execCommand = vi.fn(async () => ({
      output: "ok\n",
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
      exit_code: 0,
      durationMs: 1,
      wall_time_seconds: 0.001,
      timedOut: false,
      truncated: false,
      original_token_count: 1,
    }));
    const writeStdin = vi.fn(async () => ({
      output: "continued\n",
      stdout: "continued\n",
      stderr: "",
      exitCode: 0,
      exit_code: 0,
      process_id: 123,
      session_id: 7,
      durationMs: 1,
      wall_time_seconds: 0.001,
      timedOut: false,
      truncated: false,
      original_token_count: 1,
    }));
    const manager = {
      maxTimeoutMs: 30_000,
      execCommand,
      writeStdin,
      closeAll: vi.fn(),
    };
    const router = new ToolRouter([
      {
        tool: createExecCommandTool({
          cwd: workspaceRoot,
          allowedPaths: [workspaceRoot],
          unifiedExecManager: manager,
        }),
        supportsParallelToolCalls: false,
      },
      {
        tool: createWriteStdinTool({
          cwd: workspaceRoot,
          allowedPaths: [workspaceRoot],
          unifiedExecManager: manager,
        }),
        supportsParallelToolCalls: false,
      },
    ]);

    const blockedRead = await router.dispatchModelToolCall(
      {
        id: "call-exec-read-outside",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "cat /etc/passwd" }),
      },
      {
        session: {
          eventLog: new EventLog(),
          services: {},
        } as never,
        turn: {
          subId: "turn-exec-read-outside",
          cwd: workspaceRoot,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "read_only" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "read_only",
      },
    );
    expect(blockedRead.isError).toBe(true);
    expect(blockedRead.content).toContain("read outside workspace");
    expect(execCommand).not.toHaveBeenCalled();

    const tmpWrite = await router.dispatchModelToolCall(
      {
          id: "call-exec-generated-write",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "echo ok > dist/agenc-runtime-ok" }),
      },
      {
        session: {
          eventLog: new EventLog(),
          services: {},
        } as never,
        turn: {
          subId: "turn-exec-generated-write",
          cwd: workspaceRoot,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "workspace_write" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
      },
    );
    expect(tmpWrite.isError).toBeFalsy();
    expect(execCommand).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeSandbox: expect.objectContaining({
          sandboxPolicyCwd: workspaceRoot,
          preference: "require",
          permissionProfile: expect.objectContaining({
            fileSystem: expect.objectContaining({ kind: "restricted" }),
          }),
        }),
      }),
    );

    const readOnlyStdin = await router.dispatchModelToolCall(
      {
        id: "call-stdin-read-only",
        name: "write_stdin",
        arguments: JSON.stringify({
          session_id: 7,
          chars: "printf should-not-run\\n",
        }),
      },
      {
        session: {
          eventLog: new EventLog(),
          services: {},
        } as never,
        turn: {
          subId: "turn-stdin-read-only",
          cwd: workspaceRoot,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "read_only" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "read_only",
      },
    );
    expect(readOnlyStdin.isError).toBe(true);
    expect(readOnlyStdin.content).toContain("write_stdin");
    expect(writeStdin).not.toHaveBeenCalled();

    const restrictedStdin = await router.dispatchModelToolCall(
      {
        id: "call-stdin-continue",
        name: "write_stdin",
        arguments: JSON.stringify({
          session_id: 7,
          chars: "printf agenc-pty\\n",
        }),
      },
      {
        session: {
          eventLog: new EventLog(),
          services: {},
        } as never,
        turn: {
          subId: "turn-stdin-continue",
          cwd: workspaceRoot,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "workspace_write" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
      },
    );
    expect(restrictedStdin.isError).toBe(true);
    expect(restrictedStdin.content).toContain("write_stdin");
    expect(writeStdin).not.toHaveBeenCalled();

    const fullAccessStdin = await router.dispatchModelToolCall(
      {
        id: "call-stdin-full-access",
        name: "write_stdin",
        arguments: JSON.stringify({
          session_id: 7,
          chars: "printf agenc-pty\\n",
        }),
      },
      {
        session: {
          eventLog: new EventLog(),
          services: {},
        } as never,
        turn: {
          subId: "turn-stdin-full-access",
          cwd: workspaceRoot,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "danger_full_access" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "danger_full_access",
      },
    );
    expect(fullAccessStdin.isError).toBeFalsy();
    expect(writeStdin).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 7,
        chars: "printf agenc-pty\\n",
      }),
    );
  });

  test("actual Write handler obeys per-attempt workspace-write preflight", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-runtime-write-"));
    const router = new ToolRouter([
      {
        tool: createFileWriteTool({ allowedPaths: [workspaceRoot] }),
        supportsParallelToolCalls: false,
      },
    ]);
    const session = {
      conversationId: "runtime-write-session",
      eventLog: new EventLog(),
      services: {},
    } as never;

    const blocked = await router.dispatchModelToolCall(
      {
        id: "call-write-outside",
        name: "Write",
        arguments: JSON.stringify({
          file_path: "/etc/agenc-runtime-denied",
          content: "blocked",
        }),
      },
      {
        session,
        turn: {
          subId: "turn-write-outside",
          cwd: workspaceRoot,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "workspace_write" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
      },
    );
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain("workspace_write blocked");

    const allowedPath = join(workspaceRoot, "created.txt");
    const allowed = await router.dispatchModelToolCall(
      {
        id: "call-write-inside",
        name: "Write",
        arguments: JSON.stringify({
          file_path: "created.txt",
          content: "created by runtime sandbox\n",
        }),
      },
      {
        session,
        turn: {
          subId: "turn-write-inside",
          cwd: workspaceRoot,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "workspace_write" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
      },
    );
    expect(allowed.isError).toBeFalsy();
    expect(existsSync(allowedPath)).toBe(true);
    expect(readFileSync(allowedPath, "utf8")).toBe("created by runtime sandbox\n");
  });

  test("actual apply_patch handler obeys per-attempt workspace-write preflight", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-runtime-patch-"));
    const router = new ToolRouter([
      {
        tool: createApplyPatchTool({
          cwd: workspaceRoot,
          allowedPaths: [workspaceRoot],
        }),
        supportsParallelToolCalls: false,
      },
    ]);
    const session = {
      conversationId: "runtime-patch-session",
      eventLog: new EventLog(),
      services: {},
    } as never;
    const insidePatch = [
      "*** Begin Patch",
      "*** Add File: generated.txt",
      "+created by apply_patch",
      "*** End Patch",
      "",
    ].join("\n");
    const outsidePatch = [
      "*** Begin Patch",
      "*** Add File: /etc/agenc-runtime-patch",
      "+blocked",
      "*** End Patch",
      "",
    ].join("\n");

    const blockedReadOnly = await router.dispatchModelToolCall(
      {
        id: "call-patch-read-only",
        name: "apply_patch",
        arguments: JSON.stringify({ input: insidePatch }),
      },
      {
        session,
        turn: {
          subId: "turn-patch-read-only",
          cwd: workspaceRoot,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "read_only" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "read_only",
      },
    );
    expect(blockedReadOnly.isError).toBe(true);
    expect(blockedReadOnly.content).toContain("read_only blocked");

    const blockedOutside = await router.dispatchModelToolCall(
      {
        id: "call-patch-outside",
        name: "apply_patch",
        arguments: JSON.stringify({ input: outsidePatch }),
      },
      {
        session,
        turn: {
          subId: "turn-patch-outside",
          cwd: workspaceRoot,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "workspace_write" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
      },
    );
    expect(blockedOutside.isError).toBe(true);
    expect(blockedOutside.content).toContain("workspace_write blocked");

    const allowed = await router.dispatchModelToolCall(
      {
        id: "call-patch-inside",
        name: "apply_patch",
        arguments: JSON.stringify({ input: insidePatch }),
      },
      {
        session,
        turn: {
          subId: "turn-patch-inside",
          cwd: workspaceRoot,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "workspace_write" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
      },
    );
    expect(allowed.isError).toBeFalsy();
    expect(readFileSync(join(workspaceRoot, "generated.txt"), "utf8")).toBe(
      "created by apply_patch\n",
    );
  });

  test("router injects selected sandbox attempt context without breaking schemas", async () => {
    let observedKeys: string[] = [];
    let observedSandboxMode: string | undefined;
    let observedApprovalPolicy: string | undefined;
    const tool: Tool = {
      name: "RuntimeProbe",
      description: "",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      isReadOnly: true,
      supportsParallelToolCalls: true,
      concurrencyClass: SHARED_READ,
      execute: async (args) => {
        observedKeys = Object.keys(args);
        const context = readToolRuntimeContext(args);
        observedSandboxMode = context?.sandboxMode;
        observedApprovalPolicy = context?.approvalPolicy;
        return {
          content: JSON.stringify({
            sandboxMode: context?.sandboxMode,
            runtimeKind: context?.runtimeKind,
          }),
        };
      },
    };
    const router = new ToolRouter([
      { tool, supportsParallelToolCalls: true },
    ]);
    const call: LLMToolCall = {
      id: "call-runtime-probe",
      name: "RuntimeProbe",
      arguments: '{"value":"ok"}',
    };

    const result = await router.dispatchModelToolCall(call, {
      session: {
        eventLog: new EventLog(),
        services: {},
      } as never,
      turn: {
        subId: "turn-runtime-probe",
        cwd: "/repo",
        approvalPolicy: { value: "never" },
        sandboxPolicy: { value: "read_only" },
      } as never,
      tracker: tracker() as never,
      approvalPolicy: "never",
      sandboxMode: "read_only",
    });

    expect(result.isError).toBeFalsy();
    expect(observedKeys).toEqual(["value"]);
    expect(observedSandboxMode).toBe("read_only");
    expect(observedApprovalPolicy).toBe("never");
    expect(JSON.parse(result.content)).toEqual({
      sandboxMode: "read_only",
      runtimeKind: "function",
    });
    expect(
      readToolRuntimeContext({
        __toolRuntimeContext: {
          callId: "spoof",
          toolName: "RuntimeProbe",
          sandboxMode: "danger_full_access",
        },
      }),
    ).toBeUndefined();
  });

  test("sandbox denial escalates through approval and retries without sandbox", async () => {
    let executedSandboxMode: string | undefined;
    let approvals = 0;
    const tool: Tool = {
      name: "Write",
      description: "",
      inputSchema: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
        additionalProperties: false,
      },
      metadata: { mutating: true },
      requiresApproval: true,
      recoveryCategory: "side-effecting",
      execute: async (args) => {
        executedSandboxMode = readToolRuntimeContext(args)?.sandboxMode;
        return { content: executedSandboxMode ?? "missing-context" };
      },
    };
    const router = new ToolRouter([
      { tool, supportsParallelToolCalls: false },
    ]);

    const result = await router.dispatchModelToolCall(
      {
        id: "call-runtime-escalation",
        name: "Write",
        arguments: '{"file_path":"README.md"}',
      },
      {
        session: {
          eventLog: new EventLog(),
          services: {},
        } as never,
        turn: {
          subId: "turn-runtime-escalation",
          cwd: "/repo",
          approvalPolicy: { value: "on_failure" },
          sandboxPolicy: { value: "read_only" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "on_failure",
        sandboxMode: "read_only",
        approvalResolver: {
          request: async () => {
            approvals += 1;
            return { kind: "approved" };
          },
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("danger_full_access");
    expect(executedSandboxMode).toBe("danger_full_access");
    expect(approvals).toBe(1);
  });

  test("direct dispatch uses runtime context and sandbox enforcement", async () => {
    let executed = false;
    const tool: Tool = {
      name: "Write",
      description: "",
      inputSchema: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
        additionalProperties: false,
      },
      metadata: { mutating: true },
      execute: async () => {
        executed = true;
        return { content: "not reached" };
      },
    };
    const router = new ToolRouter([
      { tool, supportsParallelToolCalls: false },
    ]);

    const result = await router.dispatchToolCall(
      {
        session: {
          eventLog: new EventLog(),
          services: {},
        } as never,
        turn: {
          subId: "turn-direct-runtime",
          cwd: "/repo",
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "workspace_write" },
        } as never,
        tracker: tracker() as never,
        callId: "call-direct-runtime",
        toolName: { name: "Write" },
        payload: { kind: "function", arguments: '{"file_path":"/etc/passwd"}' },
        source: "direct",
      },
      { file_path: "/etc/passwd" },
      { sandboxMode: "workspace_write" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("workspace_write blocked");
    expect(executed).toBe(false);
  });

  test("direct dispatch preserves rich content items through runtime execution", async () => {
    const contentItems = [{ type: "input_text" as const, text: "rich output" }];
    const structuredResult = { rich: true };
    const tool: Tool = {
      name: "RichOutput",
      description: "",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      isReadOnly: true,
      execute: async () => ({
        content: "fallback output",
        codeModeResult: structuredResult,
        contentItems,
      }),
    };
    const router = new ToolRouter([
      { tool, supportsParallelToolCalls: true },
    ]);

    const result = await router.dispatchToolCall(
      {
        session: {
          eventLog: new EventLog(),
          services: {},
        } as never,
        turn: {
          subId: "turn-rich-runtime",
          cwd: "/repo",
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "read_only" },
        } as never,
        tracker: tracker() as never,
        callId: "call-rich-runtime",
        toolName: { name: "RichOutput" },
        payload: { kind: "function", arguments: "{}" },
        source: "direct",
      },
      {},
      { sandboxMode: "read_only" },
    );

    expect(result.isError).toBeFalsy();
    expect(result.contentItems).toEqual(contentItems);
    expect(result.codeModeResult).toEqual(structuredResult);
  });

  test("direct dispatch serializes BigInt args without losing runtime execution", async () => {
    let seen: unknown;
    const tool: Tool = {
      name: "BigIntEcho",
      description: "",
      inputSchema: { type: "object" },
      isReadOnly: true,
      execute: async (args) => {
        seen = args["lamports"];
        return { content: "ok" };
      },
    };
    const router = new ToolRouter([
      { tool, supportsParallelToolCalls: true },
    ]);

    const result = await router.dispatchToolCall(
      {
        session: {
          eventLog: new EventLog(),
          services: {},
        } as never,
        turn: {
          subId: "turn-bigint-runtime",
          cwd: "/repo",
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "read_only" },
        } as never,
        tracker: tracker() as never,
        callId: "call-bigint-runtime",
        toolName: { name: "BigIntEcho" },
        payload: { kind: "function", arguments: "{}" },
        source: "direct",
      },
      { lamports: 9007199254740993n },
      { sandboxMode: "read_only" },
    );

    expect(result.isError).toBeFalsy();
    expect(seen).toBe(9007199254740993n);
  });

  test("code-mode dispatch carries runtime source and selected sandbox", async () => {
    let observedSource: string | undefined;
    let observedSandboxMode: string | undefined;
    const tool: Tool = {
      name: "js_repl",
      description: "",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
        additionalProperties: false,
      },
      isReadOnly: true,
      execute: async (args) => {
        const context = readToolRuntimeContext(args);
        observedSource = context?.source;
        observedSandboxMode = context?.sandboxMode;
        return {
          content: JSON.stringify({
            source: context?.source,
            sandboxMode: context?.sandboxMode,
          }),
        };
      },
    };
    const router = new ToolRouter([
      { tool, supportsParallelToolCalls: true },
    ]);

    const result = await router.dispatchToolCallWithCodeMode(
      {
        session: {
          eventLog: new EventLog(),
          services: {},
        } as never,
        turn: {
          subId: "turn-code-mode-runtime",
          cwd: "/repo",
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "read_only" },
        } as never,
        tracker: tracker() as never,
        callId: "call-code-mode-runtime",
        toolName: { name: "js_repl" },
        payload: { kind: "function", arguments: '{"code":"1+1"}' },
        source: "direct",
      },
      { code: "1+1" },
      "code_mode",
      { sandboxMode: "read_only" },
    );

    expect(result.isError).toBeFalsy();
    expect(observedSource).toBe("code_mode");
    expect(observedSandboxMode).toBe("read_only");
    expect(JSON.parse(result.content)).toEqual({
      source: "code_mode",
      sandboxMode: "read_only",
    });
  });
});
