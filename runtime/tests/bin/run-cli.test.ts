import { describe, expect, it, vi } from "vitest";

import type { AgenCJsonLineDaemonRequestClient } from "../../src/app-server/agent-cli.js";
import {
  formatAgenCRunCliHelpText,
  parseAgenCRunCliArgs,
  runAgenCRunCli,
} from "../../src/bin/run-cli.js";

function captureIo(): {
  readonly io: {
    readonly stdout: { write(value: string): boolean };
    readonly stderr: { write(value: string): boolean };
  };
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(value) {
          stdout += value;
          return true;
        },
      },
      stderr: {
        write(value) {
          stderr += value;
          return true;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("agenc run CLI", () => {
  it("parses bounded replay and evidence cursors", () => {
    expect(
      parseAgenCRunCliArgs([
        "run",
        "replay",
        "run-1",
        "--after",
        "41",
        "--limit=100",
      ]),
    ).toEqual({
      kind: "replay",
      runId: "run-1",
      afterSequence: 41,
      limit: 100,
    });
    expect(
      parseAgenCRunCliArgs([
        "run",
        "evidence",
        "run-1",
        "--limit",
        "201",
      ]),
    ).toEqual({
      kind: "error",
      message: "--limit must be an integer from 1 through 200",
    });
  });

  it("parses status, terminal result, cancellation, and help", () => {
    expect(parseAgenCRunCliArgs(["run", "status", "run-1"])).toEqual({
      kind: "status",
      runId: "run-1",
    });
    expect(parseAgenCRunCliArgs(["run", "result", "run-1"])).toEqual({
      kind: "result",
      runId: "run-1",
    });
    expect(
      parseAgenCRunCliArgs([
        "run",
        "cancel",
        "run-1",
        "--reason",
        "operator stop",
      ]),
    ).toEqual({ kind: "cancel", runId: "run-1", reason: "operator stop" });
    expect(parseAgenCRunCliArgs(["run"]))
      .toEqual({ kind: "help", text: formatAgenCRunCliHelpText() });
  });

  it("does not capture ordinary prompts beginning with run", () => {
    expect(parseAgenCRunCliArgs(["run", "tools"])).toBeNull();
    expect(parseAgenCRunCliArgs(["run", "the", "tests"])).toBeNull();
  });

  it("parses the start verb with accumulating --verify flags", () => {
    expect(
      parseAgenCRunCliArgs([
        "run",
        "start",
        "--goal",
        "Fix the reported bug",
        "--cwd",
        "/workspace/repo",
        "--model",
        "impl-model",
        "--reviewer-model",
        "review-model",
        "--max-cost",
        "5",
        "--permission-mode",
        "acceptEdits",
        "--verify",
        "unit=npm test",
        "--verify=typecheck=npx tsc --noEmit",
        "--json",
        "--follow",
      ]),
    ).toEqual({
      kind: "start",
      goal: "Fix the reported bug",
      cwd: "/workspace/repo",
      model: "impl-model",
      reviewerModel: "review-model",
      maxCostUsd: 5,
      permissionMode: "acceptEdits",
      verify: [
        { label: "unit", script: "npm test" },
        { label: "typecheck", script: "npx tsc --noEmit" },
      ],
      json: true,
      follow: true,
    });
  });

  it("rejects malformed start invocations", () => {
    expect(parseAgenCRunCliArgs(["run", "start"])).toEqual({
      kind: "error",
      message: "run start requires exactly one of --goal or --goal-file",
    });
    expect(
      parseAgenCRunCliArgs([
        "run",
        "start",
        "--goal",
        "g",
        "--goal-file",
        "goal.md",
      ]),
    ).toEqual({
      kind: "error",
      message: "run start requires exactly one of --goal or --goal-file",
    });
    expect(
      parseAgenCRunCliArgs(["run", "start", "--goal", "g", "--verify", "npm test"]),
    ).toEqual({
      kind: "error",
      message: 'run start option --verify requires "label=script"',
    });
    expect(
      parseAgenCRunCliArgs(["run", "start", "--goal", "g", "--max-cost", "-1"]),
    ).toEqual({
      kind: "error",
      message: "--max-cost must be a positive number of USD",
    });
    expect(
      parseAgenCRunCliArgs([
        "run",
        "start",
        "--goal",
        "g",
        "--permission-mode",
        "yolo",
      ]),
    ).toEqual({
      kind: "error",
      message:
        "--permission-mode must be one of: default, plan, acceptEdits, bypassPermissions",
    });
  });

  it("frames run.start onto the daemon protocol, passing verification through verbatim", async () => {
    const request = vi.fn(async () => ({
      runId: "wf-run-1",
      specDigest: `sha256:${"a".repeat(64)}`,
      baseCommit: "b".repeat(40),
      baseDirty: { dirty: true, fileCount: 2 },
    }));
    const output = captureIo();
    const code = await runAgenCRunCli(
      {
        kind: "start",
        goal: "Fix the reported bug",
        cwd: "/workspace/repo",
        reviewerModel: "review-model",
        verify: [{ label: "unit", script: "npm test" }],
      },
      {
        io: output.io,
        ensureDaemonReady: async () => {},
        client: { request } as unknown as AgenCJsonLineDaemonRequestClient,
      },
    );
    expect(code).toBe(0);
    expect(request).toHaveBeenCalledWith("run.start", {
      goal: "Fix the reported bug",
      cwd: "/workspace/repo",
      reviewerModel: "review-model",
      requiredVerification: [{ label: "unit", script: "npm test" }],
    });
    expect(output.stdout()).toContain("run wf-run-1");
    expect(output.stdout()).toContain("checkout dirty: 2 file(s)");
  });

  it("omits requiredVerification entirely when no --verify was given", async () => {
    const request = vi.fn(async () => ({
      runId: "wf-run-2",
      specDigest: `sha256:${"a".repeat(64)}`,
      baseCommit: "b".repeat(40),
      baseDirty: { dirty: false, fileCount: 0 },
    }));
    await runAgenCRunCli(
      { kind: "start", goal: "g", cwd: "/workspace/repo", verify: [] },
      {
        io: captureIo().io,
        ensureDaemonReady: async () => {},
        client: { request } as unknown as AgenCJsonLineDaemonRequestClient,
      },
    );
    expect(request).toHaveBeenCalledWith("run.start", {
      goal: "g",
      cwd: "/workspace/repo",
    });
  });

  it("renders the workflow step table when run.status carries workflow", async () => {
    const request = vi.fn(async () => ({
      runId: "wf-run-1",
      status: "failed",
      terminal: true,
      workflow: {
        steps: [
          {
            stepId: "workflow.intake",
            stage: "workflow.intake",
            status: "committed",
            attempts: 1,
          },
          {
            stepId: "workflow.verify.agent",
            stage: "workflow.verify",
            status: "committed",
            attempts: 1,
            verdict: "FAIL",
          },
        ],
        stopReason: "verification_failed",
      },
    }));
    const output = captureIo();
    const code = await runAgenCRunCli(
      { kind: "status", runId: "wf-run-1" },
      {
        io: output.io,
        ensureDaemonReady: async () => {},
        client: { request } as unknown as AgenCJsonLineDaemonRequestClient,
      },
    );
    expect(code).toBe(0);
    expect(output.stdout()).toContain("workflow.verify");
    expect(output.stdout()).toContain("FAIL");
    expect(output.stdout()).toContain("stop reason: verification_failed");

    // --json restores the raw canonical JSON output.
    const jsonOutput = captureIo();
    await runAgenCRunCli(
      { kind: "status", runId: "wf-run-1", json: true },
      {
        io: jsonOutput.io,
        ensureDaemonReady: async () => {},
        client: { request } as unknown as AgenCJsonLineDaemonRequestClient,
      },
    );
    expect(JSON.parse(jsonOutput.stdout()).workflow.stopReason).toBe(
      "verification_failed",
    );
  });

  it("prints the canonical daemon response as JSON", async () => {
    const request = vi.fn(async () => ({
      runId: "run-1",
      found: true,
      terminal: false,
    }));
    const ensureDaemonReady = vi.fn(async () => {});
    const output = captureIo();

    const code = await runAgenCRunCli(
      { kind: "status", runId: "run-1" },
      {
        io: output.io,
        ensureDaemonReady,
        client: { request } as unknown as AgenCJsonLineDaemonRequestClient,
      },
    );

    expect(code).toBe(0);
    expect(ensureDaemonReady).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("run.status", { runId: "run-1" });
    expect(JSON.parse(output.stdout())).toEqual({
      runId: "run-1",
      found: true,
      terminal: false,
    });
    expect(output.stderr()).toBe("");
  });

  it("forwards replay cursors and cancellation reasons", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const client = { request } as unknown as AgenCJsonLineDaemonRequestClient;
    const ready = async () => {};

    await runAgenCRunCli(
      {
        kind: "replay",
        runId: "run-1",
        afterSequence: 12,
        limit: 25,
      },
      { io: captureIo().io, ensureDaemonReady: ready, client },
    );
    await runAgenCRunCli(
      { kind: "cancel", runId: "run-1", reason: "deadline" },
      { io: captureIo().io, ensureDaemonReady: ready, client },
    );

    expect(request).toHaveBeenNthCalledWith(1, "run.replay", {
      runId: "run-1",
      afterSequence: 12,
      limit: 25,
    });
    expect(request).toHaveBeenNthCalledWith(2, "run.cancel", {
      runId: "run-1",
      reason: "deadline",
    });
  });

  it("returns a nonzero exit code for daemon errors", async () => {
    const output = captureIo();
    const client = {
      request: vi.fn(async () => {
        throw new Error("RUN_NOT_FOUND");
      }),
    } as unknown as AgenCJsonLineDaemonRequestClient;

    const code = await runAgenCRunCli(
      { kind: "result", runId: "missing" },
      { io: output.io, ensureDaemonReady: async () => {}, client },
    );

    expect(code).toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("RUN_NOT_FOUND");
  });
});
