import { describe, expect, test, afterEach, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENC_ROLLOUT_TRACE_ROOT_ENV,
  RAW_TRACE_EVENT_SCHEMA_VERSION,
  RolloutTraceRecorder,
  TraceWriter,
  createRolloutTraceRecorder,
  type RawTraceEvent,
  type ThreadStartedTraceMetadata,
} from "./rollout-trace.js";

function freshTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rollout-trace-test-"));
}

function rmTmp(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function readEventLog(bundleDir: string): RawTraceEvent[] {
  const logPath = join(bundleDir, "trace.jsonl");
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RawTraceEvent);
}

function sampleMetadata(overrides: Partial<ThreadStartedTraceMetadata> = {}):
  ThreadStartedTraceMetadata {
  return {
    threadId: "thread-root",
    agentPath: "/root",
    cwd: "/tmp/cwd",
    model: "test-model",
    providerName: "test-provider",
    ...overrides,
  };
}

describe("RolloutTraceRecorder.disabled", () => {
  test("records nothing and reports not-enabled", () => {
    const recorder = RolloutTraceRecorder.disabled();
    expect(recorder.enabled).toBe(false);
    expect(recorder.bundleDir).toBeUndefined();

    // Every call must be a no-op.
    recorder.recordThreadStarted(sampleMetadata());
    recorder.recordCodexTurnStarted("thread-root", "turn-1");
    recorder.flush();
    recorder.close();
  });

  test("context factories return disabled contexts when recorder is disabled", () => {
    const recorder = RolloutTraceRecorder.disabled();
    const codeCell = recorder.codeCellTraceContext({
      threadId: "t1",
      codexTurnId: "turn-1",
      runtimeCellId: "cell-1",
    });
    expect(codeCell.enabled).toBe(false);
    codeCell.recordEnded("completed");

    const dispatch = recorder.startToolDispatchTrace(() => undefined);
    expect(dispatch.enabled).toBe(false);

    const inference = recorder.inferenceTraceContext({
      threadId: "t1",
      codexTurnId: "turn-1",
      model: "m",
      providerName: "p",
    });
    expect(inference.enabled).toBe(false);

    const compaction = recorder.compactionTraceContext({
      threadId: "t1",
      codexTurnId: "turn-1",
      compactionId: "c1",
      model: "m",
      providerName: "p",
    });
    expect(compaction.enabled).toBe(false);
  });
});

describe("RolloutTraceRecorder.createRootOrDisabled (env-gated)", () => {
  const savedEnv = process.env[AGENC_ROLLOUT_TRACE_ROOT_ENV];
  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[AGENC_ROLLOUT_TRACE_ROOT_ENV];
    } else {
      process.env[AGENC_ROLLOUT_TRACE_ROOT_ENV] = savedEnv;
    }
  });

  test("returns disabled when env var is not set", () => {
    delete process.env[AGENC_ROLLOUT_TRACE_ROOT_ENV];
    const recorder = RolloutTraceRecorder.createRootOrDisabled("thread-env");
    expect(recorder.enabled).toBe(false);
  });

  test("returns enabled recorder when env var points at a writable root", () => {
    const root = freshTmpRoot();
    try {
      process.env[AGENC_ROLLOUT_TRACE_ROOT_ENV] = root;
      const recorder = RolloutTraceRecorder.createRootOrDisabled("thread-env");
      expect(recorder.enabled).toBe(true);
      expect(recorder.bundleDir).toBeDefined();
      expect(recorder.bundleDir!.startsWith(root)).toBe(true);
      recorder.close();
    } finally {
      rmTmp(root);
    }
  });
});

