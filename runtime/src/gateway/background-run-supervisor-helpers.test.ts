import { describe, expect, it } from "vitest";
import type { ChatExecutorResult } from "../llm/chat-executor.js";
import {
  applyZeroToolCompletionGuard,
  buildFallbackContract,
  parseContract,
} from "./background-run-supervisor-helpers.js";
import type {
  ActiveBackgroundRun,
  BackgroundRunDecision,
} from "./background-run-supervisor-types.js";

function makeActorResult(
  overrides: Partial<ChatExecutorResult> = {},
): ChatExecutorResult {
  return {
    content: "",
    provider: "grok",
    model: "grok-test",
    usedFallback: false,
    toolCalls: [],
    tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    callUsage: [],
    durationMs: 10,
    compacted: false,
    stopReason: "completed",
    completionState: "completed",
    ...overrides,
  };
}

function makeRun(overrides: Partial<ActiveBackgroundRun> = {}): ActiveBackgroundRun {
  return {
    lastToolEvidence: undefined,
    ...overrides,
  } as unknown as ActiveBackgroundRun;
}

describe("applyZeroToolCompletionGuard", () => {
  const baseDecision: BackgroundRunDecision = {
    state: "completed",
    userUpdate: "done",
    internalSummary: "done",
    shouldNotifyUser: true,
  };

  it("passes through decisions that are not 'completed'", () => {
    const run = makeRun({ lastToolEvidence: "evidence" });
    const workingDecision: BackgroundRunDecision = {
      ...baseDecision,
      state: "working",
    };
    const out = applyZeroToolCompletionGuard(run, makeActorResult(), workingDecision);
    expect(out).toBe(workingDecision);
  });

  it("passes through when the cycle has successful tool calls", () => {
    const run = makeRun({ lastToolEvidence: "evidence" });
    const result = makeActorResult({
      toolCalls: [
        {
          callId: "call-1",
          name: "system.bash",
          arguments: "{}",
          result: "ok",
          isError: false,
        },
      ],
    });
    const out = applyZeroToolCompletionGuard(run, result, baseDecision);
    expect(out).toBe(baseDecision);
  });

  it("passes through when there is no prior tool evidence (groundDecision owns the never-started path)", () => {
    const run = makeRun({ lastToolEvidence: undefined });
    const out = applyZeroToolCompletionGuard(run, makeActorResult(), baseDecision);
    expect(out).toBe(baseDecision);
  });

  it("downgrades 'completed' to 'working' when the zero-tool cycle has prior evidence and no explicit completion signal", () => {
    const run = makeRun({ lastToolEvidence: "evidence" });
    const out = applyZeroToolCompletionGuard(
      run,
      makeActorResult({ content: "M1 progress: still compiling" }),
      baseDecision,
    );
    expect(out.state).toBe("working");
    expect(out.internalSummary).toContain("Downgraded premature completion");
    expect(out.userUpdate).toContain("M1 progress");
  });

  it("accepts 'completed' when completionProgress explicitly says completed with no remaining requirements", () => {
    const run = makeRun({ lastToolEvidence: "evidence" });
    const out = applyZeroToolCompletionGuard(
      run,
      makeActorResult({
        completionProgress: {
          completionState: "completed",
          stopReason: "completed",
          requiredRequirements: ["verifier_pass"],
          satisfiedRequirements: ["verifier_pass"],
          remainingRequirements: [],
          reusableEvidence: [],
          updatedAt: 10,
        },
      }),
      baseDecision,
    );
    expect(out).toBe(baseDecision);
  });

  it("downgrades when completionProgress claims completed but remaining requirements exist", () => {
    const run = makeRun({ lastToolEvidence: "evidence" });
    const out = applyZeroToolCompletionGuard(
      run,
      makeActorResult({
        completionProgress: {
          completionState: "completed",
          stopReason: "completed",
          requiredRequirements: ["a", "b"],
          satisfiedRequirements: ["a"],
          remainingRequirements: ["b"],
          reusableEvidence: [],
          updatedAt: 10,
        },
      }),
      baseDecision,
    );
    expect(out.state).toBe("working");
  });
});

describe("contract requiresUserStop defaults", () => {
  const plannedContractJson = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      domain: "workspace",
      kind: "finite",
      successCriteria: ["make progress"],
      completionCriteria: ["objective satisfied"],
      blockedCriteria: ["missing inputs"],
      nextCheckMs: 5_000,
      heartbeatMs: 10_000,
      requiresUserStop: false,
      ...overrides,
    });

  it("parseContract: honors the planner-set boolean verbatim", () => {
    const withFalse = parseContract(
      plannedContractJson({ requiresUserStop: false }),
      "Update the README.",
    );
    expect(withFalse?.requiresUserStop).toBe(false);

    const withTrue = parseContract(
      plannedContractJson({ requiresUserStop: true }),
      "Update the README.",
    );
    expect(withTrue?.requiresUserStop).toBe(true);
  });

  it("parseContract: defaults to kind === 'until_stopped' when the planner omits the boolean", () => {
    const raw = JSON.parse(plannedContractJson()) as Record<string, unknown>;
    delete raw.requiresUserStop;
    const finiteContract = parseContract(JSON.stringify(raw), "Update README.");
    expect(finiteContract?.requiresUserStop).toBe(false);

    raw.kind = "until_stopped";
    const untilStoppedContract = parseContract(JSON.stringify(raw), "Watch it.");
    expect(untilStoppedContract?.requiresUserStop).toBe(true);
  });

  it("buildFallbackContract: only sets requiresUserStop=true when UNTIL_STOP_RE matches", () => {
    expect(buildFallbackContract("Run npm test").requiresUserStop).toBe(false);
    expect(
      buildFallbackContract("Keep watching this until I say stop").requiresUserStop,
    ).toBe(true);
    // Exhaustive-intent phrasing is no longer special-cased — matches
    // reference-runtime behavior where only an explicit user-stop
    // directive flips the flag.
    expect(
      buildFallbackContract("Implement @PLAN.md in full").requiresUserStop,
    ).toBe(false);
  });
});
