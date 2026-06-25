/**
 * Behavioral backstop (goal #3) — pure-unit detector tests.
 *
 * Exercises the result-aware Tier-1 detectors and Tier-0 caps at the
 * function level, in isolation from the turn loop. The loop-integration
 * battery (A1/A5/B1 with a scripted fake LLM client, revert proofs, and
 * the non-blocking invariant) lives in `run-turn.progress.test.ts`.
 *
 * The single load-bearing invariant proven here: every repetition/cycle/
 * low-gain trip requires an UNCHANGED resultHash; a changed result or an
 * isError flip resets the counter. That is the entire false-positive
 * defense (status polling, progressing retries).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  evaluateBehavioralBackstop,
  recordBehavioralStep,
  resolveBehavioralConfig,
  stepActionSignature,
  stepResultHash,
  type BehavioralConfig,
} from "./behavioral-backstop.js";
import type {
  AssistantMessage,
  CompletedToolResultRecord,
  TurnState,
} from "./turn-state.js";
import type { LLMUsage } from "../llm/types.js";

// ── Minimal fixtures ────────────────────────────────────────────────

/** A TurnState reduced to only the fields the detectors read/write. */
function mkState(): TurnState {
  return {
    turnCount: 1,
    toolUseBlocks: [],
    behavioralStepHistory: [],
    behavioralLowGainStreak: 0,
    behavioralNudgeIssued: false,
    behavioralSeenToolNames: new Set<string>(),
    behavioralObserverTrip: undefined,
    messages: [],
  } as unknown as TurnState;
}

function mkAssistant(
  calls: ReadonlyArray<{ id: string; name: string; arguments: string }>,
  text = "",
): AssistantMessage {
  return {
    uuid: `a-${Math.random()}`,
    role: "assistant",
    text,
    toolCalls: calls,
  };
}

function mkCompleted(
  id: string,
  name: string,
  content: string,
  isError = false,
): CompletedToolResultRecord {
  return { callId: id, toolName: name, arguments: "{}", content, isError };
}

function completedMap(
  records: readonly CompletedToolResultRecord[],
): Map<string, CompletedToolResultRecord> {
  return new Map(records.map((r) => [r.callId, r]));
}

const usage: LLMUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

/** Default config with only env overrides applied (no ctx.config). */
function cfg(overrides: Partial<BehavioralConfig> = {}): BehavioralConfig {
  return { ...resolveBehavioralConfig({}), ...overrides };
}

const ENV_KEYS = [
  "AGENC_BEHAVIORAL_BACKSTOP",
  "AGENC_NOPROGRESS_WARN",
  "AGENC_NOPROGRESS_TERMINATE",
  "AGENC_ABAB_TERMINATE",
  "AGENC_LOWGAIN_TERMINATE",
  "AGENC_PROGRESS_WINDOW",
  "AGENC_TURN_DEADLINE_MS",
  "AGENC_TURN_TOKEN_CAP",
  "AGENC_TURN_STEP_CAP",
  "AGENC_NOPROGRESS_IGNORE_TOOLS",
  "AGENC_PROGRESS_RESULT_PREFIX",
  "AGENC_PROGRESS_NORMALIZE_VOLATILE",
  "AGENC_BEHAVIORAL_OBSERVER",
  "AGENC_BEHAVIORAL_OBSERVER_K",
] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── Default config discipline ───────────────────────────────────────

