import { afterEach, describe, expect, test } from "vitest";

import {
  AGENC_COMPACT_CALL_METRIC,
  AGENC_COMPACT_DURATION_METRIC,
  resetAgencTelemetryClient,
  setAgencTelemetryClient,
  type TelemetryAttributes,
  type TelemetryClient,
  type TelemetrySpan,
  type TelemetryTags,
  type TelemetryTimer,
} from "../src/observability/telemetry.js";
import { runContextCollapseOverflowRecovery } from "../src/phases/post-sample-recovery.js";

class RecordingSpan implements TelemetrySpan {
  readonly attributes: Record<string, unknown> = {};

  constructor(readonly name: string) {}

  setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }

  setAttributes(attributes: TelemetryAttributes): void {
    Object.assign(this.attributes, attributes);
  }

  addEvent(_name: string, _attributes?: TelemetryAttributes): void {}

  enter<T>(fn: () => T): T {
    return fn();
  }

  end(): void {}
}

class RecordingTimer implements TelemetryTimer {
  readonly records: TelemetryTags[] = [];

  constructor(
    readonly name: string,
    readonly tags?: TelemetryTags,
  ) {}

  record(additionalTags: TelemetryTags = {}): void {
    this.records.push(additionalTags);
  }

  end(additionalTags: TelemetryTags = {}): void {
    this.record(additionalTags);
  }
}

class RecordingTelemetryClient implements TelemetryClient {
  readonly counters: Array<{
    readonly name: string;
    readonly increment: number;
    readonly tags?: TelemetryTags;
  }> = [];
  readonly timers: RecordingTimer[] = [];

  startSpan(name: string, attributes?: TelemetryAttributes): TelemetrySpan {
    const span = new RecordingSpan(name);
    if (attributes !== undefined) span.setAttributes(attributes);
    return span;
  }

  withSpan<T>(
    _name: string,
    _attributes: TelemetryAttributes | undefined,
    fn: () => T,
  ): T {
    return fn();
  }

  getCurrentSpan(): TelemetrySpan | undefined {
    return undefined;
  }

  counter(name: string, increment = 1, tags?: TelemetryTags): void {
    this.counters.push({ name, increment, tags });
  }

  histogram(_name: string, _value: number, _tags?: TelemetryTags): void {}

  recordDuration(_name: string, _durationMs: number, _tags?: TelemetryTags): void {}

  timer(name: string, tags?: TelemetryTags): TelemetryTimer {
    const timer = new RecordingTimer(name, tags);
    this.timers.push(timer);
    return timer;
  }

  event(_name: string, _attributes?: TelemetryAttributes): void {}
}

afterEach(() => {
  resetAgencTelemetryClient();
});

describe("runtime session compact telemetry", () => {
  test("records compact overflow recovery pass telemetry", async () => {
    const recording = new RecordingTelemetryClient();
    setAgencTelemetryClient(recording);

    const result = await runContextCollapseOverflowRecovery({
      state: {
        messages: [],
        messagesForQuery: [],
      } as never,
    });

    expect(result).toEqual({ kind: "pass" });
    expect(recording.counters).toContainEqual({
      name: AGENC_COMPACT_CALL_METRIC,
      increment: 1,
      tags: { mode: "overflow_recovery", status: "pass" },
    });
    expect(recording.timers[0]?.name).toBe(AGENC_COMPACT_DURATION_METRIC);
    expect(recording.timers[0]?.tags).toEqual({ mode: "overflow_recovery" });
    expect(recording.timers[0]?.records).toEqual([
      { mode: "overflow_recovery", status: "pass" },
    ]);
  });
});
