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

export async function reservePluginProcess(
  owner: object,
  maxProcesses: number,
  busy: () => boolean,
  evict: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  while (!slots.has(owner)) {
    signal?.throwIfAborted();
    const limit = Math.min(maxProcesses,
      ...[...slots.values(), ...pendingEvictions].map(slot => slot.maxProcesses));
    if (slots.size + pendingEvictions.size < limit) {
      slots.set(owner, { owner, busy, evict, lastUsed: ++tick, maxProcesses });
      return;
    }
    const oldest = [...slots.values()].filter(slot => !slot.busy())
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (oldest) {
      // Remove the slot synchronously before awaiting process disposal. No
      // new spawn occurs until that disposal proves complete.
      slots.delete(oldest.owner);
      pendingEvictions.add(oldest);
      try { await oldest.evict(); }
      catch (error) {
        slots.set(oldest.owner, oldest);
        throw error;
      } finally { pendingEvictions.delete(oldest); wake(); }
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => { waiters.delete(onWake); reject(signal?.reason ?? new Error("Plugin process budget wait cancelled")); };
      const onWake = (): void => { signal?.removeEventListener("abort", onAbort); resolve(); };
      waiters.add(onWake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  touchPluginProcess(owner);
}

export function notifyPluginProcessIdle(): void { wake(); }