describe("resolveBehavioralConfig — defaults", () => {
  test("master switch ON, result-aware detectors ON, risky caps OFF", () => {
    const c = resolveBehavioralConfig({});
    expect(c.enabled).toBe(true);
    expect(c.repeatSoft).toBe(3);
    expect(c.repeatHard).toBe(8);
    expect(c.ababCycles).toBe(3);
    expect(c.lowGainStreak).toBe(6);
    expect(c.window).toBe(16);
    // The risky absolute caps ALL default 0 (OFF).
    expect(c.maxTurnMs).toBe(0);
    expect(c.maxTurnTokens).toBe(0);
    expect(c.maxTurnSteps).toBe(0);
    // normalizeVolatile OFF, observer OFF.
    expect(c.normalizeVolatile).toBe(false);
    expect(c.observerEnabled).toBe(false);
    expect(c.observerEveryK).toBe(5);
    expect(c.ignoreTools.has("Sleep")).toBe(true);
    expect(c.resultHashPrefixBytes).toBe(64 * 1024);
  });

  test("precedence: ctx.config > env > default", () => {
    process.env.AGENC_NOPROGRESS_TERMINATE = "20";
    // env wins over default
    expect(resolveBehavioralConfig({}).repeatHard).toBe(20);
    // ctx.config wins over env
    expect(
      resolveBehavioralConfig({ config: { progressRepeatHard: 5 } }).repeatHard,
    ).toBe(5);
  });

  test("master switch OFF via env", () => {
    process.env.AGENC_BEHAVIORAL_BACKSTOP = "0";
    expect(resolveBehavioralConfig({}).enabled).toBe(false);
    process.env.AGENC_BEHAVIORAL_BACKSTOP = "off";
    expect(resolveBehavioralConfig({}).enabled).toBe(false);
    process.env.AGENC_BEHAVIORAL_BACKSTOP = "1";
    expect(resolveBehavioralConfig({}).enabled).toBe(true);
  });
});

// ── Signature + result hash ─────────────────────────────────────────

describe("stepActionSignature — canonical, order-stable args", () => {
  test("argument key order does NOT change the signature (canonicalJsonKey)", () => {
    const a = mkAssistant([
      { id: "1", name: "Read", arguments: '{"a":1,"b":2}' },
    ]);
    const b = mkAssistant([
      { id: "2", name: "Read", arguments: '{"b":2,"a":1}' },
    ]);
    expect(stepActionSignature(a, [])).toBe(stepActionSignature(b, []));
  });

  test("different args DO change the signature (progress)", () => {
    const a = mkAssistant([{ id: "1", name: "Read", arguments: '{"f":"/x"}' }]);
    const b = mkAssistant([{ id: "2", name: "Read", arguments: '{"f":"/y"}' }]);
    expect(stepActionSignature(a, [])).not.toBe(stepActionSignature(b, []));
  });

  test("text-only step yields a text signature", () => {
    const a = mkAssistant([], "hello   world");
    expect(stepActionSignature(a, [])).toBe("text hello world");
  });
});

describe("stepResultHash — content + isError", () => {
  test("changing content changes the hash", () => {
    const a = mkAssistant([{ id: "1", name: "S", arguments: "{}" }]);
    const h1 = stepResultHash(a, completedMap([mkCompleted("1", "S", "x")]), cfg());
    const h2 = stepResultHash(a, completedMap([mkCompleted("1", "S", "y")]), cfg());
    expect(h1).not.toBe(h2);
  });

  test("isError flip changes the hash", () => {
    const a = mkAssistant([{ id: "1", name: "S", arguments: "{}" }]);
    const ok = stepResultHash(a, completedMap([mkCompleted("1", "S", "x", false)]), cfg());
    const err = stepResultHash(a, completedMap([mkCompleted("1", "S", "x", true)]), cfg());
    expect(ok).not.toBe(err);
  });

  test("bounded prefix: identical first N bytes collide (fail-safe under-detection)", () => {
    const a = mkAssistant([{ id: "1", name: "S", arguments: "{}" }]);
    const c = cfg({ resultHashPrefixBytes: 4 });
    const h1 = stepResultHash(a, completedMap([mkCompleted("1", "S", "AAAA-tail1")]), c);
    const h2 = stepResultHash(a, completedMap([mkCompleted("1", "S", "AAAA-tail2")]), c);
    expect(h1).toBe(h2);
  });
});

// ── A1 (function level): repetition runaway must trip ───────────────

