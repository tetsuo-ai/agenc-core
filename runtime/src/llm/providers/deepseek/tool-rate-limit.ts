import { setTimeout as delay } from "node:timers/promises";

// Account quotas apply across keys. Pace all keys together within this process;
// other processes/accounts and Fetch's unpublished domain quota can still return 429.
const queues: Record<"search" | "fetch", Promise<void>> = {
  search: Promise.resolve(), fetch: Promise.resolve(),
};
const next: Record<"search" | "fetch", number> = { search: 0, fetch: 0 };

export async function waitForDeepSeekToolSlot(api: "search" | "fetch", signal: AbortSignal): Promise<void> {
  const turn = queues[api].then(async () => {
    signal.throwIfAborted();
    const wait = next[api] - Date.now();
    if (wait > 0) await delay(wait, undefined, { signal });
    signal.throwIfAborted();
    next[api] = Date.now() + (api === "search" ? 10 : 40);
  });
  queues[api] = turn.catch(() => {});
  await turn;
}

const ocrSlots = new Set<symbol>();
/** Refuse excess work rather than queue unbounded file buffers. */
export function acquireDeepSeekOcrSlot(): (() => void) | undefined {
  if (ocrSlots.size >= 15) return undefined;
  const slot = Symbol();
  ocrSlots.add(slot);
  return () => { ocrSlots.delete(slot); };
}
