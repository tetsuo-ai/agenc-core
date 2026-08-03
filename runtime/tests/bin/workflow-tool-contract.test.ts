import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import {
  attachSandboxExecutionBroker,
  SandboxExecutionBroker,
} from "../../src/sandbox/execution-broker.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "agenc-workflow-tool-"));
  temporaryRoots.push(workspaceRoot);
  const workflowRoot = join(workspaceRoot, ".agenc", "workflows");
  const agencHome = join(workspaceRoot, "state");
  await mkdir(workflowRoot, { recursive: true });
  const execCommand = vi.fn(async () => ({
    output: "ok",
    stdout: "ok",
    stderr: "",
    exitCode: 0,
    exit_code: 0,
    durationMs: 1,
    wall_time_seconds: 0.001,
    timedOut: false,
    truncated: false,
    original_token_count: 1,
  }));
  const tool = createModelFacingTools({
    workspaceRoot,
    agencHome,
    getSession: () => null,
    unifiedExecManager: { execCommand } as never,
    env: {},
  }).find((candidate) => candidate.name === "WorkflowTool");
  if (tool === undefined) throw new Error("WorkflowTool was not registered");
  return { workspaceRoot, workflowRoot, execCommand, tool };
}

function executionArgs(
  workspaceRoot: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  attachSandboxExecutionBroker(
    value,
    new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: workspaceRoot,
    }),
    "workflow",
  );
  return value;
}

describe("WorkflowTool manifest boundary", () => {
  it("rejects traversal before filesystem escape or command dispatch", async () => {
    const { workspaceRoot, execCommand, tool } = await fixture();
    await mkdir(join(workspaceRoot, ".agenc"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".agenc", "escaped.json"),
      '{"command":"must-not-run"}',
      { mode: 0o600 },
    );

    const result = await tool.execute(
      executionArgs(workspaceRoot, { name: "../escaped" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("WORKFLOW_NAME");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("rejects duplicate manifest keys and legacy overrides before dispatch", async () => {
    const { workspaceRoot, workflowRoot, execCommand, tool } = await fixture();
    await writeFile(
      join(workflowRoot, "duplicate.json"),
      '{"command":"first","command":"second"}',
      { mode: 0o600 },
    );
    const duplicate = await tool.execute(
      executionArgs(workspaceRoot, { name: "duplicate" }),
    );
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content).toContain("duplicate object key");

    await writeFile(join(workflowRoot, "legacy.json"), '{"command":"safe"}', {
      mode: 0o600,
    });
    const override = await tool.execute(
      executionArgs(workspaceRoot, {
        name: "legacy",
        args: { max_concurrency: 1 },
      }),
    );
    expect(override.isError).toBe(true);
    expect(override.content).toContain("WORKFLOW_LEGACY_ARGS");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("dispatches a validated legacy command from a confined manifest", async () => {
    const { workspaceRoot, workflowRoot, execCommand, tool } = await fixture();
    await writeFile(join(workflowRoot, "safe.json"), '{"command":"do-safe-work"}', {
      mode: 0o600,
    });

    const result = await tool.execute(
      executionArgs(workspaceRoot, { name: "safe", args: {} }),
    );

    expect(result.isError).toBeUndefined();
    expect(execCommand).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "do-safe-work", workdir: workspaceRoot }),
    );
  });
});