function feedSteps(
  state: TurnState,
  c: BehavioralConfig,
  steps: ReadonlyArray<{
    readonly assistant: AssistantMessage;
    readonly results: readonly CompletedToolResultRecord[];
  }>,
): ReturnType<typeof evaluateBehavioralBackstop> {
  let decision = evaluateBehavioralBackstop(state, usage, Date.now(), c);
  for (const step of steps) {
    state.toolUseBlocks = step.assistant.toolCalls.map((call) => ({
      type: "tool_use" as const,
      id: call.id,
      name: call.name,
      input: JSON.parse(call.arguments),
    }));
    recordBehavioralStep(state, step.assistant, completedMap(step.results), c);
    state.turnCount += 1;
    decision = evaluateBehavioralBackstop(state, usage, Date.now(), c);
    if (decision.kind === "terminate") break;
  }
  return decision;
}

/** Identical call + identical result, with DISTINCT call ids per step. */
function identicalStep(i: number): {
  assistant: AssistantMessage;
  results: CompletedToolResultRecord[];
} {
  const id = `call-${i}`;
  return {
    assistant: mkAssistant([{ id, name: "Read", arguments: '{"file_path":"/x"}' }]),
    results: [mkCompleted(id, "Read", "stable content")],
  };
}

describe("A1 — repetition runaway trips at repeatHard with a stable result", () => {
  test("terminates with trip.kind=repetition once the run hits repeatHard", () => {
    // Isolate the repetition ladder by pushing the low-gain detector out
    // of the way (with identical sig+result steps the low-gain streak
    // would otherwise fire first at its default threshold 6 < 8 — that is
    // intended Tier-1 ordering; both are `no_progress`, see the run-turn
    // integration test which asserts the terminal, not the sub-kind).
    const c = cfg({ repeatHard: 8, repeatSoft: 3, window: 16, lowGainStreak: 99 });
    const state = mkState();
    const steps = Array.from({ length: 12 }, (_, i) => identicalStep(i));
    const decision = feedSteps(state, c, steps);
    expect(decision.kind).toBe("terminate");
    if (decision.kind === "terminate") {
      expect(decision.trip.kind).toBe("repetition");
      // honest user message, never a success string
      expect(decision.trip.userMessage).toMatch(/no-progress backstop/i);
      expect(decision.trip.userMessage).not.toMatch(/success|completed the task/i);
    }
  });

  test("default thresholds: identical repetition still terminates (low_gain fires first)", () => {
    // With stock defaults (lowGainStreak 6 < repeatHard 8) the identical
    // runaway still produces a `no_progress` terminate — just via the
    // low-gain detector. Proves a default-config A1 always bounds.
    const c = cfg();
    const state = mkState();
    const steps = Array.from({ length: 12 }, (_, i) => identicalStep(i));
    const decision = feedSteps(state, c, steps);
    expect(decision.kind).toBe("terminate");
  });

  test("warns (no terminate) at repeatSoft and injects the nudge once", () => {
    const c = cfg({ repeatHard: 8, repeatSoft: 3 });
    const state = mkState();
    // feed exactly 3 identical steps → run length 3 → warn, not terminate
    feedSteps(state, c, [identicalStep(0), identicalStep(1)]);
    state.toolUseBlocks = [
      { type: "tool_use", id: "call-2", name: "Read", input: { file_path: "/x" } },
    ];
    recordBehavioralStep(
      state,
      identicalStep(2).assistant,
      completedMap(identicalStep(2).results),
      c,
    );
    const decision = evaluateBehavioralBackstop(state, usage, Date.now(), c);
    expect(decision.kind).toBe("warn");
    if (decision.kind === "warn") {
      expect(decision.injectNudge).toBe(true);
      expect(decision.nudgeText).toMatch(/repeated the same action/i);
    }
  });
});

// ── A2 — ABAB runaway ───────────────────────────────────────────────

