/** Daemon-local budget shared by the MCP managers of all sessions. */
interface Slot {
  readonly owner: object;
  readonly evict: () => Promise<void>;
  readonly busy: () => boolean;
  lastUsed: number;
  maxProcesses: number;
}

const slots = new Map<object, Slot>();
const pendingEvictions = new Set<Slot>();
const waiters = new Set<() => void>();
let tick = 0;

function wake(): void {
  for (const waiter of waiters) waiter();
  waiters.clear();
}

export function touchPluginProcess(owner: object): void {
  const slot = slots.get(owner);
  if (slot) slot.lastUsed = ++tick;
}

export function releasePluginProcess(owner: object): void {
  if (slots.delete(owner)) wake();
}

function awaitOrAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { signal.removeEventListener("abort", onAbort); reject(signal.reason ?? new Error("Plugin process budget wait cancelled")); };
    signal.addEventListener("abort", onAbort, { once: true });
    void task.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function subscribeToWake(signal?: AbortSignal): { promise: Promise<void>; cancel: () => void } {
  signal?.throwIfAborted();
  let cancel = (): void => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      waiters.delete(onWake);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Plugin process budget wait cancelled"));
    };
    const onWake = (): void => {
      waiters.delete(onWake);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    cancel = (): void => {
      waiters.delete(onWake);
      signal?.removeEventListener("abort", onAbort);
    };
    waiters.add(onWake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, cancel };
}

export async function reservePluginProcess(
  owner: object,
  maxProcesses: number,
  busy: () => boolean,
  evict: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  while (!slots.has(owner)) {
    signal?.throwIfAborted();
    // Subscribe before reading capacity or busy state. An idle notification
    // cannot fall between that check and the wait below.
    const wakeup = subscribeToWake(signal);
    const limit = Math.min(maxProcesses,
      ...[...slots.values()].map(slot => slot.maxProcesses));
    if (slots.size < limit) {
      wakeup.cancel();
      slots.set(owner, { owner, busy, evict, lastUsed: ++tick, maxProcesses });
      return;
    }
    const oldest = [...slots.values()].filter(slot => !pendingEvictions.has(slot) && !slot.busy())
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (oldest) {
      wakeup.cancel();
      pendingEvictions.add(oldest);
      // The slot remains occupied while disposal is in progress. A timed-out
      // requester leaves the eviction task owned by the budget until it settles.
      const disposal = Promise.resolve().then(() => oldest.evict()).finally(() => {
        pendingEvictions.delete(oldest);
        wake();
      });
      await awaitOrAbort(disposal, signal);
      // Eviction may have declined because the candidate became busy. Recheck
      // capacity and candidates even if its idle notice has already fired.
      continue;
    }
    await wakeup.promise;
  }
  touchPluginProcess(owner);
}

export function notifyPluginProcessIdle(): void { wake(); }
