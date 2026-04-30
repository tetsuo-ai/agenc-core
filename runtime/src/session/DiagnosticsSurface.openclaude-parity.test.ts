import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ErrorLogSidecar, classifyErrorLogEvent } from "./error-log.js";
import type { Event } from "./event-log.js";

describe("OpenClaude diagnostics surface parity", () => {
  let project = "";

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "agenc-diagnostics-"));
  });

  afterEach(() => {
    if (project.length > 0) rmSync(project, { recursive: true, force: true });
  });

  test("internal provider diagnostics do not persist as user error logs", async () => {
    const event = {
      id: "diag-1",
      seq: 1,
      msg: {
        type: "warning",
        payload: {
          cause: "llm_request_metadata",
          message: "request shape",
          visibility: "internal",
          surface: "debug",
        },
      },
    } as Event;

    expect(classifyErrorLogEvent(event)).toMatchObject({
      persist: false,
      reason: "internal",
    });

    const sidecar = new ErrorLogSidecar({
      projectDir: project,
      sessionId: "session-1",
    });
    await sidecar.start();
    sidecar.onEvent(event);
    sidecar.flushNow();

    const errorsDir = join(project, "errors");
    const errorFiles = existsSync(errorsDir)
      ? readdirSync(errorsDir).filter((name) => name.endsWith(".jsonl"))
      : [];
    expect(errorFiles).toEqual([]);
    await sidecar.stop();
  });

  test("actionable warnings persist as sanitized records", async () => {
    const sidecar = new ErrorLogSidecar({
      projectDir: project,
      sessionId: "session-1",
    });
    await sidecar.start();
    sidecar.onEvent({
      id: "warning-1",
      seq: 1,
      msg: {
        type: "warning",
        payload: {
          cause: "mcp_startup_failed",
          message: "server failed",
          server: "github",
        },
      },
    });
    sidecar.flushNow();

    const files = readdirSync(join(project, "errors", "mcp", "github"));
    const entry = JSON.parse(
      readFileSync(join(project, "errors", "mcp", "github", files[0]!), "utf8"),
    );

    expect(entry).toMatchObject({
      level: "warning",
      cause: "mcp_startup_failed",
      server: "github",
    });
    expect(entry).not.toHaveProperty("raw");
    await sidecar.stop();
  });
});
