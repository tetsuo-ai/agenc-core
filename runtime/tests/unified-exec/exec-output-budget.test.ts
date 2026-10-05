import { describe, expect, test } from "vitest";

import { UnifiedExecProcessManager } from "./process-manager.js";

const OMITTED_MARKER = /\n\[\.\.\. omitted \d+ chars \.\.\.\]\n/;
/** The default budget of one result: 10,000 tokens at 4 chars per token. */
const DEFAULT_BUDGET_CHARS = 40_000;

/** A shell pipeline that prints `count` copies of `char` and no newline. */
function flood(char: string, count: number): string {
  return `head -c ${count} /dev/zero | tr '\\0' ${char}`;
}

async function withManager<T>(
  run: (manager: UnifiedExecProcessManager) => Promise<T>,
): Promise<T> {
  const manager = new UnifiedExecProcessManager({
    cwd: process.cwd(),
    shellPath: "/bin/sh",
  });
  try {
    return await run(manager);
  } finally {
    await manager.closeAll("test cleanup");
  }
}

describe("exec output budget", () => {
  test("stdout and stderr share the default budget", async () => {
    if (process.platform === "win32") return;
    const result = await withManager((manager) =>
      manager.execCommand({
        cmd: `printf OUT_HEAD; ${flood("o", 100_000)}; { printf ERR_HEAD; ${flood("e", 100_000)}; } >&2`,
        yield_time_ms: 10_000,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.output).toBe(`${result.stdout}${result.stderr}`);
    expect(result.output.length).toBeLessThanOrEqual(DEFAULT_BUDGET_CHARS);
    expect(result.stdout).toMatch(/^OUT_HEAD/);
    expect(result.stdout).toMatch(OMITTED_MARKER);
    expect(result.stderr).toMatch(/^ERR_HEAD/);
    expect(result.stderr).toMatch(OMITTED_MARKER);
  });

  test("a short stderr survives whole next to a flooding stdout", async () => {
    if (process.platform === "win32") return;
    const summary = "error: 3 of 120 tests failed";
    const result = await withManager((manager) =>
      manager.execCommand({
        cmd: `printf '%s' '${summary}' >&2; ${flood("o", 200_000)}`,
        yield_time_ms: 10_000,
      }),
    );

    expect(result.stderr).toBe(summary);
    expect(result.output.endsWith(summary)).toBe(true);
    expect(result.output.length).toBe(DEFAULT_BUDGET_CHARS);
    expect(result.stdout).toMatch(OMITTED_MARKER);
  });

  test("an explicit max_output_tokens above 25,000 is clamped", async () => {
    if (process.platform === "win32") return;
    const result = await withManager((manager) =>
      manager.execCommand({
        cmd: flood("o", 150_000),
        yield_time_ms: 10_000,
        max_output_tokens: 1_000_000,
      }),
    );

    expect(result.truncated).toBe(true);
    expect(result.output.length).toBe(100_000);
  });

  test("a write_stdin poll applies an explicit budget to the whole result", async () => {
    if (process.platform === "win32") return;
    await withManager(async (manager) => {
      const started = await manager.execCommand({
        cmd: `sleep 0.5; ${flood("o", 20_000)}; ${flood("e", 20_000)} >&2`,
        yield_time_ms: 250,
      });
      expect(started.process_id).toEqual(expect.any(Number));

      const polled = await manager.writeStdin({
        session_id: started.process_id!,
        chars: "",
        max_output_tokens: 500,
      });

      expect(polled.exitCode).toBe(0);
      expect(polled.stdout.length).toBe(1_000);
      expect(polled.stderr.length).toBe(1_000);
      expect(polled.output.length).toBe(2_000);
    });
  });
});
