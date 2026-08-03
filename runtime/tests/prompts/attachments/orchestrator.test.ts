/**
 * Foundation tests for the per-turn attachments orchestrator. The
 * registry is empty at landing time; these tests pin the contract that
 * subsequent producer additions must honor.
 */
import { describe, expect, test } from "vitest";

import {
  _resetAttachmentTrackingStateForTest,
  getAttachmentTrackingState,
} from "../../session/attachment-state.js";
import {
  __INTERNAL,
  type GetAttachmentsOptions,
  getAttachments,
} from "./orchestrator.js";

function makeOpts(
  partial?: Partial<GetAttachmentsOptions>,
): GetAttachmentsOptions {
  return {
    sessionKey: {},
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: {
      mode: "default",
    } as never,
    cwd: "/tmp/agenc-orchestrator-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
    ...partial,
  };
}

describe("attachments orchestrator", () => {
  test("keeps the Editor local-read-only producer surface explicit", () => {
    expect(__INTERNAL.ordinaryProducerNames).toEqual([
      "planModeProducer",
      "verifyPlanReminderProducer",
      "autoModeProducer",
      "swarmModeProducer",
      "deferredToolsDeltaProducer",
      "agentListingDeltaProducer",
      "mcpInstructionsDeltaProducer",
      "dateChangeProducer",
      "criticalReminderProducer",
      "outputStyleProducer",
      "relevantMemoriesProducer",
      "changedFilesProducer",
      "lspDiagnosticsProducer",
      "agentMentionsProducer",
      "mcpResourcesProducer",
      "fileMentionsProducer",
      "skillListingProducer",
    ]);
    expect(__INTERNAL.localReadOnlyProducerNames).toEqual([]);
  });

  test("returns an empty list with no producers registered", async () => {
    const opts = makeOpts();
    const out = await getAttachments(opts);
    expect(out).toEqual([]);
    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("does not throw on a fresh AbortSignal", async () => {
    const opts = makeOpts();
    await expect(getAttachments(opts)).resolves.not.toThrow();
    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("propagates the original reason when attachment collection is aborted", async () => {
    const ac = new AbortController();
    const reason = new Error("cancel attachment collection");
    ac.abort(reason);
    const opts = makeOpts({ signal: ac.signal });
    await expect(getAttachments(opts)).rejects.toBe(reason);
    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("isolates tracking state across distinct session keys", async () => {
    const sessionA = {};
    const sessionB = {};
    await getAttachments(makeOpts({ sessionKey: sessionA }));
    await getAttachments(makeOpts({ sessionKey: sessionB }));

    // Distinct session keys must resolve to distinct tracking-state objects:
    // no shared/aliased state across keys (the WeakMap must not collapse
    // separate sessions onto one shared object).
    const stateA = getAttachmentTrackingState(sessionA);
    const stateB = getAttachmentTrackingState(sessionB);
    expect(stateA).not.toBe(stateB);
    expect(stateA.nestedMemoryAttachmentTriggers).not.toBe(
      stateB.nestedMemoryAttachmentTriggers,
    );

    // Mutating A's state must not leak into B's state.
    stateA.needsPlanModeExitAttachment = true;
    stateA.memoryMode = "disabled";
    stateA.nestedMemoryAttachmentTriggers.add("/a/path");
    expect(stateB.needsPlanModeExitAttachment).toBe(false);
    expect(stateB.memoryMode).toBe("enabled");
    expect(stateB.nestedMemoryAttachmentTriggers.has("/a/path")).toBe(false);

    // Resetting A must not affect B's already-observed state: stateB stays
    // the same instance and keeps its untouched defaults.
    _resetAttachmentTrackingStateForTest(sessionA);
    expect(stateB).toBe(getAttachmentTrackingState(sessionB));
    expect(stateB.needsPlanModeExitAttachment).toBe(false);
    expect(stateB.memoryMode).toBe("enabled");

    // A fresh read of A after reset yields a clean object — A's earlier
    // mutations are gone (proves the reset actually cleared A's entry).
    const stateAReborn = getAttachmentTrackingState(sessionA);
    expect(stateAReborn).not.toBe(stateA);
    expect(stateAReborn.needsPlanModeExitAttachment).toBe(false);
    expect(stateAReborn.memoryMode).toBe("enabled");
    expect(stateAReborn.nestedMemoryAttachmentTriggers.has("/a/path")).toBe(
      false,
    );

    _resetAttachmentTrackingStateForTest(sessionA);
    _resetAttachmentTrackingStateForTest(sessionB);
  });
});
