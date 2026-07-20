import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, normalize, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import {
  canReadPathWithCwd,
  hasFullDiskReadAccess,
} from "../../sandbox/engine/index.js";
import { EventLog } from "../../session/event-log.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import type { LLMToolCall } from "../../llm/types.js";
import { ToolRouter } from "../router.js";
import type { Tool } from "../types.js";
import { EXCLUSIVE, SHARED_READ } from "../concurrency.js";
import { createApplyPatchTool } from "../apply-patch/tool.js";
import { createExecCommandTool } from "../system/exec-command.js";
import {
  createFileEditTool,
  createFileMultiEditTool,
} from "../system/file-edit.js";
import { createFileWriteTool } from "../system/file-write.js";
import { createPlanningTools } from "../system/planning.js";
import { recordSessionRead } from "../system/filesystem.js";
import { createWriteStdinTool } from "../system/write-stdin.js";
import {
  enforceRuntimeSandboxAttempt,
  permissionProfileForRuntimeContext,
  permissionProfileForSandboxMode,
} from "./sandboxing.js";
import { resolveRuntimePathTarget } from "./paths.js";
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

function expectShellAttemptToRespectPlatformAvailability(
  attempt: () => void,
): void {
  if (process.platform === "darwin") {
    expect(attempt).not.toThrow();
    return;
  }
  expect(attempt).toThrow(/without platform sandbox context/);
}

function makeExecutableSandboxHelper(): string {
  const dir = mkdtempSync(join(tmpdir(), "agenc-runtime-helper-"));
  const helper = join(dir, "agenc-linux-sandbox");
  writeFileSync(helper, "#!/bin/sh\nexit 126\n");
  chmodSync(helper, 0o755);
  return helper;
}

