import { describe, expect, it, vi } from "vitest";
import { UnifiedTelemetryCollector } from "./collector.js";
import { CompiledJobAlertSink } from "./compiled-job-alerts.js";
import { METRIC_NAMES } from "../task/metrics.js";

describe("CompiledJobAlertSink", () => {
  it("emits a total blocked-run spike alert when the threshold is exceeded", () => {
    const warn = vi.fn();
    const sink = new CompiledJobAlertSink({
      totalBlockedThreshold: 3,
      blockedReasonThreshold: 10,
      now: () => 1_000,
      logger: {
        debug: () => {},
        info: () => {},
        warn,
        error: () => {},
        setLevel: () => {},
      },
    });
    const telemetry = new UnifiedTelemetryCollector({ sinks: [sink] });

    telemetry.counter(METRIC_NAMES.COMPILED_JOB_BLOCKED, 2, {
      reason: "launch_paused",
      job_type: "web_research_brief",
    });
    telemetry.counter(METRIC_NAMES.COMPILED_JOB_BLOCKED, 2, {
      reason: "execution_global_concurrency_limit",
      job_type: "web_research_brief",
    });

    telemetry.flush();

    expect(sink.getRecentAlerts()).toContainEqual({
      id: "compiled_job.blocked_runs_spike:1000",
      severity: "warn",
      code: "compiled_job.blocked_runs_spike",
      message:
        "Compiled job blocked-run spike detected: 4 blocked runs since the last telemetry flush",
      createdAt: 1_000,
      delta: 4,
      threshold: 3,
    });
    expect(warn).toHaveBeenCalledWith(
      "Compiled job telemetry alert emitted",
      expect.objectContaining({
        code: "compiled_job.blocked_runs_spike",
        delta: 4,
        threshold: 3,
      }),
    );
  });

  it("emits per-reason alerts when a single denial reason spikes", () => {
    const sink = new CompiledJobAlertSink({
      totalBlockedThreshold: 99,
      blockedReasonThreshold: 3,
      now: () => 2_000,
    });
    const telemetry = new UnifiedTelemetryCollector({ sinks: [sink] });

    telemetry.counter(METRIC_NAMES.COMPILED_JOB_BLOCKED, 3, {
      reason: "compiler_version_not_enabled",
      job_type: "web_research_brief",
    });

    telemetry.flush();

    expect(sink.getRecentAlerts()).toContainEqual({
      id: "compiled_job.blocked_reason_spike:compiler_version_not_enabled:2000",
      severity: "warn",
      code: "compiled_job.blocked_reason_spike",
      message:
        "Compiled job blocked-run spike detected for compiler_version_not_enabled: 3 blocked runs since the last telemetry flush",
      createdAt: 2_000,
      delta: 3,
      threshold: 3,
      reason: "compiler_version_not_enabled",
    });
  });

  it("surfaces dependency failure spikes through the same blocked-run alerts", () => {
    const sink = new CompiledJobAlertSink({
      totalBlockedThreshold: 99,
      blockedReasonThreshold: 2,
      now: () => 2_500,
    });
    const telemetry = new UnifiedTelemetryCollector({ sinks: [sink] });

    telemetry.counter(METRIC_NAMES.COMPILED_JOB_BLOCKED, 2, {
      reason: "dependency_network_broker_unavailable",
      job_type: "web_research_brief",
    });

    telemetry.flush();

    expect(sink.getRecentAlerts()).toContainEqual({
      id: "compiled_job.blocked_reason_spike:dependency_network_broker_unavailable:2500",
      severity: "warn",
      code: "compiled_job.blocked_reason_spike",
      message:
        "Compiled job blocked-run spike detected for dependency_network_broker_unavailable: 2 blocked runs since the last telemetry flush",
      createdAt: 2_500,
      delta: 2,
      threshold: 2,
      reason: "dependency_network_broker_unavailable",
    });
  });

  it("dedupes repeated alerts inside the dedupe window", () => {
    let now = 10_000;
    const sink = new CompiledJobAlertSink({
      totalBlockedThreshold: 2,
      blockedReasonThreshold: 2,
      dedupeWindowMs: 5_000,
      now: () => now,
    });
    const telemetry = new UnifiedTelemetryCollector({ sinks: [sink] });

    telemetry.counter(METRIC_NAMES.COMPILED_JOB_BLOCKED, 2, {
      reason: "launch_paused",
      job_type: "web_research_brief",
    });
    telemetry.flush();

    now += 1_000;
    telemetry.counter(METRIC_NAMES.COMPILED_JOB_BLOCKED, 2, {
      reason: "launch_paused",
      job_type: "web_research_brief",
    });
    telemetry.flush();

    expect(sink.getRecentAlerts()).toHaveLength(2);
    expect(
      sink
        .getRecentAlerts()
        .filter((alert) => alert.code === "compiled_job.blocked_reason_spike"),
    ).toHaveLength(1);
    expect(
      sink
        .getRecentAlerts()
        .filter((alert) => alert.code === "compiled_job.blocked_runs_spike"),
    ).toHaveLength(1);
  });

  it("emits fresh alerts again after the dedupe window passes", () => {
    let now = 20_000;
    const sink = new CompiledJobAlertSink({
      totalBlockedThreshold: 2,
      blockedReasonThreshold: 2,
      dedupeWindowMs: 2_000,
      now: () => now,
    });
    const telemetry = new UnifiedTelemetryCollector({ sinks: [sink] });

    telemetry.counter(METRIC_NAMES.COMPILED_JOB_BLOCKED, 2, {
      reason: "launch_paused",
      job_type: "web_research_brief",
    });
    telemetry.flush();

    now += 2_500;
    telemetry.counter(METRIC_NAMES.COMPILED_JOB_BLOCKED, 2, {
      reason: "launch_paused",
      job_type: "web_research_brief",
    });
    telemetry.flush();

    expect(
      sink
        .getRecentAlerts()
        .filter((alert) => alert.code === "compiled_job.blocked_reason_spike"),
    ).toHaveLength(2);
  });
});
