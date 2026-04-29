import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runAgencCli } from "./agenc.js";

function captureStream(): { stream: Writable; data: () => string } {
  let data = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    data: () => data,
  };
}

describe("agenc launcher CLI", () => {
  it("launches the general shell by default", async () => {
    const runOperatorConsole = vi.fn().mockResolvedValue(0);
    const runUiCommand = vi.fn().mockResolvedValue(0);
    const runCli = vi.fn().mockResolvedValue(0);

    const code = await runAgencCli(
      {
        argv: [],
      },
      {
        runOperatorConsole,
        runUiCommand,
        runCli,
      },
    );

    expect(code).toBe(0);
    expect(runCli).toHaveBeenCalledWith({
      argv: ["shell"],
      stdout: expect.any(Writable),
      stderr: expect.any(Writable),
    });
    expect(runOperatorConsole).not.toHaveBeenCalled();
    expect(runUiCommand).not.toHaveBeenCalled();
  });

  it("passes shell flags through to the runtime shell command when no subcommand is provided", async () => {
    const runOperatorConsole = vi.fn().mockResolvedValue(0);
    const runUiCommand = vi.fn().mockResolvedValue(0);
    const runCli = vi.fn().mockResolvedValue(0);

    await runAgencCli(
      {
        argv: [
          "--profile",
          "coding",
          "--config",
          "/tmp/agenc.json",
          "--pid-path",
          "/tmp/agenc.pid",
          "--new",
        ],
        cwd: "/workspace/demo",
        env: {
          DEMO: "1",
        },
      },
      {
        runOperatorConsole,
        runUiCommand,
        runCli,
      },
    );

    expect(runCli).toHaveBeenCalledWith({
      argv: [
        "shell",
        "--profile",
        "coding",
        "--config",
        "/tmp/agenc.json",
        "--pid-path",
        "/tmp/agenc.pid",
        "--new",
      ],
      stdout: expect.any(Writable),
      stderr: expect.any(Writable),
    });
    expect(runOperatorConsole).not.toHaveBeenCalled();
    expect(runUiCommand).not.toHaveBeenCalled();
  });

  it("forwards explicit agenc shell subcommands to agenc-runtime", async () => {
    const runOperatorConsole = vi.fn().mockResolvedValue(0);
    const runUiCommand = vi.fn().mockResolvedValue(0);
    const runCli = vi.fn().mockResolvedValue(0);
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runAgencCli(
      {
        argv: ["shell", "coding", "--new"],
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
      {
        runOperatorConsole,
        runUiCommand,
        runCli,
      },
    );

    expect(code).toBe(0);
    expect(runCli).toHaveBeenCalledWith({
      argv: ["shell", "coding", "--new"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(runOperatorConsole).not.toHaveBeenCalled();
    expect(runUiCommand).not.toHaveBeenCalled();
  });

  it("routes agenc ui to the dashboard launcher with no-open support", async () => {
    const runOperatorConsole = vi.fn().mockResolvedValue(0);
    const runUiCommand = vi.fn().mockResolvedValue(0);
    const runCli = vi.fn().mockResolvedValue(1);
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runAgencCli(
      {
        argv: ["ui", "--config", "/tmp/agenc.json", "--no-open"],
        stdout: stdout.stream,
        stderr: stderr.stream,
        cwd: "/workspace/demo",
        env: { DEMO: "1" },
      },
      {
        runOperatorConsole,
        runUiCommand,
        runCli,
      },
    );

    expect(code).toBe(0);
    expect(runUiCommand).toHaveBeenCalledWith({
      configPath: "/tmp/agenc.json",
      pidPath: undefined,
      logLevel: undefined,
      yolo: undefined,
      open: false,
      cwd: "/workspace/demo",
      env: { DEMO: "1" },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(runOperatorConsole).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
  });

  it("forwards explicit runtime subcommands to agenc-runtime", async () => {
    const runOperatorConsole = vi.fn().mockResolvedValue(0);
    const runUiCommand = vi.fn().mockResolvedValue(0);
    const runCli = vi.fn().mockResolvedValue(0);
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runAgencCli(
      {
        argv: ["status", "--pid-path", "/tmp/agenc.pid"],
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
      {
        runOperatorConsole,
        runUiCommand,
        runCli,
      },
    );

    expect(code).toBe(0);
    expect(runCli).toHaveBeenCalledWith({
      argv: ["status", "--pid-path", "/tmp/agenc.pid"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(runOperatorConsole).not.toHaveBeenCalled();
    expect(runUiCommand).not.toHaveBeenCalled();
  });

  it("shows launcher help without touching the daemon path", async () => {
    const runOperatorConsole = vi.fn().mockResolvedValue(0);
    const runUiCommand = vi.fn().mockResolvedValue(0);
    const runCli = vi.fn().mockResolvedValue(0);
    const stdout = captureStream();

    const code = await runAgencCli(
      {
        argv: ["--help"],
        stdout: stdout.stream,
      },
      {
        runOperatorConsole,
        runUiCommand,
        runCli,
      },
    );

    expect(code).toBe(0);
    expect(stdout.data()).toContain("agenc [--profile <name>]");
    expect(stdout.data()).toContain("agenc shell [profile]");
    expect(stdout.data()).toContain("agenc plan | agents | tasks | files | grep | git | branch | worktree | diff | review");
    expect(stdout.data()).toContain("agenc agents roles");
    expect(stdout.data()).toContain("agenc ui");
    expect(stdout.data()).toContain("agenc init");
    expect(stdout.data()).toContain("agenc status");
    expect(runOperatorConsole).not.toHaveBeenCalled();
    expect(runUiCommand).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
  });

  it("rejects unexpected console positional arguments", async () => {
    const runOperatorConsole = vi.fn().mockResolvedValue(0);
    const runUiCommand = vi.fn().mockResolvedValue(0);
    const runCli = vi.fn().mockResolvedValue(0);
    const stderr = captureStream();

    const code = await runAgencCli(
      {
        argv: ["console", "extra"],
        stderr: stderr.stream,
      },
      {
        runOperatorConsole,
        runUiCommand,
        runCli,
      },
    );

    expect(code).toBe(2);
    expect(stderr.data()).toContain(
      "agenc console does not accept positional arguments",
    );
    expect(runOperatorConsole).not.toHaveBeenCalled();
    expect(runUiCommand).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
  });

  it("rejects unexpected agenc ui positional arguments", async () => {
    const runOperatorConsole = vi.fn().mockResolvedValue(0);
    const runUiCommand = vi.fn().mockResolvedValue(0);
    const runCli = vi.fn().mockResolvedValue(0);
    const stderr = captureStream();

    const code = await runAgencCli(
      {
        argv: ["ui", "extra"],
        stderr: stderr.stream,
      },
      {
        runOperatorConsole,
        runUiCommand,
        runCli,
      },
    );

    expect(code).toBe(2);
    expect(stderr.data()).toContain("agenc ui does not accept positional arguments");
    expect(runOperatorConsole).not.toHaveBeenCalled();
    expect(runUiCommand).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
  });
});
