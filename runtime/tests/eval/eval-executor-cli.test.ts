import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import { isDirectInvocation, main } from "../../src/eval-executor/cli.js";

const FORTY_HEX = "0123456789abcdef0123456789abcdef01234567";

describe("eval executor CLI argument handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function silenceOutput(): { stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    return { stdout, stderr };
  }

  test("prints usage to stderr with exit 2 when no command is given", async () => {
    const output = silenceOutput();
    await expect(main([])).resolves.toBe(2);
    expect(output.stderr.join("")).toContain("Usage:");
    expect(output.stdout.join("")).toBe("");
  });

  test("honors --help before and after a command with exit 0", async () => {
    const output = silenceOutput();
    await expect(main(["--help"])).resolves.toBe(0);
    await expect(main(["preflight", "--help"])).resolves.toBe(0);
    await expect(main(["run-agent", "--task", "t", "-h"])).resolves.toBe(0);
    expect(output.stdout.join("")).toContain("Usage:");
    expect(output.stderr.join("")).toBe("");
  });

  test("rejects an unknown command with exit 2", async () => {
    const output = silenceOutput();
    await expect(main(["bogus"])).resolves.toBe(2);
    expect(output.stderr.join("")).toContain("Unknown command bogus");
  });

  test("turns option parser failures into executor errors with a usage hint", async () => {
    silenceOutput();
    await expect(main(["verify-lock", "--lock"])).rejects.toThrow(
      /argument missing.*run with --help for usage/u,
    );
    await expect(main(["preflight", "--task", "x", "stray"])).rejects.toThrow(
      /positional.*run with --help for usage/u,
    );
  });

  test("requires the subcommand's mandatory options before touching the lock", async () => {
    silenceOutput();
    await expect(main(["preflight"])).rejects.toThrow(/preflight requires --task/u);
    await expect(main(["run-agent", "--task", "t"])).rejects.toThrow(
      /run-agent requires --task <instanceId> and --overlay <dir>/u,
    );
    await expect(
      main(["run-agent-real", "--task", "t", "--overlay", "o", "--provider-host", "h"]),
    ).rejects.toThrow(/requires --provider-host, --provider-base-url, and --provider-model/u);
  });

  test.each(["0x10", "1e3", "0", "", " 12", "12.0", "+7"])(
    "rejects --agent-timeout-ms %j instead of coercing it",
    async (raw) => {
      silenceOutput();
      await expect(
        main(["run-agent", "--task", "t", "--overlay", "o", "--agent-timeout-ms", raw]),
      ).rejects.toThrow(/--agent-timeout-ms must be a decimal integer of at least 1/u);
    },
  );

  test.each(["", "0x1", "1e1", " 0"])(
    "rejects --seed-slot %j before running the trust suite",
    async (raw) => {
      silenceOutput();
      await expect(
        main(["trust-run", "--repository-commit", FORTY_HEX, "--seed-slot", raw]),
      ).rejects.toThrow(/--seed-slot must be a decimal integer of at least 0/u);
    },
  );

  test("rejects negative integer options at the option parser", async () => {
    // node:util parseArgs treats a leading dash as another option, so a
    // negative number never reaches the integer check; it still fails closed.
    silenceOutput();
    await expect(
      main(["run-agent", "--task", "t", "--overlay", "o", "--agent-timeout-ms", "-5"]),
    ).rejects.toThrow(/ambiguous[\s\S]*run with --help for usage/u);
    await expect(
      main(["trust-run", "--repository-commit", FORTY_HEX, "--seed-slot", "-1"]),
    ).rejects.toThrow(/ambiguous[\s\S]*run with --help for usage/u);
  });

  test("rejects a --tasks list that repeats a task id", async () => {
    silenceOutput();
    await expect(
      main([
        "run-agent-real-batch",
        "--overlay",
        "o",
        "--provider-host",
        "h",
        "--provider-base-url",
        "u",
        "--provider-model",
        "m",
        "--tasks",
        "a, b ,a",
      ]),
    ).rejects.toThrow(/--tasks must not repeat a task id/u);
    await expect(
      main([
        "run-agent-real-batch",
        "--overlay",
        "o",
        "--provider-host",
        "h",
        "--provider-base-url",
        "u",
        "--provider-model",
        "m",
        "--tasks",
        " , ",
      ]),
    ).rejects.toThrow(/--tasks must name at least one task id/u);
  });

  test("recognizes a direct invocation through a URL-significant checkout path", () => {
    for (const scriptPath of [
      "/tmp/agenc#core/runtime/src/eval-executor/cli.ts",
      "/tmp/agenc%core/cli.ts",
      "/tmp/agenc core/cli.ts",
      "/tmp/plain/cli.ts",
    ]) {
      expect(isDirectInvocation(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
    }
    expect(isDirectInvocation(pathToFileURL("/tmp/a/cli.ts").href, "/tmp/b/cli.ts")).toBe(false);
    expect(isDirectInvocation(pathToFileURL("/tmp/a/cli.ts").href, undefined)).toBe(false);
  });
});
