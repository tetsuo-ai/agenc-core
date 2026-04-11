/**
 * Runtime incident diagnostics and degraded/safe-mode state tracking.
 *
 * @module
 */

import type { TelemetryCollector } from "./types.js";
import { TELEMETRY_METRIC_NAMES } from "./metric-names.js";

export type RuntimeDependencyDomain =
  | "provider"
  | "tool"
  | "persistence"
  | "approval_store"
  | "child_run"
  | "daemon";

export type RuntimeDependencyMode = "healthy" | "degraded" | "safe_mode";

interface RuntimeIncidentRecord {
  readonly id: string;
  readonly domain: RuntimeDependencyDomain;
  readonly mode: Exclude<RuntimeDependencyMode, "healthy">;
  readonly severity: "warn" | "error";
  readonly code: string;
  readonly message: string;
  readonly createdAt: number;
  readonly count: number;
  readonly sessionId?: string;
  readonly runId?: string;
}

interface RuntimeDependencySnapshot {
  readonly domain: RuntimeDependencyDomain;
  readonly mode: Exclude<RuntimeDependencyMode, "healthy">;
  readonly since: number;
  readonly code: string;
  readonly message: string;
  readonly incidentId: string;
  readonly count: number;
  readonly sessionId?: string;
  readonly runId?: string;
}

interface RuntimeIncidentSnapshot {
  readonly runtimeMode: RuntimeDependencyMode;
  readonly dependencies: readonly RuntimeDependencySnapshot[];
  readonly recentIncidents: readonly RuntimeIncidentRecord[];
}

interface RuntimeIncidentDiagnosticsConfig {
  readonly telemetry?: TelemetryCollector;
  readonly now?: () => number;
  readonly maxIncidents?: number;
}

function modeRank(mode: RuntimeDependencyMode): number {
  switch (mode) {
    case "safe_mode":
      return 2;
    case "degraded":
      return 1;
    default:
      return 0;
  }
}

export class RuntimeIncidentDiagnostics {
  private readonly telemetry?: TelemetryCollector;
  private readonly now: () => number;
  private readonly maxIncidents: number;
  private readonly incidents: RuntimeIncidentRecord[] = [];
  private readonly dependencies = new Map<
    RuntimeDependencyDomain,
    RuntimeDependencySnapshot
  >();

  constructor(config: RuntimeIncidentDiagnosticsConfig = {}) {
    this.telemetry = config.telemetry;
    this.now = config.now ?? Date.now;
    this.maxIncidents = Math.max(8, config.maxIncidents ?? 64);
  }

  report(params: {
    domain: RuntimeDependencyDomain;
    mode: Exclude<RuntimeDependencyMode, "healthy">;
    severity: "warn" | "error";
    code: string;
    message: string;
    sessionId?: string;
    runId?: string;
  }): RuntimeIncidentRecord {
    const now = this.now();
    const existing = this.dependencies.get(params.domain);
    const count = existing && existing.code === params.code ? existing.count + 1 : 1;
    const record: RuntimeIncidentRecord = {
      id: `${params.domain}:${params.code}:${now}:${Math.random().toString(36).slice(2, 8)}`,
      domain: params.domain,
      mode: params.mode,
      severity: params.severity,
      code: params.code,
      message: params.message,
      createdAt: now,
      count,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
    };
    this.incidents.unshift(record);
    if (this.incidents.length > this.maxIncidents) {
      this.incidents.length = this.maxIncidents;
    }
    this.dependencies.set(params.domain, {
      domain: params.domain,
      mode: params.mode,
      since: existing?.since ?? now,
      code: params.code,
      message: params.message,
      incidentId: record.id,
      count,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
    });
    this.telemetry?.counter(TELEMETRY_METRIC_NAMES.RUNTIME_INCIDENTS_TOTAL, 1, {
      domain: params.domain,
      mode: params.mode,
      code: params.code,
    });
    this.refreshModeGauges();
    return record;
  }

  clearDomain(domain: RuntimeDependencyDomain): void {
    if (!this.dependencies.has(domain)) return;
    this.dependencies.delete(domain);
    this.refreshModeGauges();
  }

  getSnapshot(): RuntimeIncidentSnapshot {
    return {
      runtimeMode: this.resolveRuntimeMode(),
      dependencies: [...this.dependencies.values()].sort((left, right) =>
        left.domain.localeCompare(right.domain),
      ),
      recentIncidents: [...this.incidents],
    };
  }

  private resolveRuntimeMode(): RuntimeDependencyMode {
    let current: RuntimeDependencyMode = "healthy";
    for (const dependency of this.dependencies.values()) {
      if (modeRank(dependency.mode) > modeRank(current)) {
        current = dependency.mode;
      }
    }
    return current;
  }

  private refreshModeGauges(): void {
    const snapshot = this.getSnapshot();
    this.telemetry?.gauge(
      TELEMETRY_METRIC_NAMES.RUNTIME_DEGRADED_DEPENDENCIES_TOTAL,
      snapshot.dependencies.length,
      { runtime_mode: snapshot.runtimeMode },
    );
    this.telemetry?.gauge(
      TELEMETRY_METRIC_NAMES.RUNTIME_MODE_ACTIVE,
      snapshot.runtimeMode === "healthy" ? 0 : snapshot.runtimeMode === "degraded" ? 1 : 2,
      { runtime_mode: snapshot.runtimeMode },
    );
  }
}
