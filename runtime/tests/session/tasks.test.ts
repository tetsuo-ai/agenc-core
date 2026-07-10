/**
 * Tests for the task-dispatch subsystem (`session/tasks.ts` + the
 * `Session.spawnTask` / `Session.onTaskFinished` / `Session.abortAllTasks`
 * methods). Proves the "one turn in flight at a time" invariant that
 * upstream agenc runtime `tasks/mod.rs::spawn_task` enforces via the
 * `active_turn` mutex + `abort_all_tasks(TurnAbortReason::Replaced)`
 * re-entry contract.
 *
 * Coverage (per T5 port brief):
 *   1. Concurrency — two concurrent spawn/run paths serialize.
 *   2. Replace-on-new-turn — prior AbortController fires with "replaced".
 *   3. Task registry lifecycle — spawn/finish/abort bookkeeping.
 *   4. ActiveTurnState lock — concurrent mutations to one field are safe.
 *   5. Regression — back-to-back sequential spawns reuse a clean state.
 *   6. bin/agenc.ts parity — the single-turn spawn flow still behaves.
 */

import { describe, expect, it } from "vitest";

import { AsyncQueue } from "../utils/async-queue.js";
import {
  Session,
  type Event,
  type SessionOpts,
  type SessionServices,
} from "./session.js";
import {
  type Config,
  type ManagedFeatures,
  type ModelInfo,
  type SessionConfiguration,
} from "./turn-context.js";
import {
  GRACEFUL_INTERRUPTION_TIMEOUT_MS,
  acceptMailboxDeliveryForCurrentTurn,
  acceptsMailboxDeliveryForCurrentTurn,
  createActiveTurnState,
  createDoneHandle,
  deferMailboxDeliveryToNextTurn,
  prependPendingInput,
  pushPendingInput,
  takePendingInput,
  waitForDoneWithin,
  type SessionTask,
} from "./tasks.js";
import type { LLMProvider } from "../llm/types.js";
import { ToolRouter } from "../tools/router.js";
import type { Tool } from "../tools/types.js";

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers (mirror session.test.ts)
// ─────────────────────────────────────────────────────────────────────

function mkFeatures(): ManagedFeatures {
  return {
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
  };
}

