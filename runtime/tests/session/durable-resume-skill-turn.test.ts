/**
 * A turn the user started with a skill journals the skill's record on its
 * turn context. Reconstruction carries the record of the interrupted turn's
 * latest context to the resume, and the resume runs the turn on the context
 * the embedder rebuilds from it; without one it runs on the session's
 * settings and says so.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { resumeTurnFromCheckpoint } from "../../src/conversation/thread-manager.js";
import { computeCheckpointPrefixHashV3 } from "../../src/session/durable-checkpoint-reader.js";
import { resetBuildIdForTestingOnly } from "../../src/session/durable-turns.js";
import type { ResponseItem, RolloutItem } from "../../src/session/rollout-item.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import type { Session } from "../../src/session/session.js";
import type { SkillInvocationRecord } from "../../src/session/skill-invocation.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import type {
  ToolPairIntegrityFailure,
  ToolPairOperationalDeferral,
  ToolPairProjection,
  ToolPairProjectionRecord,
  ToolPairProjectionSummary,
} from "../../src/session/tool-pair-validator.js";

/** In-memory tool-pair projection, so checkpoint integrity can be proven. */
class TestToolPairProjection implements ToolPairProjection {
  private records = new Map<string, ToolPairProjectionRecord>();
  runAtomically<T>(operation: () => T): T { return operation(); }
  reset(): void { this.records.clear(); }
  find(_projectionId: string, callId: string): ToolPairProjectionRecord | undefined {
    return this.records.get(callId);
  }
  insertCall(_projectionId: string, record: ToolPairProjectionRecord): boolean {
    if (this.records.has(record.callId)) return false;
    this.records.set(record.callId, record);
    return true;
  }
  resolveCall(params: {
    readonly callId: string;
    readonly resultIndex: number;
    readonly resultId?: string;
    readonly originalResultDigest?: string;
  }): "resolved" | "already_resolved" | "missing" {
    const record = this.records.get(params.callId);
    if (record === undefined) return "missing";
    if (record.resultIndex !== undefined) return "already_resolved";
    this.records.set(params.callId, { ...record, ...params });
    return "resolved";
  }
  complete(): void {}
  completeDangling(): void {}
  fail(
    _projectionId: string,
    _summary: ToolPairProjectionSummary,
    _failure: ToolPairIntegrityFailure | ToolPairOperationalDeferral,
  ): void {}
}

let projectionOrdinal = 0;

function reconstruct(items: ReadonlyArray<RolloutItem>) {
  projectionOrdinal += 1;
  return reconstructFromRollout(items, {
    checkpointProjection: {
      projection: new TestToolPairProjection(),
      projectionId: `skill-resume-projection-${projectionOrdinal}`,
      sourceKey: `skill-resume-rollout-${projectionOrdinal}`,
      expectedRunId: "skill-resume-run",
    },
  });
}

const TURN_ID = "skill-turn";

const RECORD: SkillInvocationRecord = {
  name: "deep-review",
  source: "userSettings",
  requested: { model: "deepseek-v4-pro", effort: "low", allowedTools: ["Write"] },
  model: "deepseek-v4-pro",
  effort: "low",
  allowedTools: ["Write", "Skill(deep-review)"],
};

afterEach(() => {
  delete process.env.AGENC_BUILD_ID;
  resetBuildIdForTestingOnly();
});

function pinBuild(id: string): string {
  process.env.AGENC_BUILD_ID = id;
  resetBuildIdForTestingOnly();
  return id;
}

function turnContext(skillInvocation?: SkillInvocationRecord): RolloutItem {
  return {
    type: "turn_context",
    payload: {
      turnId: TURN_ID,
      cwd: "/tmp",
      approvalPolicy: "on_request",
      sandboxPolicy: "workspace_write",
      model: skillInvocation?.model ?? "deepseek-flash",
      ...(skillInvocation !== undefined ? { skillInvocation } : {}),
    },
  } as RolloutItem;
}

/** An interrupted turn: started, its contexts, a prefix and a checkpoint. */
function interruptedSkillTurn(contexts: readonly RolloutItem[]): RolloutItem[] {
  const buildId = pinBuild("skill-resume-build");
  const prefix: ResponseItem[] = [{ role: "user", content: "review the diff" }];
  return [
    { type: "event_msg", payload: { id: "started", seq: 1, msg: {
      type: "turn_started", payload: { turnId: TURN_ID, buildId },
    } } },
    ...contexts,
    ...prefix.map((payload) => ({ type: "response_item", payload }) as RolloutItem),
    { type: "event_msg", payload: { id: "checkpoint", seq: 2, msg: {
      type: "turn_checkpoint", payload: {
        turnId: TURN_ID, iterationIndex: 1, boundary: "iteration", checkpointSeq: 1,
        persistedMessageCount: prefix.length,
        prefixHash: computeCheckpointPrefixHashV3(prefix, prefix.length),
        checkpointVersion: 4, prefixHashVersion: 3, toolResultIntegrityVersion: 1,
        resumableState: { turnCount: 1, recoveryReentryCount: 0,
          maxOutputTokensRecoveryCount: 0, continuationNudgeCount: 0, stopHookBlockingCount: 0 },
      },
    } } },
  ] as RolloutItem[];
}

