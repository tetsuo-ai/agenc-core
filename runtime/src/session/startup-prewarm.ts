import type { LLMProviderStartupPrewarmHandle } from "../llm/types.js";
import type { Session } from "./session.js";

export const DEFAULT_PROVIDER_STARTUP_PREWARM_BOUND_MS = 250;

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
  readonly promise: Promise<LLMProviderStartupPrewarmHandle | undefined>;
  readonly startedAtMs: number;
  readonly boundMs: number;
}

export class SessionStartupPrewarmStore implements StartupPrewarmStore {
  private providerHandle: LLMProviderStartupPrewarmHandle | undefined;
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
    const pending: PendingProviderStartupPrewarm = {
      promise: task.then(
        (handle) => handle ?? undefined,
        () => undefined,
      ),
      startedAtMs: Date.now(),
      boundMs: opts.boundMs ?? DEFAULT_PROVIDER_STARTUP_PREWARM_BOUND_MS,
    };
    if (this.closed || this.expired) {
      disposePendingProviderStartupPrewarm(pending);
      return;
    }
    const previous = this.providerHandle;
    const previousPending = this.providerPending;
    this.providerHandle = undefined;
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
    const pending = this.providerPending;
    this.providerHandle = undefined;
    this.providerPending = undefined;
    if (handle !== undefined) return handle;
    if (pending === undefined) return undefined;
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
    if (resolved === undefined) {
      disposePendingProviderStartupPrewarm(pending);
    }
    return resolved;
  }

  async expireProviderHandle(): Promise<void> {
    this.expired = true;
    const handle = this.providerHandle;
    const pending = this.providerPending;
    this.providerHandle = undefined;
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
  void pending.promise.then((handle) =>
    handle !== undefined
      ? disposeProviderStartupPrewarmHandle(handle).catch(() => {
          /* best-effort disposal after timeout/shutdown */
        })
      : undefined,
  );
}

async function resolvePendingProviderStartupPrewarm(
  pending: PendingProviderStartupPrewarm,
  remainingMs: number,
  signal?: AbortSignal,
): Promise<LLMProviderStartupPrewarmHandle | undefined> {
  if (signal?.aborted) return undefined;
  let timeout: number | NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => resolve(undefined), remainingMs);
    (timeout as { unref?: () => void }).unref?.();
  });
  const abortPromise =
    signal === undefined
      ? undefined
      : new Promise<undefined>((resolve) => {
          onAbort = () => resolve(undefined);
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

export function ensureStartupPrewarmStore(
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