function mkConfig(): Config {
  return {
    model: "test-model",
    cwd: "/tmp",
    features: mkFeatures(),
    multiAgentV2: {
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: {
        allowedEnvVars: [],
        blockedEnvVars: [],
      },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  };
}

function mkModelInfo(): ModelInfo {
  return {
    slug: "test-model",
    effectiveContextWindowPercent: 100,
    contextWindow: 1024,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };
}

function mkSessionConfiguration(): SessionConfiguration {
  return {
    cwd: "/tmp",
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: {
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
    windowsSandboxLevel: "none",
    collaborationMode: { model: "test-model" },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
}

function mkProvider(): LLMProvider {
  return {
    name: "stub-provider",
    chat: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
    chatStream: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
  } as unknown as LLMProvider;
}

function buildSession(): Session {
  const services = {
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    provider: mkProvider(),
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "", isError: false }),
    },
  } as unknown as SessionServices;
  const opts: SessionOpts = {
    conversationId: "conv-test",
    initialState: {
      sessionConfiguration: mkSessionConfiguration(),
      history: [],
    },
    features: mkFeatures(),
    services,
    jsRepl: { id: "repl-test" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  };
  return new Session(opts);
}

// Resolves on next microtask so async tests can interleave work.
const flush = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

// ─────────────────────────────────────────────────────────────────────
// Module-level primitives
// ─────────────────────────────────────────────────────────────────────

describe("tasks.ts primitives", () => {
  it("createActiveTurnState initializes all 11 upstream fields to defaults", () => {
    const s = createActiveTurnState();
    expect(s.pendingApprovals.size).toBe(0);
    expect(s.pendingRequestPermissions.size).toBe(0);
    expect(s.pendingUserInput.size).toBe(0);
    expect(s.pendingElicitations.size).toBe(0);
    expect(s.pendingDynamicTools.size).toBe(0);
    expect(s.pendingInput).toEqual([]);
    expect(s.mailboxDeliveryPhase).toBe("current_turn");
    expect(s.grantedPermissions).toBeNull();
    expect(s.strictAutoReviewEnabled).toBe(false);
    expect(s.toolCalls).toBe(0);
    expect(s.hasMemoryCitation).toBe(false);
    expect(s.tokenUsageAtTurnStart).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it("pending-input helpers mirror upstream TurnState queue operations", () => {
    const s = createActiveTurnState();
    pushPendingInput(s, "b");
    prependPendingInput(s, ["a"]);
    expect(takePendingInput(s)).toEqual(["a", "b"]);
    expect(takePendingInput(s)).toEqual([]);

    expect(acceptsMailboxDeliveryForCurrentTurn(s)).toBe(true);
    deferMailboxDeliveryToNextTurn(s);
    expect(acceptsMailboxDeliveryForCurrentTurn(s)).toBe(false);
    acceptMailboxDeliveryForCurrentTurn(s);
    expect(acceptsMailboxDeliveryForCurrentTurn(s)).toBe(true);
  });

  it("createDoneHandle resolves when resolveDone fires", async () => {
    const { done, resolveDone } = createDoneHandle();
    let resolved = false;
    void done.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    resolveDone();
    await done;
    expect(resolved).toBe(true);
  });

  it("waitForDoneWithin returns true on done, false on timeout", async () => {
    const { done: done1, resolveDone: r1 } = createDoneHandle();
    setTimeout(r1, 5);
    await expect(waitForDoneWithin(done1, 100)).resolves.toBe(true);

    // Never-resolving Promise — the timeout arm wins.
    const stuck = new Promise<void>(() => {
      /* never */
    });
    await expect(waitForDoneWithin(stuck, 20)).resolves.toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Part 3 — Task registry lifecycle
// ─────────────────────────────────────────────────────────────────────

describe("Session.spawnTask registry lifecycle", () => {
  it("binds root human text to the exact active turn and drops it on replacement", async () => {
    const session = buildSession();
    await session.spawnTask({
      subId: "turn-ledger",
      kind: "regular",
      rootHumanTurnText: "@ledger send 1 lamport",
    });
    expect(session.currentRootHumanTurn()).toEqual({
      turnId: "turn-ledger",
      text: "@ledger send 1 lamport",
    });
    await expect(
      session.claimLedgerTransferAuthorization("turn-ledger"),
    ).resolves.toBe(true);
    await expect(
      session.claimLedgerTransferAuthorization("turn-ledger"),
    ).resolves.toBe(false);

    await session.spawnTask({ subId: "turn-next", kind: "regular" });
    expect(session.currentRootHumanTurn()).toBeNull();
  });

  it("starts SessionTask.run when a concrete task is supplied", async () => {
    const session = buildSession();
    let ran = false;
    const task: SessionTask = {
      kind: () => "regular",
      spanName: () => "session_task.regular",
      run: async () => {
        ran = true;
        return null;
      },
      abort: async () => {},
    };

    await session.spawnTask({
      subId: "turn-A",
      kind: "regular",
      task,
      turnContext: { subId: "turn-A" } as never,
    });
    await flush();

    expect(ran).toBe(true);
    expect(session.activeTurn.unsafePeek()).toBeNull();
  });

  it("calls SessionTask.abort through handleTaskAbort", async () => {
    const session = buildSession();
    let aborted = false;
    const task: SessionTask = {
      kind: () => "regular",
      spanName: () => "session_task.regular",
      run: async () =>
        await new Promise<null>(() => {
          /* keep task pending until abort */
        }),
      abort: async () => {
        aborted = true;
      },
    };

    await session.spawnTask({
      subId: "turn-A",
      kind: "regular",
      task,
      turnContext: { subId: "turn-A" } as never,
    });
    await session.abortAllTasks("interrupted");

    expect(aborted).toBe(true);
    expect(session.activeTurn.unsafePeek()).toBeNull();
  });

  it("abortAllTasks emits a single turn_aborted event for interrupted tasks", async () => {
    const session = buildSession();
    const events: Event[] = [];
    const unsubscribe = session.eventLog.subscribe((event) => events.push(event));
    try {
      const task: SessionTask = {
        kind: () => "regular",
        spanName: () => "session_task.regular",
        run: async () =>
          await new Promise<null>(() => {
            /* keep task pending until abort */
          }),
        abort: async () => {},
      };

      await session.spawnTask({
        subId: "turn-A",
        kind: "regular",
        task,
        turnContext: { subId: "turn-A" } as never,
      });
      await session.abortAllTasks("interrupted");
      session.emitTurnAbortedOnce("turn-A", "interrupted");

      const aborted = events.filter((event) => event.msg.type === "turn_aborted");
      expect(aborted).toHaveLength(1);
      expect(aborted[0]?.msg).toEqual({
        type: "turn_aborted",
        payload: { turnId: "turn-A", reason: "interrupted" },
      });
    } finally {
      unsubscribe();
    }
  });

  it("registers the task under its subId and fills the activeTurn slot", async () => {
    const session = buildSession();
    const task = await session.spawnTask({ subId: "turn-A", kind: "regular" });
    const active = session.activeTurn.unsafePeek();
    expect(active).not.toBeNull();
    expect(active?.turnId).toBe("turn-A");
    expect(active?.tasks.has("turn-A")).toBe(true);
    expect(active?.tasks.get("turn-A")?.kind).toBe("regular");
    expect(task.subId).toBe("turn-A");
    expect(task.done).toBeInstanceOf(Promise);
    expect(task.abortController).toBeInstanceOf(AbortController);
    // Cleanup for next test-stage.
    await session.onTaskFinished("turn-A");
  });

  it("onTaskFinished removes the task and clears the activeTurn slot when empty", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });
    await session.onTaskFinished("turn-A");
    expect(session.activeTurn.unsafePeek()).toBeNull();
  });

  it("onTaskFinished resolves the task's done promise", async () => {
    const session = buildSession();
    const task = await session.spawnTask({ subId: "turn-A", kind: "regular" });
    let resolved = false;
    const watcher = task.done.then(() => {
      resolved = true;
    });
    await session.onTaskFinished("turn-A");
    await watcher;
    expect(resolved).toBe(true);
  });

  it("finish racing with a new spawn never clears the newer active turn", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });

    await Promise.all([
      session.onTaskFinished("turn-A"),
      session.spawnTask({ subId: "turn-B", kind: "regular" }),
    ]);

    const active = session.activeTurn.unsafePeek();
    expect(active?.turnId).toBe("turn-B");
    expect(active?.tasks.has("turn-B")).toBe(true);
    await session.onTaskFinished("turn-B");
  });

  it("abortAllTasks clears the registry AND fires each task's AbortController", async () => {
    const session = buildSession();
    const task = await session.spawnTask({ subId: "turn-A", kind: "regular" });
    expect(task.abortController.signal.aborted).toBe(false);
    await session.abortAllTasks("interrupted");
    expect(task.abortController.signal.aborted).toBe(true);
    expect(session.activeTurn.unsafePeek()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Part 2 — Replace-on-new-turn semantics
// ─────────────────────────────────────────────────────────────────────

describe("Session.spawnTask replace-on-new-turn", () => {
  it("aborts the prior in-flight task with reason=replaced", async () => {
    const session = buildSession();
    const first = await session.spawnTask({ subId: "turn-A", kind: "regular" });
    expect(first.abortController.signal.aborted).toBe(false);
    const second = await session.spawnTask({ subId: "turn-B", kind: "regular" });
    // Prior task's AbortController fires.
    expect(first.abortController.signal.aborted).toBe(true);
    expect(first.abortController.signal.reason).toBe("replaced");
    // New turn is live.
    expect(session.activeTurn.unsafePeek()?.turnId).toBe("turn-B");
    expect(second.abortController.signal.aborted).toBe(false);
    await session.onTaskFinished("turn-B");
  });

  it("prior task's done Promise settles after replace", async () => {
    const session = buildSession();
    const first = await session.spawnTask({ subId: "turn-A", kind: "regular" });
    const doneP = first.done;
    await session.spawnTask({ subId: "turn-B", kind: "regular" });
    // done was resolved during handleTaskAbort (fallback path) — awaiting
    // should resolve immediately, not hang.
    await expect(
      Promise.race([
        doneP.then(() => "done"),
        new Promise((r) => setTimeout(() => r("timeout"), 50)),
      ]),
    ).resolves.toBe("done");
    await session.onTaskFinished("turn-B");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Part 1 — Concurrency: two concurrent spawns serialize
// ─────────────────────────────────────────────────────────────────────

describe("Session.spawnTask concurrency", () => {
  it("serializes two concurrent spawns via taskDispatchLock", async () => {
    const session = buildSession();
    // Kick off two spawns at once. The second MUST see the first
    // installed-then-aborted; it MUST NOT race with it.
    const [a, b] = await Promise.all([
      session.spawnTask({ subId: "turn-A", kind: "regular" }),
      session.spawnTask({ subId: "turn-B", kind: "regular" }),
    ]);
    // Exactly one of them is the "winner" — the last one installed.
    const active = session.activeTurn.unsafePeek();
    expect(active).not.toBeNull();
    // The live turn matches the later-scheduled task's subId.
    expect([a.subId, b.subId]).toContain(active?.turnId);
    // The OTHER one was replaced mid-flight — its abortController fired.
    const replaced = active?.turnId === a.subId ? b : a;
    expect(replaced.abortController.signal.aborted).toBe(true);
    expect(replaced.abortController.signal.reason).toBe("replaced");
    await session.onTaskFinished(active!.turnId);
  });

  it("concurrent abort + spawn remain consistent", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });
    // Fire an abort + a new spawn concurrently. Whichever lands first
    // the invariant "registry in a known good state at end" must hold.
    await Promise.all([
      session.abortAllTasks("interrupted"),
      session.spawnTask({ subId: "turn-B", kind: "regular" }),
    ]);
    // End state: exactly one task or none, never half-cleaned.
    const active = session.activeTurn.unsafePeek();
    if (active !== null) {
      expect(active.tasks.size).toBe(1);
      await session.onTaskFinished(active.turnId);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Part 4 — ActiveTurnState lock: concurrent mutations serialize
// ─────────────────────────────────────────────────────────────────────

describe("ActiveTurnState lock", () => {
  it("concurrent toolCalls increments under the lock are safe", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });
    const N = 200;
    const increments = Array.from({ length: N }, () =>
      session.withActiveTurnState(async (s) => {
        // Simulate a read-modify-write across an await boundary.
        const before = s.toolCalls;
        await flush();
        s.toolCalls = before + 1;
      }),
    );
    await Promise.all(increments);
    const final = await session.withActiveTurnState((s) => s.toolCalls);
    expect(final).toBe(N);
    await session.onTaskFinished("turn-A");
  });

  it("withActiveTurnState returns undefined when no turn is active", async () => {
    const session = buildSession();
    const v = await session.withActiveTurnState((s) => s.toolCalls);
    expect(v).toBeUndefined();
  });

  it("token_usage_at_turn_start is captured on spawn when provided", async () => {
    const session = buildSession();
    await session.spawnTask({
      subId: "turn-A",
      kind: "regular",
      tokenUsageAtTurnStart: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
    });
    const seeded = await session.withActiveTurnState(
      (s) => s.tokenUsageAtTurnStart,
    );
    expect(seeded).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
    await session.onTaskFinished("turn-A");
  });

  it("token_usage_at_turn_start seed goes through the lock (does not race with concurrent reads)", async () => {
    // Regression for WIRED-NOW semantics on `tokenUsageAtTurnStart`.
    // The spawn-time seed must be visible to any caller that acquires
    // the lock after spawn returns — i.e. seeding and reads serialize.
    const session = buildSession();
    await session.spawnTask({
      subId: "turn-A",
      kind: "regular",
      tokenUsageAtTurnStart: {
        promptTokens: 100,
        completionTokens: 200,
        totalTokens: 300,
      },
    });
    const reads = await Promise.all(
      Array.from({ length: 50 }, () =>
        session.withActiveTurnState((s) => ({ ...s.tokenUsageAtTurnStart })),
      ),
    );
    for (const r of reads) {
      expect(r).toEqual({
        promptTokens: 100,
        completionTokens: 200,
        totalTokens: 300,
      });
    }
    await session.onTaskFinished("turn-A");
  });

  it("hasMemoryCitation round-trips through withActiveTurnState (SLOT-ONLY readiness)", async () => {
    // Field is SLOT-ONLY in gut today (no live consumer), but the
    // schema must still round-trip cleanly so the future memory
    // subsystem can flip it through `withActiveTurnState`.
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });
    const before = await session.withActiveTurnState((s) => s.hasMemoryCitation);
    expect(before).toBe(false);
    await session.withActiveTurnState((s) => {
      s.hasMemoryCitation = true;
    });
    const after = await session.withActiveTurnState((s) => s.hasMemoryCitation);
    expect(after).toBe(true);
    await session.onTaskFinished("turn-A");
  });

  it("abortAllTasks clears every pending-* map under the lock (SLOT-ONLY clear contract)", async () => {
    // Sanity check that Session.abortAllTasksLocked() still clears
    // every SLOT-ONLY pending map. Future consumers of those slots
    // inherit this clear contract without re-implementing it.
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });
    await session.withActiveTurnState((s) => {
      s.pendingApprovals.set("a1", () => {});
      s.pendingRequestPermissions.set("r1", {});
      s.pendingUserInput.set("u1", () => {});
      s.pendingElicitations.set("e1", () => {});
      s.pendingDynamicTools.set("d1", () => {});
      s.pendingInput.push("queued");
    });
    await session.abortAllTasks("interrupted");
    // The activeTurn slot is cleared too, so a probing read returns
    // undefined — that itself is the proof the prior state is gone.
    expect(session.activeTurn.unsafePeek()).toBeNull();
    // Spawn a fresh turn and confirm every pending-* map came up empty.
    await session.spawnTask({ subId: "turn-B", kind: "regular" });
    const cleared = await session.withActiveTurnState((s) => ({
      approvals: s.pendingApprovals.size,
      reqPerms: s.pendingRequestPermissions.size,
      userInput: s.pendingUserInput.size,
      elicit: s.pendingElicitations.size,
      dynTools: s.pendingDynamicTools.size,
      input: s.pendingInput.length,
    }));
    expect(cleared).toEqual({
      approvals: 0,
      reqPerms: 0,
      userInput: 0,
      elicit: 0,
      dynTools: 0,
      input: 0,
    });
    await session.onTaskFinished("turn-B");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Part 5 — Regression: sequential spawns reuse a clean state
// ─────────────────────────────────────────────────────────────────────

describe("Session.spawnTask sequential reentry", () => {
  it("back-to-back spawn + finish cycles yield fresh ActiveTurn each time", async () => {
    const session = buildSession();
    for (let i = 0; i < 5; i += 1) {
      const task = await session.spawnTask({
        subId: `turn-${i}`,
        kind: "regular",
      });
      // toolCalls starts from zero in each turn — proves the state was
      // reset (not carried over from the prior turn).
      const before = await session.withActiveTurnState((s) => s.toolCalls);
      expect(before).toBe(0);
      await session.withActiveTurnState((s) => {
        s.toolCalls = 42;
      });
      await session.onTaskFinished(`turn-${i}`);
      // activeTurn slot cleared between turns.
      expect(session.activeTurn.unsafePeek()).toBeNull();
      // task.done resolved.
      await task.done;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Part 6 — bin/agenc.ts parity: the single-turn spawn flow
// ─────────────────────────────────────────────────────────────────────

describe("bin/agenc.ts parity", () => {
  it("session.spawnTask from runTurnKernel entry + session.onTaskFinished from finally is the supported pattern", async () => {
    // Mirrors the pattern in runTurnKernel: spawnTask at entry, do
    // yields, then onTaskFinished in a finally. Prove the round-trip
    // works even when the kernel throws.
    const session = buildSession();

    const runKernelLike = async (subId: string, shouldThrow: boolean) => {
      const task = await session.spawnTask({ subId, kind: "regular" });
      try {
        await flush();
        if (shouldThrow) throw new Error("kernel blew up");
        return task;
      } finally {
        await session.onTaskFinished(subId);
      }
    };

    // Happy path.
    await runKernelLike("turn-happy", false);
    expect(session.activeTurn.unsafePeek()).toBeNull();

    // Error path — must still clean the registry.
    await expect(runKernelLike("turn-error", true)).rejects.toThrow(
      "kernel blew up",
    );
    expect(session.activeTurn.unsafePeek()).toBeNull();
  });

  it("abortTurnIfActive returns true for the live turn and false otherwise", async () => {
    const session = buildSession();
    const task = await session.spawnTask({ subId: "turn-A", kind: "regular" });
    expect(await session.abortTurnIfActive("turn-B", "interrupted")).toBe(
      false,
    );
    expect(task.abortController.signal.aborted).toBe(false);
    expect(await session.abortTurnIfActive("turn-A", "interrupted")).toBe(
      true,
    );
    expect(task.abortController.signal.aborted).toBe(true);
    expect(session.activeTurn.unsafePeek()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Constants parity check
// ─────────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("graceful interruption budget matches runtime tasks/mod.rs:62", () => {
    // Upstream: GRACEFULL_INTERRUPTION_TIMEOUT_MS = 100 (note: typo in
    // upstream; gut carries the corrected spelling). The ms value is
    // what matters for behavior parity.
    expect(GRACEFUL_INTERRUPTION_TIMEOUT_MS).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Part 7 — Router integration: toolCalls counter wiring through the
// ActiveTurnState lock. Mirrors upstream agenc runtime tools/registry.rs:303-309.
// ─────────────────────────────────────────────────────────────────────

describe("ToolRouter.dispatchModelToolCall toolCalls counter", () => {
  const noopTool: Tool = {
    name: "system.noop",
    description: "",
    inputSchema: {},
    execute: async () => ({ content: "ok" }),
  };

  it("increments ActiveTurnState.toolCalls once per dispatch", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });
    const router = new ToolRouter([
      { tool: noopTool, supportsParallelToolCalls: true },
    ]);

    const result = await router.dispatchModelToolCall(
      { id: "call-1", name: "system.noop", arguments: "{}" },
      {
        session: session as never,
        turn: { subId: "turn-A" } as never,
        tracker: {
          appendFileDiff: () => {},
          snapshot: () => [],
          clear: () => {},
        },
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
      },
    );

    expect(result.isError).toBeFalsy();
    const count = await session.withActiveTurnState((s) => s.toolCalls);
    expect(count).toBe(1);
    await session.onTaskFinished("turn-A");
  });

  it("serializes concurrent dispatches (no lost increments)", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });
    const router = new ToolRouter([
      { tool: noopTool, supportsParallelToolCalls: true },
    ]);
    const N = 20;
    const dispatches = Array.from({ length: N }, (_, i) =>
      router.dispatchModelToolCall(
        { id: `call-${i}`, name: "system.noop", arguments: "{}" },
        {
          session: session as never,
          turn: { subId: "turn-A" } as never,
          tracker: {
            appendFileDiff: () => {},
            snapshot: () => [],
            clear: () => {},
          },
          approvalPolicy: "never",
          sandboxMode: "workspace_write",
        },
      ),
    );
    await Promise.all(dispatches);
    const count = await session.withActiveTurnState((s) => s.toolCalls);
    expect(count).toBe(N);
    await session.onTaskFinished("turn-A");
  });

  it("no-ops when there is no active turn (post-onTaskFinished)", async () => {
    // After onTaskFinished clears the activeTurn slot, dispatching a
    // tool still succeeds but the increment path is a no-op — the
    // state itself is gone. Nothing throws.
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });
    await session.onTaskFinished("turn-A");
    const router = new ToolRouter([
      { tool: noopTool, supportsParallelToolCalls: true },
    ]);
    const result = await router.dispatchModelToolCall(
      { id: "call-1", name: "system.noop", arguments: "{}" },
      {
        session: session as never,
        turn: { subId: "turn-A" } as never,
        tracker: {
          appendFileDiff: () => {},
          snapshot: () => [],
          clear: () => {},
        },
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
      },
    );
    expect(result.isError).toBeFalsy();
    expect(session.activeTurn.unsafePeek()).toBeNull();
  });
});