describe("tools/runtimes", () => {
  test("resolveRuntimePathTarget normalizes absolute paths and resolves relatives from cwd", () => {
    expect(resolveRuntimePathTarget("nested/../file.txt", "/repo/work"))
      .toBe(resolve("/repo/work", "file.txt"));
    expect(resolveRuntimePathTarget("/repo/work/../other.txt", "/ignored"))
      .toBe(normalize("/repo/other.txt"));
  });

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
    expect(hasFullDiskReadAccess(readOnly.fileSystem)).toBe(true);
    expect(readOnly.network).toBe("disabled");

    const workspaceWrite = permissionProfileForSandboxMode("workspace_write", {
      cwd: "/repo",
    });
    expect(workspaceWrite.fileSystem.kind).toBe("restricted");
    expect(workspaceWrite.fileSystem.entries.some((entry) => entry.access === "write"))
      .toBe(true);
    expect(hasFullDiskReadAccess(workspaceWrite.fileSystem)).toBe(true);
    expect(workspaceWrite.network).toBe("disabled");

    const full = permissionProfileForSandboxMode("danger_full_access", {
      cwd: "/repo",
    });
    expect(full.fileSystem.kind).toBe("unrestricted");
    expect(full.network).toBe("enabled");

    const external = permissionProfileForSandboxMode("external_sandbox", {
      cwd: "/repo",
    });
    expect(external.fileSystem.kind).toBe("external_sandbox");
    expect(external.network).toBe("restricted");
  });

  test("live default workspace-write policy preserves unrestricted reads", () => {
    const profile = permissionProfileForRuntimeContext(
      {
        sandboxMode: "workspace_write",
        invocation: {
          turn: {
            cwd: "/repo",
            fileSystemSandboxPolicy: {
              allowWrite: ["/repo"],
              denyWrite: [],
              allowRead: [],
              denyRead: [],
            },
          },
        },
      } as never,
      { cwd: "/repo" },
    );

    expect(hasFullDiskReadAccess(profile.fileSystem)).toBe(true);
  });

  test("live deny-read paths still override the unrestricted read baseline", () => {
    const profile = permissionProfileForRuntimeContext(
      {
        sandboxMode: "workspace_write",
        invocation: {
          turn: {
            cwd: "/repo",
            fileSystemSandboxPolicy: {
              allowWrite: ["/repo"],
              denyWrite: [],
              allowRead: [],
              denyRead: ["/repo/private"],
            },
          },
        },
      } as never,
      { cwd: "/repo" },
    );

    expect(canReadPathWithCwd(profile.fileSystem, "/etc/passwd", "/repo"))
      .toBe(true);
    expect(canReadPathWithCwd(profile.fileSystem, "/repo/private/key", "/repo"))
      .toBe(false);
  });

  test.runIf(process.platform === "darwin")(
    "live default workspace-write policy launches pwd through macOS Seatbelt",
    async () => {
      const cwd = process.cwd();
      const profile = permissionProfileForRuntimeContext(
        {
          sandboxMode: "workspace_write",
          invocation: {
            turn: {
              cwd,
              fileSystemSandboxPolicy: {
                allowWrite: [cwd],
                denyWrite: [],
                allowRead: [],
                denyRead: [],
              },
            },
          },
        } as never,
        { cwd },
      );
      const manager = new UnifiedExecProcessManager({ cwd });

      try {
        const result = await manager.execCommand({
          cmd: "pwd",
          yield_time_ms: 1_000,
          runtimeSandbox: {
            permissionProfile: profile,
            sandboxPolicyCwd: cwd,
            preference: "require",
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(cwd);
      } finally {
        await manager.closeAll("test cleanup");
      }
    },
  );

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
    const sandboxHelper = makeExecutableSandboxHelper();
    const sandboxedInvocation = {
      ...invocation,
      turn: {
        cwd: "/repo",
        agencLinuxSandboxExe: sandboxHelper,
      } as never,
    };
    const sandboxedWorkspaceContext = {
      ...base,
      approvalPolicy: "never" as const,
      requestedSandboxMode: "workspace_write" as const,
      sandboxMode: "workspace_write" as const,
      approvalResolved: false,
      rawArgs: "{}",
      invocation: sandboxedInvocation,
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
    expectShellAttemptToRespectPlatformAvailability(() =>
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
      }));

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation: sandboxedInvocation,
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
          invocation: sandboxedInvocation,
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
          invocation: sandboxedInvocation,
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
          invocation: sandboxedInvocation,
        },
        tool: shellTool,
        args: { cmd: "echo allowed > /tmp/agenc-runtime-ok" },
      }),
    ).toThrow(/workspace_write blocked/);

    // Redirecting into safe pseudo-devices (`2>/dev/null`, `>/dev/stdout`,
    // `>/dev/fd/1`) never mutates the filesystem and must not be treated as
    // an outside-workspace write — plan mode runs every exploration command
    // through this path (observed: `2>/dev/null` self-poisoned a session).
    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "workspace_write",
          sandboxMode: "workspace_write",
          approvalResolved: false,
          rawArgs: "{}",
          invocation: sandboxedInvocation,
        },
        tool: shellTool,
        args: { cmd: "ls -la 2>/dev/null" },
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
          invocation: sandboxedInvocation,
        },
        tool: shellTool,
        args: { cmd: "make build &> /dev/null" },
      }),
    ).not.toThrow();

    // /dev/tty stays gated: writing to the user's terminal is an observable
    // side effect the sandbox policy must still see.
    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "workspace_write",
          sandboxMode: "workspace_write",
          approvalResolved: false,
          rawArgs: "{}",
          invocation: sandboxedInvocation,
        },
        tool: shellTool,
        args: { cmd: "echo hi > /dev/tty" },
      }),
    ).toThrow(/workspace_write blocked/);

    // Reading a pseudo-device (operand or `<` redirect) is not an
    // outside-workspace read either.
    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation: sandboxedInvocation,
        },
        tool: shellTool,
        args: { cmd: "cat /dev/null" },
      }),
    ).not.toThrow();

    const scopedAdditionalContext = {
      ...sandboxedWorkspaceContext,
      additionalPermissions: {
        network: { enabled: true },
        fileSystem: {
          entries: [
            {
              path: { kind: "path" as const, path: "/tmp/agenc-runtime-ok" },
              access: "write" as const,
            },
          ],
        },
      },
    };
    const scopedProfile = permissionProfileForRuntimeContext(
      scopedAdditionalContext,
      {
        cwd: "/repo",
        network: "disabled",
      },
    );
    expect(scopedProfile.network).toBe("enabled");
    expect(
      scopedProfile.fileSystem.entries.some(
        (entry) =>
          entry.access === "write" &&
          entry.path.kind === "path" &&
          entry.path.path === "/tmp/agenc-runtime-ok",
      ),
    ).toBe(true);
    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: scopedAdditionalContext,
        tool: shellTool,
        args: { cmd: "echo allowed > /tmp/agenc-runtime-ok/file.txt" },
      }),
    ).not.toThrow();
    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: scopedAdditionalContext,
        tool: shellTool,
        args: { cmd: "echo blocked > /tmp/agenc-runtime-nope/file.txt" },
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
            invocation: sandboxedInvocation,
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
          invocation: sandboxedInvocation,
        },
        tool: shellTool,
        args: { cmd: "node -e \"require('fs').writeFileSync('/etc/agenc-outside','x')\"" },
      }),
    ).toThrow(/could not verify (read|write) targets/);

    expectShellAttemptToRespectPlatformAvailability(() =>
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
      }));
    for (const cmd of ["npm test", "node script.js", "python -m pytest", "make"]) {
      expect(() =>
        enforceRuntimeSandboxAttempt({
          context: sandboxedWorkspaceContext,
          tool: shellTool,
          args: { cmd },
        }),
      ).not.toThrow();
    }

    expectShellAttemptToRespectPlatformAvailability(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...sandboxedWorkspaceContext,
          invocation,
        },
        tool: shellTool,
        args: { cmd: "node script.js" },
      }));

    expectShellAttemptToRespectPlatformAvailability(() =>
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
        args: { cmd: "ls", shell: "/bin/sh" },
      }));

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...base,
          approvalPolicy: "never",
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          approvalResolved: false,
          rawArgs: "{}",
          invocation: sandboxedInvocation,
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
          invocation: sandboxedInvocation,
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
          invocation: sandboxedInvocation,
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
          invocation: sandboxedInvocation,
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
          invocation: sandboxedInvocation,
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
          invocation: sandboxedInvocation,
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
          invocation: sandboxedInvocation,
        },
        tool: shellTool,
        args: { cmd: "ls", workdir: "/etc" },
      }),
    ).toThrow(/read outside workspace/);

    const livePolicyInvocation = {
      ...invocation,
      turn: {
        cwd: "/repo",
        agencLinuxSandboxExe: sandboxHelper,
        fileSystemSandboxPolicy: {
          allowWrite: ["/repo"],
          denyWrite: ["/repo/blocked"],
          allowRead: ["/repo"],
          denyRead: ["/repo/private"],
        },
        networkSandboxPolicy: {
          allowlist: [],
          denylist: [],
          allowManagedDomainsOnly: false,
          enabled: false,
        },
      } as never,
    };
    const livePolicyContext = {
      ...base,
      approvalPolicy: "never" as const,
      requestedSandboxMode: "workspace_write" as const,
      sandboxMode: "workspace_write" as const,
      approvalResolved: false,
      rawArgs: "{}",
      invocation: livePolicyInvocation,
    };
    const liveProfile = permissionProfileForRuntimeContext(livePolicyContext, {
      cwd: "/repo",
    });
    expect(liveProfile.network).toBe("disabled");

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: livePolicyContext,
        tool: mutatingTool,
        args: { file_path: "blocked/file.txt" },
      }),
    ).toThrow(/workspace_write blocked/);

    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: {
          ...livePolicyContext,
          requestedSandboxMode: "read_only",
          sandboxMode: "read_only",
          invocation: {
            ...livePolicyInvocation,
            turn: {
              cwd: "/repo",
              agencLinuxSandboxExe: sandboxHelper,
              fileSystemSandboxPolicy: {
                allowWrite: [],
                denyWrite: ["/repo"],
                allowRead: ["/repo"],
                denyRead: ["/repo/private"],
              },
              networkSandboxPolicy: {
                allowlist: [],
                denylist: [],
                allowManagedDomainsOnly: false,
                enabled: false,
              },
            } as never,
          },
        },
        tool: shellTool,
        args: { cmd: "cat /repo/private/secret.txt" },
      }),
    ).toThrow(/read outside workspace|could not verify read targets/);

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

  test("virtualNoFsWrites tools bypass the indeterminate-target denial without weakening real writers", () => {
    const invocation = {
      session: {} as never,
      turn: { cwd: "/repo" } as never,
      tracker: tracker() as never,
      callId: "call-virtual-no-fs",
      toolName: { name: "RuntimeProbe" },
      payload: { kind: "function", arguments: "{}" },
      source: "direct",
    } as const;
    const base = callContext("call-virtual-no-fs", EXCLUSIVE, false);
    const attempt = (sandboxMode: "read_only" | "workspace_write") => ({
      ...base,
      approvalPolicy: "never" as const,
      requestedSandboxMode: sandboxMode,
      sandboxMode,
      approvalResolved: false,
      rawArgs: "{}",
      invocation,
    });

    const virtualTool: Tool = {
      name: "TodoWrite",
      description: "",
      inputSchema: { type: "object" },
      metadata: { mutating: true, virtualNoFsWrites: true },
      execute: async () => ({ content: "not reached" }),
    };

    // (1) targetless virtual tool is allowed under workspace_write.
    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: attempt("workspace_write"),
        tool: virtualTool,
        args: { todos: [] },
      }),
    ).not.toThrow();

    // (2) same under read_only — covers the read_only write-capable branch.
    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: attempt("read_only"),
        tool: virtualTool,
        args: { todos: [] },
      }),
    ).not.toThrow();

    // (3) REGRESSION GUARD: a real writer with no flag and no resolvable
    // target still throws the indeterminate-write denial.
    const realWriter: Tool = {
      name: "Write",
      description: "",
      inputSchema: { type: "object" },
      metadata: { mutating: true },
      execute: async () => ({ content: "not reached" }),
    };
    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: attempt("workspace_write"),
        tool: realWriter,
        args: { contents: "no target arg" },
      }),
    ).toThrow(/could not verify write targets/);

    // (3b) The shell-envelope path is untouched: a targetless
    // exec_command/system.bash-style shell tool is still indeterminate-denied
    // under workspace_write without a platform helper. (Even if such a tool
    // were ever mis-flagged virtualNoFsWrites, the shell-access guard runs
    // BEFORE toolMayMutate and denies it independently.)
    const shellTool: Tool = {
      name: "exec_command",
      description: "",
      inputSchema: { type: "object" },
      metadata: { mutating: true },
      execute: async () => ({ content: "not reached" }),
    };
    expectShellAttemptToRespectPlatformAvailability(() =>
      enforceRuntimeSandboxAttempt({
        context: attempt("workspace_write"),
        tool: shellTool,
        args: { cmd: "node script.js" },
      }));

    const flaggedShellTool: Tool = {
      ...shellTool,
      metadata: { mutating: true, virtualNoFsWrites: true },
    };
    expectShellAttemptToRespectPlatformAvailability(() =>
      enforceRuntimeSandboxAttempt({
        context: attempt("workspace_write"),
        tool: flaggedShellTool,
        args: { cmd: "node script.js" },
      }));

    // (4) The resolved-writeTargets path stays intact for unflagged tools: an
    // UNFLAGGED real writer with a resolved outside-workspace target still
    // throws the workspace_write boundary denial. The flag never participates
    // in this path because a flagged tool is not treated as mutating at all.
    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: attempt("workspace_write"),
        tool: realWriter,
        args: { file_path: "/etc/passwd" },
      }),
    ).toThrow(/workspace_write blocked/);

    // (4b) Document the flag's full semantics: a flagged virtual tool that
    // happens to carry a path-shaped arg is NOT denied, because the audit
    // guarantees it performs no filesystem write — the arg is not a write
    // target. This is the deliberate consequence of treating the tool as
    // non-mutating, and is only safe because each flagged tool was audited.
    expect(() =>
      enforceRuntimeSandboxAttempt({
        context: attempt("workspace_write"),
        tool: virtualTool,
        args: { file_path: "/etc/passwd" },
      }),
    ).not.toThrow();
  });

  test("real planning tools advertise virtualNoFsWrites while file writers do not", () => {
    const planningTools = createPlanningTools();
    const byName = new Map(planningTools.map((tool) => [tool.name, tool] as const));

    expect(byName.get("TodoWrite")?.metadata?.virtualNoFsWrites).toBe(true);
    expect(byName.get("ExitPlanMode")?.metadata?.virtualNoFsWrites).toBe(true);
    // EnterPlanMode is already isReadOnly — it must NOT carry the flag.
    expect(byName.get("EnterPlanMode")?.metadata?.virtualNoFsWrites).toBeUndefined();

    const writeTool = createFileWriteTool({ allowedPaths: ["/repo"] });
    const editTool = createFileEditTool({ allowedPaths: ["/repo"] });
    expect(writeTool.metadata?.virtualNoFsWrites).not.toBe(true);
    expect(editTool.metadata?.virtualNoFsWrites).not.toBe(true);
  });

  test("actual exec_command handler is preflighted by selected runtime sandbox", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-runtime-exec-"));
    const sandboxHelper = makeExecutableSandboxHelper();
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
          services: { admissionRequired: false },
        } as never,
        turn: {
          subId: "turn-exec-read-outside",
          cwd: workspaceRoot,
          agencLinuxSandboxExe: sandboxHelper,
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
          services: { admissionRequired: false },
        } as never,
        turn: {
          subId: "turn-exec-generated-write",
          cwd: workspaceRoot,
          agencLinuxSandboxExe: sandboxHelper,
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

    const nestedWorkdir = join(workspaceRoot, "subdir");
    mkdirSync(nestedWorkdir);
    const rootScopedRead = await router.dispatchModelToolCall(
      {
        id: "call-exec-root-scoped-read",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "cat ../README.md",
          workdir: nestedWorkdir,
        }),
      },
      {
        session: {
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: {
          subId: "turn-exec-root-scoped-read",
          cwd: workspaceRoot,
          agencLinuxSandboxExe: sandboxHelper,
          fileSystemSandboxPolicy: {
            allowWrite: [],
            denyWrite: [workspaceRoot],
            allowRead: [workspaceRoot],
            denyRead: [],
          },
          networkSandboxPolicy: {
            allowlist: [],
            denylist: [],
            allowManagedDomainsOnly: false,
            enabled: false,
          },
          windowsSandboxLevel: "strict",
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "read_only" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "read_only",
      },
    );
    expect(rootScopedRead.isError).toBeFalsy();
    expect(execCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workdir: nestedWorkdir,
        runtimeSandbox: expect.objectContaining({
          sandboxPolicyCwd: workspaceRoot,
          windowsSandboxLevel: "high",
          permissionProfile: expect.objectContaining({
            network: "disabled",
            fileSystem: expect.objectContaining({ kind: "restricted" }),
          }),
        }),
      }),
    );

    const noHelperStdin = await router.dispatchModelToolCall(
      {
        id: "call-stdin-no-helper",
        name: "write_stdin",
        arguments: JSON.stringify({
          session_id: 7,
          chars: "",
        }),
      },
      {
        session: {
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: {
          subId: "turn-stdin-no-helper",
          cwd: workspaceRoot,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "read_only" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "read_only",
      },
    );
    if (process.platform === "darwin") {
      expect(noHelperStdin.isError).toBeFalsy();
      expect(writeStdin).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: 7,
          chars: "",
          runtimeSandbox: expect.objectContaining({
            sandboxPolicyCwd: workspaceRoot,
          }),
        }),
      );
      writeStdin.mockClear();
    } else {
      expect(noHelperStdin.isError).toBe(true);
      expect(noHelperStdin.content).toContain("write_stdin");
      expect(writeStdin).not.toHaveBeenCalled();
    }

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
          services: { admissionRequired: false },
        } as never,
        turn: {
          subId: "turn-stdin-read-only",
          cwd: workspaceRoot,
          agencLinuxSandboxExe: sandboxHelper,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "read_only" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "read_only",
      },
    );
    expect(readOnlyStdin.isError).toBeFalsy();
    expect(writeStdin).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 7,
        chars: "printf should-not-run\\n",
        runtimeSandbox: expect.objectContaining({
          sandboxPolicyCwd: workspaceRoot,
        }),
      }),
    );

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
          services: { admissionRequired: false },
        } as never,
        turn: {
          subId: "turn-stdin-continue",
          cwd: workspaceRoot,
          agencLinuxSandboxExe: sandboxHelper,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "workspace_write" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
      },
    );
    expect(restrictedStdin.isError).toBeFalsy();
    expect(writeStdin).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 7,
        chars: "printf agenc-pty\\n",
        runtimeSandbox: expect.objectContaining({
          sandboxPolicyCwd: workspaceRoot,
        }),
      }),
    );

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
          services: { admissionRequired: false },
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
    expect(writeStdin.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "runtimeSandbox",
    );
  });

  test.runIf(process.platform !== "darwin")(
    "actual exec_command denies restricted shell commands without a platform helper",
    async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-runtime-real-exec-"));
    const router = new ToolRouter([
      {
        tool: createExecCommandTool({
          cwd: workspaceRoot,
          allowedPaths: [workspaceRoot],
        }),
        supportsParallelToolCalls: false,
      },
    ]);

    const result = await router.dispatchModelToolCall(
      {
        id: "call-real-exec-no-helper",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "pwd",
          yield_time_ms: 250,
        }),
      },
      {
        session: {
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: {
          subId: "turn-real-exec-no-helper",
          cwd: workspaceRoot,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "workspace_write" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("without platform sandbox context");
    },
  );

  test.runIf(process.platform === "linux")(
    "actual exec_command validates linux sandbox helper before dispatch",
    async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-runtime-helper-check-"));
      const helperDir = mkdtempSync(join(tmpdir(), "agenc-runtime-helper-bad-"));
      const missingHelper = join(helperDir, "missing-helper");
      const nonExecutableHelper = join(helperDir, "non-executable-helper");
      writeFileSync(nonExecutableHelper, "#!/bin/sh\nexit 126\n");
      chmodSync(nonExecutableHelper, 0o644);
      const workspaceHelper = join(workspaceRoot, "agenc-linux-sandbox");
      writeFileSync(workspaceHelper, "#!/bin/sh\nexit 126\n");
      chmodSync(workspaceHelper, 0o755);
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
      const router = new ToolRouter([
        {
          tool: createExecCommandTool({
            cwd: workspaceRoot,
            allowedPaths: [workspaceRoot],
            unifiedExecManager: {
              maxTimeoutMs: 30_000,
              execCommand,
              writeStdin: vi.fn(),
              closeAll: vi.fn(),
            },
          }),
          supportsParallelToolCalls: false,
        },
      ]);
      const dispatch = (helper: string) =>
        router.dispatchModelToolCall(
          {
            id: `call-helper-${helper}`,
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "pwd" }),
          },
          {
            session: {
              eventLog: new EventLog(),
              services: { admissionRequired: false },
            } as never,
            turn: {
              subId: "turn-helper-check",
              cwd: workspaceRoot,
              agencLinuxSandboxExe: helper,
              approvalPolicy: { value: "never" },
              sandboxPolicy: { value: "workspace_write" },
            } as never,
            tracker: tracker() as never,
            approvalPolicy: "never",
            sandboxMode: "workspace_write",
          },
        );

      const missing = await dispatch(missingHelper);
      expect(missing.isError).toBe(true);
      expect(missing.content).toContain("does not exist");

      const nonExecutable = await dispatch(nonExecutableHelper);
      expect(nonExecutable.isError).toBe(true);
      expect(nonExecutable.content).toContain("not executable");

      const local = await dispatch(workspaceHelper);
      expect(local.isError).toBe(true);
      expect(local.content).toContain("outside the workspace");
      expect(execCommand).not.toHaveBeenCalled();
    },
  );

  test.runIf(process.platform !== "darwin")(
    "actual exec_command denies shell envelopes without a platform helper",
    async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-runtime-shell-env-"));
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
    const router = new ToolRouter([
      {
        tool: createExecCommandTool({
          cwd: workspaceRoot,
          allowedPaths: [workspaceRoot],
          unifiedExecManager: {
            maxTimeoutMs: 30_000,
            execCommand,
            writeStdin: vi.fn(),
            closeAll: vi.fn(),
          },
        }),
        supportsParallelToolCalls: false,
      },
    ]);
    const baseOpts = {
      session: {
        eventLog: new EventLog(),
        services: { admissionRequired: false },
      } as never,
      turn: {
        subId: "turn-shell-envelope",
        cwd: workspaceRoot,
        approvalPolicy: { value: "never" },
        sandboxPolicy: { value: "workspace_write" },
      } as never,
      tracker: tracker() as never,
      approvalPolicy: "never" as const,
      sandboxMode: "workspace_write" as const,
    };

    const customShell = await router.dispatchModelToolCall(
      {
        id: "call-custom-shell-no-helper",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "ls", shell: "/bin/sh" }),
      },
      baseOpts,
    );
    expect(customShell.isError).toBe(true);
    expect(customShell.content).toContain("without platform sandbox context");

    const loginShell = await router.dispatchModelToolCall(
      {
        id: "call-login-shell-no-helper",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "ls", login: true }),
      },
      baseOpts,
    );
    expect(loginShell.isError).toBe(true);
    expect(loginShell.content).toContain("without platform sandbox context");
    expect(execCommand).not.toHaveBeenCalled();
    },
  );

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
      services: { admissionRequired: false },
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

  test("actual Edit and MultiEdit handlers obey per-attempt file sandbox preflight", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-runtime-edit-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "agenc-runtime-edit-outside-"));
    const sessionId = "runtime-edit-session";
    const router = new ToolRouter([
      {
        tool: createFileEditTool({ allowedPaths: [workspaceRoot] }),
        supportsParallelToolCalls: false,
      },
      {
        tool: createFileMultiEditTool({ allowedPaths: [workspaceRoot] }),
        supportsParallelToolCalls: false,
      },
    ]);
    const session = {
      conversationId: sessionId,
      eventLog: new EventLog(),
      services: { admissionRequired: false },
    } as never;
    const dispatch = (
      call: LLMToolCall,
      sandboxMode: "read_only" | "workspace_write",
      subId: string,
    ) =>
      router.dispatchModelToolCall(call, {
        session,
        turn: {
          subId,
          cwd: workspaceRoot,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: sandboxMode },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode,
      });
    const recordRead = (filePath: string, content: string): void => {
      const fileStats = statSync(filePath);
      recordSessionRead(sessionId, realpathSync(filePath), {
        content,
        rawContent: content,
        timestamp: fileStats.mtimeMs,
        viewKind: "full",
      });
    };

    const readOnlyEditPath = join(workspaceRoot, "read-only-edit.txt");
    writeFileSync(readOnlyEditPath, "alpha\n");
    recordRead(readOnlyEditPath, "alpha\n");
    const readOnlyEdit = await dispatch(
      {
        id: "call-edit-read-only",
        name: "Edit",
        arguments: JSON.stringify({
          file_path: "read-only-edit.txt",
          old_string: "alpha",
          new_string: "beta",
        }),
      },
      "read_only",
      "turn-edit-read-only",
    );
    expect(readOnlyEdit.isError).toBe(true);
    expect(readOnlyEdit.content).toContain("read_only blocked");
    expect(readFileSync(readOnlyEditPath, "utf8")).toBe("alpha\n");

    const readOnlyMultiPath = join(workspaceRoot, "read-only-multi.txt");
    writeFileSync(readOnlyMultiPath, "one\ntwo\n");
    recordRead(readOnlyMultiPath, "one\ntwo\n");
    const readOnlyMulti = await dispatch(
      {
        id: "call-multiedit-read-only",
        name: "MultiEdit",
        arguments: JSON.stringify({
          file_path: "read-only-multi.txt",
          edits: [{ old_string: "one", new_string: "uno" }],
        }),
      },
      "read_only",
      "turn-multiedit-read-only",
    );
    expect(readOnlyMulti.isError).toBe(true);
    expect(readOnlyMulti.content).toContain("read_only blocked");
    expect(readFileSync(readOnlyMultiPath, "utf8")).toBe("one\ntwo\n");

    const outsideEditPath = join(outsideRoot, "outside-edit.txt");
    writeFileSync(outsideEditPath, "outside alpha\n");
    recordRead(outsideEditPath, "outside alpha\n");
    const outsideEdit = await dispatch(
      {
        id: "call-edit-outside",
        name: "Edit",
        arguments: JSON.stringify({
          file_path: outsideEditPath,
          old_string: "alpha",
          new_string: "beta",
        }),
      },
      "workspace_write",
      "turn-edit-outside",
    );
    expect(outsideEdit.isError).toBe(true);
    expect(outsideEdit.content).toContain("outside allowed");
    expect(readFileSync(outsideEditPath, "utf8")).toBe("outside alpha\n");

    const outsideMultiPath = join(outsideRoot, "outside-multi.txt");
    writeFileSync(outsideMultiPath, "outside one\noutside two\n");
    recordRead(outsideMultiPath, "outside one\noutside two\n");
    const outsideMulti = await dispatch(
      {
        id: "call-multiedit-outside",
        name: "MultiEdit",
        arguments: JSON.stringify({
          file_path: outsideMultiPath,
          edits: [{ old_string: "outside one", new_string: "outside uno" }],
        }),
      },
      "workspace_write",
      "turn-multiedit-outside",
    );
    expect(outsideMulti.isError).toBe(true);
    expect(outsideMulti.content).toContain("outside allowed");
    expect(readFileSync(outsideMultiPath, "utf8")).toBe(
      "outside one\noutside two\n",
    );

    const insideEditPath = join(workspaceRoot, "inside-edit.txt");
    writeFileSync(insideEditPath, "inside alpha\n");
    recordRead(insideEditPath, "inside alpha\n");
    const insideEdit = await dispatch(
      {
        id: "call-edit-inside",
        name: "Edit",
        arguments: JSON.stringify({
          file_path: "inside-edit.txt",
          old_string: "alpha",
          new_string: "beta",
        }),
      },
      "workspace_write",
      "turn-edit-inside",
    );
    expect(insideEdit.isError).toBeFalsy();
    expect(readFileSync(insideEditPath, "utf8")).toBe("inside beta\n");

    const insideMultiPath = join(workspaceRoot, "inside-multi.txt");
    writeFileSync(insideMultiPath, "inside one\ninside two\n");
    recordRead(insideMultiPath, "inside one\ninside two\n");
    const insideMulti = await dispatch(
      {
        id: "call-multiedit-inside",
        name: "MultiEdit",
        arguments: JSON.stringify({
          file_path: "inside-multi.txt",
          edits: [
            { old_string: "inside one", new_string: "inside uno" },
            { old_string: "inside two", new_string: "inside dos" },
          ],
        }),
      },
      "workspace_write",
      "turn-multiedit-inside",
    );
    expect(insideMulti.isError).toBeFalsy();
    expect(readFileSync(insideMultiPath, "utf8")).toBe(
      "inside uno\ninside dos\n",
    );
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
      services: { admissionRequired: false },
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
        services: { admissionRequired: false },
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
          services: { admissionRequired: false },
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
          services: { admissionRequired: false },
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
          services: { admissionRequired: false },
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
          services: { admissionRequired: false },
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
          services: { admissionRequired: false },
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
