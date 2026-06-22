import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ErrorLogSidecar } from "./error-log.js";
import type { Event } from "./event-log.js";
import { StateSqliteReader } from "../state/sqlite-driver.js";

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
    expect(JSON.parse(contents.trim())).not.toHaveProperty("raw");
    await sidecar.stop();
  });

  test.each([
    "llm_request_metadata",
    "tool_routing_classified",
    "mode_changed",
    "mode_changed_to_plan",
    "mode_exited_plan",
    "memory_extract_failed",
    "memory_extract_parse_failed",
    "memory_extract_timeout",
    "compact_prompt_build_slow",
    "compact_tool_result_dropped",
  ])("does not persist internal warning cause %s", async (cause) => {
    const sidecar = new ErrorLogSidecar({
      projectDir: project,
      sessionId: "sess-1",
    });
    await sidecar.start();
    sidecar.onEvent({
      id: "metadata-1",
      seq: 1,
      msg: {
        type: "warning",
        payload: {
          cause,
          message: `internal diagnostic ${cause}`,
        },
      },
    });
    sidecar.flushNow();
    const files = readdirSync(join(project, "errors")).filter((file) =>
      file.endsWith(".jsonl"),
    );
    expect(files).toHaveLength(0);
    await sidecar.stop();
  });

  test("classifies internal diagnostics semantically instead of by one-off cause names", async () => {
    const errorLog = await import("./error-log.js") as unknown as {
      classifyErrorLogEvent?: (event: Event) => {
        readonly persist: boolean;
        readonly reason?: string;
      };
    };
    expect(errorLog.classifyErrorLogEvent).toBeTypeOf("function");

    const internalDiagnostic = errorLog.classifyErrorLogEvent?.({
      id: "internal-1",
      seq: 1,
      msg: {
        type: "warning",
        payload: {
          cause: "provider_request_shape_changed",
          message: "debug details",
          visibility: "internal",
          surface: "debug",
        },
      },
    } as unknown as Event);
    expect(internalDiagnostic).toMatchObject({
      persist: false,
      reason: "internal",
    });

    const actionableWarning = errorLog.classifyErrorLogEvent?.({
      id: "warning-1",
      seq: 2,
      msg: {
        type: "warning",
        payload: {
          cause: "mcp_startup_failed",
          message: "github failed to start",
          visibility: "user",
        },
      },
    } as unknown as Event);
    expect(actionableWarning).toMatchObject({ persist: true });

    const arrayPayloadWarning = errorLog.classifyErrorLogEvent?.({
      id: "array-warning-1",
      seq: 3,
      msg: {
        type: "warning",
        payload: Object.assign(["debug details"], {
          cause: "compact_prompt_build_slow",
          visibility: "internal",
          surface: "debug",
        }),
      },
    } as unknown as Event);
    expect(arrayPayloadWarning).toMatchObject({ persist: true });
  });

  test("writes actionable warnings as sanitized entries", async () => {
    const sidecar = new ErrorLogSidecar({
      projectDir: project,
      sessionId: "sess-1",
    });
    await sidecar.start();
    sidecar.onEvent({
      id: "warning-1",
      seq: 1,
      msg: {
        type: "warning",
        payload: {
          cause: "mcp_startup_failed",
          message: "github failed to start",
          server: "github",
        },
      },
    });
    sidecar.flushNow();
    const files = readdirSync(join(project, "errors", "mcp", "github"));
    const logFile = files.find((file) => file.endsWith(".jsonl"));
    expect(logFile).toBeDefined();
    const entry = JSON.parse(
      readFileSync(join(project, "errors", "mcp", "github", logFile!), "utf8").trim(),
    );
    expect(entry).toMatchObject({
      level: "warning",
      cause: "mcp_startup_failed",
      server: "github",
    });
    expect(entry).not.toHaveProperty("raw");
    await sidecar.stop();
  });

  test("writes sanitized stream errors without raw event envelopes", async () => {
    const sidecar = new ErrorLogSidecar({
      projectDir: project,
      sessionId: "sess-1",
    });
    await sidecar.start();
    sidecar.onEvent({
      id: "stream-1",
      seq: 1,
      msg: {
        type: "stream_error",
        payload: {
          cause: "provider_stream_failed",
          message: "stream closed early",
          provider: "openai",
        },
      },
    });
    sidecar.flushNow();
    const files = readdirSync(join(project, "errors"));
    const logFile = files.find((f) => f.endsWith(".jsonl"));
    expect(logFile).toBeDefined();
    const entry = JSON.parse(
      readFileSync(join(project, "errors", logFile!), "utf8").trim(),
    );
    expect(entry).toMatchObject({
      level: "stream_error",
      cause: "provider_stream_failed",
      provider: "openai",
    });
    expect(entry).not.toHaveProperty("raw");
    await sidecar.stop();
  });

  test("redacts secrets from error JSONL partitions and indexed logs", async () => {
    const sidecar = new ErrorLogSidecar({
      projectDir: project,
      sessionId: "sess-secret",
    });
    const rawSecret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456-";
    const opaqueSecret = "opaque-value-12345";
    await sidecar.start();
    sidecar.onEvent({
      id: "secret-error",
      seq: 1,
      msg: {
        type: "error",
        payload: {
          cause: "provider_failed",
          message: "Authorization: Bearer abcdefghijklmnop=",
          server: rawSecret,
          provider: rawSecret,
          stack: `api_key=${opaqueSecret}`,
        },
      },
    } as unknown as Event);
    sidecar.flushNow();

    const mcpServers = readdirSync(join(project, "errors", "mcp"));
    expect(mcpServers.join("\n")).not.toContain(rawSecret);
    const logFile = readdirSync(join(project, "errors", "mcp", mcpServers[0]!))
      .find((file) => file.endsWith(".jsonl"));
    expect(logFile).toBeDefined();
    const jsonl = readFileSync(
      join(project, "errors", "mcp", mcpServers[0]!, logFile!),
      "utf8",
    );
    expect(jsonl).not.toContain(rawSecret);
    expect(jsonl).not.toContain(opaqueSecret);
    expect(jsonl).not.toContain("abcdefghijklmnop=");
    expect(jsonl).toContain("[REDACTED_SECRET]");

    await sidecar.stop();
    const reader = new StateSqliteReader({
      projectDir: project,
      stateDbPath: join(project, "agenc-state_1.sqlite"),
      logsDbPath: join(project, "agenc-logs_1.sqlite"),
    });
    try {
      const row = reader.prepareLogs<
        [],
        { readonly message: string; readonly payload_json: string }
      >(
        `SELECT message, payload_json
         FROM logs
         ORDER BY id DESC
         LIMIT 1`,
      ).get();
      expect(row).toBeDefined();
      const persisted = `${row!.message}\n${row!.payload_json}`;
      expect(persisted).not.toContain(rawSecret);
      expect(persisted).not.toContain(opaqueSecret);
      expect(persisted).not.toContain("abcdefghijklmnop=");
      expect(persisted).toContain("[REDACTED_SECRET]");
    } finally {
      reader.close();
    }
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
