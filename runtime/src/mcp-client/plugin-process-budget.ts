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
  const declined = new Set<Slot>();
  const retriedAfterWake = new Set<Slot>();
  const declinedWhileBusy = new Set<Slot>();
  while (!slots.has(owner)) {
    signal?.throwIfAborted();
    // Subscribe before reading capacity or busy state. An idle notification
    // cannot fall between that check and the wait below.
    const wakeup = subscribeToWake(signal);
    for (const slot of declined) {
      if (!slots.has(slot.owner)) {
        declined.delete(slot);
        declinedWhileBusy.delete(slot);
      } else if (slot.busy()) {
        declinedWhileBusy.add(slot);
      } else if (declinedWhileBusy.delete(slot)) {
        declined.delete(slot);
        retriedAfterWake.delete(slot);
      }
    }
    const limit = Math.min(maxProcesses,
      ...[...slots.values()].map(slot => slot.maxProcesses));
    if (slots.size < limit) {
      wakeup.cancel();
      slots.set(owner, { owner, busy, evict, lastUsed: ++tick, maxProcesses });
      return;
    }
    const oldest = [...slots.values()].filter(slot => !pendingEvictions.has(slot) && !declined.has(slot) && !slot.busy())
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (oldest) {
      wakeup.cancel();
      pendingEvictions.add(oldest);
      let becameBusy = false;
      // The slot remains occupied while disposal is in progress. A timed-out
      // requester leaves the eviction task owned by the budget until it settles.
      const disposal = Promise.resolve().then(() => {
        becameBusy = oldest.busy();
        return oldest.evict();
      }).finally(() => {
        pendingEvictions.delete(oldest);
        wake();
      });
      await awaitOrAbort(disposal, signal);
      // A no-op eviction cannot make this same slot available. A candidate
      // that was busy when eviction ran may have become idle and notified us
      // before the task settled; allow that one recheck, then wait for a new
      // wake if it still cannot release anything.
      if (slots.has(oldest.owner)) {
        const busyNow = oldest.busy();
        if (becameBusy && !busyNow && !retriedAfterWake.has(oldest)) {
          retriedAfterWake.add(oldest);
        } else {
          declined.add(oldest);
          if (busyNow) declinedWhileBusy.add(oldest);
        }
      }
      continue;
    }
    await wakeup.promise;
  }
  touchPluginProcess(owner);
}

export function notifyPluginProcessIdle(): void { wake(); }
