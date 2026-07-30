import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  activeEditorProposalId,
  clearEditorProposalRecords,
  editorProposalRecord,
  editorProposalStoreRevision,
  markEditorProposalPending,
  proposalId,
  resolveEditorProposalRecord,
  stageContentFreeEditorProposalRecoveryRecord,
  stageEditorProposalRecord,
  stageUnavailableEditorProposalRecord,
  subscribeEditorProposalStore,
} from "../../../src/tui/workbench/editorProposalStore.js";
import type { BufferEditorProposal } from "../../../src/tui/workbench/buffer/providers/types.js";
import type { ScrollBoxHandle } from "../../../src/tui/ink/components/ScrollBox.js";
import {
  scrollEditorProposalPage,
  scrollEditorProposalToEdge,
} from "../../../src/tui/workbench/EditorProposalRail.js";

describe("editor proposal store", () => {
  beforeEach(() => {
    clearEditorProposalRecords();
  });

  test("tracks staged, pending, stale, and cleared proposal state", () => {
    const proposal = fixtureProposal();
    const id = proposalId(proposal);
    const listener = vi.fn();
    const unsubscribe = subscribeEditorProposalStore(listener);
    const initialRevision = editorProposalStoreRevision();

    expect(stageEditorProposalRecord(proposal)).toMatchObject({
      id,
      status: "staged",
    });
    expect(editorProposalStoreRevision()).toBe(initialRevision + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    markEditorProposalPending(id, "accepting");
    expect(editorProposalRecord(id)).toMatchObject({
      status: "accepting",
    });

    resolveEditorProposalRecord({
      ok: false,
      proposalId: id,
      stale: true,
      reason: "buffer changed after the proposal was created",
    });
    expect(editorProposalRecord(id)).toMatchObject({
      status: "stale",
      message: "buffer changed after the proposal was created",
    });

    clearEditorProposalRecords();
    expect(editorProposalRecord(id)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  test("drops accepted source content immediately", () => {
    const proposal = fixtureProposal();
    const id = proposalId(proposal);
    stageEditorProposalRecord(proposal);
    markEditorProposalPending(id, "accepting");
    resolveEditorProposalRecord({
      ok: true,
      action: "accepted",
      proposalId: id,
      changedtick: 18,
    });

    expect(editorProposalRecord(id)).toBeNull();
  });

  test("refuses new source records instead of evicting unresolved proposals", () => {
    for (let index = 0; index < 32; index += 1) {
      stageEditorProposalRecord(
        fixtureProposal({
          interaction_id: `interaction-${index}`,
        }),
      );
    }

    expect(() =>
      stageEditorProposalRecord(
        fixtureProposal({ interaction_id: "interaction-overflow" }),
      ),
    ).toThrow(/32 unresolved proposals/u);
    expect(editorProposalRecord("interaction-0:17")).not.toBeNull();
    expect(editorProposalRecord("interaction-31:17")).not.toBeNull();
    expect(editorProposalRecord("interaction-overflow:17")).toBeNull();
  });

  test("exposes only unresolved review state as the active proposal gate", () => {
    stageEditorProposalRecord(fixtureProposal({ interaction_id: "first" }));
    expect(activeEditorProposalId()).toBe("first:17");

    markEditorProposalPending("first:17", "rejecting");
    expect(activeEditorProposalId()).toBe("first:17");
    resolveEditorProposalRecord({
      ok: true,
      action: "rejected",
      proposalId: "first:17",
    });
    expect(activeEditorProposalId()).toBeNull();

    stageEditorProposalRecord(fixtureProposal({ interaction_id: "second" }));
    expect(activeEditorProposalId()).toBe("second:17");
  });

  test("keeps a local outcome awaiting daemon acknowledgement as the active gate", () => {
    stageEditorProposalRecord(
      fixtureProposal({ interaction_id: "pending-ack" }),
    );
    resolveEditorProposalRecord({
      ok: false,
      proposalId: "pending-ack:17",
      reason: "response lost",
      acknowledgementPending: true,
      acknowledgementAction: "reject",
    });

    expect(editorProposalRecord("pending-ack:17")).toMatchObject({
      status: "acknowledgement",
      acknowledgementAction: "reject",
    });
    expect(activeEditorProposalId()).toBe("pending-ack:17");
  });

  test("keeps a content-free recovered commitment review-gated without source bytes", () => {
    const discard = vi.fn(async () => ({
      ok: true as const,
      action: "rejected" as const,
      proposalId: "recovered-proposal",
    }));

    stageUnavailableEditorProposalRecord({
      id: "recovered-proposal",
      path: "/workspace/src/value.ts",
      sourceLabel: "Edit",
      baseContentSha256: "a".repeat(64),
      message: "The daemon restarted before the proposal could be inspected.",
      discard,
    });

    expect(editorProposalRecord("recovered-proposal")).toMatchObject({
      id: "recovered-proposal",
      status: "unavailable",
      reviewMode: "discard_only",
      proposal: {
        path: "/workspace/src/value.ts",
        edits: [],
      },
    });
    expect(
      JSON.stringify(editorProposalRecord("recovered-proposal")),
    ).not.toContain("old_text");
    expect(activeEditorProposalId()).toBe("recovered-proposal");

    resolveEditorProposalRecord({
      ok: false,
      proposalId: "recovered-proposal",
      reason: "daemon still reconnecting",
    });
    expect(activeEditorProposalId()).toBe("recovered-proposal");
  });

  test("offers content-free acceptance recovery only for an exact committed after hash", async () => {
    const id = "accepted-recovery";
    const acknowledge = vi.fn(async () => ({
      ok: true as const,
      action: "accepted" as const,
      proposalId: id,
      changedtick: 23,
    }));
    const discard = vi.fn(async () => ({
      ok: true as const,
      action: "rejected" as const,
      proposalId: id,
    }));

    const record = stageContentFreeEditorProposalRecoveryRecord({
      id,
      path: "/workspace/src/value.ts",
      sourceLabel: "Edit",
      baseContentSha256: "a".repeat(64),
      afterContentSha256: "b".repeat(64),
      baseChangedtick: 17,
      bufferHandle: 7,
      liveContentSha256: "b".repeat(64),
      acknowledge,
      discard,
    });

    expect(record).toMatchObject({
      id,
      status: "recovery",
      reviewMode: "acceptance_recovery",
      proposal: {
        path: "/workspace/src/value.ts",
        buffer_handle: 7,
        base_changedtick: 17,
        base_content_sha256: "a".repeat(64),
        edits: [],
      },
      recovery: {
        kind: "content_free_acceptance",
        afterContentSha256: "b".repeat(64),
        liveContentSha256: "b".repeat(64),
      },
    });
    expect(JSON.stringify(record)).not.toContain("old_text");
    expect(JSON.stringify(record)).not.toContain("new_text");
    expect(activeEditorProposalId()).toBe(id);

    await expect(record.resolve?.("accept")).resolves.toMatchObject({
      ok: true,
      action: "accepted",
    });
    await expect(record.resolve?.("reject")).resolves.toMatchObject({
      ok: true,
      action: "rejected",
    });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  test("falls back to discard-only recovery when the live buffer does not match", async () => {
    const id = "mismatched-recovery";
    const acknowledge = vi.fn();
    const discard = vi.fn(async () => ({
      ok: true as const,
      action: "rejected" as const,
      proposalId: id,
    }));

    const record = stageContentFreeEditorProposalRecoveryRecord({
      id,
      path: "/workspace/src/value.ts",
      sourceLabel: "Edit",
      baseContentSha256: "a".repeat(64),
      afterContentSha256: "b".repeat(64),
      baseChangedtick: 17,
      bufferHandle: 7,
      liveContentSha256: "c".repeat(64),
      acknowledge,
      discard,
    });

    expect(record).toMatchObject({
      status: "unavailable",
      reviewMode: "discard_only",
      proposal: { edits: [] },
    });
    await expect(record.resolve?.("accept")).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("only be discarded"),
    });
    expect(acknowledge).not.toHaveBeenCalled();
    await record.resolve?.("reject");
    expect(discard).toHaveBeenCalledTimes(1);
  });

  test("keeps acceptance recovery gated through acknowledgement and error retries", () => {
    const id = "retry-recovery";
    stageContentFreeEditorProposalRecoveryRecord({
      id,
      path: "/workspace/src/value.ts",
      sourceLabel: "Edit",
      baseContentSha256: "a".repeat(64),
      afterContentSha256: "b".repeat(64),
      baseChangedtick: 17,
      bufferHandle: 7,
      liveContentSha256: "b".repeat(64),
      acknowledge: vi.fn(),
      discard: vi.fn(),
    });

    resolveEditorProposalRecord({
      ok: false,
      proposalId: id,
      reason: "accept response lost",
      acknowledgementPending: true,
      acknowledgementAction: "accept",
    });
    expect(editorProposalRecord(id)).toMatchObject({
      status: "acknowledgement",
      acknowledgementAction: "accept",
    });
    expect(activeEditorProposalId()).toBe(id);

    resolveEditorProposalRecord({
      ok: false,
      proposalId: id,
      reason: "daemon still unavailable",
    });
    expect(editorProposalRecord(id)).toMatchObject({
      status: "error",
      message: "daemon still unavailable",
    });
    expect(activeEditorProposalId()).toBe(id);
  });

  test("keeps a workspace-backed proposal active after a non-stale error", () => {
    const proposal = fixtureProposal({
      interaction_id: "workspace-backed-error",
    });
    const id = proposalId(proposal);
    stageEditorProposalRecord(proposal, vi.fn(), vi.fn());
    resolveEditorProposalRecord({
      ok: false,
      proposalId: id,
      reason: "daemon acknowledgement is temporarily unavailable",
    });

    expect(editorProposalRecord(id)).toMatchObject({ status: "error" });
    expect(editorProposalRecord(id)?.staleDiscardActive).not.toBe(true);
    expect(activeEditorProposalId()).toBe(id);
  });

  test("keeps a direct model proposal gated until the editor positively reports its shadow stale", () => {
    const proposal = fixtureProposal({
      interaction_id: "direct-model-error",
    });
    const id = proposalId(proposal);
    stageEditorProposalRecord(proposal);
    markEditorProposalPending(id, "accepting");
    resolveEditorProposalRecord({
      ok: false,
      proposalId: id,
      reason: "editor response was lost",
    });

    expect(editorProposalRecord(id)).toMatchObject({
      status: "error",
      message: "editor response was lost",
    });
    expect(activeEditorProposalId()).toBe(id);

    markEditorProposalPending(id, "accepting");
    resolveEditorProposalRecord({
      ok: false,
      proposalId: id,
      stale: true,
      reason: "proposal is no longer active",
    });

    expect(editorProposalRecord(id)).toMatchObject({
      status: "stale",
      message: "proposal is no longer active",
    });
    expect(activeEditorProposalId()).toBeNull();
  });

  test("pages and jumps within the focused proposal preview", () => {
    const scrollTo = vi.fn();
    const handle = {
      scrollTo,
      getScrollTop: () => 10,
      getPendingDelta: () => 2,
      getScrollHeight: () => 100,
      getViewportHeight: () => 20,
    } as unknown as ScrollBoxHandle;

    scrollEditorProposalPage(handle, "down");
    scrollEditorProposalPage(handle, "up");
    scrollEditorProposalToEdge(handle, "bottom");
    scrollEditorProposalToEdge(handle, "top");

    expect(scrollTo.mock.calls).toEqual([[22], [2], [80], [0]]);
    expect(scrollEditorProposalPage(null, "down")).toBe(false);
    expect(scrollEditorProposalToEdge(null, "bottom")).toBe(false);
  });
});

function fixtureProposal(
  overrides: Partial<BufferEditorProposal> = {},
): BufferEditorProposal {
  return {
    version: 1,
    interaction_id: "interaction-1",
    path: "/workspace/src/value.ts",
    buffer_handle: 7,
    base_changedtick: 17,
    base_content_sha256: "a".repeat(64),
    summary: "Replace the value",
    edits: [
      {
        id: "edit-1",
        start_line: 1,
        start_column: 0,
        end_line: 1,
        end_column: 5,
        old_text: "value",
        new_text: "answer",
      },
    ],
    ...overrides,
  };
}
