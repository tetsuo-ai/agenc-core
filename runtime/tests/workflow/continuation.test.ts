import { describe, expect, it } from "vitest";

import {
  completedContinuationSource,
  continuationRunId,
} from "../../src/app-server/workflow/continuation.js";
import type { WorkflowContinuation, WorkflowSpec } from "../../src/contracts/run-contracts.js";
import { computeSpecDigest } from "../../src/workflow/evidence-record.js";
import type {
  DurableRunEffect,
  DurableRunTerminalRecord,
  StateRunDurabilityRepository,
} from "../../src/state/run-durability.js";

const HEX40 = "a".repeat(40);
const HEX64 = "b".repeat(64);
const DIGEST = `sha256:${HEX64}` as const;
const RUN = "wf-source-1";
const RUN_ID_SHAPE =
  /^wf-[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function spec(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    runId: RUN,
    goal: "Fix add",
    repoPath: "/repo/root",
    baseCommit: HEX40,
    baseDirty: { dirty: false, summaryDigest: DIGEST, fileCount: 0 },
    reviewerModel: "reviewer",
    permissionMode: "acceptEdits",
    budget: { maxCostUsd: 1 },
    requiredVerification: [{ label: "test", script: "./test.sh" }],
    maxImplementAttempts: 2,
    ...overrides,
  };
}

function effect(
  outcome: DurableRunEffect["outcome"],
  evidence: unknown,
  intentDigest?: string,
): DurableRunEffect {
  const digest =
    intentDigest ??
    (typeof evidence === "object" &&
    evidence !== null &&
    "specDigest" in evidence &&
    typeof evidence.specDigest === "string"
      ? evidence.specDigest
      : DIGEST);
  return { outcome, intentDigest: digest, evidence } as DurableRunEffect;
}

function intakeEffect(source: WorkflowSpec): DurableRunEffect {
  const specDigest = computeSpecDigest(source);
  return effect("committed", { spec: source, specDigest }, specDigest);
}

function finalizeEffect(overrides: {
  readonly headCommit?: string;
  readonly treeHash?: string;
  readonly sealDigest?: string;
  readonly patchRunId?: string;
  readonly patchDigest?: string;
  readonly omitPatch?: boolean;
} = {}): DurableRunEffect {
  return effect("committed", {
    finalize: {
      headCommit: overrides.headCommit ?? HEX40,
      treeHash: overrides.treeHash ?? HEX40,
      sealDigest: overrides.sealDigest ?? DIGEST,
      baseMovement: "none",
    },
    artifacts: overrides.omitPatch === true
      ? []
      : [{
        step: { runId: overrides.patchRunId ?? RUN, stepId: "workflow.finalize" },
        role: "patch",
        digest: overrides.patchDigest ?? DIGEST,
        bytes: 16,
        storagePath: `cas://sha256/${HEX64}`,
        recordedAt: "2026-10-01T00:00:00Z",
      }],
  });
}

function terminal(
  overrides: Partial<DurableRunTerminalRecord> = {},
): DurableRunTerminalRecord {
  return {
    runId: RUN,
    status: "completed",
    exitCode: 0,
    stopReason: null,
    finalMessage: "done",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, costUsd: 0.2 },
    lastSequence: 1,
    finishedAt: "2026-10-01T00:00:00.000Z",
    epoch: 1,
    eventId: "term",
    ...overrides,
  };
}

function repo(parts: {
  readonly terminal?: DurableRunTerminalRecord | undefined;
  readonly intake?: DurableRunEffect | undefined;
  readonly finalize?: DurableRunEffect | undefined;
}): StateRunDurabilityRepository {
  return {
    getCurrentTerminalResult: () => parts.terminal,
    getEffect: (_runId: string, stepId: string) => {
      if (stepId === "workflow.intake") return parts.intake;
      if (stepId === "workflow.finalize") return parts.finalize;
      return undefined;
    },
  } as StateRunDurabilityRepository;
}

function source(parts: {
  readonly spec?: WorkflowSpec;
  readonly terminal?: DurableRunTerminalRecord | null;
  readonly intake?: DurableRunEffect | null;
  readonly finalize?: DurableRunEffect | null;
  readonly repoPath?: string;
} = {}): WorkflowContinuation {
  const frozen = parts.spec ?? spec();
  const provided = <K extends keyof typeof parts>(key: K): boolean =>
    Object.hasOwn(parts, key);
  return completedContinuationSource({
    repo: repo({
      terminal: provided("terminal") ? parts.terminal ?? undefined : terminal(),
      intake: provided("intake") ? parts.intake ?? undefined : intakeEffect(frozen),
      finalize: provided("finalize") ? parts.finalize ?? undefined : finalizeEffect(),
    }),
    sourceRunId: RUN,
    repoPath: parts.repoPath ?? frozen.repoPath,
    requestId: "next-feature",
    requestDigest: DIGEST,
  });
}