describe("A2 — ABAB stable cycle trips", () => {
  test("alternating A/B with stable results trips trip.kind=abab", () => {
    const c = cfg({ ababCycles: 3, repeatHard: 99, lowGainStreak: 99 });
    const state = mkState();
    const steps = Array.from({ length: 12 }, (_, i) => {
      const id = `c-${i}`;
      const name = i % 2 === 0 ? "ToolA" : "ToolB";
      return {
        assistant: mkAssistant([{ id, name, arguments: "{}" }]),
        results: [mkCompleted(id, name, `${name}-stable`)],
      };
    });
    const decision = feedSteps(state, c, steps);
    expect(decision.kind).toBe("terminate");
    if (decision.kind === "terminate") expect(decision.trip.kind).toBe("abab");
  });

  test("a single A,B does NOT trip", () => {
    const c = cfg({ ababCycles: 3, repeatHard: 99, lowGainStreak: 99 });
    const state = mkState();
    const decision = feedSteps(state, c, [
      {
        assistant: mkAssistant([{ id: "a", name: "ToolA", arguments: "{}" }]),
        results: [mkCompleted("a", "ToolA", "x")],
      },
      {
        assistant: mkAssistant([{ id: "b", name: "ToolB", arguments: "{}" }]),
        results: [mkCompleted("b", "ToolB", "y")],
      },
    ]);
    expect(decision.kind).not.toBe("terminate");
  });
});

// ── A3 — low-gain runaway ───────────────────────────────────────────

describe("A3 — low-gain streak (gated by a repeated signature) trips", () => {
  test("repeated low-gain steps trip trip.kind=low_gain", () => {
    // Tighten lowGainStreak so it fires before repetition; keep repeatHard high.
    const c = cfg({ lowGainStreak: 4, repeatHard: 99, ababCycles: 99, window: 16 });
    const state = mkState();
    const steps = Array.from({ length: 10 }, (_, i) => identicalStep(i));
    const decision = feedSteps(state, c, steps);
    expect(decision.kind).toBe("terminate");
    if (decision.kind === "terminate") {
      expect(decision.trip.kind).toBe("low_gain");
    }
  });
});

// ── A4 — token cap (deadline) with DISTINCT calls ───────────────────

describe("A4 — Tier-0 token cap catches a novel-but-pointless runaway", () => {
  test("distinct calls never trip Tier-1, but the token cap trips trip.kind=deadline", () => {
    const c = cfg({ maxTurnTokens: 200_000, repeatHard: 99 });
    const state = mkState();
    let total = 0;
    let decision = evaluateBehavioralBackstop(
      state,
      { promptTokens: 0, completionTokens: 0, totalTokens: total },
      Date.now(),
      c,
    );
    for (let i = 0; i < 10; i++) {
      const id = `dist-${i}`;
      const a = mkAssistant([
        { id, name: "Distinct", arguments: JSON.stringify({ step: i }) },
      ]);
      state.toolUseBlocks = [
        { type: "tool_use", id, name: "Distinct", input: { step: i } },
      ];
      recordBehavioralStep(state, a, completedMap([mkCompleted(id, "Distinct", `r${i}`)]), c);
      state.turnCount += 1;
      total += 65_000; // ~65k tokens/step
      decision = evaluateBehavioralBackstop(
        state,
        { promptTokens: 0, completionTokens: 0, totalTokens: total },
        Date.now(),
        c,
      );
      if (decision.kind === "terminate") break;
    }
    expect(decision.kind).toBe("terminate");
    if (decision.kind === "terminate") {
      expect(decision.trip.kind).toBe("deadline");
      // the detail names the TOKEN cap, not a repetition
      expect(decision.trip.detail).toMatch(/token cap/i);
      expect(decision.trip.detail).not.toMatch(/repeat/i);
    }
  });
});

// ── B1 — status polling that PROGRESSES must NOT trip ───────────────

/** Same tool 12x, but with a CHANGING result each step. */
function pollingSteps(): ReadonlyArray<{
  assistant: AssistantMessage;
  results: CompletedToolResultRecord[];
}> {
  return Array.from({ length: 12 }, (_, i) => {
    const id = `poll-${i}`;
    return {
      assistant: mkAssistant([{ id, name: "GetStatus", arguments: "{}" }]),
      results: [mkCompleted(id, "GetStatus", i < 11 ? `pending ${i}/11` : "done")],
    };
  });
}

