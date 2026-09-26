import { describe, expect, it } from "vitest";
import { ProviderWaitScope, waitForProviderRetry } from "../../src/recovery/provider-wait.js";
import { abortableSleep } from "../../src/recovery/reconnection.js";
import { EventLog } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";

describe("provider wait lifetime", () => {
  it.each(["aborted", "failed"])("clears a %s wait", async (ending) => {
    const scope = new ProviderWaitScope();
    const abort = new AbortController();
    const session = {
      eventLog: new EventLog(), nextInternalSubId: () => "retry",
    } as unknown as Session;
    const run = scope.run(async () => {
      try {
        await waitForProviderRetry({
          session, cause: "provider_outage_wait", message: "Retrying soon.", delayMs: 30_000,
          wait: async () => {
            expect(scope.current()?.cause).toBe("provider_outage_wait");
            if (ending === "failed") throw new Error("sleep failed");
            const sleeping = abortableSleep(30_000, abort.signal);
            abort.abort();
            await sleeping;
          },
        });
      } finally {
        // Clear before scope/step cleanup, including thrown sleeps.
        expect(scope.current()).toBeUndefined();
      }
    });
    if (ending === "failed") await expect(run).rejects.toThrow("sleep failed");
    else await run;
    expect(scope.current()).toBeUndefined();
  });

  it("clears step state even when a child wait outlives the step", async () => {
    const scope = new ProviderWaitScope();
    const session = {
      eventLog: new EventLog(), nextInternalSubId: () => "retry",
    } as unknown as Session;
    let finish!: () => void;
    let child!: Promise<void>;
    await scope.run(async () => {
      child = waitForProviderRetry({
        session, cause: "provider_rate_limited", message: "Retrying soon.", delayMs: 30_000,
        wait: () => new Promise<void>((resolve) => { finish = resolve; }),
      });
      expect(scope.current()).toBeDefined();
    });
    expect(scope.current()).toBeUndefined();
    finish();
    await child;
    expect(scope.current()).toBeUndefined();
  });
});
