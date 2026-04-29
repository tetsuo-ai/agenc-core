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
    expect(out.decision).toBe(workingDecision);
    expect(out.guardFired).toBe(false);
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
    expect(out.decision).toBe(baseDecision);
    expect(out.guardFired).toBe(false);
  });

  it("passes through when there is no prior tool evidence (groundDecision owns the never-started path)", () => {
    const run = makeRun({ lastToolEvidence: undefined });
    const out = applyZeroToolCompletionGuard(run, makeActorResult(), baseDecision);
    expect(out.decision).toBe(baseDecision);
    expect(out.guardFired).toBe(false);
  });

  it("downgrades 'completed' to 'working' when the zero-tool cycle has prior evidence and no explicit completion signal", () => {
    const run = makeRun({ lastToolEvidence: "evidence" });
    const out = applyZeroToolCompletionGuard(
      run,
      makeActorResult({ content: "M1 progress: still compiling" }),
      baseDecision,
    );
    expect(out.decision.state).toBe("working");
    expect(out.decision.internalSummary).toContain("Downgraded premature completion");
    expect(out.decision.userUpdate).toContain("M1 progress");
    expect(out.guardFired).toBe(true);
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
    expect(out.decision).toBe(baseDecision);
    expect(out.guardFired).toBe(false);
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
    expect(out.decision.state).toBe("working");
    expect(out.guardFired).toBe(true);
  });

  it("accepts the actor's terminal 'completed' decision once the nudge budget is exhausted", () => {
    const run = makeRun({
      lastToolEvidence: "evidence",
      consecutiveNudgeCycles: 2,
    });
    const out = applyZeroToolCompletionGuard(
      run,
      makeActorResult({ content: "Understood. Objective complete." }),
      baseDecision,
    );
    expect(out.decision).toBe(baseDecision);
    expect(out.guardFired).toBe(false);
  });
});

describe("contract kind parsing defaults", () => {
  const plannedContractJson = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      domain: "workspace",
      kind: "finite",
      successCriteria: ["make progress"],
      completionCriteria: ["objective satisfied"],
      blockedCriteria: ["missing inputs"],
      nextCheckMs: 5_000,
      heartbeatMs: 10_000,
      ...overrides,
    });

  it("parseContract: honors the planner-set kind verbatim", () => {
    const finiteContract = parseContract(
      plannedContractJson({ kind: "finite" }),
      "Update the README.",
    );
    expect(finiteContract?.kind).toBe("finite");

    const untilStoppedContract = parseContract(
      plannedContractJson({ kind: "until_stopped" }),
      "Watch forever.",
    );
    expect(untilStoppedContract?.kind).toBe("until_stopped");
  });

  it("parseContract: silently ignores a stray requiresUserStop field on legacy input", () => {
    const raw = JSON.parse(plannedContractJson()) as Record<string, unknown>;
    raw.requiresUserStop = true;
    const contract = parseContract(JSON.stringify(raw), "Update README.");
    expect(contract).toBeDefined();
    expect((contract as Record<string, unknown> | undefined)?.requiresUserStop).toBeUndefined();
  });

  it("buildFallbackContract: infers 'until_stopped' kind only when UNTIL_STOP_RE matches", () => {
    expect(buildFallbackContract("Run npm test").kind).toBe("finite");
    expect(
      buildFallbackContract("Keep watching this until I say stop").kind,
    ).toBe("until_stopped");
    // Exhaustive-intent phrasing ("in full") is not special-cased —
    // matches reference-runtime behavior where only an explicit
    // user-stop directive promotes the run kind.
    expect(
      buildFallbackContract("Implement @PLAN.md in full").kind,
    ).toBe("finite");
  });
});
