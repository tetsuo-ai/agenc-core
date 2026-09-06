import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createFilesystemTools } from "../../../src/tools/system/filesystem.js";
import { createKillProcessTool } from "../../../src/tools/system/kill-process.js";
import { createMonitorTool } from "../../../src/tools/system/monitor.js";
import { createSleepTool } from "../../../src/tools/system/sleep.js";
import {
  UnifiedExecError,
  type UnifiedExecProcessManagerLike,
} from "../../../src/unified-exec/types.js";
import type { ToolResult } from "../../../src/tools/types.js";

// #2190: a bare isError from a side-effecting tool is filed as an unknown
// outcome and gates the session behind /resolve. Every refusal below happens
// before the tool touches anything and must say so.

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-pre-effect-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function expectNoEffect(result: ToolResult, contains: string): void {
  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain(contains);
  expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
}

function manager(terminate?: UnifiedExecProcessManagerLike["terminateProcess"]) {
  const base: UnifiedExecProcessManagerLike = {
    maxTimeoutMs: 30_000,
    execCommand: vi.fn(async () => undefined as never),
    writeStdin: vi.fn(async () => undefined as never),
    closeAll: vi.fn(async () => {}),
  };
  return terminate === undefined ? base : { ...base, terminateProcess: terminate };
}

describe("kill_process refusals", () => {
  test("a rejected argument", async () => {
    const tool = createKillProcessTool({ unifiedExecManager: manager(() => ({ terminated: true })) });
    expectNoEffect(await tool.execute({}), "session_id must be a number");
  });

  test("a runtime without process termination", async () => {
    const tool = createKillProcessTool({ unifiedExecManager: manager() });
    expectNoEffect(await tool.execute({ session_id: 4 }), "not supported");
  });

  test("a manager that refuses before signalling", async () => {
    const tool = createKillProcessTool({
      unifiedExecManager: manager(() => {
        throw new UnifiedExecError("owner_denied", "process belongs to another turn");
      }),
    });
    expectNoEffect(await tool.execute({ session_id: 4 }), "another turn");
  });
});

describe("sleep refusals", () => {
  test("a rejected argument", async () => {
    expectNoEffect(await createSleepTool().execute({}), "durationMs");
  });

  test("an interrupted wait", async () => {
    const controller = new AbortController();
    const pending = createSleepTool().execute({
      durationMs: 60_000,
      __abortSignal: controller.signal,
    });
    controller.abort();
    expectNoEffect(await pending, "Sleep interrupted");
  });
});

describe("monitor refusals", () => {
  test("a rejected argument", async () => {
    const tool = createMonitorTool({ cwd: root, unifiedExecManager: manager() });
    expectNoEffect(await tool.execute({ description: "list files" }), "command must be");
  });
});

describe("filesystem refusals before mkdir, rm or rename", () => {
  function toolNamed(name: string) {
    const tool = createFilesystemTools({ allowedPaths: [root], allowDelete: true }).find(
      (candidate) => candidate.name === name,
    );
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool;
  }

  test("a path outside the allowed roots", async () => {
    expectNoEffect(
      await toolNamed("system.mkdir").execute({ path: "/etc/agenc-no" }),
      "Access denied",
    );
    expectNoEffect(
      await toolNamed("system.delete").execute({ path: "/etc/passwd" }),
      "Access denied",
    );
  });

  test("a missing path", async () => {
    expectNoEffect(
      await toolNamed("system.delete").execute({ path: join(root, "missing.txt") }),
      "Path not found",
    );
    expectNoEffect(
      await toolNamed("system.move").execute({
        source: join(root, "missing.txt"),
        destination: join(root, "moved.txt"),
      }),
      "not found",
    );
  });

  test("a rejected argument", async () => {
    expectNoEffect(await toolNamed("system.delete").execute({}), "must be a non-empty string");
  });
});
