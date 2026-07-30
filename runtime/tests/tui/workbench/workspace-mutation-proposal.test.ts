import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  adoptWorkspaceMutationProposalLocalOutcome,
  editorProposalFromWorkspaceMutation,
  workspaceMutationProposalFromChange,
  workspaceMutationProposalFromTuiEvent,
  workspaceMutationReferenceMatchesCommitment,
  workspaceMutationReferenceMatchesProposal,
  workspaceMutationReferenceMatchesTerminalStatus,
  workspaceMutationTerminalResolutionAction,
  workspaceMutationTerminalStatusMatchesLocalOutcome,
  type WorkspaceMutationProposalLocalOutcome,
} from "../../../src/tui/workbench/workspaceMutationProposal.js";
import type { WorkspaceEditorProposalResult } from "../../../src/app-server/protocol/index.js";

describe("workspace mutation proposal UI bridge", () => {
  test("extracts only content-free dirty-buffer proposal events", () => {
    const event = {
      type: "tool_call_completed",
      payload: {
        isError: true,
        result: "review in Editor",
        metadata: {
          workspaceMutation: {
            kind: "editor_proposal",
            proposalId: "proposal-1",
            workspaceRoot: "/workspace",
            path: "/workspace/src/value.ts",
            source: "file_edit",
            baseContentSha256: "a".repeat(64),
            afterContentSha256: "b".repeat(64),
            baseChangedtick: 17,
            bufferHandle: 7,
          },
        },
      },
    };

    expect(workspaceMutationProposalFromTuiEvent(event)).toEqual({
      proposalId: "proposal-1",
      workspaceRoot: "/workspace",
      path: "/workspace/src/value.ts",
      source: "file_edit",
      baseContentSha256: "a".repeat(64),
      afterContentSha256: "b".repeat(64),
      baseChangedtick: 17,
      bufferHandle: 7,
    });
    expect(
      workspaceMutationProposalFromTuiEvent({
        ...event,
        payload: { ...event.payload, isError: false },
      }),
    ).toBeNull();
    expect(
      workspaceMutationProposalFromTuiEvent({
        ...event,
        payload: {
          ...event.payload,
          metadata: {
            workspaceMutation: {
              ...event.payload.metadata.workspaceMutation,
              afterContentSha256: undefined,
            },
          },
        },
      }),
    ).toBeNull();
    expect(JSON.stringify(event)).not.toContain("const value");
  });

  test("turns exact daemon source into a revision-bound whole-buffer shadow edit", () => {
    const proposal = fixtureProposal();
    const reference = workspaceMutationProposalFromTuiEvent({
      type: "tool_call_completed",
      payload: {
        isError: true,
        metadata: {
          workspaceMutation: {
            kind: "editor_proposal",
            proposalId: proposal.proposalId,
            workspaceRoot: proposal.workspaceRoot,
            path: proposal.path,
            source: proposal.source,
            baseContentSha256: proposal.baseContentSha256,
            afterContentSha256: createHash("sha256")
              .update(proposal.afterText, "utf8")
              .digest("hex"),
            baseChangedtick: proposal.baseChangedtick,
            bufferHandle: proposal.bufferHandle,
          },
        },
      },
    });
    expect(reference).not.toBeNull();
    expect(
      workspaceMutationReferenceMatchesProposal(reference!, proposal),
    ).toBe(true);

    expect(editorProposalFromWorkspaceMutation(proposal)).toEqual({
      version: 1,
      interaction_id: "workspace-mutation:proposal-1",
      path: "/workspace/src/value.ts",
      buffer_handle: 7,
      base_changedtick: 17,
      base_content_sha256: "a".repeat(64),
      base_end_of_line: true,
      new_end_of_line: false,
      summary: "Edit requested by Agent",
      edits: [
        {
          id: "workspace-mutation:proposal-1",
          start_line: 1,
          start_column: 0,
          end_line: 2,
          end_column: 14,
          old_text: "const π = 1;\nexport { π };",
          new_text: "const π = 2;\nexport { π };",
        },
      ],
    });
  });

  test("recovers a content-free durable proposal reference and verifies its replacement hash", () => {
    const proposal = fixtureProposal();
    const reference = workspaceMutationProposalFromChange({
      sequence: 4,
      timestamp: "2026-07-29T00:00:00.000Z",
      workspaceRoot: proposal.workspaceRoot,
      path: proposal.path,
      source: proposal.source,
      status: "proposed",
      beforeSha256: proposal.baseContentSha256,
      afterSha256:
        "ab995617a7244bf1d9a14152ee64a002b9b6ef7b17b60070594fe9d2e2161e6b",
      proposalId: proposal.proposalId,
    });

    expect(reference).toEqual({
      proposalId: proposal.proposalId,
      workspaceRoot: proposal.workspaceRoot,
      path: proposal.path,
      source: proposal.source,
      baseContentSha256: proposal.baseContentSha256,
      afterContentSha256:
        "ab995617a7244bf1d9a14152ee64a002b9b6ef7b17b60070594fe9d2e2161e6b",
    });
    expect(
      workspaceMutationReferenceMatchesProposal(reference!, proposal),
    ).toBe(true);
    expect(
      workspaceMutationReferenceMatchesProposal(reference!, {
        ...proposal,
        afterText: "a different replacement",
      }),
    ).toBe(false);
    expect(
      workspaceMutationProposalFromChange({
        sequence: 5,
        timestamp: "2026-07-29T00:00:01.000Z",
        workspaceRoot: proposal.workspaceRoot,
        path: proposal.path,
        source: proposal.source,
        status: "proposed",
        beforeSha256: proposal.baseContentSha256,
        proposalId: proposal.proposalId,
      }),
    ).toBeNull();
  });

  test("accepts only terminal receipts bound to the announced path and applied revision", () => {
    const reference = {
      proposalId: "proposal-1",
      workspaceRoot: "/workspace",
      path: "/workspace/src/value.ts",
      source: "file_edit",
      baseContentSha256: "a".repeat(64),
      afterContentSha256: "b".repeat(64),
      baseChangedtick: 17,
      bufferHandle: 7,
    };
    const applied = {
      status: "applied" as const,
      proposalId: reference.proposalId,
      path: reference.path,
      changedtick: 18,
      contentSha256: reference.afterContentSha256,
    };
    const discarded = {
      status: "discarded" as const,
      proposalId: reference.proposalId,
      path: reference.path,
    };

    expect(
      workspaceMutationReferenceMatchesTerminalStatus(reference, applied),
    ).toBe(true);
    expect(
      workspaceMutationReferenceMatchesTerminalStatus(reference, discarded),
    ).toBe(true);
    expect(
      workspaceMutationReferenceMatchesTerminalStatus(reference, {
        ...applied,
        path: "/workspace/src/other.ts",
      }),
    ).toBe(false);
    expect(
      workspaceMutationReferenceMatchesTerminalStatus(reference, {
        ...applied,
        contentSha256: "c".repeat(64),
      }),
    ).toBe(false);
    expect(
      workspaceMutationReferenceMatchesTerminalStatus(reference, {
        ...applied,
        changedtick: reference.baseChangedtick,
      }),
    ).toBe(false);
    const {
      baseChangedtick: _baseChangedtick,
      bufferHandle: _bufferHandle,
      ...durableReference
    } = reference;
    expect(
      workspaceMutationReferenceMatchesTerminalStatus(durableReference, {
        ...applied,
        changedtick: 0,
      }),
    ).toBe(false);
    expect(
      workspaceMutationReferenceMatchesTerminalStatus(
        {
          ...reference,
          afterContentSha256: undefined as unknown as string,
        },
        applied,
      ),
    ).toBe(false);
    expect(
      workspaceMutationReferenceMatchesTerminalStatus(reference, {
        ...discarded,
        path: "/workspace/src/other.ts",
      }),
    ).toBe(false);
  });

  test("binds a durable commitment to every stable announced field", () => {
    const reference = {
      proposalId: "proposal-1",
      workspaceRoot: "/workspace",
      path: "/workspace/src/value.ts",
      source: "file_edit",
      baseContentSha256: "a".repeat(64),
      afterContentSha256: "b".repeat(64),
      baseChangedtick: 17,
      bufferHandle: 7,
    };
    const commitment = {
      status: "committed" as const,
      proposalId: reference.proposalId,
      path: reference.path,
      source: reference.source,
      baseContentSha256: reference.baseContentSha256,
      afterContentSha256: reference.afterContentSha256,
      baseChangedtick: reference.baseChangedtick,
      bufferHandle: reference.bufferHandle,
    };

    expect(
      workspaceMutationReferenceMatchesCommitment(reference, commitment),
    ).toBe(true);
    expect(
      workspaceMutationReferenceMatchesCommitment(reference, {
        ...commitment,
        source: "file_write",
      }),
    ).toBe(false);
    expect(
      workspaceMutationReferenceMatchesCommitment(reference, {
        ...commitment,
        afterContentSha256: "c".repeat(64),
      }),
    ).toBe(false);
  });

  test("retains the first local outcome across opposite acknowledgement retries", () => {
    const proposal = fixtureProposal();
    const accepted: WorkspaceMutationProposalLocalOutcome = {
      action: "accept",
      result: {
        ok: true,
        action: "accepted",
        proposalId: "workspace-mutation:proposal-1:17",
        changedtick: 18,
      },
      proposal,
    };
    const rejected: WorkspaceMutationProposalLocalOutcome = {
      action: "reject",
      result: {
        ok: true,
        action: "rejected",
        proposalId: "workspace-mutation:proposal-1:17",
      },
    };

    const acceptedFirst = new Map<
      string,
      WorkspaceMutationProposalLocalOutcome
    >();
    expect(
      adoptWorkspaceMutationProposalLocalOutcome(
        acceptedFirst,
        proposal.proposalId,
        accepted,
      ),
    ).toBe(accepted);
    expect(
      adoptWorkspaceMutationProposalLocalOutcome(
        acceptedFirst,
        proposal.proposalId,
        rejected,
      ),
    ).toBe(accepted);
    expect(acceptedFirst.get(proposal.proposalId)).toBe(accepted);
    expect(
      workspaceMutationTerminalResolutionAction(
        "missing",
        acceptedFirst.get(proposal.proposalId)?.action,
      ),
    ).toBe("accepted");
    expect(
      workspaceMutationTerminalStatusMatchesLocalOutcome(
        "discarded",
        acceptedFirst.get(proposal.proposalId)?.action,
      ),
    ).toBe(false);

    const rejectedFirst = new Map<
      string,
      WorkspaceMutationProposalLocalOutcome
    >();
    expect(
      adoptWorkspaceMutationProposalLocalOutcome(
        rejectedFirst,
        proposal.proposalId,
        rejected,
      ),
    ).toBe(rejected);
    expect(
      adoptWorkspaceMutationProposalLocalOutcome(
        rejectedFirst,
        proposal.proposalId,
        accepted,
      ),
    ).toBe(rejected);
    expect(rejectedFirst.get(proposal.proposalId)).toBe(rejected);
    expect(
      workspaceMutationTerminalResolutionAction(
        "missing",
        rejectedFirst.get(proposal.proposalId)?.action,
      ),
    ).toBe("rejected");
    expect(
      workspaceMutationTerminalStatusMatchesLocalOutcome(
        "applied",
        rejectedFirst.get(proposal.proposalId)?.action,
      ),
    ).toBe(false);
  });
});

function fixtureProposal(): WorkspaceEditorProposalResult {
  return {
    proposalId: "proposal-1",
    workspaceRoot: "/workspace",
    path: "/workspace/src/value.ts",
    beforeText: "const π = 1;\nexport { π };\n",
    afterText: "const π = 2;\nexport { π };",
    baseContentSha256: "a".repeat(64),
    baseChangedtick: 17,
    bufferHandle: 7,
    source: "file_edit",
  };
}
