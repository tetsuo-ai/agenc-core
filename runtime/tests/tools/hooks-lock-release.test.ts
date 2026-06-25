/**
 * PRIMARY acceptance test for GOAL ITEM #1 (signal-aware, cooperatively-
 * cancellable tool hooks).
 *
 * The load-bearing proof: a real `ToolCallRuntime` lock held by tool A
 * while A runs a WEDGED, UNCOOPERATIVE pre-hook (`() => new Promise(()=>{})`
 * that ignores its abort signal). A sibling B is queued on the SAME runtime
 * guard. Before abort, B has NOT acquired. After `ac.abort(...)`:
 *
 *   - A's `runPreToolUseHooks` resolves to a fail-closed `"deny"` (the
 *     signal-race cut the wedged hook short WITHOUT awaiting it), so the
 *     lock-wrapped fn() settles and the existing `finally` releases the
 *     guard, AND
 *   - B ACQUIRES the guard within a bounded timeout. ← THE PROOF.
 *
 * The acceptance criterion is the SIBLING acquiring the released guard,
 * not "the call returned". Three guard variants prove all three release
 * legs: exclusive (write gate), shared_read (readers--), shared_server
 * (Semaphore permit freed).
 *
 * REVERT-SENSITIVITY: against the pre-fix `hooks.ts` (no signal param, no
 * `raceHookWithSignal`), the wedged `await hook(...)` hangs forever, A's
 * fn() never settles, B never acquires, and the bounded await REJECTS
 * (clean red). The stash/restore run is reported in the agent summary.
 */
import { describe, expect, test } from "vitest";
import {
  EXCLUSIVE,
  SHARED_READ,
  sharedServer,
  ToolCallRuntime,
  type ConcurrencyClass,
} from "./concurrency.js";
import { runPreToolUseHooks, type PreToolUseHook } from "./hooks.js";
import type { Tool } from "./types.js";
import type { ToolInvocation } from "./context.js";

const stubTool: Tool = {
  name: "stub",
  description: "",
  inputSchema: {},
  execute: async () => ({ content: "ok" }),
};
const stubInvocation: ToolInvocation = {
  session: {} as never,
  turn: {} as never,
  tracker: {
    appendFileDiff: () => {},
    snapshot: () => [],
    clear: () => {},
  },
  callId: "c1",
  toolName: { name: "stub" },
  payload: { kind: "function", arguments: "" },
  source: "direct",
};

/** Bound an await so a regression is a CLEAN reject, not an ambient hang. */
function withTestTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`withTestTimeout(${ms}ms) exceeded`)),
        ms,
      );
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
}

describe("wedged pre-hook releases the ToolCallRuntime guard on abort", () => {
  for (const variant of [
    // A holds the guard; the SIBLING is the contention primitive that
    // proves that exact guard was released:
    //   exclusive    → sibling EXCLUSIVE drains the write gate
    //   shared_read  → sibling EXCLUSIVE waits for readers-- to reach 0
    //   shared_server→ sibling on the SAME serverId waits for the freed
    //                  Semaphore permit (capacity 1)
    {
      name: "exclusive",
      klass: EXCLUSIVE as ConcurrencyClass,
      sibling: EXCLUSIVE as ConcurrencyClass,
    },
    {
      name: "shared_read",
      klass: SHARED_READ as ConcurrencyClass,
      sibling: EXCLUSIVE as ConcurrencyClass,
    },
    {
      name: "shared_server",
      klass: sharedServer("srvA"),
      sibling: sharedServer("srvA"),
    },
  ] as const) {
    test(`${variant.name}: sibling acquires after a wedged uncooperative pre-hook is force-cancelled`, async () => {
      const runtime = new ToolCallRuntime();
      const ac = new AbortController();
      let entered = false;
      // UNCOOPERATIVE: ignores its signal entirely (the hard case).
      const wedged: PreToolUseHook = () =>
        new Promise<never>(() => {
          entered = true;
        });

      // Tool A holds the guard while running the wedged pre-hook.
      const aDone = runtime.run(variant.klass, async () => {
        const res = await runPreToolUseHooks(
          [wedged],
          { invocation: stubInvocation, tool: stubTool, args: {} },
          undefined,
          undefined,
          ac.signal, // NEW signal param
        );
        return res.kind; // expect "deny" (fail-closed)
      });

      // Sibling B must wait for A to release the SAME guard.
      let bAcquired = false;
      const bDone = runtime.run(variant.sibling, async () => {
        bAcquired = true;
        return "B";
      });

      // Let A enter the wedged hook; B must still be blocked.
      await new Promise((r) => setTimeout(r, 30));
      expect(entered).toBe(true);
      expect(bAcquired).toBe(false);

      ac.abort("tool timeout: drain exceeded");

      // cancelled ⇒ fail-closed deny.
      await expect(withTestTimeout(aDone, 2000)).resolves.toBe("deny");
      // ← THE PROOF: the sibling acquired the released guard.
      await expect(withTestTimeout(bDone, 2000)).resolves.toBe("B");
      expect(bAcquired).toBe(true);
    });
  }

  test("already-aborted signal: pre-hook denies immediately without awaiting the hook", async () => {
    const ac = new AbortController();
    ac.abort("pre-aborted");
    let hookCalled = false;
    const neverResolves: PreToolUseHook = () => {
      hookCalled = true;
      return new Promise<never>(() => {});
    };
    const res = await withTestTimeout(
      runPreToolUseHooks(
        [neverResolves],
        { invocation: stubInvocation, tool: stubTool, args: {} },
        undefined,
        undefined,
        ac.signal,
      ),
      1000,
    );
    expect(res.kind).toBe("deny");
    expect(hookCalled).toBe(false); // never invoked on the already-aborted fast path
  });
});