describe("continuationRunId", () => {
  it("assigns a stable UUIDv8-shaped id from the source and request", () => {
    const first = continuationRunId(RUN, "next-feature");
    expect(first).toMatch(RUN_ID_SHAPE);
    expect(continuationRunId(RUN, "next-feature")).toBe(first);
    expect(continuationRunId(RUN, "other-feature")).not.toBe(first);
    expect(continuationRunId(RUN, "other-feature")).toMatch(RUN_ID_SHAPE);
  });
});

describe("completedContinuationSource", () => {
  it("reads only a completed verified snapshot and seeds a new series", () => {
    const frozen = spec();
    expect(source({ spec: frozen })).toEqual({
      sourceRunId: RUN,
      sourceSpecDigest: computeSpecDigest(frozen),
      sourceBaseCommit: HEX40,
      sourceHeadCommit: HEX40,
      sourceTreeHash: HEX40,
      sourcePatchDigest: DIGEST,
      sourceSealDigest: DIGEST,
      seriesRootRunId: RUN,
      requestId: "next-feature",
      requestDigest: DIGEST,
      previousCostUsd: 0.2,
      sourceUsage: terminal().usage,
    });
  });

  it.each([
    ["failed", terminal({ status: "failed" })],
    ["cancelled", terminal({ status: "cancelled" })],
    ["missing", undefined],
  ] as const)("refuses a %s source terminal", (_label, record) => {
    expect(() => source({ terminal: record })).toThrow(
      /completed verified Goal/u,
    );
  });

  it("refuses incomplete intake or finalize authority", () => {
    const frozen = spec();
    expect(() => source({ intake: effect("unknown", { spec: frozen }) })).toThrow(
      /completed verified Goal/u,
    );
    expect(() => source({ finalize: effect("unknown", { finalize: {} }) })).toThrow(
      /completed verified Goal/u,
    );
  });

  it.each([
    ["belongs to another run", spec({ runId: "wf-other" })],
    ["belongs to another repository", spec({ repoPath: "/other/repo" })],
  ])("refuses a spec that %s", (_label, frozen) => {
    expect(() => source({ spec: frozen, repoPath: "/repo/root" })).toThrow(
      /missing, changed, or belongs to another repository/u,
    );
  });

  it("refuses a spec whose stored digest no longer matches the frozen body", () => {
    const frozen = spec();
    expect(() =>
      source({
        intake: effect(
          "committed",
          { spec: frozen, specDigest: `sha256:${"0".repeat(64)}` },
          `sha256:${"0".repeat(64)}`,
        ),
      }),
    ).toThrow(/missing, changed, or belongs to another repository/u);
  });

  it.each([
    ["short head commit", { headCommit: "deadbeef" }],
    ["missing seal", { sealDigest: "not-a-digest" }],
    ["patch from another run", { patchRunId: "wf-other" }],
    ["no patch artifact", { omitPatch: true }],
  ])("refuses a snapshot with %s", (_label, finalize) => {
    expect(() => source({ finalize: finalizeEffect(finalize) })).toThrow(
      /no valid verified snapshot/u,
    );
  });

  it("refuses a prior continuation whose cost history is not a finite non-negative number", () => {
    const prior = {
      sourceRunId: "wf-root",
      sourceSpecDigest: DIGEST,
      sourceBaseCommit: HEX40,
      sourceHeadCommit: HEX40,
      sourceTreeHash: HEX40,
      sourcePatchDigest: DIGEST,
      sourceSealDigest: DIGEST,
      seriesRootRunId: "wf-root",
      requestId: "first",
      requestDigest: DIGEST,
      previousCostUsd: -0.01,
      sourceUsage: null,
    } satisfies WorkflowContinuation;
    expect(() => source({ spec: spec({ continuationOf: prior }) })).toThrow(
      /continuation history is invalid/u,
    );
  });

  it("adds known source spend onto a prior series and keeps the estimated flag", () => {
    const prior = {
      sourceRunId: "wf-root",
      sourceSpecDigest: DIGEST,
      sourceBaseCommit: HEX40,
      sourceHeadCommit: HEX40,
      sourceTreeHash: HEX40,
      sourcePatchDigest: DIGEST,
      sourceSealDigest: DIGEST,
      seriesRootRunId: "wf-root",
      requestId: "first",
      requestDigest: DIGEST,
      previousCostUsd: 0.05,
      previousCostEstimated: true,
      sourceUsage: null,
    } satisfies WorkflowContinuation;
    const frozen = spec({ continuationOf: prior });
    expect(source({ spec: frozen })).toMatchObject({
      seriesRootRunId: "wf-root",
      previousCostUsd: 0.25,
      previousCostEstimated: true,
    });
  });

  it("leaves cumulative spend unknown when the source cost is not known", () => {
    expect(
      source({
        terminal: terminal({
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            totalTokens: 14,
            costUsd: 0.2,
            costKnown: false,
          },
        }),
      }).previousCostUsd,
    ).toBeNull();
  });
});