describe("B1 — status polling that progresses NEVER trips (the killer test)", () => {
  test("same tool, changing result → no terminate, run counter never exceeds 1", () => {
    const c = cfg({ repeatHard: 8, repeatSoft: 3, ababCycles: 3, lowGainStreak: 6 });
    const state = mkState();
    let sawTerminate = false;
    let sawWarn = false;
    for (const step of pollingSteps()) {
      state.toolUseBlocks = step.assistant.toolCalls.map((call) => ({
        type: "tool_use" as const,
        id: call.id,
        name: call.name,
        input: {},
      }));
      recordBehavioralStep(state, step.assistant, completedMap(step.results), c);
      state.turnCount += 1;
      const d = evaluateBehavioralBackstop(state, usage, Date.now(), c);
      if (d.kind === "terminate") sawTerminate = true;
      if (d.kind === "warn") sawWarn = true;
    }
    expect(sawTerminate).toBe(false);
    expect(sawWarn).toBe(false);
  });

  test(
    "GUARD-OF-THE-GUARD: force resultHash constant → B1 reddens (trips)",
    () => {
      // Simulate breaking the result-aware gate by hashing a CONSTANT
      // result content for every step (what would happen if resultHash
      // were dropped / pinned in the fingerprint). The same polling
      // sequence must now trip — proving the result-aware gate is the
      // load-bearing defense, not decorative.
      const c = cfg({ repeatHard: 8, repeatSoft: 3, ababCycles: 99, lowGainStreak: 99 });
      const state = mkState();
      let sawTerminate = false;
      for (let i = 0; i < 12; i++) {
        const id = `poll-${i}`;
        const a = mkAssistant([{ id, name: "GetStatus", arguments: "{}" }]);
        state.toolUseBlocks = [
          { type: "tool_use", id, name: "GetStatus", input: {} },
        ];
        // CONSTANT content — the gate is broken on purpose.
        recordBehavioralStep(
          state,
          a,
          completedMap([mkCompleted(id, "GetStatus", "CONSTANT")]),
          c,
        );
        state.turnCount += 1;
        const d = evaluateBehavioralBackstop(state, usage, Date.now(), c);
        if (d.kind === "terminate") {
          sawTerminate = true;
          break;
        }
      }
      expect(sawTerminate).toBe(true);
    },
  );
});

// ── B2 — progressing retry (isError flip) resets the counter ────────

describe("B2 — progressing retry (isError flip) resets the counter", () => {
  test("isError flip resets the trailing run, then genuine progress never trips", () => {
    const c = cfg({ repeatHard: 4, repeatSoft: 99, ababCycles: 99, lowGainStreak: 99 });
    const state = mkState();
    // 3 identical failing retries → run length 3 (one short of repeatHard 4).
    for (let i = 0; i < 3; i++) {
      const id = `w-${i}`;
      const a = mkAssistant([{ id, name: "Write", arguments: '{"path":"/a"}' }]);
      state.toolUseBlocks = [
        { type: "tool_use", id, name: "Write", input: { path: "/a" } },
      ];
      recordBehavioralStep(state, a, completedMap([mkCompleted(id, "Write", "out", true)]), c);
      state.turnCount += 1;
    }
    // Run is 3 (identical failing sig+result).
    let d = evaluateBehavioralBackstop(state, usage, Date.now(), c);
    expect(d.kind).not.toBe("terminate");
    // The flip to success changes resultHash → trailing run RESETS to 1.
    const flipId = "w-flip";
    const flip = mkAssistant([{ id: flipId, name: "Write", arguments: '{"path":"/a"}' }]);
    state.toolUseBlocks = [
      { type: "tool_use", id: flipId, name: "Write", input: { path: "/a" } },
    ];
    recordBehavioralStep(state, flip, completedMap([mkCompleted(flipId, "Write", "ok", false)]), c);
    state.turnCount += 1;
    d = evaluateBehavioralBackstop(state, usage, Date.now(), c);
    expect(d.kind).not.toBe("terminate");
    // After the flip, the agent makes genuine progress (distinct results),
    // so even continuing for many steps never trips.
    for (let i = 0; i < 8; i++) {
      const id = `prog-${i}`;
      const a = mkAssistant([{ id, name: "Write", arguments: JSON.stringify({ path: `/f${i}` }) }]);
      state.toolUseBlocks = [
        { type: "tool_use", id, name: "Write", input: { path: `/f${i}` } },
      ];
      recordBehavioralStep(state, a, completedMap([mkCompleted(id, "Write", `wrote-${i}`, false)]), c);
      state.turnCount += 1;
      d = evaluateBehavioralBackstop(state, usage, Date.now(), c);
      expect(d.kind).not.toBe("terminate");
    }
  });
});

