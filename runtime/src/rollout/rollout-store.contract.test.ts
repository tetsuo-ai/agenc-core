import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TraceWriter } from "../session/rollout-trace.js";
import {
  AGENC_ROLLOUT_SESSION_INDEX_FILE,
  AgenCRolloutSessionIndex,
} from "./session-index.js";
import {
  AGENC_ROLLOUT_SESSIONS_DIR,
  AGENC_ROLLOUT_TRACE_DIR,
  buildAgenCRolloutFileName,
  buildAgenCRolloutMetadata,
} from "./metadata.js";
import {
  findAgenCRolloutSession,
  listAgenCRolloutSessions,
  pruneAgenCRollouts,
} from "./list.js";
import {
  AgenCRolloutRecorder,
  readAgenCRolloutLines,
} from "./recorder.js";
import {
  AGENC_ROLLOUT_TRACE_REDUCED_STATE_FILE,
  AgenCRolloutTraceBundle,
  readAgenCRolloutTraceBundle,
  readAgenCRolloutTraceReducedState,
  replayAgenCRolloutTraceBundle,
} from "./trace.js";
import {
  shouldPersistRolloutItem,
} from "./policy.js";

let rootDir = "";

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "agenc-rollout-store-"));
});

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

describe("AgenC rollout recorder", () => {
  it("writes limited JSONL events and mirrors latest metadata into the index", () => {
    const recorder = new AgenCRolloutRecorder({
      rootDir,
      sessionId: "session-alpha",
      createdAt: "2026-05-02T17:00:00.000Z",
      cwd: "/tmp/project",
      name: "Root session",
      source: "contract-test",
    });

    expect(
      recorder.append(
        { type: "user_message", text: "hello" },
        { now: () => "2026-05-02T17:00:01.000Z" },
      )?.seq,
    ).toBe(1);
    expect(recorder.append({ type: "exec_command_end", exitCode: 0 }))
      .toBeUndefined();
    expect(
      recorder.append(
        { type: "exec_command_end", exitCode: 0 },
        {
          persistenceMode: "extended",
          now: () => "2026-05-02T17:00:02.000Z",
        },
      )?.seq,
    ).toBe(2);
    recorder.close();

    const lines = readAgenCRolloutLines(recorder.rolloutPath);
    expect(lines.map((line) => line.seq)).toEqual([1, 2]);
    expect(lines.map((line) => line.item)).toEqual([
      { type: "user_message", text: "hello" },
      { type: "exec_command_end", exitCode: 0 },
    ]);

    const indexed = new AgenCRolloutSessionIndex(rootDir).find("session-alpha");
    expect(indexed).toMatchObject({
      sessionId: "session-alpha",
      eventCount: 2,
      cwd: "/tmp/project",
      name: "Root session",
      source: "contract-test",
    });
    expect(indexed!.byteLength).toBeGreaterThan(0);
  });

  it("persists developer response items in limited mode", () => {
    const recorder = new AgenCRolloutRecorder({
      rootDir,
      sessionId: "session-developer-response-item",
      createdAt: "2026-05-02T17:05:00.000Z",
    });

    expect(
      recorder.append(
        {
          type: "response_item",
          payload: {
            role: "developer",
            content: "runtime instruction fragment",
          },
        },
        { now: () => "2026-05-02T17:05:01.000Z" },
      )?.seq,
    ).toBe(1);
    recorder.close();

    expect(readAgenCRolloutLines(recorder.rolloutPath).map((line) => line.item))
      .toEqual([
        {
          type: "response_item",
          payload: {
            role: "developer",
            content: "runtime instruction fragment",
          },
        },
      ]);
  });

  it("continues sequence numbers when reopening the same session file", () => {
    const options = {
      rootDir,
      sessionId: "session-resume",
      createdAt: "2026-05-02T18:00:00.000Z",
    };
    const first = new AgenCRolloutRecorder(options);
    first.append(
      { type: "turn_started" },
      { now: () => "2026-05-02T18:00:01.000Z" },
    );
    first.close();

    const second = new AgenCRolloutRecorder(options);
    const appended = second.append(
      { type: "turn_complete" },
      { now: () => "2026-05-02T18:00:02.000Z" },
    );
    second.close();

    expect(appended?.seq).toBe(2);
    expect(readAgenCRolloutLines(second.rolloutPath).map((line) => line.seq))
      .toEqual([1, 2]);
    expect(new AgenCRolloutSessionIndex(rootDir).find("session-resume"))
      .toMatchObject({ eventCount: 2 });
  });

  it("uses collision-free file names for unsafe session ids", () => {
    const createdAt = "2026-05-02T18:10:00.000Z";
    const first = new AgenCRolloutRecorder({
      rootDir,
      sessionId: "a/b",
      createdAt,
    });
    const second = new AgenCRolloutRecorder({
      rootDir,
      sessionId: "a b",
      createdAt,
    });
    first.append({ type: "turn_started" });
    second.append({ type: "turn_started" });
    first.close();
    second.close();

    expect(first.rolloutPath).not.toBe(second.rolloutPath);
    expect(readAgenCRolloutLines(first.rolloutPath)[0]?.sessionId).toBe("a/b");
    expect(readAgenCRolloutLines(second.rolloutPath)[0]?.sessionId).toBe("a b");
  });

  it("keeps malicious createdAt values inside the sessions directory", () => {
    const recorder = new AgenCRolloutRecorder({
      rootDir,
      sessionId: "session-safe-created-at",
      createdAt: "../../outside",
    });
    recorder.append({ type: "turn_started" });
    recorder.close();

    const rel = relative(
      join(rootDir, AGENC_ROLLOUT_SESSIONS_DIR),
      recorder.rolloutPath,
    );
    expect(rel.startsWith("..")).toBe(false);
    expect(isAbsolute(rel)).toBe(false);
    expect(readAgenCRolloutLines(recorder.rolloutPath)[0]?.sessionId)
      .toBe("session-safe-created-at");
  });

  it("can reopen an existing empty rollout file after startup interruption", () => {
    const createdAt = "2026-05-02T18:15:00.000Z";
    const sessionsDir = join(rootDir, AGENC_ROLLOUT_SESSIONS_DIR);
    mkdirSync(sessionsDir, { recursive: true });
    const rolloutPath = join(
      sessionsDir,
      buildAgenCRolloutFileName("session-empty-file", createdAt),
    );
    writeFileSync(rolloutPath, "", { encoding: "utf8", mode: 0o600 });

    const recorder = new AgenCRolloutRecorder({
      rootDir,
      sessionId: "session-empty-file",
      createdAt,
    });
    recorder.append(
      { type: "turn_started" },
      { now: () => "2026-05-02T18:15:01.000Z" },
    );
    recorder.close();

    expect(readAgenCRolloutLines(rolloutPath).map((line) => line.seq))
      .toEqual([1]);
  });

  it("rejects appends after close and surfaces corrupt JSONL", () => {
    const recorder = new AgenCRolloutRecorder({
      rootDir,
      sessionId: "session-closed",
      createdAt: "2026-05-02T18:30:00.000Z",
    });
    recorder.append({ type: "turn_started" });
    recorder.close();

    expect(() => recorder.append({ type: "turn_complete" })).toThrow(
      /rollout recorder is closed/,
    );
    expect(() => recorder.append({ type: "exec_command_begin" })).toThrow(
      /rollout recorder is closed/,
    );

    appendFileSync(recorder.rolloutPath, "{bad-json\n", "utf8");
    expect(() => readAgenCRolloutLines(recorder.rolloutPath)).toThrow();
  });

  it("rejects valid JSON rows with invalid rollout line shape", () => {
    const createdAt = "2026-05-02T18:50:00.000Z";
    const sessionsDir = join(rootDir, AGENC_ROLLOUT_SESSIONS_DIR);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, buildAgenCRolloutFileName("session-invalid-row", createdAt)),
      JSON.stringify({
        format: "agenc.rollout.line",
        schemaVersion: 1,
        seq: "bad",
        sessionId: "session-invalid-row",
        writtenAt: "2026-05-02T18:50:01.000Z",
        item: { type: "turn_started" },
      }) + "\n",
      "utf8",
    );

    expect(
      () =>
        new AgenCRolloutRecorder({
          rootDir,
          sessionId: "session-invalid-row",
          createdAt,
        }),
    ).toThrow(/malformed rollout JSONL row/);
  });

  it("sanitizes extended command output before persistence", () => {
    const recorder = new AgenCRolloutRecorder({
      rootDir,
      sessionId: "session-command-output",
      createdAt: "2026-05-02T18:45:00.000Z",
    });
    const largeOutput = "x".repeat(12_000);
    recorder.append(
      {
        type: "exec_command_end",
        aggregated_output: largeOutput,
        stdout: "stdout copy",
        stderr: "stderr copy",
        formatted_output: "formatted copy",
      },
      { persistenceMode: "extended" },
    );
    recorder.close();

    const item = readAgenCRolloutLines(recorder.rolloutPath)[0]!.item as Record<
      string,
      unknown
    >;
    expect(String(item.aggregated_output).length).toBeLessThan(largeOutput.length);
    expect(item.aggregated_output).toContain("chars truncated");
    expect(item.stdout).toBe("");
    expect(item.stderr).toBe("");
    expect(item.formatted_output).toBe("");
  });

  it("redacts secrets from limited rollout JSONL rows before persistence", () => {
    const recorder = new AgenCRolloutRecorder({
      rootDir,
      sessionId: "session-secret-row",
      createdAt: "2026-05-02T18:45:30.000Z",
    });
    const rawSecret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456-";
    recorder.append({
      type: "user_message",
      apiKey: "opaque-value-12345",
      text: `Authorization: Bearer abcdefghijklmnop= ${rawSecret}`,
    });
    recorder.close();

    const content = readFileSync(recorder.rolloutPath, "utf8");
    expect(content).not.toContain(rawSecret);
    expect(content).not.toContain("opaque-value-12345");
    expect(content).not.toContain("abcdefghijklmnop=");

    const item = readAgenCRolloutLines(recorder.rolloutPath)[0]!.item as Record<
      string,
      unknown
    >;
    expect(item.apiKey).toBe("[REDACTED_SECRET]");
    expect(item.text).toContain("Bearer [REDACTED_SECRET]");
  });

  it("sanitizes real event_msg exec output before persistence", () => {
    const recorder = new AgenCRolloutRecorder({
      rootDir,
      sessionId: "session-real-command-output",
      createdAt: "2026-05-02T18:46:00.000Z",
    });
    const largeOutput = "stdout ".repeat(2_000);
    recorder.append(
      {
        type: "event_msg",
        payload: {
          id: "event-1",
          timestamp: "2026-05-02T18:46:01.000Z",
          msg: {
            type: "exec_command_end",
            payload: {
              callId: "call-1",
              exitCode: 0,
              stdout: largeOutput,
              stderr: "stderr copy",
            },
          },
        },
      },
      { persistenceMode: "extended" },
    );
    recorder.close();

    const item = readAgenCRolloutLines(recorder.rolloutPath)[0]!.item as {
      readonly payload: {
        readonly msg: {
          readonly payload: Record<string, unknown>;
        };
      };
    };
    expect(String(item.payload.msg.payload.aggregated_output).length)
      .toBeLessThan(largeOutput.length);
    expect(item.payload.msg.payload.aggregated_output).toContain("chars truncated");
    expect(item.payload.msg.payload.stdout).toBe("");
    expect(item.payload.msg.payload.stderr).toBe("");
  });

  it("repairs the index from disk without truncating sanitized session ids", () => {
    const recorder = new AgenCRolloutRecorder({
      rootDir,
      sessionId: "root session/with-dashes",
      createdAt: "2026-05-02T19:00:00.000Z",
    });
    recorder.append(
      { type: "agent_message", text: "done" },
      { now: () => "2026-05-02T19:00:01.000Z" },
    );
    recorder.close();
    rmSync(join(rootDir, AGENC_ROLLOUT_SESSION_INDEX_FILE), { force: true });
    appendFileSync(
      join(rootDir, AGENC_ROLLOUT_SESSION_INDEX_FILE),
      [
        "not-json",
        JSON.stringify({
          format: "wrong",
          schemaVersion: 1,
          sessionId: "bad",
          rolloutPath: "/tmp/bad",
          createdAt: "2026-05-02T19:00:00.000Z",
          updatedAt: "2026-05-02T19:00:00.000Z",
          eventCount: 0,
          byteLength: 0,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    expect(findAgenCRolloutSession(rootDir, "root session/with-dashes"))
      .toMatchObject({
        sessionId: "root session/with-dashes",
        eventCount: 1,
      });
  });
});

describe("AgenC rollout persistence policy", () => {
  it("matches limited, extended-only, and never-persist event classes", () => {
    const limited = [
      { type: "user_message" },
      { type: "event_msg", event: { type: "context_compacted" } },
      { type: "event_msg", payload: { msg: { type: "user_message", payload: {} } } },
      { type: "response_item", item: { type: "function_call" } },
      { type: "response_item", payload: { role: "developer", content: "handoff" } },
      { type: "response_item", payload: { role: "user", content: "hello" } },
      { type: "item_completed", item: { type: "plan" } },
      { type: "session_meta" },
    ];
    for (const item of limited) {
      expect(shouldPersistRolloutItem(item), JSON.stringify(item)).toBe(true);
      expect(shouldPersistRolloutItem(item, "extended")).toBe(true);
    }

    const extendedOnly = [
      { type: "error" },
      { type: "event_msg", event: { type: "web_search_end" } },
      { type: "event_msg", payload: { msg: { type: "exec_command_end", payload: {} } } },
      { type: "dynamic_tool_call_response" },
    ];
    for (const item of extendedOnly) {
      expect(shouldPersistRolloutItem(item), JSON.stringify(item)).toBe(false);
      expect(shouldPersistRolloutItem(item, "extended")).toBe(true);
    }

    const neverPersist = [
      null,
      "message",
      { type: "warning" },
      { type: "exec_command_begin" },
      { type: "response_item", item: { type: "other" } },
      { type: "item_completed", item: { type: "task" } },
      { type: "unknown" },
    ];
    for (const item of neverPersist) {
      expect(shouldPersistRolloutItem(item), JSON.stringify(item)).toBe(false);
      expect(shouldPersistRolloutItem(item, "extended")).toBe(false);
    }
  });
});

describe("AgenC rollout retention", () => {
  it("prunes oldest sessions, trace bundles, and records tombstones", () => {
    const timestamps = [
      "2026-05-02T20:00:00.000Z",
      "2026-05-02T20:01:00.000Z",
      "2026-05-02T20:02:00.000Z",
    ];
    for (const [index, timestamp] of timestamps.entries()) {
      const traceBundlePath = index === 0
        ? join(rootDir, AGENC_ROLLOUT_TRACE_DIR, "trace-for-session-0")
        : undefined;
      if (traceBundlePath !== undefined) {
        mkdirSync(traceBundlePath, { recursive: true });
        writeFileSync(join(traceBundlePath, "manifest.json"), "{}\n", "utf8");
      }
      const recorder = new AgenCRolloutRecorder({
        rootDir,
        sessionId: `session-${index}`,
        createdAt: timestamp,
        ...(traceBundlePath !== undefined ? { traceBundlePath } : {}),
      });
      recorder.append(
        { type: "turn_complete", index },
        { now: () => timestamp },
      );
      recorder.close();
    }

    const result = pruneAgenCRollouts(
      rootDir,
      { maxSessions: 2 },
      { now: () => "2026-05-02T21:00:00.000Z" },
    );

    expect(result.removed.map((entry) => entry.sessionId)).toEqual(["session-0"]);
    expect(result.kept.map((entry) => entry.sessionId)).toEqual([
      "session-2",
      "session-1",
    ]);
    expect(existsSync(result.removed[0]!.rolloutPath)).toBe(false);
    expect(existsSync(join(rootDir, AGENC_ROLLOUT_TRACE_DIR, "trace-for-session-0")))
      .toBe(false);
    expect(listAgenCRolloutSessions(rootDir).map((entry) => entry.sessionId))
      .toEqual(["session-2", "session-1"]);
  });

  it("applies max age and max bytes while keeping the newest session", () => {
    for (const timestamp of [
      "2026-05-02T20:00:00.000Z",
      "2026-05-02T20:10:00.000Z",
    ]) {
      const recorder = new AgenCRolloutRecorder({
        rootDir,
        sessionId: `session-${timestamp}`,
        createdAt: timestamp,
      });
      recorder.append(
        { type: "agent_message", text: "x".repeat(128) },
        { now: () => timestamp },
      );
      recorder.close();
    }

    expect(
      pruneAgenCRollouts(
        rootDir,
        { maxAgeMs: 5 * 60 * 1000 },
        { now: () => "2026-05-02T20:10:01.000Z" },
      ).removed.map((entry) => entry.sessionId),
    ).toEqual(["session-2026-05-02T20:00:00.000Z"]);

    expect(
      pruneAgenCRollouts(rootDir, { maxBytes: 1 }).kept.map(
        (entry) => entry.sessionId,
      ),
    ).toEqual(["session-2026-05-02T20:10:00.000Z"]);
  });

  it("does not delete index paths outside the rollout root", () => {
    const outsideFileRoot = mkdtempSync(join(tmpdir(), "agenc-rollout-outside-file-"));
    const outsideFile = join(outsideFileRoot, "outside.jsonl");
    const outsideTrace = mkdtempSync(join(tmpdir(), "agenc-rollout-outside-trace-"));
    writeFileSync(outsideFile, "do not delete\n", "utf8");
    writeFileSync(join(outsideTrace, "manifest.json"), "{}\n", "utf8");

    try {
      new AgenCRolloutSessionIndex(rootDir).append(
        buildAgenCRolloutMetadata({
          sessionId: "malicious-index-row",
          rolloutPath: outsideFile,
          traceBundlePath: outsideTrace,
          createdAt: "2026-05-02T20:20:00.000Z",
          updatedAt: "2026-05-02T20:20:00.000Z",
          eventCount: 1,
          byteLength: 14,
        }),
      );

      expect(
        pruneAgenCRollouts(rootDir, { maxSessions: 0 }).removed.map(
          (entry) => entry.sessionId,
        ),
      ).toEqual(["malicious-index-row"]);
      expect(existsSync(outsideFile)).toBe(true);
      expect(existsSync(outsideTrace)).toBe(true);
    } finally {
      rmSync(outsideFileRoot, { recursive: true, force: true });
      rmSync(outsideTrace, { recursive: true, force: true });
    }
  });
});

describe("AgenC rollout trace bundles", () => {
  it("rejects trace ids that escape the trace root", () => {
    expect(
      () =>
        new AgenCRolloutTraceBundle({
          rootDir,
          rolloutId: "rollout-traversal",
          rootSessionId: "session-traversal",
          traceId: "../outside",
        }),
    ).toThrow(/unsafe rollout trace id/);
  });

  it("writes manifest, event JSONL, payload files, and reduced replay state", () => {
    const trace = new AgenCRolloutTraceBundle({
      rootDir,
      rolloutId: "rollout-1",
      rootSessionId: "session-alpha",
      traceId: "trace-1",
      createdAt: "2026-05-02T22:00:00.000Z",
    });

    const payload = trace.writePayload("inference_request", {
      prompt: "hello",
    });
    const responsePayload = trace.writePayload("inference_response", {
      output: [{ id: "assistant-1", role: "assistant", content: "hi" }],
    });
    const runtimePayload = trace.writePayload("runtime_event", {
      terminal_id: "terminal-1",
    });
    const compactionPayload = trace.writePayload("compaction_checkpoint", {
      checkpoint: true,
    });
    const protocolPayload = trace.writePayload("protocol_event", {
      event: "observed",
    });
    const events = [
      trace.appendEvent(
        { type: "thread_started", thread_id: "session-alpha", agent_path: "/root" },
        { now: () => "2026-05-02T22:00:01.000Z" },
      ),
      trace.appendEvent(
        {
          type: "agenc_turn_started",
          thread_id: "session-alpha",
          agenc_turn_id: "turn-1",
        },
        { now: () => "2026-05-02T22:00:02.000Z" },
      ),
      trace.appendEvent(
        {
          type: "inference_attempt_started",
          thread_id: "session-alpha",
          agenc_turn_id: "turn-1",
          inference_call_id: "infer-1",
          model: "test-model",
          provider_name: "test-provider",
          payload,
        },
        { now: () => "2026-05-02T22:00:03.000Z" },
      ),
      trace.appendEvent(
        {
          type: "inference_attempt_completed",
          inference_call_id: "infer-1",
          status: "completed",
          response_payload: responsePayload,
        },
        { now: () => "2026-05-02T22:00:04.000Z" },
      ),
      trace.appendEvent(
        {
          type: "tool_call_started",
          thread_id: "session-alpha",
          agenc_turn_id: "turn-1",
          tool_call_id: "tool-1",
          kind: "exec",
        },
        { now: () => "2026-05-02T22:00:05.000Z" },
      ),
      trace.appendEvent(
        {
          type: "code_cell_started",
          runtime_cell_id: "cell-1",
          agenc_turn_id: "turn-1",
          source_js: "1 + 1",
        },
        { now: () => "2026-05-02T22:00:05.100Z" },
      ),
      trace.appendEvent(
        {
          type: "tool_call_runtime_started",
          tool_call_id: "tool-1",
          terminal_id: "terminal-1",
          runtime_payload: runtimePayload,
        },
        { now: () => "2026-05-02T22:00:05.200Z" },
      ),
      trace.appendEvent(
        {
          type: "conversation_item_observed",
          conversation_item_id: "item-1",
          thread_id: "session-alpha",
        },
        { now: () => "2026-05-02T22:00:05.300Z" },
      ),
      trace.appendEvent(
        {
          type: "compaction_request_started",
          compaction_request_id: "compact-request-1",
          compaction_id: "compact-1",
          thread_id: "session-alpha",
          agenc_turn_id: "turn-1",
        },
        { now: () => "2026-05-02T22:00:05.400Z" },
      ),
      trace.appendEvent(
        {
          type: "compaction_installed",
          compaction_id: "compact-1",
          checkpoint_payload: compactionPayload,
        },
        { now: () => "2026-05-02T22:00:05.500Z" },
      ),
      trace.appendEvent(
        {
          type: "protocol_event_observed",
          event_id: "protocol-1",
          event_payload: protocolPayload,
        },
        { now: () => "2026-05-02T22:00:05.600Z" },
      ),
      trace.appendEvent(
        {
          type: "agent_result_observed",
          edge_id: "edge-1",
          child_thread_id: "session-child",
          parent_thread_id: "session-alpha",
        },
        { now: () => "2026-05-02T22:00:05.700Z" },
      ),
      trace.appendEvent(
        {
          type: "tool_call_ended",
          tool_call_id: "tool-1",
          status: "failed",
        },
        { now: () => "2026-05-02T22:00:06.000Z" },
      ),
      trace.appendEvent(
        {
          type: "agenc_turn_ended",
          agenc_turn_id: "turn-1",
          status: "completed",
        },
        { now: () => "2026-05-02T22:00:07.000Z" },
      ),
      trace.appendEvent(
        { type: "rollout_ended", status: "completed" },
        { now: () => "2026-05-02T22:00:08.000Z" },
      ),
    ];
    const bundle = readAgenCRolloutTraceBundle(trace.bundleDir);

    expect(bundle.manifest).toMatchObject({
      traceId: "trace-1",
      rolloutId: "rollout-1",
      rootSessionId: "session-alpha",
    });
    expect(bundle.events).toEqual(events);
    const payloadPath = join(trace.bundleDir, payload.path);
    expect(JSON.parse(readFileSync(payloadPath, "utf8"))).toEqual({
      prompt: "hello",
    });

    const reduced = replayAgenCRolloutTraceBundle(trace.bundleDir, {
      writeCache: true,
    });
    expect(reduced.status).toBe("completed");
    expect(reduced.sessions["session-alpha"]).toMatchObject({
      agentPath: "/root",
      status: "running",
    });
    expect(reduced.turns["turn-1"]).toMatchObject({
      status: "completed",
      sessionId: "session-alpha",
    });
    expect(reduced.inferenceCalls["infer-1"]).toMatchObject({
      status: "completed",
      model: "test-model",
      providerName: "test-provider",
      conversationItemIds: ["assistant-1"],
    });
    expect(reduced.conversationItems["assistant-1"]).toMatchObject({
      type: "conversation_item",
    });
    expect(reduced.codeCells["cell-1"]).toMatchObject({
      status: "running",
      turnId: "turn-1",
    });
    expect(reduced.terminalOperations["tool-1:runtime"]).toMatchObject({
      status: "running",
    });
    expect(reduced.terminalSessions["terminal-1"]).toBeDefined();
    expect(reduced.conversationItems["item-1"]).toBeDefined();
    expect(reduced.compactionRequests["compact-request-1"]).toMatchObject({
      status: "running",
    });
    expect(reduced.compactions["compact-1"]).toMatchObject({
      status: "completed",
    });
    expect(reduced.protocolEvents["protocol-1"]).toBeDefined();
    expect(reduced.interactionEdges["edge-1"]).toBeDefined();
    expect(reduced.toolCalls["tool-1"]).toMatchObject({
      status: "failed",
      kind: "exec",
    });
    expect(reduced.rawPayloads[payload.payloadId]).toEqual(payload);
    expect(reduced.rawPayloads[responsePayload.payloadId]).toEqual(responsePayload);
    expect(reduced.rawPayloads[runtimePayload.payloadId]).toEqual(runtimePayload);
    expect(reduced.rawPayloads[compactionPayload.payloadId]).toEqual(compactionPayload);
    expect(reduced.rawPayloads[protocolPayload.payloadId]).toEqual(protocolPayload);
    expect(existsSync(join(trace.bundleDir, AGENC_ROLLOUT_TRACE_REDUCED_STATE_FILE)))
      .toBe(true);
    expect(readAgenCRolloutTraceReducedState(trace.bundleDir)).toEqual(reduced);
  });

  it("redacts secrets in trace bundle payload files and events", () => {
    const trace = new AgenCRolloutTraceBundle({
      rootDir,
      rolloutId: "rollout-secret-trace",
      rootSessionId: "session-secret-trace",
      traceId: "trace-secret-bundle",
      createdAt: "2026-05-02T22:30:00.000Z",
    });
    const rawSecret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456-";
    const opaqueSecret = "opaque-value-12345";
    const payload = trace.writePayload("tool_result", {
      apiKey: opaqueSecret,
      output: rawSecret,
    });
    trace.appendEvent(
      {
        type: "tool_call_ended",
        tool_call_id: "tool-secret",
        status: "failed",
        message: "Authorization: Bearer abcdefghijklmnop=",
        result_payload: payload,
      },
      { now: () => "2026-05-02T22:30:01.000Z" },
    );

    const content = [
      readFileSync(join(trace.bundleDir, payload.path), "utf8"),
      readFileSync(join(trace.bundleDir, "trace.jsonl"), "utf8"),
    ].join("\n");
    expect(content).not.toContain(rawSecret);
    expect(content).not.toContain(opaqueSecret);
    expect(content).not.toContain("abcdefghijklmnop=");
    expect(content).toContain("[REDACTED_SECRET]");
  });

  it("replays an empty trace log as a running root session", () => {
    const trace = new AgenCRolloutTraceBundle({
      rootDir,
      rolloutId: "rollout-empty",
      rootSessionId: "session-empty",
      traceId: "trace-empty",
      createdAt: "2026-05-02T23:00:00.000Z",
    });

    expect(readAgenCRolloutTraceBundle(trace.bundleDir).events).toEqual([]);
    expect(replayAgenCRolloutTraceBundle(trace.bundleDir)).toMatchObject({
      traceId: "trace-empty",
      eventCount: 0,
      status: "running",
      sessions: {
        "session-empty": {
          sessionId: "session-empty",
          status: "running",
          startedAt: "2026-05-02T23:00:00.000Z",
        },
      },
    });
  });

  it("normalizes raw trace envelopes during replay", () => {
    const externalTurnIdField = "external_turn_id";
    const bundleDir = join(rootDir, AGENC_ROLLOUT_TRACE_DIR, "trace-raw");
    const payloadsDir = "raw-payloads";
    mkdirSync(join(bundleDir, payloadsDir), { recursive: true });
    writeFileSync(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        schema_version: 1,
        trace_id: "trace-raw",
        rollout_id: "rollout-raw",
        root_thread_id: "session-raw",
        started_at_unix_ms: Date.parse("2026-05-03T00:00:00.000Z"),
        raw_event_log: "events.jsonl",
        payloads_dir: payloadsDir,
      }) + "\n",
      "utf8",
    );
    const payload = {
      payloadId: "payload-1",
      kind: { type: "protocol_event" },
      path: `${payloadsDir}/payload-1.json`,
    };
    writeFileSync(join(bundleDir, payload.path), JSON.stringify({ ok: true }), "utf8");
    appendFileSync(
      join(bundleDir, "events.jsonl"),
      [
        {
          schema_version: 1,
          seq: 1,
          wall_time_unix_ms: Date.parse("2026-05-03T00:00:01.000Z"),
          rollout_id: "rollout-raw",
          thread_id: "session-raw",
          payload: {
            type: "external_turn_started",
            agenc_turn_id: "turn-raw",
            thread_id: "session-raw",
          },
        },
        {
          schema_version: 1,
          seq: 2,
          wall_time_unix_ms: Date.parse("2026-05-03T00:00:02.000Z"),
          rollout_id: "rollout-raw",
          thread_id: "session-raw",
          [externalTurnIdField]: "turn-raw",
          payload: {
            type: "protocol_event_observed",
            event_payload: payload,
          },
        },
      ].map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    );

    const reduced = replayAgenCRolloutTraceBundle(bundleDir);
    expect(reduced.traceId).toBe("trace-raw");
    expect(reduced.rootSessionId).toBe("session-raw");
    expect(reduced.turns["turn-raw"]).toMatchObject({
      sessionId: "session-raw",
      status: "running",
    });
    expect(reduced.protocolEvents["protocol:2"]).toMatchObject({
      type: "protocol_event_observed",
      sessionId: "session-raw",
      turnId: "turn-raw",
    });
    expect(reduced.rawPayloads["payload-1"]).toMatchObject({
      kind: "protocol_event",
    });
  });

  it("redacts secrets in existing trace writer payloads and events", () => {
    const bundleDir = join(rootDir, AGENC_ROLLOUT_TRACE_DIR, "existing-writer-secret");
    const writer = TraceWriter.create({
      bundleDir,
      traceId: "trace-existing-secret",
      rolloutId: "rollout-existing-secret",
      rootThreadId: "thread-existing-secret",
    });
    const rawSecret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456-";
    const opaqueSecret = "opaque-value-12345";
    const resultPayload = writer.writeJsonPayload("tool_result", {
      apiKey: opaqueSecret,
      output: rawSecret,
    });
    writer.appendWithContext(
      { threadId: "thread-existing-secret", agencTurnId: "turn-existing-secret" },
      {
        type: "tool_dispatch_ended",
        toolCallId: "tool-existing-secret",
        status: "failed",
        resultPayload,
      },
    );
    writer.appendWithContext(
      { threadId: "thread-existing-secret", agencTurnId: "turn-existing-secret" },
      {
        type: "inference_attempt_ended",
        inferenceAttemptId: "infer-existing-secret",
        status: "failed",
        error: "Authorization: Bearer abcdefghijklmnop=",
      },
    );
    writer.close();

    const content = [
      readFileSync(join(bundleDir, resultPayload.path), "utf8"),
      readFileSync(join(bundleDir, "trace.jsonl"), "utf8"),
    ].join("\n");
    expect(content).not.toContain(rawSecret);
    expect(content).not.toContain(opaqueSecret);
    expect(content).not.toContain("abcdefghijklmnop=");
    expect(content).toContain("[REDACTED_SECRET]");
  });

  it("replays bundles emitted by the existing trace writer", () => {
    const bundleDir = join(rootDir, AGENC_ROLLOUT_TRACE_DIR, "existing-writer");
    const writer = TraceWriter.create({
      bundleDir,
      traceId: "trace-existing",
      rolloutId: "rollout-existing",
      rootThreadId: "thread-existing",
    });
    const requestPayload = writer.writeJsonPayload("inference_request", {
      messages: [{ id: "user-1", role: "user", content: "hello" }],
    });
    const responsePayload = writer.writeJsonPayload("inference_response", {
      output: [{ id: "assistant-1", role: "assistant", content: "hi" }],
    });
    const toolPayload = writer.writeJsonPayload("tool_invocation", {
      command: "pwd",
    });
    writer.appendWithContext(
      { threadId: "thread-existing", agencTurnId: "turn-existing" },
      {
        type: "agenc_turn_started",
        agencTurnId: "turn-existing",
        threadId: "thread-existing",
      },
    );
    writer.appendWithContext(
      { threadId: "thread-existing", agencTurnId: "turn-existing" },
      {
        type: "inference_attempt_started",
        inferenceAttemptId: "infer-existing",
        model: "test-model",
        providerName: "test-provider",
        requestPayload,
      },
    );
    writer.appendWithContext(
      { threadId: "thread-existing", agencTurnId: "turn-existing" },
      {
        type: "tool_dispatch_started",
        toolCallId: "tool-existing",
        toolName: "bash",
        invocationPayload: toolPayload,
      },
    );
    writer.appendWithContext(
      { threadId: "thread-existing", agencTurnId: "turn-existing" },
      {
        type: "tool_dispatch_ended",
        toolCallId: "tool-existing",
        status: "completed",
      },
    );
    writer.appendWithContext(
      { threadId: "thread-existing", agencTurnId: "turn-existing" },
      {
        type: "inference_attempt_ended",
        inferenceAttemptId: "infer-existing",
        status: "completed",
        responsePayload,
      },
    );
    writer.appendWithContext(
      { threadId: "thread-existing", agencTurnId: "turn-existing" },
      {
        type: "compaction_request_started",
        compactionId: "compact-existing",
        model: "test-model",
        providerName: "test-provider",
      },
    );
    writer.appendWithContext(
      { threadId: "thread-existing", agencTurnId: "turn-existing" },
      {
        type: "compaction_request_ended",
        compactionId: "compact-existing",
        status: "completed",
      },
    );
    writer.close();

    const reduced = replayAgenCRolloutTraceBundle(bundleDir);
    expect(reduced.rootSessionId).toBe("thread-existing");
    expect(reduced.turns["turn-existing"]).toMatchObject({
      sessionId: "thread-existing",
      status: "running",
    });
    expect(reduced.inferenceCalls["infer-existing"]).toMatchObject({
      status: "completed",
      conversationItemIds: ["user-1", "assistant-1"],
    });
    expect(reduced.toolCalls["tool-existing"]).toMatchObject({
      kind: "bash",
      status: "completed",
    });
    expect(reduced.compactionRequests["compact-existing"]).toMatchObject({
      status: "completed",
    });
  });

  it("fails replay for missing trace logs, sequence gaps, and missing payloads", () => {
    const missingLog = new AgenCRolloutTraceBundle({
      rootDir,
      rolloutId: "rollout-missing-log",
      rootSessionId: "session-missing-log",
      traceId: "trace-missing-log",
    });
    rmSync(join(missingLog.bundleDir, "trace.jsonl"), { force: true });
    expect(() => replayAgenCRolloutTraceBundle(missingLog.bundleDir)).toThrow(
      /trace event log missing/,
    );

    const sequenceGap = new AgenCRolloutTraceBundle({
      rootDir,
      rolloutId: "rollout-gap",
      rootSessionId: "session-gap",
      traceId: "trace-gap",
    });
    appendFileSync(
      join(sequenceGap.bundleDir, "trace.jsonl"),
      JSON.stringify({
        schemaVersion: 1,
        seq: 2,
        traceId: "trace-gap",
        rolloutId: "rollout-gap",
        writtenAt: "2026-05-03T00:10:00.000Z",
        payload: { type: "rollout_ended" },
      }) + "\n",
      "utf8",
    );
    expect(() => replayAgenCRolloutTraceBundle(sequenceGap.bundleDir)).toThrow(
      /trace event sequence gap/,
    );

    const missingPayload = new AgenCRolloutTraceBundle({
      rootDir,
      rolloutId: "rollout-missing-payload",
      rootSessionId: "session-missing-payload",
      traceId: "trace-missing-payload",
    });
    missingPayload.appendEvent({
      type: "protocol_event_observed",
      event_payload: {
        payloadId: "missing",
        kind: "protocol",
        path: "payloads/missing.json",
      },
    });
    expect(() => replayAgenCRolloutTraceBundle(missingPayload.bundleDir)).toThrow(
      /trace payload missing/,
    );
  });

  it("fails replay for invalid lifecycle ordering and owner mismatches", () => {
    const unknownEnd = new AgenCRolloutTraceBundle({
      rootDir,
      rolloutId: "rollout-unknown-end",
      rootSessionId: "session-root",
      traceId: "trace-unknown-end",
    });
    unknownEnd.appendEvent({
      type: "agenc_turn_ended",
      agenc_turn_id: "turn-missing",
      status: "completed",
    });
    expect(() => replayAgenCRolloutTraceBundle(unknownEnd.bundleDir)).toThrow(
      /trace turn ended before start/,
    );

    const duplicateStart = new AgenCRolloutTraceBundle({
      rootDir,
      rolloutId: "rollout-duplicate-start",
      rootSessionId: "session-root",
      traceId: "trace-duplicate-start",
    });
    duplicateStart.appendEvent({
      type: "agenc_turn_started",
      agenc_turn_id: "turn-1",
      thread_id: "session-root",
    });
    duplicateStart.appendEvent({
      type: "agenc_turn_started",
      agenc_turn_id: "turn-1",
      thread_id: "session-root",
    });
    expect(() => replayAgenCRolloutTraceBundle(duplicateStart.bundleDir))
      .toThrow(/trace turn started twice/);

    const ownerMismatch = new AgenCRolloutTraceBundle({
      rootDir,
      rolloutId: "rollout-owner-mismatch",
      rootSessionId: "session-root",
      traceId: "trace-owner-mismatch",
    });
    ownerMismatch.appendEvent({
      type: "agenc_turn_started",
      agenc_turn_id: "turn-1",
      thread_id: "session-root",
    });
    ownerMismatch.appendEvent({
      type: "tool_call_started",
      tool_call_id: "tool-1",
      agenc_turn_id: "turn-1",
      thread_id: "session-other",
    });
    expect(() => replayAgenCRolloutTraceBundle(ownerMismatch.bundleDir))
      .toThrow(/trace turn owner mismatch/);

    const unknownSessionEnd = new AgenCRolloutTraceBundle({
      rootDir,
      rolloutId: "rollout-unknown-session",
      rootSessionId: "session-root",
      traceId: "trace-unknown-session",
    });
    unknownSessionEnd.appendEvent({
      type: "session_ended",
      session_id: "session-missing",
      status: "completed",
    });
    expect(() => replayAgenCRolloutTraceBundle(unknownSessionEnd.bundleDir))
      .toThrow(/trace session ended before start/);
  });

  it("rejects manifest paths that escape the trace bundle", () => {
    const bundleDir = join(rootDir, AGENC_ROLLOUT_TRACE_DIR, "trace-escape");
    mkdirSync(join(bundleDir, "payloads"), { recursive: true });
    writeFileSync(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        schema_version: 1,
        trace_id: "trace-escape",
        rollout_id: "rollout-escape",
        root_thread_id: "session-escape",
        started_at_unix_ms: Date.parse("2026-05-03T01:00:00.000Z"),
        raw_event_log: "../outside.jsonl",
        payloads_dir: "payloads",
      }) + "\n",
      "utf8",
    );
    expect(() => replayAgenCRolloutTraceBundle(bundleDir)).toThrow(
      /trace event log path escapes trace bundle/,
    );

    const payloadEscape = join(rootDir, AGENC_ROLLOUT_TRACE_DIR, "payload-escape");
    mkdirSync(join(payloadEscape, "payloads"), { recursive: true });
    writeFileSync(
      join(payloadEscape, "manifest.json"),
      JSON.stringify({
        schema_version: 1,
        trace_id: "payload-escape",
        rollout_id: "payload-escape",
        root_thread_id: "session-payload-escape",
        started_at_unix_ms: Date.parse("2026-05-03T01:00:00.000Z"),
        raw_event_log: "trace.jsonl",
        payloads_dir: "../payloads",
      }) + "\n",
      "utf8",
    );
    writeFileSync(
      join(payloadEscape, "trace.jsonl"),
      JSON.stringify({
        schema_version: 1,
        seq: 1,
        wall_time_unix_ms: Date.parse("2026-05-03T01:00:01.000Z"),
        rollout_id: "payload-escape",
        payload: {
          type: "protocol_event_observed",
          event_payload: {
            payloadId: "outside",
            kind: "protocol",
            path: "../payloads/outside.json",
          },
        },
      }) + "\n",
      "utf8",
    );
    expect(() => replayAgenCRolloutTraceBundle(payloadEscape)).toThrow(
      /payload directory path escapes trace bundle/,
    );
  });

  it("rejects malformed trace manifests and raw envelopes", () => {
    const wrongSchema = join(rootDir, AGENC_ROLLOUT_TRACE_DIR, "wrong-schema");
    mkdirSync(wrongSchema, { recursive: true });
    writeFileSync(
      join(wrongSchema, "manifest.json"),
      JSON.stringify({
        schema_version: 99,
        trace_id: "wrong-schema",
        rollout_id: "wrong-schema",
        root_thread_id: "session-wrong-schema",
        started_at_unix_ms: Date.parse("2026-05-03T02:00:00.000Z"),
      }) + "\n",
      "utf8",
    );
    writeFileSync(join(wrongSchema, "trace.jsonl"), "", "utf8");
    expect(() => replayAgenCRolloutTraceBundle(wrongSchema)).toThrow(
      /unsupported trace manifest schema version/,
    );

    const badManifest = join(rootDir, AGENC_ROLLOUT_TRACE_DIR, "bad-manifest");
    mkdirSync(badManifest, { recursive: true });
    writeFileSync(
      join(badManifest, "manifest.json"),
      JSON.stringify({
        schema_version: 1,
        rollout_id: "missing-trace-id",
        root_thread_id: "session-bad",
        started_at_unix_ms: Date.parse("2026-05-03T02:00:00.000Z"),
      }) + "\n",
      "utf8",
    );
    writeFileSync(join(badManifest, "trace.jsonl"), "", "utf8");
    expect(() => replayAgenCRolloutTraceBundle(badManifest)).toThrow(
      /trace manifest missing trace_id/,
    );

    const badEvent = join(rootDir, AGENC_ROLLOUT_TRACE_DIR, "bad-event");
    mkdirSync(badEvent, { recursive: true });
    writeFileSync(
      join(badEvent, "manifest.json"),
      JSON.stringify({
        schema_version: 1,
        trace_id: "bad-event",
        rollout_id: "bad-event",
        root_thread_id: "session-bad-event",
        started_at_unix_ms: Date.parse("2026-05-03T02:00:00.000Z"),
      }) + "\n",
      "utf8",
    );
    writeFileSync(
      join(badEvent, "trace.jsonl"),
      JSON.stringify({
        schema_version: 1,
        seq: 1,
        rollout_id: "bad-event",
        payload: { type: "rollout_ended" },
      }) + "\n",
      "utf8",
    );
    expect(() => replayAgenCRolloutTraceBundle(badEvent)).toThrow(
      /raw trace event missing wall_time_unix_ms/,
    );

    writeFileSync(
      join(badEvent, "trace.jsonl"),
      JSON.stringify({
        seq: 1,
        wall_time_unix_ms: Date.parse("2026-05-03T02:00:01.000Z"),
        rollout_id: "bad-event",
        payload: { type: "rollout_ended" },
      }) + "\n",
      "utf8",
    );
    expect(() => replayAgenCRolloutTraceBundle(badEvent)).toThrow(
      /raw trace event missing schema_version/,
    );

    const mismatchedEvent = new AgenCRolloutTraceBundle({
      rootDir,
      rolloutId: "rollout-mismatch",
      rootSessionId: "session-mismatch",
      traceId: "trace-mismatch",
    });
    appendFileSync(
      join(mismatchedEvent.bundleDir, "trace.jsonl"),
      JSON.stringify({
        schemaVersion: 1,
        seq: 1,
        traceId: "other-trace",
        rolloutId: "rollout-mismatch",
        writtenAt: "2026-05-03T02:10:00.000Z",
        payload: { type: "rollout_ended" },
      }) + "\n",
      "utf8",
    );
    expect(() => replayAgenCRolloutTraceBundle(mismatchedEvent.bundleDir))
      .toThrow(/trace event traceId does not match manifest/);
  });
});
