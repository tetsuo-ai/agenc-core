import { AsyncLocalStorage } from "node:async_hooks";
import type { CompactionTransactionLease } from "../services/compact/transaction-types.js";

interface Owner {
  readonly kind: "background" | "compaction";
  readonly token: symbol;
  readonly settled: Promise<void>;
  readonly release: () => void;
}

const owners = new Map<string, Owner>();
const backgroundScope = new AsyncLocalStorage<{ key: string; token: symbol }>();

function own(key: string, kind: Owner["kind"]): Owner {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const token = Symbol(kind);
  const owner: Owner = { kind, token, settled, release: () => {
    if (owners.get(key)?.token !== token) return;
    owners.delete(key);
    settle();
  } };
  owners.set(key, owner);
  return owner;
}

/** Competing compactions still fail fast; background bookkeeping drains first. */
export function acquireCanonicalCompactionLease(
  key: string,
  busy: () => Error,
  signal?: AbortSignal,
): CompactionTransactionLease | Promise<CompactionTransactionLease> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Compaction aborted", "AbortError");
  const owner = owners.get(key);
  if (owner?.kind === "compaction") throw busy();
  if (owner !== undefined) {
    if (backgroundScope.getStore()?.token === owner.token) throw busy();
    return waitForOwner(owner, signal).then(() => acquireCanonicalCompactionLease(key, busy, signal));
  }
  return own(key, "compaction");
}

function waitForOwner(owner: Owner, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return owner.settled;
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Compaction aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void owner.settled.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}

/** Keep a complete parent-journal producer outside the compaction window. */
export async function withCanonicalBackgroundWork<T>(
  key: string,
  work: () => T | Promise<T>,
): Promise<T> {
  const scope = backgroundScope.getStore();
  if (scope?.key === key && owners.get(key)?.token === scope.token) return work();
  for (;;) {
    const owner = owners.get(key);
    if (owner === undefined) break;
    await owner.settled;
  }
  const owner = own(key, "background");
  try {
    return await backgroundScope.run({ key, token: owner.token }, work);
  } finally {
    owner.release();
  }
}
