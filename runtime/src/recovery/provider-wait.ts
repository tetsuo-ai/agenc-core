import { AsyncLocalStorage } from "node:async_hooks";
import { emitWarning } from "../session/event-log.js";
import type { Session } from "../session/session.js";

export interface ProviderWait {
  readonly cause: "provider_outage_wait" | "provider_rate_limited";
  readonly message: string;
  readonly retryAt?: string;
}

const providerWaitScope = new AsyncLocalStorage<Set<ProviderWait>>();

/** Live step state, inherited by child calls but never restored after restart. */
export class ProviderWaitScope {
  readonly #waits = new Set<ProviderWait>();

  current(): ProviderWait | undefined {
    return [...this.#waits].at(-1);
  }

  async run<T>(execute: () => Promise<T>): Promise<T> {
    try {
      return await providerWaitScope.run(this.#waits, execute);
    } finally {
      this.#waits.clear();
    }
  }
}

/** The warning and polling projection share one message and one wait lifetime. */
export async function waitForProviderRetry(input: {
  readonly session: Session;
  readonly cause: ProviderWait["cause"];
  readonly message: string;
  readonly delayMs: number;
  readonly wait: () => Promise<void>;
  readonly now?: () => number;
}): Promise<void> {
  const wait: ProviderWait = {
    cause: input.cause,
    message: input.message,
    retryAt: new Date((input.now ?? Date.now)() + input.delayMs).toISOString(),
  };
  const scope = providerWaitScope.getStore();
  scope?.add(wait);
  try {
    emitWarning(input.session.eventLog, input.session.nextInternalSubId(), wait.cause, wait.message);
    await input.wait();
  } finally {
    scope?.delete(wait);
  }
}
