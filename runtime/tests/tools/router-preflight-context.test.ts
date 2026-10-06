import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { parseToolName } from "../../src/tools/context.js";
import { attachPreflightRuntimeContext } from "../../src/tools/router.js";
import { readToolRuntimeContext } from "../../src/tools/runtimes/context.js";
import { createExecCommandTool } from "../../src/tools/system/exec-command.js";
import type { ToolInvocation } from "../../src/tools/types.js";

/** Chosen outside the workspace, the temp directory and the hermetic home. */
const OUTSIDE_FILE = "/srv/agenc-outside-workspace/outside.txt";

describe("attachPreflightRuntimeContext", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-preflight-context-"));
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  function invocationFor(mode: string): ToolInvocation {
    return {
      session: {
        permissionModeRegistry: {
          current: () => ({ mode, additionalWorkingDirectories: new Map() }),
        },
      },
      turn: {
        cwd: root,
        approvalPolicy: { value: "on_request" },
        sandboxPolicy: { value: "danger_full_access" },
      },
      callId: "call-preflight",
      toolName: parseToolName("exec_command"),
      payload: { kind: "function", arguments: "{}" },
      source: "model",
    } as unknown as ToolInvocation;
  }

  test("the exec_command preflight sees the session's mode and sandbox before approval", () => {
    const tool = createExecCommandTool({ cwd: root, allowedPaths: [root] });
    const args: Record<string, unknown> = { cmd: `rm ${OUTSIDE_FILE}` };

    // Without a context the preflight decides as a prompting session would;
    // this is what the live run under the full bypass saw.
    expect(tool.preflight?.(args)).toMatchObject({ code: "shell_workspace_write_policy" });

    attachPreflightRuntimeContext(tool, args, invocationFor("bypassPermissions"), {
      approvalPolicy: "on_request",
      sandboxMode: "danger_full_access",
    });

    expect(readToolRuntimeContext(args)).toMatchObject({
      callId: "call-preflight",
      toolName: "exec_command",
      approvalPolicy: "on_request",
      requestedSandboxMode: "danger_full_access",
      sandboxMode: "danger_full_access",
      approvalResolved: false,
    });
    expect(tool.preflight?.(args)).toBeNull();
  });

  test("a sandboxed bypass keeps the refusal at preflight", () => {
    const tool = createExecCommandTool({ cwd: root, allowedPaths: [root] });
    const args: Record<string, unknown> = { cmd: `rm ${OUTSIDE_FILE}` };

    attachPreflightRuntimeContext(tool, args, invocationFor("bypassPermissions"), {
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
    });

    expect(tool.preflight?.(args)).toMatchObject({ code: "shell_workspace_write_policy" });
  });

  test("does not replace a context the args already carry", () => {
    const tool = createExecCommandTool({ cwd: root, allowedPaths: [root] });
    const args: Record<string, unknown> = { cmd: "ls" };

    attachPreflightRuntimeContext(tool, args, invocationFor("default"), {
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
    });
    attachPreflightRuntimeContext(tool, args, invocationFor("bypassPermissions"), {
      approvalPolicy: "never",
      sandboxMode: "danger_full_access",
    });

    expect(readToolRuntimeContext(args)).toMatchObject({
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
    });
  });
});