describe("RolloutTraceRecorder.createInRootForTest — filesystem semantics", () => {
  let root: string;
  beforeEach(() => {
    root = freshTmpRoot();
  });
  afterEach(() => {
    rmTmp(root);
  });

  test("creates bundle directory + manifest + empty event log on init", () => {
    const recorder = RolloutTraceRecorder.createInRootForTest(root, "thread-a");
    expect(recorder.enabled).toBe(true);
    const bundleDir = recorder.bundleDir!;
    expect(existsSync(bundleDir)).toBe(true);
    expect(existsSync(join(bundleDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(bundleDir, "trace.jsonl"))).toBe(true);
    expect(existsSync(join(bundleDir, "payloads"))).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(bundleDir, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.rootThreadId).toBe("thread-a");
    expect(manifest.rolloutId).toBe("thread-a");
    expect(manifest.rawEventLog).toBe("trace.jsonl");
    expect(manifest.payloadsDir).toBe("payloads");

    // The constructor writes exactly one RolloutStarted event.
    const events = readEventLog(bundleDir);
    expect(events).toHaveLength(1);
    expect(events[0]!.schemaVersion).toBe(RAW_TRACE_EVENT_SCHEMA_VERSION);
    expect(events[0]!.seq).toBe(1);
    expect(events[0]!.payload.type).toBe("rollout_started");
    recorder.close();
  });

  test("recordThreadStarted appends a thread_started event and writes metadata payload", () => {
    const recorder = RolloutTraceRecorder.createInRootForTest(root, "thread-b");
    const bundleDir = recorder.bundleDir!;
    recorder.recordThreadStarted(
      sampleMetadata({ threadId: "thread-b", agentPath: "/root" }),
    );
    recorder.flush();

    const events = readEventLog(bundleDir);
    // rollout_started + thread_started.
    expect(events.map((e) => e.payload.type)).toEqual([
      "rollout_started",
      "thread_started",
    ]);
    const started = events[1]!.payload;
    if (started.type !== "thread_started") throw new Error("unexpected");
    expect(started.threadId).toBe("thread-b");
    expect(started.agentPath).toBe("/root");
    expect(started.metadataPayload).toBeDefined();
    expect(started.metadataPayload!.kind).toBe("session_metadata");
    expect(started.metadataPayload!.path).toBe("payloads/1.json");

    const payloadPath = join(bundleDir, started.metadataPayload!.path);
    expect(existsSync(payloadPath)).toBe(true);
    const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(payload.threadId).toBe("thread-b");
    expect(payload.model).toBe("test-model");
    recorder.close();
  });

  test("recordCodexTurnStarted emits codex_turn_started with thread+turn context", () => {
    const recorder = RolloutTraceRecorder.createInRootForTest(root, "thread-c");
    recorder.recordCodexTurnStarted("thread-c", "turn-42");
    recorder.flush();
    const events = readEventLog(recorder.bundleDir!);
    const turn = events.find((e) => e.payload.type === "codex_turn_started");
    expect(turn).toBeDefined();
    expect(turn!.threadId).toBe("thread-c");
    expect(turn!.codexTurnId).toBe("turn-42");
    if (turn!.payload.type !== "codex_turn_started") throw new Error();
    expect(turn!.payload.threadId).toBe("thread-c");
    expect(turn!.payload.codexTurnId).toBe("turn-42");
    recorder.close();
  });

  test("event sequence numbers are monotonic across mixed lifecycle calls", () => {
    const recorder = RolloutTraceRecorder.createInRootForTest(root, "thread-f");
    recorder.recordThreadStarted(sampleMetadata({ threadId: "thread-f" }));
    for (let i = 0; i < 5; i += 1) {
      recorder.recordCodexTurnStarted("thread-f", `turn-${i}`);
    }
    recorder.flush();
    const events = readEventLog(recorder.bundleDir!);
    const seqs = events.map((e) => e.seq);
    // 1 rollout_started + 1 thread_started + 5 turn_started = 7 monotonic seqs.
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);
    recorder.close();
  });

  test("close is idempotent and swallows subsequent flush attempts", () => {
    const recorder = RolloutTraceRecorder.createInRootForTest(root, "thread-g");
    recorder.close();
    // No throw on repeat close / flush.
    recorder.close();
    recorder.flush();
  });
});