function stubSession() {
  const runTurn = vi.fn(async function* () {});
  const emit = vi.fn();
  const session = {
    config: { durableTurns: { resume: { requireLease: false } } },
    services: { registry: { tools: [] } },
    rolloutStore: { rootHasOnlyTerminalDescendants: () => true, appendRollout: vi.fn() },
    runTurn,
    emit,
    nextInternalSubId: () => "warning-skill-resume",
  } as unknown as Session;
  return { session, runTurn, emit };
}

describe("durable resume of a skill turn", () => {
  test("reconstruction hands the resume the skill record of the turn's latest context", () => {
    const withSkill = reconstruct(interruptedSkillTurn([turnContext(RECORD)]));
    expect(withSkill.resumableTurns).toEqual([
      expect.objectContaining({ turnId: TURN_ID, skillInvocation: RECORD }),
    ]);
    // A continuation that fell back to the session's settings journaled a
    // context without the skill: a later resume does not bring it back.
    const fellBack = reconstruct(
      interruptedSkillTurn([turnContext(RECORD), turnContext()]),
    );
    expect(fellBack.resumableTurns[0]).not.toHaveProperty("skillInvocation");
    expect(reconstruct(interruptedSkillTurn([turnContext()])).resumableTurns[0])
      .not.toHaveProperty("skillInvocation");
  });

  test("the resumed turn runs on the context rebuilt from the record", async () => {
    const { session, runTurn } = stubSession();
    const rebuilt = { subId: TURN_ID, skillInvocation: { name: "deep-review" } } as unknown as TurnContext;
    const resumeTurnContext = vi.fn(async () => rebuilt);
    const reconstruction = reconstruct(interruptedSkillTurn([turnContext(RECORD)]));

    await expect(resumeTurnFromCheckpoint(
      session, reconstruction, undefined, undefined, undefined, resumeTurnContext,
    )).resolves.toMatchObject({ resumed: true });

    expect(resumeTurnContext).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ turnId: TURN_ID, skillInvocation: RECORD }),
    );
    expect(runTurn).toHaveBeenCalledOnce();
    const options = runTurn.mock.calls[0]![1] as { ctx?: TurnContext; subId?: string; resume?: unknown };
    expect(options.ctx).toBe(rebuilt);
    expect(options).not.toHaveProperty("subId");
    expect(options.resume).toMatchObject({ turnId: TURN_ID });
  });

  test("when the record cannot be rebuilt the turn runs on the session's settings", async () => {
    const declined = stubSession();
    const reconstruction = reconstruct(interruptedSkillTurn([turnContext(RECORD)]));
    await expect(resumeTurnFromCheckpoint(
      declined.session, reconstruction, undefined, undefined, undefined, async () => undefined,
    )).resolves.toMatchObject({ resumed: true });
    expect(declined.runTurn.mock.calls[0]![1]).toMatchObject({ subId: TURN_ID });

    // A runtime with no way to rebuild it says so.
    const plain = stubSession();
    await expect(resumeTurnFromCheckpoint(
      plain.session, reconstruct(interruptedSkillTurn([turnContext(RECORD)])),
    )).resolves.toMatchObject({ resumed: true });
    expect(plain.runTurn.mock.calls[0]![1]).toMatchObject({ subId: TURN_ID });
    expect(plain.emit).toHaveBeenCalledWith(expect.objectContaining({
      msg: expect.objectContaining({ type: "warning", payload: expect.objectContaining({
        cause: "durable_resume_skill_settings_dropped",
      }) }),
    }));
  });

  test("a turn started without a skill resumes as before", async () => {
    const { session, runTurn } = stubSession();
    const resumeTurnContext = vi.fn(async () => undefined);
    await resumeTurnFromCheckpoint(
      session, reconstruct(interruptedSkillTurn([turnContext()])),
      undefined, undefined, undefined, resumeTurnContext,
    );
    expect(resumeTurnContext).not.toHaveBeenCalled();
    expect(runTurn.mock.calls[0]![1]).toMatchObject({ subId: TURN_ID });
  });
});
