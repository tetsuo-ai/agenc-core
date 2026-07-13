import { describe, expect, it } from "vitest";
import {
  assertProcessOwnerAccess,
  processOwnerIdFromToolArgs,
} from "../../src/unified-exec/process-ownership.js";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { UnifiedExecError } from "../../src/unified-exec/types.js";
import { toolNameAliases, SHELL_TOOL_FAMILY } from "../../src/permissions/rules.js";
import { normalizeUnattendedToolList } from "../../src/permissions/unattended-policy.js";

describe("process ownership (TOOL-01)", () => {
  it("processOwnerIdFromToolArgs reads injected session id", () => {
    expect(
      processOwnerIdFromToolArgs({ __agencSessionId: "conv-a" }),
    ).toBe("conv-a");
    expect(processOwnerIdFromToolArgs({})).toBeUndefined();
    expect(processOwnerIdFromToolArgs({ __agencSessionId: "  " })).toBeUndefined();
  });

  it("unowned entries remain accessible", () => {
    expect(
      assertProcessOwnerAccess({
        entryOwnerId: undefined,
        requestOwnerId: "other",
      }).ok,
    ).toBe(true);
  });

  it("owned entries reject foreign or missing request owners", () => {
    const foreign = assertProcessOwnerAccess({
      entryOwnerId: "agent-a",
      requestOwnerId: "agent-b",
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.reason).toMatch(/another agent/i);
    }

    const missing = assertProcessOwnerAccess({
      entryOwnerId: "agent-a",
      requestOwnerId: undefined,
    });
    expect(missing.ok).toBe(false);
  });

  it("owned entries accept matching owner", () => {
    expect(
      assertProcessOwnerAccess({
        entryOwnerId: "agent-a",
        requestOwnerId: "agent-a",
      }).ok,
    ).toBe(true);
  });

  it("manager denies write_stdin and kill across owners on a live process", async () => {
    const manager = new UnifiedExecProcessManager({ maxTimeoutMs: 5_000 });
    try {
      const started = await manager.execCommand({
        cmd: "sleep 30",
        tty: true,
        yield_time_ms: 250,
        ownerId: "session-parent",
      });
      expect(started.session_id ?? started.process_id).toBeTypeOf("number");
      const sessionId = started.session_id ?? started.process_id!;

      await expect(
        manager.writeStdin({
          session_id: sessionId,
          chars: "echo hijack\n",
          ownerId: "session-child",
        }),
      ).rejects.toMatchObject({
        name: "UnifiedExecError",
        code: "owner_denied",
      });

      expect(() =>
        manager.terminateProcess({
          processId: sessionId,
          ownerId: "session-child",
        }),
      ).toThrow(UnifiedExecError);

      const killed = manager.terminateProcess({
        processId: sessionId,
        ownerId: "session-parent",
      });
      expect(killed.terminated).toBe(true);
    } finally {
      await manager.closeAll();
    }
  }, 15_000);
});

describe("shell family covers write_stdin/kill (TOOL-02)", () => {
  it("includes write_stdin, kill_process, Monitor, PowerShell in SHELL_TOOL_FAMILY", () => {
    expect(SHELL_TOOL_FAMILY).toContain("write_stdin");
    expect(SHELL_TOOL_FAMILY).toContain("kill_process");
    expect(SHELL_TOOL_FAMILY).toContain("Monitor");
    expect(SHELL_TOOL_FAMILY).toContain("PowerShell");
    expect(toolNameAliases("write_stdin")).toContain("exec_command");
    expect(toolNameAliases("kill_process")).toContain("Bash");
    expect(toolNameAliases("Monitor")).toContain("exec_command");
  });

  it("unattended denylist Bash covers write_stdin, kill_process, and Monitor", () => {
    const list = normalizeUnattendedToolList([
      "Bash",
      "write_stdin",
      "kill_process",
      "Monitor",
    ]);
    // All collapse to system.bash
    expect(list).toContain("system.bash");
    expect(new Set(list).size).toBe(1);
  });
});