describe("TraceWriter — low-level writer", () => {
  let root: string;
  beforeEach(() => {
    root = freshTmpRoot();
  });
  afterEach(() => {
    rmTmp(root);
  });

  test("writeJsonPayload assigns monotonic ordinals and stable relative paths", () => {
    const bundleDir = join(root, "bundle-1");
    const writer = TraceWriter.create({
      bundleDir,
      traceId: "trace-1",
      rolloutId: "rollout-1",
      rootThreadId: "thread-root",
    });
    const ref1 = writer.writeJsonPayload("protocol_event", { i: 1 });
    const ref2 = writer.writeJsonPayload("tool_result", { i: 2 });
    expect(ref1.rawPayloadId).toBe("raw_payload:1");
    expect(ref2.rawPayloadId).toBe("raw_payload:2");
    expect(ref1.path).toBe("payloads/1.json");
    expect(ref2.path).toBe("payloads/2.json");
    expect(ref1.kind).toBe("protocol_event");
    expect(ref2.kind).toBe("tool_result");
    const files = readdirSync(join(bundleDir, "payloads")).sort();
    expect(files).toEqual(["1.json", "2.json"]);
    writer.close();
  });

  test("append + appendWithContext propagate thread/turn envelope", () => {
    const bundleDir = join(root, "bundle-2");
    const writer = TraceWriter.create({
      bundleDir,
      traceId: "trace-2",
      rolloutId: "rollout-2",
      rootThreadId: "thread-root",
    });
    writer.append({
      type: "rollout_started",
      traceId: "trace-2",
      rootThreadId: "thread-root",
    });
    writer.appendWithContext(
      { threadId: "thread-root", codexTurnId: "turn-1" },
      { type: "codex_turn_started", codexTurnId: "turn-1", threadId: "thread-root" },
    );
    writer.close();
    const events = readEventLog(bundleDir);
    expect(events).toHaveLength(2);
    expect(events[0]!.threadId).toBeUndefined();
    expect(events[1]!.threadId).toBe("thread-root");
    expect(events[1]!.codexTurnId).toBe("turn-1");
  });

  test("writer throws when reused after close", () => {
    const bundleDir = join(root, "bundle-3");
    const writer = TraceWriter.create({
      bundleDir,
      traceId: "trace-3",
      rolloutId: "rollout-3",
      rootThreadId: "thread-root",
    });
    writer.close();
    expect(() =>
      writer.append({
        type: "rollout_started",
        traceId: "trace-3",
        rootThreadId: "thread-root",
      }),
    ).toThrow();
  });
});

describe("createRolloutTraceRecorder factory", () => {
  let root: string;
  beforeEach(() => {
    root = freshTmpRoot();
  });
  afterEach(() => {
    rmTmp(root);
  });

  test("disabled: true returns a disabled recorder", () => {
    const recorder = createRolloutTraceRecorder({
      threadId: "thread-x",
      disabled: true,
    });
    expect(recorder.enabled).toBe(false);
  });

  test("inherit takes priority over every other field", () => {
    const parent = RolloutTraceRecorder.createInRootForTest(root, "thread-root");
    const child = createRolloutTraceRecorder({
      threadId: "thread-child",
      inherit: parent,
      root,
    });
    // Inherited recorder is the exact same handle.
    expect(child).toBe(parent);
    expect(child.enabled).toBe(true);
    parent.close();
  });

  test("root override creates a recorder without touching env", () => {
    const savedEnv = process.env[AGENC_ROLLOUT_TRACE_ROOT_ENV];
    delete process.env[AGENC_ROLLOUT_TRACE_ROOT_ENV];
    try {
      const recorder = createRolloutTraceRecorder({
        threadId: "thread-root-override",
        root,
      });
      expect(recorder.enabled).toBe(true);
      expect(recorder.bundleDir!.startsWith(root)).toBe(true);
      recorder.close();
    } finally {
      if (savedEnv !== undefined) {
        process.env[AGENC_ROLLOUT_TRACE_ROOT_ENV] = savedEnv;
      }
    }
  });
});
