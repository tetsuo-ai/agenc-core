import { describe, expect, it } from "vitest";

import { createBashTool as createUnboundBashTool } from "../../../src/tools/system/bash.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";

const createBashTool = (
  config?: Parameters<typeof createUnboundBashTool>[0],
) => bindExplicitDangerBoundary(createUnboundBashTool(config));

// M-EXEC-2 (core-todo.md): the shell-mode spawn path (runSpawnedCommand) accumulated
// every stdout/stderr chunk into an unbounded Buffer[] and only truncated at flush, so
// a fast, huge emitter could OOM the daemon before truncation. The fix caps retention
// at 2x maxOutputBytes (matching the direct-mode execFile maxBuffer). truncate() keeps
// only the first maxOutputBytes, so the emitted output is unchanged — this test pins
// that correctness (large shell-mode output still truncates cleanly with the marker).
// NOTE: the memory bound is a transient heap peak with identical output, so it is not
// separately unit-assertable; this is a correctness-preservation test.

function parseMetadata(result: { metadata?: unknown }): Record<string, unknown> {
  return (result.metadata ?? {}) as Record<string, unknown>;
}

describe("bash shell-mode output cap — M-EXEC-2", () => {
  it("truncates large shell-mode output to the byte cap with the marker", async () => {
    const maxOutputBytes = 2000;
    const tool = createBashTool({ maxOutputBytes });
    // A pipe forces shell mode (runSpawnedCommand). Emit ~500KB — far beyond the
    // 2x retention cap — and confirm the result is cleanly truncated, not corrupt.
    const result = await tool.execute({
      command:
        "node -e \"process.stdout.write('x'.repeat(500000))\" | cat",
    });

    const meta = parseMetadata(result);
    expect(meta.truncated).toBe(true);
    const stdout = String(meta.stdout ?? "");
    // Kept prefix stays within the cap (+ the "[truncated]" marker line).
    expect(Buffer.byteLength(stdout, "utf8")).toBeLessThanOrEqual(maxOutputBytes + 32);
    expect(stdout).toContain("[truncated]");
    // The retained head is the real output, not garbage.
    expect(stdout.startsWith("x")).toBe(true);
  }, 20_000);

  it("does not truncate small shell-mode output", async () => {
    const tool = createBashTool({ maxOutputBytes: 2000 });
    const result = await tool.execute({ command: "echo hello | cat" });
    const meta = parseMetadata(result);
    expect(meta.truncated).toBe(false);
    expect(String(meta.stdout ?? "")).toContain("hello");
  }, 20_000);
});
