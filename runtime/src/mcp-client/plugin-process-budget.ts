/** Daemon-local budget shared by the MCP managers of all sessions. */
interface Slot {
  readonly owner: object;
  readonly evict: () => Promise<"busy" | void>;
  readonly busy: () => boolean;
  readonly evictable: () => boolean;
  lastUsed: number;
  maxProcesses: number;
  activityGeneration: number;
  activityBusy: boolean;
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

function markPluginProcessActivity(owner: object, busy: boolean): void {
  const slot = slots.get(owner);
  if (!slot || slot.activityBusy === busy) return;
  slot.activityBusy = busy;
  slot.activityGeneration++;
  wake();
}

export function notifyPluginProcessBusy(owner: object): void {
  markPluginProcessActivity(owner, true);
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
  evict: () => Promise<"busy" | void>,
  signal?: AbortSignal,
  evictable: () => boolean = () => true,
): Promise<void> {
  const permanentlyDeclined = new Set<Slot>();
  const busyRefusals = new Map<Slot, number>();
  while (!slots.has(owner)) {
    signal?.throwIfAborted();
    // Subscribe before reading capacity or busy state. An idle notification
    // cannot fall between that check and the wait below.
    const wakeup = subscribeToWake(signal);
    for (const [slot, refusedGeneration] of busyRefusals) {
      if (!slots.has(slot.owner) ||
        (slot.activityGeneration !== refusedGeneration && !slot.busy())) {
        busyRefusals.delete(slot);
      }
    }
    const limit = Math.min(maxProcesses,
      ...[...slots.values()].map(slot => slot.maxProcesses));
    if (slots.size < limit) {
      wakeup.cancel();
      slots.set(owner, { owner, busy, evict, evictable, lastUsed: ++tick, maxProcesses,
        activityGeneration: 0, activityBusy: busy() });
      return;
    }
    const oldest = [...slots.values()].filter(slot => !pendingEvictions.has(slot) &&
      !permanentlyDeclined.has(slot) && !busyRefusals.has(slot) && slot.evictable() && !slot.busy())
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (oldest) {
      wakeup.cancel();
      pendingEvictions.add(oldest);
      const attemptedGeneration = oldest.activityGeneration;
      // The slot remains occupied while disposal is in progress. A timed-out
      // requester leaves the eviction task owned by the budget until it settles.
      const disposal = Promise.resolve().then(() => oldest.evict()).finally(() => {
        pendingEvictions.delete(oldest);
        wake();
      });
      const outcome = await awaitOrAbort(disposal, signal);
      // A busy refusal is eligible again after any subsequent activity cycle,
      // including one that completed before this eviction promise settled.
      // A no-op refusal remains permanent for this waiter.
      if (slots.has(oldest.owner)) {
        if (outcome === "busy") busyRefusals.set(oldest, attemptedGeneration);
        else permanentlyDeclined.add(oldest);
      }
      continue;
    }
    if ([...slots.values()].every(slot => permanentlyDeclined.has(slot) || !slot.evictable())) {
      wakeup.cancel();
      throw new Error("No evictable plugin process remains in the budget");
    }
    await wakeup.promise;
  }
  touchPluginProcess(owner);
}

export function notifyPluginProcessIdle(owner?: object): void {
  if (owner) markPluginProcessActivity(owner, false);
  else wake();
}
