/**
 * Explicitly gated runtime fault injection helpers for evals and operator drills.
 *
 * These hooks are inert unless a RuntimeFaultInjector instance is passed into
 * runtime-owned execution paths. Production behavior must never implicitly
 * enable them through environment defaults.
 *
 * @module
 */

import { LLMTimeoutError } from "../llm/errors.js";

export type FaultInjectionPoint =
  | "provider_timeout"
  | "tool_timeout"
  | "persistence_failure"
  | "approval_store_failure"
  | "child_run_crash"
  | "daemon_restart";

interface FaultInjectionEvent {
  readonly point: FaultInjectionPoint;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly operation?: string;
  readonly provider?: string;
}

interface FaultInjectionRule {
  readonly point: FaultInjectionPoint;
  readonly triggerAt?: number;
  readonly maxTriggers?: number;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly operation?: string;
  readonly provider?: string;
  readonly message?: string;
}

interface FaultInjectionRecord extends FaultInjectionEvent {
  readonly triggeredAt: number;
  readonly triggerCount: number;
}

export class FaultInjectionError extends Error {
  readonly point: FaultInjectionPoint;
  readonly operation?: string;
  readonly transient: boolean;

  constructor(
    point: FaultInjectionPoint,
    message: string,
    options?: {
      operation?: string;
      transient?: boolean;
    },
  ) {
    super(message);
    this.name = "FaultInjectionError";
    this.point = point;
    this.operation = options?.operation;
    this.transient = options?.transient ?? point !== "persistence_failure";
  }
}

function ruleMatches(
  rule: FaultInjectionRule,
  event: FaultInjectionEvent,
): boolean {
  if (rule.point !== event.point) return false;
  if (rule.sessionId && rule.sessionId !== event.sessionId) return false;
  if (rule.runId && rule.runId !== event.runId) return false;
  if (rule.operation && rule.operation !== event.operation) return false;
  if (rule.provider && rule.provider !== event.provider) return false;
  return true;
}

function buildFaultError(
  rule: FaultInjectionRule,
  event: FaultInjectionEvent,
): Error {
  switch (event.point) {
    case "provider_timeout":
      return new LLMTimeoutError(
        event.provider ?? "fault-injector",
        60_000,
      );
    case "tool_timeout": {
      return new FaultInjectionError(
        event.point,
        rule.message ??
          `Injected tool timeout${event.operation ? ` during ${event.operation}` : ""}`,
        { operation: event.operation },
      );
    }
    case "persistence_failure":
      return new FaultInjectionError(
        event.point,
        rule.message ??
          `Injected persistence failure${event.operation ? ` during ${event.operation}` : ""}`,
        { operation: event.operation, transient: false },
      );
    case "approval_store_failure":
      return new FaultInjectionError(
        event.point,
        rule.message ??
          `Injected approval-store failure${event.operation ? ` during ${event.operation}` : ""}`,
        { operation: event.operation },
      );
    case "child_run_crash":
      return new FaultInjectionError(
        event.point,
        rule.message ?? "Injected child-run crash",
        { operation: event.operation },
      );
    case "daemon_restart":
      return new FaultInjectionError(
        event.point,
        rule.message ?? "Injected daemon restart fault",
        { operation: event.operation },
      );
    default:
      return new FaultInjectionError(
        event.point,
        rule.message ?? `Injected fault at ${event.point}`,
        { operation: event.operation },
      );
  }
}

interface RuntimeFaultInjectorConfig {
  readonly enabled?: boolean;
  readonly rules?: readonly FaultInjectionRule[];
  readonly now?: () => number;
}

export class RuntimeFaultInjector {
  private readonly enabled: boolean;
  private readonly rules: readonly FaultInjectionRule[];
  private readonly now: () => number;
  private readonly attempts = new Map<string, number>();
  private readonly triggered = new Map<string, number>();
  private readonly records: FaultInjectionRecord[] = [];

  constructor(config: RuntimeFaultInjectorConfig = {}) {
    this.enabled = config.enabled === true;
    this.rules = config.rules ?? [];
    this.now = config.now ?? Date.now;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  listRecords(): readonly FaultInjectionRecord[] {
    return [...this.records];
  }

  maybeThrow(event: FaultInjectionEvent): void {
    if (!this.enabled) return;
    for (const [index, rule] of this.rules.entries()) {
      if (!ruleMatches(rule, event)) continue;
      const key = `${index}:${event.point}:${event.sessionId ?? ""}:${event.runId ?? ""}:${event.operation ?? ""}:${event.provider ?? ""}`;
      const attempt = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, attempt);
      const triggerAt = Math.max(1, rule.triggerAt ?? 1);
      const maxTriggers = Math.max(1, rule.maxTriggers ?? 1);
      if (attempt < triggerAt) {
        continue;
      }
      const triggerCount = this.triggered.get(key) ?? 0;
      if (triggerCount >= maxTriggers) {
        continue;
      }
      this.triggered.set(key, triggerCount + 1);
      this.records.push({
        ...event,
        triggeredAt: this.now(),
        triggerCount: triggerCount + 1,
      });
      throw buildFaultError(rule, event);
    }
  }
}
