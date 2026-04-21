import { METRIC_NAMES } from "../task/metrics.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import type { TelemetrySink, TelemetrySnapshot } from "./types.js";

const DEFAULT_TOTAL_BLOCKED_THRESHOLD = 10;
const DEFAULT_REASON_BLOCKED_THRESHOLD = 5;
const DEFAULT_MAX_RECENT_ALERTS = 20;
const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60_000;

export interface CompiledJobTelemetryAlert {
  readonly id: string;
  readonly severity: "warn" | "error";
  readonly code:
    | "compiled_job.blocked_runs_spike"
    | "compiled_job.blocked_reason_spike";
  readonly message: string;
  readonly createdAt: number;
  readonly delta: number;
  readonly threshold: number;
  readonly reason?: string;
}

export interface CompiledJobAlertSinkOptions {
  readonly totalBlockedThreshold?: number;
  readonly blockedReasonThreshold?: number;
  readonly maxRecentAlerts?: number;
  readonly dedupeWindowMs?: number;
  readonly now?: () => number;
  readonly logger?: Logger;
}

interface EmittedAlertState {
  readonly createdAt: number;
  readonly alert: CompiledJobTelemetryAlert;
}

export class CompiledJobAlertSink implements TelemetrySink {
  readonly name = "compiled-job-alerts";

  private readonly totalBlockedThreshold: number;
  private readonly blockedReasonThreshold: number;
  private readonly maxRecentAlerts: number;
  private readonly dedupeWindowMs: number;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly previousCounters = new Map<string, number>();
  private readonly recentAlerts: CompiledJobTelemetryAlert[] = [];
  private readonly dedupeState = new Map<string, EmittedAlertState>();

  constructor(options: CompiledJobAlertSinkOptions = {}) {
    this.totalBlockedThreshold =
      options.totalBlockedThreshold ?? DEFAULT_TOTAL_BLOCKED_THRESHOLD;
    this.blockedReasonThreshold =
      options.blockedReasonThreshold ?? DEFAULT_REASON_BLOCKED_THRESHOLD;
    this.maxRecentAlerts = options.maxRecentAlerts ?? DEFAULT_MAX_RECENT_ALERTS;
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? silentLogger;
  }

  flush(snapshot: TelemetrySnapshot): void {
    const counters = extractCompiledJobBlockedCounters(snapshot.counters);
    if (counters.length === 0) {
      return;
    }

    const reasonDeltas = new Map<string, number>();
    let totalDelta = 0;

    for (const counter of counters) {
      const previous = this.previousCounters.get(counter.key);
      const delta =
        previous === undefined
          ? counter.value
          : counter.value >= previous
            ? counter.value - previous
            : counter.value;
      this.previousCounters.set(counter.key, counter.value);
      if (delta <= 0) continue;
      totalDelta += delta;
      const reason = counter.labels.reason ?? "unknown";
      reasonDeltas.set(reason, (reasonDeltas.get(reason) ?? 0) + delta);
    }

    const now = this.now();

    if (totalDelta >= this.totalBlockedThreshold) {
      this.emitAlert(
        {
          id: `compiled_job.blocked_runs_spike:${now}`,
          severity:
            totalDelta >= this.totalBlockedThreshold * 2 ? "error" : "warn",
          code: "compiled_job.blocked_runs_spike",
          message:
            `Compiled job blocked-run spike detected: ${totalDelta} blocked runs ` +
            "since the last telemetry flush",
          createdAt: now,
          delta: totalDelta,
          threshold: this.totalBlockedThreshold,
        },
        now,
      );
    }

    for (const [reason, delta] of reasonDeltas) {
      if (delta < this.blockedReasonThreshold) continue;
      this.emitAlert(
        {
          id: `compiled_job.blocked_reason_spike:${reason}:${now}`,
          severity:
            delta >= this.blockedReasonThreshold * 2 ? "error" : "warn",
          code: "compiled_job.blocked_reason_spike",
          message:
            `Compiled job blocked-run spike detected for ${reason}: ${delta} blocked runs ` +
            "since the last telemetry flush",
          createdAt: now,
          delta,
          threshold: this.blockedReasonThreshold,
          reason,
        },
        now,
      );
    }
  }

  getRecentAlerts(): readonly CompiledJobTelemetryAlert[] {
    return [...this.recentAlerts];
  }

  reset(): void {
    this.previousCounters.clear();
    this.recentAlerts.length = 0;
    this.dedupeState.clear();
  }

  private emitAlert(alert: CompiledJobTelemetryAlert, now: number): void {
    const dedupeKey = `${alert.code}:${alert.reason ?? "all"}`;
    const previous = this.dedupeState.get(dedupeKey);
    if (previous && now - previous.createdAt < this.dedupeWindowMs) {
      return;
    }

    this.dedupeState.set(dedupeKey, {
      createdAt: now,
      alert,
    });
    this.recentAlerts.unshift(alert);
    if (this.recentAlerts.length > this.maxRecentAlerts) {
      this.recentAlerts.length = this.maxRecentAlerts;
    }

    this.logger.warn("Compiled job telemetry alert emitted", {
      code: alert.code,
      severity: alert.severity,
      message: alert.message,
      delta: alert.delta,
      threshold: alert.threshold,
      reason: alert.reason,
    });
  }
}

function extractCompiledJobBlockedCounters(
  counters: Record<string, number>,
): Array<{
  readonly key: string;
  readonly value: number;
  readonly labels: Record<string, string>;
}> {
  return Object.entries(counters)
    .filter(([key]) =>
      key === METRIC_NAMES.COMPILED_JOB_BLOCKED ||
      key.startsWith(`${METRIC_NAMES.COMPILED_JOB_BLOCKED}|`),
    )
    .map(([key, value]) => ({
      key,
      value,
      labels: parseCompositeLabels(key),
    }));
}

function parseCompositeLabels(key: string): Record<string, string> {
  const [, ...labelParts] = key.split("|");
  const labels: Record<string, string> = {};
  for (const part of labelParts) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (!name || !value) continue;
    labels[name] = value;
  }
  return labels;
}
