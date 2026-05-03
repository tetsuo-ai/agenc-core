import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readRotatedToolOutputLog,
  recordInFlightToolCallCompletion,
  recordInFlightToolCallStart,
  resolveToolOutputLogPath,
} from "./tool-output-rotation.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-tool-output-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-tool-output-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("tool outputRotation persistence", () => {
  it("caps output_partial and spills overflow to bounded rotated logs", () => {
    const outputRotation = {
      outputPartialMaxBytes: 5,
      logMaxBytes: 4,
      rotatedLogCount: 2,
    };
    recordInFlightToolCallStart(driver, {
      sessionId: "session-1",
      agentId: "agent-1",
      toolCallId: "tool-1",
      toolName: "Bash",
      args: { command: "printf output" },
      startedAt: "2026-05-01T00:00:00.000Z",
      agencHome: home,
      outputRotation,
    });

    recordInFlightToolCallCompletion(driver, {
      sessionId: "session-1",
      agentId: "agent-1",
      toolCallId: "tool-1",
      toolName: "Bash",
      result: "abcdefghijklmnopqrstuvwxyz123",
      isError: false,
      completedAt: "2026-05-01T00:00:01.000Z",
      agencHome: home,
      outputRotation,
    });

    const outputLogPath = resolveToolOutputLogPath({
      agencHome: home,
      agentId: "agent-1",
      toolCallId: "tool-1",
    });
    expect(toolCallRow("session-1", "tool-1")).toEqual({
      status: "completed",
      output_partial: "abcde",
      output_log_path: outputLogPath,
      output_log_bytes: 12,
    });
    expect(readRotatedToolOutputLog(outputLogPath, outputRotation)).toBe(
      "rstuvwxyz123",
    );
    expect(statSync(outputLogPath).size).toBeLessThanOrEqual(4);
    expect(statSync(`${outputLogPath}.1`).size).toBeLessThanOrEqual(4);
    expect(statSync(`${outputLogPath}.2`).size).toBeLessThanOrEqual(4);
    expect(existsSync(`${outputLogPath}.3`)).toBe(false);
  });

  it("removes stale spill logs when a later output fits in the row cap", () => {
    const outputRotation = {
      outputPartialMaxBytes: 5,
      logMaxBytes: 4,
      rotatedLogCount: 1,
    };
    recordInFlightToolCallStart(driver, {
      sessionId: "session-2",
      agentId: "agent-2",
      toolCallId: "tool-2",
      toolName: "Read",
      args: null,
      startedAt: "2026-05-01T00:00:00.000Z",
      agencHome: home,
      outputRotation,
    });
    recordInFlightToolCallCompletion(driver, {
      sessionId: "session-2",
      agentId: "agent-2",
      toolCallId: "tool-2",
      result: "abcdefghi",
      isError: false,
      completedAt: "2026-05-01T00:00:01.000Z",
      agencHome: home,
      outputRotation,
    });
    const outputLogPath = resolveToolOutputLogPath({
      agencHome: home,
      agentId: "agent-2",
      toolCallId: "tool-2",
    });
    expect(readFileSync(outputLogPath, "utf8")).toBe("fghi");

    recordInFlightToolCallCompletion(driver, {
      sessionId: "session-2",
      agentId: "agent-2",
      toolCallId: "tool-2",
      result: "ok",
      isError: false,
      completedAt: "2026-05-01T00:00:02.000Z",
      agencHome: home,
      outputRotation,
    });

    expect(toolCallRow("session-2", "tool-2")).toEqual({
      status: "completed",
      output_partial: "ok",
      output_log_path: null,
      output_log_bytes: 0,
    });
    expect(existsSync(outputLogPath)).toBe(false);
    expect(existsSync(`${outputLogPath}.1`)).toBe(false);
  });

  it("sanitizes dot-only and traversal-like agent log path segments", () => {
    const logsRoot = join(home, "agent-logs");
    const outputLogPath = resolveToolOutputLogPath({
      agencHome: home,
      agentId: "..",
      toolCallId: ".",
    });
    const relativePath = relative(logsRoot, outputLogPath);

    expect(relativePath.startsWith("..")).toBe(false);
    expect(relativePath).not.toContain("/../");
    expect(outputLogPath).not.toBe(join(home, ".log"));
  });

  it("bounds overflow writes to the retained rotation capacity", () => {
    const outputRotation = {
      outputPartialMaxBytes: 2,
      logMaxBytes: 3,
      rotatedLogCount: 1,
    };
    const retainedTail = "xxTAIL";
    recordInFlightToolCallCompletion(driver, {
      sessionId: "session-large",
      agentId: "agent-large",
      toolCallId: "tool-large",
      result: `ab${"x".repeat(10_000)}TAIL`,
      isError: false,
      completedAt: "2026-05-01T00:00:00.000Z",
      agencHome: home,
      outputRotation,
    });
    const outputLogPath = resolveToolOutputLogPath({
      agencHome: home,
      agentId: "agent-large",
      toolCallId: "tool-large",
    });

    expect(toolCallRow("session-large", "tool-large")).toEqual({
      status: "completed",
      output_partial: "ab",
      output_log_path: outputLogPath,
      output_log_bytes: retainedTail.length,
    });
    expect(readRotatedToolOutputLog(outputLogPath, outputRotation)).toBe(
      retainedTail,
    );
    expect(existsSync(`${outputLogPath}.2`)).toBe(false);
  });

  it("keeps retained UTF-8 log tails on code point boundaries", () => {
    const outputRotation = {
      outputPartialMaxBytes: 0,
      logMaxBytes: 5,
      rotatedLogCount: 0,
    };
    recordInFlightToolCallCompletion(driver, {
      sessionId: "session-utf8",
      agentId: "agent-utf8",
      toolCallId: "tool-utf8",
      result: "🙂🙂",
      isError: false,
      completedAt: "2026-05-01T00:00:00.000Z",
      agencHome: home,
      outputRotation,
    });
    const outputLogPath = resolveToolOutputLogPath({
      agencHome: home,
      agentId: "agent-utf8",
      toolCallId: "tool-utf8",
    });

    expect(toolCallRow("session-utf8", "tool-utf8")).toEqual({
      status: "completed",
      output_partial: null,
      output_log_path: outputLogPath,
      output_log_bytes: 4,
    });
    expect(readRotatedToolOutputLog(outputLogPath, outputRotation)).toBe("🙂");
  });
});

function toolCallRow(
  sessionId: string,
  toolCallId: string,
): {
  readonly status: string;
  readonly output_partial: string | null;
  readonly output_log_path: string | null;
  readonly output_log_bytes: number;
} {
  const row = driver
    .prepareState<
      [string, string],
      {
        status: string;
        output_partial: string | null;
        output_log_path: string | null;
        output_log_bytes: number;
      }
    >(
      `SELECT status, output_partial, output_log_path, output_log_bytes
       FROM in_flight_tool_calls
       WHERE session_id = ?
         AND tool_call_id = ?`,
    )
    .get(sessionId, toolCallId);
  if (row === undefined) throw new Error("tool call row missing");
  return row;
}
