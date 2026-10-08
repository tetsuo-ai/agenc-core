import { experimentMinimal } from "../experiment-minimal.js";
/** Nonshipping warm-daemon experiment. Never replaces canonical admission. */
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export function createWarmSessionSetupCeiling(agencHome: string, sessionId: string): {
  register(setup: () => Promise<void>): void;
  wrap(transport: typeof fetch): typeof fetch;
  assertOpen(): void;
  close(): Promise<void>;
} {
  const callbacks: Array<() => Promise<void>> = [];
  let firstRequest: Promise<void> | undefined;
  let setupTask: Promise<void> | undefined;
  const closure = new AbortController();
  const assertOpen = (): void => closure.signal.throwIfAborted();
  const mark = (name: string): void => {
    (globalThis as { __dgTimelineMark?: (name: string) => void }).__dgTimelineMark?.(name);
  };
  return {
    assertOpen,
    close() {
      // Close admission now; do not wait for a transport that ignores abort.
      closure.abort(new Error("session setup closed"));
      callbacks.length = 0;
      // Once setup has begun, transport has resolved. Join setup and response
      // cancellation before bootstrap disposes the partially built resources.
      return setupTask === undefined ? Promise.resolve()
        : (firstRequest ?? setupTask).catch(() => {});
    },
    register(setup) {
      if (experimentMinimal()) return;
      assertOpen();
      if (firstRequest !== undefined) throw new Error("session setup registered after dispatch");
      callbacks.push(setup);
    },
    wrap(transport) {
      if (experimentMinimal()) return transport;
      return async (input, init) => {
        assertOpen();
        const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const transportInit = { ...init, signal: callerSignal === undefined || callerSignal === null
          ? closure.signal : AbortSignal.any([callerSignal, closure.signal]) };
        if (init?.method?.toUpperCase() !== "POST") return transport(input, transportInit);
        if (firstRequest !== undefined) {
          await firstRequest;
          assertOpen();
          return transport(input, transportInit);
        }
        if (typeof init.body !== "string") throw new Error("ceiling requires serialized request");
        // The ordinary canonical rollout, settings and reservation already
        // exist. Also sync exact request data, excluding credential headers.
        const path = join(agencHome, `fx-warm-request-${sessionId}.jsonl`);
        const fd = openSync(path, "ax", 0o600);
        try {
          const bytes = Buffer.from(JSON.stringify({ sessionId, url: String(input), body: init.body }) + "\n");
          for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset);
          fsyncSync(fd);
        } finally { closeSync(fd); }
        const directory = openSync(agencHome, "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
        mark("fx_warm_request_journal_synced");
        let response: Response | undefined;
        firstRequest = (async () => {
          response = await transport(input, transportInit);
          try {
            assertOpen();
            // Publish the joinable task before invoking any callback, including
            // a callback that synchronously initiates shutdown.
            setupTask = Promise.resolve().then(async () => {
              assertOpen();
              mark("fx_warm_setup_start");
              for (const setup of callbacks) {
                assertOpen();
                await setup();
                assertOpen();
              }
              mark("fx_warm_setup_end");
            });
            await setupTask;
            assertOpen();
          } catch (error) {
            await response.body?.cancel().catch(() => {});
            throw error;
          }
        })();
        await firstRequest;
        assertOpen();
        return response!;
      };
    },
  };
}
