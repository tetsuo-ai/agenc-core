import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ErrorLogSidecar } from "./error-log.js";

describe("ErrorLogSidecar", () => {
  let project = "";

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "agenc-errorlog-"));
  });
  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test("writes error event to dated JSONL file", async () => {
    const sidecar = new ErrorLogSidecar({
      projectDir: project,
      sessionId: "sess-1",
    });
    await sidecar.start();
    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: {
        type: "error",
        payload: { cause: "disk_full", message: "ENOSPC" },
      },
    });
    sidecar.flushNow();
    const files = readdirSync(join(project, "errors"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const logFile = files.find((f) => f.endsWith(".jsonl"));
    expect(logFile).toBeDefined();
    const contents = readFileSync(join(project, "errors", logFile!), "utf8");
    expect(contents).toContain('"cause":"disk_full"');
    expect(contents).toContain('"message":"ENOSPC"');
    await sidecar.stop();
  });

  test("per-MCP-server partition when server field present", async () => {
    const sidecar = new ErrorLogSidecar({
      projectDir: project,
      sessionId: "sess-1",
    });
    await sidecar.start();
    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: {
        type: "warning",
        payload: {
          cause: "mcp_startup_slow",
          message: "github took 8s",
          server: "github",
        } as unknown as { cause: string; message: string },
      },
    });
    sidecar.flushNow();
    const mcpDir = join(project, "errors", "mcp", "github");
    const files = readdirSync(mcpDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    await sidecar.stop();
  });
});