// ── B3 — distinct-but-cheap long turn never accumulates low-gain ────

describe("B3 — distinct-but-cheap long turn never trips low-gain", () => {
  test("all distinct signatures past lowGainStreak → no trip", () => {
    const c = cfg({ lowGainStreak: 3, repeatHard: 99, ababCycles: 99, window: 16 });
    const state = mkState();
    const steps = Array.from({ length: 12 }, (_, i) => {
      const id = `d-${i}`;
      return {
        assistant: mkAssistant([
          { id, name: "Step", arguments: JSON.stringify({ i }) },
        ]),
        results: [mkCompleted(id, "Step", `r${i}`)],
      };
    });
    const decision = feedSteps(state, c, steps);
    expect(decision.kind).not.toBe("terminate");
    expect(state.behavioralLowGainStreak).toBe(0);
  });
});

// ── B4 — designated ignore-tool excluded ────────────────────────────

describe("B4 — ignore-tool exclusion is tool-scoped", () => {
  test("identical Sleep{} (ignored) never trips, identical non-ignored 12x trips", () => {
    const c = cfg({ repeatHard: 8, ignoreTools: new Set(["Sleep"]) });
    const sleepState = mkState();
    const sleepSteps = Array.from({ length: 12 }, (_, i) => {
      const id = `s-${i}`;
      return {
        assistant: mkAssistant([{ id, name: "Sleep", arguments: "{}" }]),
        results: [mkCompleted(id, "Sleep", "zzz")],
      };
    });
    const sleepDecision = feedSteps(sleepState, c, sleepSteps);
    expect(sleepDecision.kind).not.toBe("terminate");
    // history never grew (all-ignored steps are skipped)
    expect(sleepState.behavioralStepHistory.length).toBe(0);

    // A non-ignored identical tool DOES trip.
    const otherState = mkState();
    const otherSteps = Array.from({ length: 12 }, (_, i) => identicalStep(i));
    const otherDecision = feedSteps(otherState, c, otherSteps);
    expect(otherDecision.kind).toBe("terminate");
  });
});

// ── B5 — two-state legitimate poll (ABAB with changing results) ─────

describe("B5 — two-state legit poll does not trip ABAB", () => {
  test("A/B alternation with changing results → no trip", () => {
    const c = cfg({ ababCycles: 3, repeatHard: 99, lowGainStreak: 99 });
    const state = mkState();
    const steps = Array.from({ length: 12 }, (_, i) => {
      const id = `t-${i}`;
      const name = i % 2 === 0 ? "ToolA" : "ToolB";
      // changing result each occurrence
      return {
        assistant: mkAssistant([{ id, name, arguments: "{}" }]),
        results: [mkCompleted(id, name, `${name}-${i}`)],
      };
    });
    const decision = feedSteps(state, c, steps);
    expect(decision.kind).not.toBe("terminate");
  });
});

// ── B7 — disabled master switch is byte-identical inert ─────────────

describe("B7 — disabled master switch records nothing and never trips", () => {
  test("enabled:false → record is a no-op and evaluate returns none", () => {
    const c = cfg({ enabled: false });
    const state = mkState();
    const decision = feedSteps(
      state,
      c,
      Array.from({ length: 20 }, (_, i) => identicalStep(i)),
    );
    expect(decision.kind).toBe("none");
    expect(state.behavioralStepHistory.length).toBe(0);
  });
});

