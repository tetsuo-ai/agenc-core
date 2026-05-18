/**
 * Tests for the steer-input subsystem (`Session.steerInput` +
 * `SteerInputError` + `isSteerable`). Mirrors upstream agenc runtime
 * `agenc-rs/core/src/session/mod.rs::steer_input` (line 2938) and the
 * `SteerInputError` taxonomy at `session/mod.rs:213`.
 *
 * Coverage (per task brief):
 *   1. steerInput against a regular task succeeds (items reach mailbox).
 *   2. steerInput against a compact task rejects with
 *      active_turn_not_steerable.
 *   3. steerInput against a review task rejects with
 *      active_turn_not_steerable.
 *   4. steerInput with no active turn rejects with no_active_turn.
 *   5. steerInput with mismatched subId rejects with sub_id_mismatch.
 *   6. isSteerable('regular') true, isSteerable('compact'|'review') false.
 *
 * The happy-path assertion that "items reach the mailbox" is verified
 * through the existing `drainIdleInput` consumer so we know the steer
 * path uses the same envelope the rest of the runtime already drains.
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
  describeSteerInputError,
  isSteerable,
  nonSteerableTurnKindFrom,
  type SteerInputError,
} from "./tasks.js";
import type { LLMProvider, LLMMessage } from "../llm/types.js";

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers (mirror tasks.test.ts)
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

function mkMessage(text: string): LLMMessage {
  return { role: "user", content: text };
}

// Narrow the error union to a specific kind in assertions. Vitest's
// `expect(...).toMatchObject` loses `kind` discriminator refinement,
// so pull the value out explicitly.
function expectError(err: SteerInputError, kind: SteerInputError["kind"]): void {
  expect(err.kind).toBe(kind);
}

// ─────────────────────────────────────────────────────────────────────
// Predicate — isSteerable / nonSteerableTurnKindFrom
// ─────────────────────────────────────────────────────────────────────

describe("isSteerable", () => {
  it("returns true for regular", () => {
    expect(isSteerable("regular")).toBe(true);
  });

  it("returns false for compact", () => {
    expect(isSteerable("compact")).toBe(false);
  });

  it("returns false for review", () => {
    expect(isSteerable("review")).toBe(false);
  });
});

describe("nonSteerableTurnKindFrom", () => {
  it("maps compact to 'compact' label", () => {
    expect(nonSteerableTurnKindFrom("compact")).toBe("compact");
  });

  it("maps review to 'review' label", () => {
    expect(nonSteerableTurnKindFrom("review")).toBe("review");
  });

  it("returns null for regular (caller should not emit ActiveTurnNotSteerable)", () => {
    expect(nonSteerableTurnKindFrom("regular")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Session.steerInput — happy path
// ─────────────────────────────────────────────────────────────────────

describe("Session.steerInput against a regular task", () => {
  it("accepts items and the subId round-trips through drainIdleInput", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });

    const m1 = mkMessage("first");
    const m2 = mkMessage("second");

    const result = await session.steerInput("turn-A", [m1, m2]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subId).toBe("turn-A");
      expect(result.accepted).toBe(2);
    }

    // Drain via the existing idle-input consumer — this is the
    // canonical proof the steered items landed on the same mailbox
    // path the rest of the runtime already drains.
    const drained = session.drainIdleInput();
    expect(drained).toEqual([m1, m2]);

    await session.onTaskFinished("turn-A");
  });

  it("sets mailboxDeliveryPhase back to current_turn after a deferred phase", async () => {
    // Pre-condition: force the turnState phase to `next_turn`, proving
    // steerInput flips it back — upstream parity for
    // `accept_mailbox_delivery_for_current_turn` at session/mod.rs:2992.
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });
    await session.withActiveTurnState((s) => {
      s.mailboxDeliveryPhase = "next_turn";
    });

    const before = await session.withActiveTurnState(
      (s) => s.mailboxDeliveryPhase,
    );
    expect(before).toBe("next_turn");

    const result = await session.steerInput("turn-A", [mkMessage("late")]);
    expect(result.ok).toBe(true);

    const after = await session.withActiveTurnState(
      (s) => s.mailboxDeliveryPhase,
    );
    expect(after).toBe("current_turn");

    // Cleanup: drain so the next test starts clean.
    session.drainIdleInput();
    await session.onTaskFinished("turn-A");
  });

  it("preserves FIFO order across multiple steer calls", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });

    const m1 = mkMessage("one");
    const m2 = mkMessage("two");
    const m3 = mkMessage("three");

    const r1 = await session.steerInput("turn-A", [m1]);
    const r2 = await session.steerInput("turn-A", [m2, m3]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const drained = session.drainIdleInput();
    expect(drained).toEqual([m1, m2, m3]);

    await session.onTaskFinished("turn-A");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Session.steerInput — rejection surface
// ─────────────────────────────────────────────────────────────────────

describe("Session.steerInput rejections", () => {
  it("rejects with no_active_turn when the activeTurn slot is empty", async () => {
    const session = buildSession();
    const items = [mkMessage("lost")];
    const result = await session.steerInput("turn-Z", items);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectError(result.error, "no_active_turn");
      if (result.error.kind === "no_active_turn") {
        // Items are returned to the caller so nothing is dropped.
        expect(result.error.items).toEqual(items);
      }
    }

    // And no envelopes were pushed onto the mailbox.
    expect(session.hasPendingInput()).toBe(false);
  });

  it("rejects with sub_id_mismatch when subId does not match the live turn", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });

    const result = await session.steerInput("turn-WRONG", [mkMessage("x")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectError(result.error, "sub_id_mismatch");
      if (result.error.kind === "sub_id_mismatch") {
        expect(result.error.expected).toBe("turn-WRONG");
        expect(result.error.actual).toBe("turn-A");
      }
    }
    // Nothing was enqueued on the mailbox either.
    expect(session.hasPendingInput()).toBe(false);

    await session.onTaskFinished("turn-A");
  });

  it("rejects a compact turn with active_turn_not_steerable (turnKind=compact)", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-compact", kind: "compact" });

    const result = await session.steerInput("turn-compact", [mkMessage("x")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectError(result.error, "active_turn_not_steerable");
      if (result.error.kind === "active_turn_not_steerable") {
        expect(result.error.turnKind).toBe("compact");
      }
    }
    expect(session.hasPendingInput()).toBe(false);

    await session.onTaskFinished("turn-compact");
  });

  it("rejects a review turn with active_turn_not_steerable (turnKind=review)", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-review", kind: "review" });

    const result = await session.steerInput("turn-review", [mkMessage("x")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectError(result.error, "active_turn_not_steerable");
      if (result.error.kind === "active_turn_not_steerable") {
        expect(result.error.turnKind).toBe("review");
      }
    }
    expect(session.hasPendingInput()).toBe(false);

    await session.onTaskFinished("turn-review");
  });

  it("rejects empty items with empty_input", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-A", kind: "regular" });

    const result = await session.steerInput("turn-A", []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectError(result.error, "empty_input");
    }

    await session.onTaskFinished("turn-A");
  });

  it("empty_input is checked before active-turn state (upstream parity)", async () => {
    // Upstream session/mod.rs:2944 checks empty input BEFORE taking the
    // active_turn lock. Gut mirrors this: with no active turn AND empty
    // items, the error should still be empty_input, not no_active_turn.
    const session = buildSession();
    const result = await session.steerInput("turn-nope", []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectError(result.error, "empty_input");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Helper surface — describeSteerInputError
// ─────────────────────────────────────────────────────────────────────

describe("describeSteerInputError", () => {
  it("maps empty_input to the upstream message text", () => {
    expect(describeSteerInputError({ kind: "empty_input" })).toEqual({
      message: "input must not be empty",
      code: "bad_request",
    });
  });

  it("maps no_active_turn to the upstream message text", () => {
    const err: SteerInputError = { kind: "no_active_turn", items: [] };
    expect(describeSteerInputError(err)).toEqual({
      message: "no active turn to steer",
      code: "bad_request",
    });
  });

  it("maps sub_id_mismatch to the upstream message text", () => {
    const err: SteerInputError = {
      kind: "sub_id_mismatch",
      expected: "A",
      actual: "B",
    };
    expect(describeSteerInputError(err)).toEqual({
      message: "expected active turn id `A` but found `B`",
      code: "bad_request",
    });
  });

  it("maps active_turn_not_steerable with turnKind to the upstream message text", () => {
    for (const turnKind of ["review", "compact"] as const) {
      const err: SteerInputError = {
        kind: "active_turn_not_steerable",
        turnKind,
      };
      expect(describeSteerInputError(err)).toEqual({
        message: `cannot steer a ${turnKind} turn`,
        code: "active_turn_not_steerable",
      });
    }
  });
});
