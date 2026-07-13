/**
 * Tests for `Monitor` — AgenC monitor tool contract.
 * Verifies schema parity, the upstream-style result-content sentence,
 * and that the tool wires through to AgenC's `unifiedExecManager`.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import { createMonitorTool } from "./monitor.js";

describe("Monitor (AgenC port)", () => {
  let manager: UnifiedExecProcessManager;

  beforeEach(() => {
    manager = new UnifiedExecProcessManager({
      cwd: process.cwd(),
      maxTimeoutMs: 5_000,
    });
  });

  afterEach(async () => {
    await manager.closeAll("test_cleanup");
  });

  test("rejects empty command", async () => {
    const tool = createMonitorTool({
      cwd: process.cwd(),
      unifiedExecManager: manager,
    });
    const result = await tool.execute({
      description: "list files",
    });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("command must be a non-empty");
  });

  test("rejects empty description", async () => {
    const tool = createMonitorTool({
      cwd: process.cwd(),
      unifiedExecManager: manager,
    });
    const result = await tool.execute({
      command: "ls",
    });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("description must be a non-empty");
  });

  test("emits the upstream-style result content with task id and output stream URI", async () => {
    const tool = createMonitorTool({
      cwd: process.cwd(),
      unifiedExecManager: manager,
    });
    const result = await tool.execute({
      command: "printf agenc-monitor",
      description: "smoke",
    });
    expect(result.isError).toBeUndefined();
    const content = String(result.content);
    // Verbatim port of AgenC MonitorTool.ts:140-145 sentence
    // structure (taskId / outputFile / 1s polling).
    expect(content).toContain("Monitor task started with ID:");
    expect(content).toContain("Output is being streamed to:");
    expect(content).toContain("notifications as new output lines appear");

    const meta = result.metadata as Record<string, unknown>;
    expect(typeof meta.taskId).toBe("string");
    expect(typeof meta.outputFile).toBe("string");
    expect(String(meta.outputFile)).toMatch(/^agenc:\/\/exec\//);
    // The wrapped exec produced "agenc-monitor" on stdout.
    expect(meta.stdout).toBe("agenc-monitor");
    expect(meta.exitCode).toBe(0);
  });

  test("schema declares the verbatim AgenC fields", async () => {
    const tool = createMonitorTool({
      cwd: process.cwd(),
      unifiedExecManager: manager,
    });
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "command",
      "description",
    ]);
    expect(schema.required.sort()).toEqual(["command", "description"]);
  });

  test("description accurately states the ~30s streaming window (M-EXEC-1)", async () => {
    const tool = createMonitorTool({
      cwd: process.cwd(),
      unifiedExecManager: manager,
    });
    expect(tool.description).toContain(
      "Execute a shell command in the background and stream its stdout line-by-line as notifications",
    );
    // The donor's inaccurate "(~1s)" continuous-polling claim was removed: streaming
    // is clamped to ~30s and the model must poll afterward via write_stdin.
    expect(tool.description).not.toContain("(~1s)");
    expect(tool.description).toContain("30 seconds");
    expect(tool.description).toContain('write_stdin(session_id, "")');
    expect(tool.description).toContain("monitoring logs");
    // AgenC adapts only the trailing reference: AgenC says
    // "Bash with run_in_background"; AgenC wires to exec_command.
    expect(tool.description).toContain("exec_command with a short yield_time_ms");
  });
});