// ── Tier-0 step + wall-clock caps ───────────────────────────────────

describe("Tier-0 caps — step + wall-clock", () => {
  test("step cap trips deadline when turnCount exceeds it", () => {
    const c = cfg({ maxTurnSteps: 5 });
    const state = mkState();
    state.turnCount = 6;
    const decision = evaluateBehavioralBackstop(state, usage, Date.now(), c);
    expect(decision.kind).toBe("terminate");
    if (decision.kind === "terminate") {
      expect(decision.trip.kind).toBe("deadline");
      expect(decision.trip.detail).toMatch(/step cap/i);
    }
  });

  test("wall-clock cap trips deadline when elapsed exceeds it", () => {
    const c = cfg({ maxTurnMs: 1000 });
    const state = mkState();
    const decision = evaluateBehavioralBackstop(
      state,
      usage,
      Date.now() - 5000, // started 5s ago
      c,
    );
    expect(decision.kind).toBe("terminate");
    if (decision.kind === "terminate") {
      expect(decision.trip.detail).toMatch(/wall-clock/i);
    }
  });

  test("caps OFF (0) never trip even with a huge turnCount/usage", () => {
    const c = cfg(); // all caps default 0
    const state = mkState();
    state.turnCount = 100_000;
    const decision = evaluateBehavioralBackstop(
      state,
      { promptTokens: 0, completionTokens: 0, totalTokens: 999_999_999 },
      Date.now() - 999_999,
      c,
    );
    expect(decision.kind).toBe("none");
  });
});

// ── normalizeVolatile (off by default, opt-in) ──────────────────────

describe("normalizeVolatile — opt-in volatile stripping", () => {
  test("OFF by default: re-stamped timestamps yield DIFFERENT hashes", () => {
    const c = cfg({ normalizeVolatile: false });
    const a = mkAssistant([{ id: "1", name: "S", arguments: "{}" }]);
    const h1 = stepResultHash(a, completedMap([mkCompleted("1", "S", "t=2026-01-01T00:00:00Z")]), c);
    const h2 = stepResultHash(a, completedMap([mkCompleted("1", "S", "t=2026-01-01T00:00:01Z")]), c);
    expect(h1).not.toBe(h2);
  });

  test("ON: re-stamped timestamps collapse to the SAME hash", () => {
    const c = cfg({ normalizeVolatile: true });
    const a = mkAssistant([{ id: "1", name: "S", arguments: "{}" }]);
    const h1 = stepResultHash(a, completedMap([mkCompleted("1", "S", "t=2026-01-01T00:00:00Z")]), c);
    const h2 = stepResultHash(a, completedMap([mkCompleted("1", "S", "t=2026-01-01T00:00:01Z")]), c);
    expect(h1).toBe(h2);
  });
});

// ── C1 (function level) — the policing path issues no awaits ─────────

describe("C1 — record + evaluate are synchronous (return non-thenables)", () => {
  test("recordBehavioralStep returns undefined (not a Promise)", () => {
    const c = cfg();
    const state = mkState();
    const a = identicalStep(0).assistant;
    state.toolUseBlocks = [
      { type: "tool_use", id: "call-0", name: "Read", input: { file_path: "/x" } },
    ];
    const ret = recordBehavioralStep(
      state,
      a,
      completedMap(identicalStep(0).results),
      c,
    );
    expect(ret).toBeUndefined();
    expect(typeof (ret as unknown as { then?: unknown })?.then).not.toBe(
      "function",
    );
  });

  test("evaluateBehavioralBackstop returns a plain decision object (not a Promise)", () => {
    const c = cfg();
    const state = mkState();
    const d = evaluateBehavioralBackstop(state, usage, Date.now(), c);
    expect(typeof (d as unknown as { then?: unknown })?.then).not.toBe(
      "function",
    );
    expect(d.kind).toBe("none");
  });
});
