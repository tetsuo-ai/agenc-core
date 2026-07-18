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
