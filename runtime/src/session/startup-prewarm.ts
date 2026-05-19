import type { LLMProviderStartupPrewarmHandle } from "../llm/types.js";
import type { Session } from "./session.js";
import {
  AGENC_STARTUP_PREWARM_AGE_AT_FIRST_TURN_METRIC,
  AGENC_STARTUP_PREWARM_DURATION_METRIC,
  agencTelemetry,
  toMetricTags,
} from "../observability/telemetry.js";

const DEFAULT_PROVIDER_STARTUP_PREWARM_BOUND_MS = 250;

export interface StartupPrewarmStore {
  setProviderHandle(handle: LLMProviderStartupPrewarmHandle): void;
  setProviderTask(
    task: Promise<LLMProviderStartupPrewarmHandle | void>,
    opts?: { readonly boundMs?: number },
  ): void;
  consumeProviderHandle(opts?: {
    readonly boundMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<LLMProviderStartupPrewarmHandle | undefined>;
  expireProviderHandle(): Promise<void>;
  clear(): Promise<void>;
}

interface PendingProviderStartupPrewarm {
  readonly promise: Promise<ProviderStartupPrewarmResolution>;
  readonly startedAtMs: number;
  readonly boundMs: number;
}

type ProviderStartupPrewarmResolution =
  | {
      readonly status: "ready" | "consumed";
      readonly handle: LLMProviderStartupPrewarmHandle;
    }
  | {
      readonly status: "failed" | "unavailable" | "timed_out" | "cancelled";
      readonly handle?: undefined;
    };

class SessionStartupPrewarmStore implements StartupPrewarmStore {
  private providerHandle: LLMProviderStartupPrewarmHandle | undefined;
  private providerHandleStartedAtMs: number | undefined;
  private providerPending: PendingProviderStartupPrewarm | undefined;
  private closed = false;
  private expired = false;

  setProviderHandle(handle: LLMProviderStartupPrewarmHandle): void {
    if (this.closed || this.expired) {
      void disposeProviderStartupPrewarmHandle(handle).catch(() => {
        /* best-effort disposal after shutdown/expiry */
      });
      return;
    }
    const previous = this.providerHandle;
    const previousPending = this.providerPending;
    this.providerHandle = handle;
    this.providerHandleStartedAtMs = Date.now();
    this.providerPending = undefined;
    if (previous !== undefined) {
      void disposeProviderStartupPrewarmHandle(previous).catch(() => {
        /* best-effort disposal on overwrite */
      });
    }
    if (previousPending !== undefined) {
      disposePendingProviderStartupPrewarm(previousPending);
    }
  }

  setProviderTask(
    task: Promise<LLMProviderStartupPrewarmHandle | void>,
    opts: { readonly boundMs?: number } = {},
  ): void {
    const startedAtMs = Date.now();
    const pending: PendingProviderStartupPrewarm = {
      promise: task.then(
        (handle) => {
          if (handle === undefined) {
            recordStartupPrewarmDuration(startedAtMs, "unavailable");
            return { status: "unavailable" };
          }
          recordStartupPrewarmDuration(startedAtMs, "ready");
          return { status: "ready", handle };
        },
        () => {
          recordStartupPrewarmDuration(startedAtMs, "failed");
          return { status: "failed" };
        },
      ),
      startedAtMs,
      boundMs: opts.boundMs ?? DEFAULT_PROVIDER_STARTUP_PREWARM_BOUND_MS,
    };
    if (this.closed || this.expired) {
      disposePendingProviderStartupPrewarm(pending);
      return;
    }
    const previous = this.providerHandle;
    const previousPending = this.providerPending;
    this.providerHandle = undefined;
    this.providerHandleStartedAtMs = undefined;
    this.providerPending = pending;
    if (previous !== undefined) {
      void disposeProviderStartupPrewarmHandle(previous).catch(() => {
        /* best-effort disposal on pending replacement */
      });
    }
    if (previousPending !== undefined) {
      disposePendingProviderStartupPrewarm(previousPending);
    }
  }

  async consumeProviderHandle(opts: {
    readonly boundMs?: number;
    readonly signal?: AbortSignal;
  } = {}): Promise<LLMProviderStartupPrewarmHandle | undefined> {
    this.expired = true;
    const handle = this.providerHandle;
    const handleStartedAtMs = this.providerHandleStartedAtMs;
    const pending = this.providerPending;
    this.providerHandle = undefined;
    this.providerHandleStartedAtMs = undefined;
    this.providerPending = undefined;
    if (handle !== undefined) {
      recordStartupPrewarmAge(handleStartedAtMs ?? Date.now(), "consumed");
      return handle;
    }
    if (pending === undefined) {
      recordStartupPrewarmAge(Date.now(), "unavailable");
      return undefined;
    }
    const boundMs = opts.boundMs ?? pending.boundMs;
    const remainingMs = Math.max(
      0,
      boundMs - (Date.now() - pending.startedAtMs),
    );
    const resolved = await resolvePendingProviderStartupPrewarm(
      pending,
      remainingMs,
      opts.signal,
    );
    recordStartupPrewarmAge(
      pending.startedAtMs,
      resolved.handle === undefined ? resolved.status : "consumed",
    );
    if (resolved.handle === undefined) {
      disposePendingProviderStartupPrewarm(pending);
    }
    return resolved.handle;
  }

  async expireProviderHandle(): Promise<void> {
    this.expired = true;
    const handle = this.providerHandle;
    const pending = this.providerPending;
    this.providerHandle = undefined;
    this.providerHandleStartedAtMs = undefined;
    this.providerPending = undefined;
    if (handle !== undefined) {
      await disposeProviderStartupPrewarmHandle(handle);
    }
    if (pending !== undefined) {
      disposePendingProviderStartupPrewarm(pending);
    }
  }

  async clear(): Promise<void> {
    this.closed = true;
    await this.expireProviderHandle();
  }
}

export async function disposeProviderStartupPrewarmHandle(
  handle: LLMProviderStartupPrewarmHandle,
): Promise<void> {
  await handle.dispose?.();
}

function disposePendingProviderStartupPrewarm(
  pending: PendingProviderStartupPrewarm,
): void {
  void pending.promise.then((resolution) =>
    resolution.handle !== undefined
      ? disposeProviderStartupPrewarmHandle(resolution.handle).catch(() => {
          /* best-effort disposal after timeout/shutdown */
        })
      : undefined,
  );
}

async function resolvePendingProviderStartupPrewarm(
  pending: PendingProviderStartupPrewarm,
  remainingMs: number,
  signal?: AbortSignal,
): Promise<ProviderStartupPrewarmResolution> {
  if (signal?.aborted) return { status: "cancelled" };
  let timeout: number | NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<ProviderStartupPrewarmResolution>((resolve) => {
    timeout = setTimeout(() => resolve({ status: "timed_out" }), remainingMs);
    (timeout as { unref?: () => void }).unref?.();
  });
  const abortPromise =
    signal === undefined
      ? undefined
      : new Promise<ProviderStartupPrewarmResolution>((resolve) => {
          onAbort = () => resolve({ status: "cancelled" });
          signal.addEventListener("abort", onAbort, { once: true });
        });
  try {
    return await Promise.race(
      abortPromise === undefined
        ? [pending.promise, timeoutPromise]
        : [pending.promise, timeoutPromise, abortPromise],
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function recordStartupPrewarmDuration(
  startedAtMs: number,
  status: string,
): void {
  agencTelemetry.recordDuration(
    AGENC_STARTUP_PREWARM_DURATION_METRIC,
    Math.max(0, Date.now() - startedAtMs),
    toMetricTags({ status }),
  );
}

function recordStartupPrewarmAge(startedAtMs: number, status: string): void {
  agencTelemetry.recordDuration(
    AGENC_STARTUP_PREWARM_AGE_AT_FIRST_TURN_METRIC,
    Math.max(0, Date.now() - startedAtMs),
    toMetricTags({ status }),
  );
}

function ensureStartupPrewarmStore(
  session: Session,
): StartupPrewarmStore {
  const existing = session.services.startupPrewarm;
  if (existing !== undefined) return existing;
  const store = new SessionStartupPrewarmStore();
  session.services.startupPrewarm = store;
  return store;
}

export function scheduleProviderStartupPrewarm(
  session: Session,
  threadId: string,
  opts: { readonly boundMs?: number } = {},
): void {
  const prewarmStartup = session.services.provider.prewarmStartup;
  if (prewarmStartup === undefined) return;
  const store = ensureStartupPrewarmStore(session);
  const boundMs = opts.boundMs ?? DEFAULT_PROVIDER_STARTUP_PREWARM_BOUND_MS;
  try {
    const prewarm = Promise.resolve(
      prewarmStartup({
        conversationId: session.conversationId,
        threadId,
      }),
    );
    store.setProviderTask(prewarm, { boundMs });
  } catch {
    /* provider prewarm is best-effort; first turn uses direct provider */
  }
}
