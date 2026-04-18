import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { ObservabilityService } from "./observability.js";
import {
  awaitTracePayloadDrain,
  persistTracePayloadArtifact,
} from "../utils/trace-payload-store.js";

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `agenc-observability-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function hasSqliteDependency(): boolean {
  try {
    require.resolve("better-sqlite3");
    return true;
  } catch {
    return false;
  }
}

const sqliteDescribe = hasSqliteDependency() ? describe : describe.skip;

function createService(
  logContents = "",
  options: { fanoutEnabled?: boolean } = {},
): ObservabilityService {
  const daemonLogPath = join(tempDir, "daemon.log");
  writeFileSync(daemonLogPath, logContents, "utf8");
  return new ObservabilityService({
    dbPath: join(tempDir, "observability.sqlite"),
    daemonLogPath,
    traceFanoutEnabled: options.fanoutEnabled,
  });
}

async function expectCompletedTraceState(
  service: ObservabilityService,
  traceId: string,
  lastEventName: string,
): Promise<void> {
  const traces = await service.listTraces();
  expect(traces).toHaveLength(1);
  expect(traces[0]?.traceId).toBe(traceId);
  expect(traces[0]?.status).toBe("completed");

  const detail = await service.getTrace(traceId);
  expect(detail?.summary.status).toBe("completed");
  expect(detail?.summary.lastEventName).toBe(lastEventName);
  expect(detail?.completeness.complete).toBe(true);

  const summary = await service.getSummary();
  expect(summary.traces.total).toBe(1);
  expect(summary.traces.completed).toBe(1);
  expect(summary.traces.open).toBe(0);
}

sqliteDescribe("ObservabilityService", () => {
  it("persists trace events and returns summaries/details", async () => {
    const artifact = persistTracePayloadArtifact({
      traceId: "trace-1",
      eventName: "webchat.provider.request",
      payload: { payload: { ok: true } },
    });
    expect(artifact?.path).toBeTruthy();
    const service = createService("line-1\nline-2 trace-1\n");

    service.recordEvent({
      eventName: "webchat.inbound",
      level: "info",
      traceId: "trace-1",
      sessionId: "session-1",
      payloadPreview: { ok: true },
      rawPayload: { sessionId: "session-1" },
      artifact,
    });
    service.recordEvent({
      eventName: "webchat.chat.response",
      level: "info",
      traceId: "trace-1",
      sessionId: "session-1",
      payloadPreview: { stopReason: "completed" },
      rawPayload: { stopReason: "completed" },
    });

    const traces = await service.listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.traceId).toBe("trace-1");
    expect(traces[0]?.status).toBe("completed");

    const detail = await service.getTrace("trace-1");
    expect(detail?.events).toHaveLength(2);
    expect(detail?.completeness.complete).toBe(true);

    const summary = await service.getSummary();
    expect(summary.traces.total).toBe(1);
    expect(summary.traces.completed).toBe(1);

    const artifactBody = await service.getArtifact(artifact!.path);
    expect((artifactBody.body as Record<string, unknown>).payload).toEqual({
      payload: { ok: true },
    });

    const logs = await service.getLogTail({ lines: 10, traceId: "trace-1" });
    expect(logs.path).toBe("daemon.log");
    expect(logs.lines).toEqual(["line-2 trace-1"]);

    await service.close();
  });

  it("marks traces incomplete when no terminal event is recorded", async () => {
    const service = createService();

    service.recordEvent({
      eventName: "webchat.inbound",
      level: "info",
      traceId: "trace-open",
      payloadPreview: {},
    });

    const detail = await service.getTrace("trace-open");
    expect(detail?.summary.status).toBe("open");
    expect(detail?.completeness.complete).toBe(false);
    expect(detail?.completeness.issues[0]).toContain("no terminal");

    await service.close();
  });

  it("treats handled slash-command traces as completed terminal traces", async () => {
    const service = createService();
    const now = Date.now();

    service.recordEvent({
      eventName: "webchat.inbound",
      level: "info",
      traceId: "trace-command",
      sessionId: "session-1",
      timestampMs: now,
      payloadPreview: { content: "/policy simulate system.delete {}" },
    });
    service.recordEvent({
      eventName: "webchat.command.reply",
      level: "info",
      traceId: "trace-command",
      sessionId: "session-1",
      timestampMs: now + 1,
      payloadPreview: { content: "Policy simulation..." },
    });
    service.recordEvent({
      eventName: "webchat.command.handled",
      level: "info",
      traceId: "trace-command",
      sessionId: "session-1",
      timestampMs: now + 2,
      payloadPreview: { command: "/policy simulate system.delete {}" },
    });

    await expectCompletedTraceState(
      service,
      "trace-command",
      "webchat.command.handled",
    );

    await service.close();
  });

  it("treats working background cycle traces as completed cycle traces", async () => {
    const service = createService();
    const now = Date.now();

    service.recordEvent({
      eventName: "background_run.cycle.decision_resolved",
      level: "info",
      traceId: "trace-background-cycle",
      sessionId: "session-1",
      channel: "background_run",
      timestampMs: now,
      payloadPreview: { decisionState: "working" },
    });
    service.recordEvent({
      eventName: "background_run.cycle.working_applied",
      level: "info",
      traceId: "trace-background-cycle",
      sessionId: "session-1",
      channel: "background_run",
      timestampMs: now + 1,
      payloadPreview: { summary: "Managed process is still running." },
    });

    await expectCompletedTraceState(
      service,
      "trace-background-cycle",
      "background_run.cycle.working_applied",
    );
    await service.close();
  });

  it("filters trace listings and summaries by session scope", async () => {
    const service = createService();
    const now = Date.now();

    service.recordEvent({
      eventName: "webchat.inbound",
      level: "info",
      traceId: "trace-owned",
      sessionId: "session-owned",
      timestampMs: now,
      payloadPreview: {},
      rawPayload: { toolName: "system.fs.read" },
    });
    service.recordEvent({
      eventName: "webchat.chat.response",
      level: "info",
      traceId: "trace-owned",
      sessionId: "session-owned",
      timestampMs: now + 1,
      payloadPreview: { stopReason: "completed" },
      rawPayload: { stopReason: "completed" },
    });

    service.recordEvent({
      eventName: "webchat.provider.error",
      level: "error",
      traceId: "trace-foreign",
      sessionId: "session-foreign",
      timestampMs: now + 2,
      payloadPreview: {},
      rawPayload: { toolName: "system.browserSessionResume" },
    });

    const scopedTraces = await service.listTraces({
      sessionIds: ["session-owned"],
    });
    expect(scopedTraces).toHaveLength(1);
    expect(scopedTraces[0]?.traceId).toBe("trace-owned");

    const scopedSummary = await service.getSummary({
      sessionIds: ["session-owned"],
    });
    expect(scopedSummary.traces.total).toBe(1);
    expect(scopedSummary.traces.completed).toBe(1);
    expect(scopedSummary.traces.errors).toBe(0);
    expect(scopedSummary.events.providerErrors).toBe(0);
    expect(scopedSummary.topStopReasons).toEqual([{ name: "completed", count: 1 }]);

    await service.close();
  });

  it("writes derived concern logs when trace fan-out is enabled", async () => {
    const service = createService("", { fanoutEnabled: true });
    const now = Date.now();

    service.recordEvent({
      eventName: "webchat.executor.tool_rejected",
      level: "info",
      traceId: "trace-fanout",
      sessionId: "session-1",
      timestampMs: now,
      payloadPreview: { traceId: "trace-fanout", tool: "system.bash" },
      rawPayload: { tool: "system.bash" },
    });
    service.recordEvent({
      eventName: "webchat.provider.error",
      level: "error",
      traceId: "trace-fanout",
      sessionId: "session-1",
      timestampMs: now + 1,
      payloadPreview: { traceId: "trace-fanout", provider: "grok" },
      rawPayload: { provider: "grok" },
    });

    await service.close();

    expect(
      readFileSync(join(tempDir, "daemon.executor.log"), "utf8"),
    ).toContain("webchat.executor.tool_rejected");
    expect(
      readFileSync(join(tempDir, "daemon.provider.log"), "utf8"),
    ).toContain("webchat.provider.error");
    expect(
      readFileSync(join(tempDir, "daemon.errors.log"), "utf8"),
    ).toContain("webchat.provider.error");
  });

  it("getArtifact reads a JSONL line by sha256 anchor", async () => {
    const traceId = "trace-getartifact-jsonl";
    const ref = persistTracePayloadArtifact({
      traceId,
      eventName: "evt.one",
      payload: { idx: 1, marker: "expected-body" },
    });
    expect(ref).toBeDefined();
    await awaitTracePayloadDrain(traceId);

    const service = createService();
    const result = await service.getArtifact(ref!.path);
    const body = result.body as Record<string, unknown>;
    expect(body.sha256).toBe(ref!.sha256);
    expect(body.eventName).toBe("evt.one");
    expect(body.traceId).toBe(traceId);
    expect(body.payload).toEqual({ idx: 1, marker: "expected-body" });

    rmSync(
      join(homedir(), ".agenc/trace-payloads", `${traceId}.jsonl`),
      { force: true },
    );
  });

  it("getArtifact reads a legacy per-event JSON file", async () => {
    // Simulate an old-format artifact: a .json file at any path
    // under ~/.agenc/trace-payloads, no #sha256= anchor on the ref.
    const legacyDir = join(homedir(), ".agenc/trace-payloads/legacy-trace");
    mkdirSync(legacyDir, { recursive: true });
    const legacyFile = join(legacyDir, "legacy-event.json");
    writeFileSync(
      legacyFile,
      JSON.stringify({
        eventName: "evt.legacy",
        traceId: "legacy-trace",
        payload: { from: "old-format" },
      }),
      "utf8",
    );

    const service = createService();
    const result = await service.getArtifact(legacyFile);
    const body = result.body as Record<string, unknown>;
    expect(body.eventName).toBe("evt.legacy");
    expect(body.payload).toEqual({ from: "old-format" });
    expect(result.path).toBe(legacyFile);

    rmSync(legacyDir, { recursive: true, force: true });
  });

  it("getArtifact throws when sha256 anchor does not match any line", async () => {
    const traceId = "trace-getartifact-miss";
    const ref = persistTracePayloadArtifact({
      traceId,
      eventName: "evt.one",
      payload: { idx: 1 },
    });
    expect(ref).toBeDefined();
    await awaitTracePayloadDrain(traceId);

    // Construct an anchored path with the right file but a wrong sha.
    const wrongSha = "0".repeat(64);
    const wrongPath = ref!.path.replace(/#sha256=.*/, `#sha256=${wrongSha}`);
    const service = createService();
    await expect(service.getArtifact(wrongPath)).rejects.toThrow(
      /Artifact not found in JSONL/,
    );

    rmSync(
      join(homedir(), ".agenc/trace-payloads", `${traceId}.jsonl`),
      { force: true },
    );
  });
});
