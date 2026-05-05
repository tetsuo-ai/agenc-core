import { afterEach, describe, expect, test } from "vitest";

import {
  AGENC_HOOK_RUN_METRIC,
  agencTelemetry,
  createNoopTelemetryClient,
  resetAgencTelemetryClient,
  sanitizeMetricTagValue,
  setAgencTelemetryClient,
  toMetricTags,
  type TelemetryAttributes,
  type TelemetryClient,
  type TelemetrySpan,
  type TelemetryTags,
  type TelemetryTimer,
} from "./telemetry.js";

class RecordingSpan implements TelemetrySpan {
  readonly attributes: Record<string, unknown> = {};
  readonly events: Array<{ name: string; attributes?: TelemetryAttributes }> = [];
  ended = false;

  constructor(readonly name: string) {}

  setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }

  setAttributes(attributes: TelemetryAttributes): void {
    Object.assign(this.attributes, attributes);
  }

  addEvent(name: string, attributes?: TelemetryAttributes): void {
    this.events.push({ name, attributes });
  }

  enter<T>(fn: () => T): T {
    return fn();
  }

  end(): void {
    this.ended = true;
  }
}

class RecordingTimer implements TelemetryTimer {
  readonly records: TelemetryTags[] = [];

  record(additionalTags: TelemetryTags = {}): void {
    this.records.push(additionalTags);
  }

  end(additionalTags: TelemetryTags = {}): void {
    this.record(additionalTags);
  }
}

class RecordingTelemetryClient implements TelemetryClient {
  readonly spans: RecordingSpan[] = [];
  readonly counters: Array<{
    name: string;
    increment: number;
    tags?: TelemetryTags;
  }> = [];
  readonly durations: Array<{
    name: string;
    durationMs: number;
    tags?: TelemetryTags;
  }> = [];
  readonly timers: RecordingTimer[] = [];
  current: TelemetrySpan | undefined;

  startSpan(name: string, attributes?: TelemetryAttributes): TelemetrySpan {
    const span = new RecordingSpan(name);
    if (attributes !== undefined) span.setAttributes(attributes);
    this.spans.push(span);
    return span;
  }

  withSpan<T>(
    name: string,
    attributes: TelemetryAttributes | undefined,
    fn: () => T,
  ): T {
    const previous = this.current;
    const span = this.startSpan(name, attributes);
    this.current = span;
    try {
      return span.enter(fn);
    } finally {
      span.end();
      this.current = previous;
    }
  }

  getCurrentSpan(): TelemetrySpan | undefined {
    return this.current;
  }

  counter(name: string, increment = 1, tags?: TelemetryTags): void {
    this.counters.push({ name, increment, tags });
  }

  histogram(_name: string, _value: number, _tags?: TelemetryTags): void {}

  recordDuration(name: string, durationMs: number, tags?: TelemetryTags): void {
    this.durations.push({ name, durationMs, tags });
  }

  timer(_name: string, _tags?: TelemetryTags): TelemetryTimer {
    const timer = new RecordingTimer();
    this.timers.push(timer);
    return timer;
  }

  event(_name: string, _attributes?: TelemetryAttributes): void {}
}

afterEach(() => {
  resetAgencTelemetryClient();
});

describe("observability telemetry", () => {
  test("default no-op client preserves the full call surface", async () => {
    const noop = createNoopTelemetryClient();
    const span = noop.startSpan("test.span", { "test.attr": "value" });

    span.setAttribute("later", true);
    span.addEvent("event", { count: 1 });
    expect(span.enter(() => 42)).toBe(42);
    span.end();
    noop.counter("test.counter", 1, { status: "ok" });
    noop.histogram("test.histogram", 3, { status: "ok" });
    noop.recordDuration("test.duration", 7, { status: "ok" });
    noop.timer("test.timer", { status: "ok" }).end({ result: "done" });
    await noop.withSpan("test.async", undefined, async () => "done");

    expect(noop.getCurrentSpan()).toBeUndefined();
  });

  test("global client can be swapped without changing call sites", () => {
    const recording = new RecordingTelemetryClient();
    const restore = setAgencTelemetryClient(recording);

    const span = agencTelemetry.startSpan("session.task", {
      "task.kind": "regular",
    });
    span.addEvent("started");
    span.end();
    agencTelemetry.counter(
      AGENC_HOOK_RUN_METRIC,
      1,
      toMetricTags({ status: "completed" }),
    );

    restore();

    expect(recording.spans[0]?.name).toBe("session.task");
    expect(recording.spans[0]?.attributes["task.kind"]).toBe("regular");
    expect(recording.spans[0]?.events[0]?.name).toBe("started");
    expect(recording.spans[0]?.ended).toBe(true);
    expect(recording.counters).toEqual([
      {
        name: AGENC_HOOK_RUN_METRIC,
        increment: 1,
        tags: { status: "completed" },
      },
    ]);
  });

  test("metric tags are sanitized and bounded", () => {
    expect(sanitizeMetricTagValue("  hello world!*  ")).toBe("hello_world");
    expect(sanitizeMetricTagValue("")).toBe("unknown");
    expect(toMetricTags({ ok: true, missing: undefined })).toEqual({
      ok: "true",
      missing: "unknown",
    });
  });
});
