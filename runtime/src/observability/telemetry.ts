import { AsyncLocalStorage } from "node:async_hooks";

export type TelemetryAttributeValue =
  | string
  | number
  | boolean
  | null
  | undefined;

export type TelemetryAttributes = Readonly<
  Record<string, TelemetryAttributeValue | readonly TelemetryAttributeValue[]>
>;

export type TelemetryTags = Readonly<Record<string, string>>;

export interface TelemetrySpan {
  readonly name: string;
  setAttribute(key: string, value: TelemetryAttributeValue): void;
  setAttributes(attributes: TelemetryAttributes): void;
  addEvent(name: string, attributes?: TelemetryAttributes): void;
  enter<T>(fn: () => T): T;
  end(): void;
}

export interface TelemetryTimer {
  record(additionalTags?: TelemetryTags): void;
  end(additionalTags?: TelemetryTags): void;
}

export interface TelemetryClient {
  startSpan(name: string, attributes?: TelemetryAttributes): TelemetrySpan;
  withSpan<T>(
    name: string,
    attributes: TelemetryAttributes | undefined,
    fn: () => T,
  ): T;
  getCurrentSpan(): TelemetrySpan | undefined;
  counter(name: string, increment?: number, tags?: TelemetryTags): void;
  histogram(name: string, value: number, tags?: TelemetryTags): void;
  recordDuration(name: string, durationMs: number, tags?: TelemetryTags): void;
  timer(name: string, tags?: TelemetryTags): TelemetryTimer;
  event(name: string, attributes?: TelemetryAttributes): void;
}

export const AGENC_TOOL_UNIFIED_EXEC_METRIC =
  "agenc.tool.unified_exec";
export const AGENC_TOOL_UNIFIED_EXEC_DURATION_METRIC =
  "agenc.tool.unified_exec.duration_ms";
export const AGENC_MCP_CALL_METRIC = "agenc.mcp.call";
export const AGENC_MCP_CALL_DURATION_METRIC = "agenc.mcp.call.duration_ms";
export const AGENC_HOOK_RUN_METRIC = "agenc.hooks.run";
export const AGENC_HOOK_RUN_DURATION_METRIC =
  "agenc.hooks.run.duration_ms";
export const AGENC_TURN_E2E_DURATION_METRIC =
  "agenc.turn.e2e_duration_ms";
export const AGENC_TURN_TTFT_DURATION_METRIC =
  "agenc.turn.ttft.duration_ms";
export const AGENC_TURN_TTFM_DURATION_METRIC =
  "agenc.turn.ttfm.duration_ms";
export const AGENC_STARTUP_PREWARM_DURATION_METRIC =
  "agenc.startup_prewarm.duration_ms";
export const AGENC_STARTUP_PREWARM_AGE_AT_FIRST_TURN_METRIC =
  "agenc.startup_prewarm.age_at_first_turn_ms";
export const AGENC_COMPACT_CALL_METRIC = "agenc.compact.call";
export const AGENC_COMPACT_DURATION_METRIC = "agenc.compact.duration_ms";
export const AGENC_WINDOWS_SANDBOX_SETUP_DURATION_METRIC =
  "agenc.windows_sandbox.setup_duration_ms";
export const AGENC_WINDOWS_SANDBOX_SETUP_SUCCESS_METRIC =
  "agenc.windows_sandbox.setup_success";
export const AGENC_WINDOWS_SANDBOX_SETUP_FAILURE_METRIC =
  "agenc.windows_sandbox.setup_failure";

const DEFAULT_TAG_VALUE = "unknown";
const MAX_TAG_VALUE_CHARS = 128;

class NoopTelemetrySpan implements TelemetrySpan {
  private ended = false;

  constructor(readonly name: string) {}

  setAttribute(_key: string, _value: TelemetryAttributeValue): void {}

  setAttributes(_attributes: TelemetryAttributes): void {}

  addEvent(_name: string, _attributes?: TelemetryAttributes): void {}

  enter<T>(fn: () => T): T {
    return fn();
  }

  end(): void {
    this.ended = true;
  }

  get isEnded(): boolean {
    return this.ended;
  }
}

class NoopTelemetryTimer implements TelemetryTimer {
  record(_additionalTags?: TelemetryTags): void {
    return;
  }

  end(additionalTags?: TelemetryTags): void {
    this.record(additionalTags);
  }
}

class NoopTelemetryClient implements TelemetryClient {
  private readonly spanStorage = new AsyncLocalStorage<TelemetrySpan>();

  startSpan(name: string, _attributes?: TelemetryAttributes): TelemetrySpan {
    return new NoopTelemetrySpan(name);
  }

  withSpan<T>(
    name: string,
    attributes: TelemetryAttributes | undefined,
    fn: () => T,
  ): T {
    const span = this.startSpan(name, attributes);
    return this.spanStorage.run(span, () => {
      try {
        const result = span.enter(fn);
        if (isPromiseLike(result)) {
          return (result as Promise<unknown>).finally(() => {
            span.end();
          }) as T;
        }
        span.end();
        return result;
      } catch (error) {
        span.end();
        throw error;
      }
    });
  }

  getCurrentSpan(): TelemetrySpan | undefined {
    return this.spanStorage.getStore();
  }

  counter(_name: string, _increment = 1, _tags?: TelemetryTags): void {}

  histogram(_name: string, _value: number, _tags?: TelemetryTags): void {}

  recordDuration(_name: string, _durationMs: number, _tags?: TelemetryTags): void {}

  timer(_name: string, _tags?: TelemetryTags): TelemetryTimer {
    return new NoopTelemetryTimer();
  }

  event(_name: string, _attributes?: TelemetryAttributes): void {}
}

export function createNoopTelemetryClient(): TelemetryClient {
  return new NoopTelemetryClient();
}

export let agencTelemetry: TelemetryClient = createNoopTelemetryClient();

export function setAgencTelemetryClient(client: TelemetryClient): () => void {
  const previous = agencTelemetry;
  agencTelemetry = client;
  return () => {
    agencTelemetry = previous;
  };
}

export function resetAgencTelemetryClient(): void {
  agencTelemetry = createNoopTelemetryClient();
}

export function sanitizeMetricTagValue(value: unknown): string {
  const raw =
    value === null || value === undefined ? "" : String(value).trim();
  if (raw.length === 0) return DEFAULT_TAG_VALUE;
  const cleaned = raw
    .replace(/[^A-Za-z0-9_.:/-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const safe = cleaned.length === 0 ? DEFAULT_TAG_VALUE : cleaned;
  return safe.slice(0, MAX_TAG_VALUE_CHARS);
}

export function toMetricTags(
  values: Readonly<Record<string, unknown>>,
): TelemetryTags {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    tags[key] = sanitizeMetricTagValue(value);
  }
  return tags;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { finally?: unknown }).finally === "function"
  );
}
