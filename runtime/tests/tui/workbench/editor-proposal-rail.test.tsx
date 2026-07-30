import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const proposalRailHarness = vi.hoisted(() => ({
  keybindingCalls: [] as Array<{
    handlers: Record<string, () => void>;
    options?: Record<string, unknown>;
  }>,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: (
    handlers: Record<string, () => void>,
    options?: Record<string, unknown>,
  ) => {
    proposalRailHarness.keybindingCalls.push({ handlers, options });
  },
}));

import {
  AppStateProvider,
  getDefaultAppState,
  type AppState,
} from "../../../src/tui/state/AppState.js";
import { EditorProposalRail } from "../../../src/tui/workbench/EditorProposalRail.js";
import {
  activeEditorProposalId,
  clearEditorProposalRecords,
  editorProposalRecord,
  markEditorProposalPending,
  proposalId,
  resolveEditorProposalRecord,
  stageContentFreeEditorProposalRecoveryRecord,
  stageEditorProposalRecord,
  stageUnavailableEditorProposalRecord,
} from "../../../src/tui/workbench/editorProposalStore.js";
import { workbenchReducer } from "../../../src/tui/workbench/reducer.js";
import type {
  BufferEditorProposal,
  BufferEditorProposalResolution,
} from "../../../src/tui/workbench/buffer/providers/types.js";
import { renderToString } from "../../../src/utils/staticRender.js";

describe("EditorProposalRail", () => {
  beforeEach(() => {
    proposalRailHarness.keybindingCalls = [];
    clearEditorProposalRecords();
  });

  test("dismisses a stale proposal locally when reject or close can no longer reach its shadow", async () => {
    const proposal = fixtureProposal();
    const id = proposalId(proposal);
    const resolve =
      vi.fn<
        (action: "accept" | "reject") => Promise<BufferEditorProposalResolution>
      >();
    stageEditorProposalRecord(proposal, resolve);
    markEditorProposalPending(id, "accepting");
    resolveEditorProposalRecord({
      ok: false,
      proposalId: id,
      stale: true,
      reason: "buffer changed after the proposal was created",
    });
    const changes: AppState[] = [];

    await renderToString(
      <AppStateProvider
        initialState={editorProposalState(id)}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <EditorProposalRail proposalId={id} focused={true} />
      </AppStateProvider>,
      100,
    );

    const handlers = proposalRailHarness.keybindingCalls.find(
      (call) => call.options?.context === "Surface",
    )?.handlers;
    handlers?.["surface:reject"]?.();

    expect(resolve).not.toHaveBeenCalled();
    expect(editorProposalRecord(id)).toBeNull();
    expect(changes.at(-1)?.workbench).toMatchObject({
      rail: null,
      editorRail: null,
      focusedPane: "surface",
      editorFocusedPane: "surface",
    });
  });

  test("retries a transient direct-model resolution error before allowing deliberate stale dismissal", async () => {
    const proposal = fixtureProposal({
      interaction_id: "direct-model-retry",
    });
    const id = proposalId(proposal);
    const resolve =
      vi.fn<
        (action: "accept" | "reject") => Promise<BufferEditorProposalResolution>
      >();
    resolve
      .mockRejectedValueOnce(new Error("editor transport disconnected"))
      .mockResolvedValueOnce({
        ok: false,
        proposalId: id,
        stale: true,
        reason: "proposal is no longer active",
      });
    stageEditorProposalRecord(proposal, resolve);

    await renderToString(
      <AppStateProvider initialState={editorProposalState(id)}>
        <EditorProposalRail proposalId={id} focused={true} />
      </AppStateProvider>,
      100,
    );
    latestSurfaceHandlers()["surface:accept"]?.();
    await vi.waitFor(() =>
      expect(editorProposalRecord(id)).toMatchObject({
        status: "error",
        message: "editor transport disconnected",
      }),
    );
    expect(activeEditorProposalId()).toBe(id);

    proposalRailHarness.keybindingCalls = [];
    const retryOutput = await renderToString(
      <AppStateProvider initialState={editorProposalState(id)}>
        <EditorProposalRail proposalId={id} focused={true} />
      </AppStateProvider>,
      100,
    );
    expect(retryOutput).toContain("editor transport disconnected");
    latestSurfaceHandlers()["surface:accept"]?.();
    await vi.waitFor(() =>
      expect(editorProposalRecord(id)).toMatchObject({
        status: "stale",
        message: "proposal is no longer active",
      }),
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(activeEditorProposalId()).toBeNull();

    proposalRailHarness.keybindingCalls = [];
    await renderToString(
      <AppStateProvider initialState={editorProposalState(id)}>
        <EditorProposalRail proposalId={id} focused={true} />
      </AppStateProvider>,
      100,
    );
    latestSurfaceHandlers()["surface:reject"]?.();

    expect(editorProposalRecord(id)).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  test("does not locally dismiss a review outcome that still requires daemon acknowledgement", async () => {
    const proposal = fixtureProposal({ interaction_id: "pending-ack" });
    const id = proposalId(proposal);
    const pending: BufferEditorProposalResolution = {
      ok: false,
      proposalId: id,
      reason: "discard response lost",
      acknowledgementPending: true,
      acknowledgementAction: "reject",
    };
    const resolve = vi.fn(async () => pending);
    stageEditorProposalRecord(proposal, resolve);
    resolveEditorProposalRecord(pending);

    await renderToString(
      <AppStateProvider initialState={editorProposalState(id)}>
        <EditorProposalRail proposalId={id} focused={true} />
      </AppStateProvider>,
      100,
    );

    const handlers = proposalRailHarness.keybindingCalls.find(
      (call) => call.options?.context === "Surface",
    )?.handlers;
    handlers?.["workbench:closeSurface"]?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(resolve).toHaveBeenCalledWith("reject");
    expect(editorProposalRecord(id)).toMatchObject({
      status: "acknowledgement",
      acknowledgementAction: "reject",
    });
  });

  test("explicitly discards a stale workspace-backed proposal instead of dismissing it locally", async () => {
    const proposal = fixtureProposal({
      interaction_id: "workspace-mutation:durable-proposal",
    });
    const id = proposalId(proposal);
    const resolve = vi.fn();
    const discardStale = vi
      .fn()
      .mockRejectedValueOnce(new Error("discard response lost"))
      .mockResolvedValueOnce({
        ok: true as const,
        action: "rejected" as const,
        proposalId: id,
      });
    stageEditorProposalRecord(proposal, resolve, discardStale);
    markEditorProposalPending(id, "accepting");
    resolveEditorProposalRecord({
      ok: false,
      proposalId: id,
      stale: true,
      reason: "buffer changed after the proposal was created",
    });

    const output = await renderToString(
      <AppStateProvider initialState={editorProposalState(id)}>
        <EditorProposalRail proposalId={id} focused={true} />
      </AppStateProvider>,
      100,
    );
    expect(output).toContain("discard commitment");
    expect(activeEditorProposalId()).toBe(id);
    latestSurfaceHandlers()["surface:reject"]?.();

    await vi.waitFor(() =>
      expect(editorProposalRecord(id)).toMatchObject({
        status: "error",
        staleDiscardActive: true,
      }),
    );
    expect(activeEditorProposalId()).toBe(id);
    proposalRailHarness.keybindingCalls = [];
    await renderToString(
      <AppStateProvider initialState={editorProposalState(id)}>
        <EditorProposalRail proposalId={id} focused={true} />
      </AppStateProvider>,
      100,
    );
    latestSurfaceHandlers()["surface:reject"]?.();
    await vi.waitFor(() => expect(discardStale).toHaveBeenCalledTimes(2));
    expect(resolve).not.toHaveBeenCalled();
    expect(editorProposalRecord(id)).toBeNull();
  });

  test("closes a rail whose proposal record is already gone", async () => {
    const missingId = "missing-proposal:17";
    const changes: AppState[] = [];

    const output = await renderToString(
      <AppStateProvider
        initialState={editorProposalState(missingId)}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <EditorProposalRail proposalId={missingId} focused={true} />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("proposal is no longer available");
    const handlers = proposalRailHarness.keybindingCalls.find(
      (call) => call.options?.context === "Surface",
    )?.handlers;
    handlers?.["surface:reject"]?.();

    expect(changes.at(-1)?.workbench).toMatchObject({
      rail: null,
      editorRail: null,
      focusedPane: "surface",
      editorFocusedPane: "surface",
    });
  });

  test("requires an explicit discard for a content-free recovered proposal", async () => {
    const id = "recovered-workspace-proposal";
    const discard = vi.fn(async () => ({
      ok: true as const,
      action: "rejected" as const,
      proposalId: id,
    }));
    stageUnavailableEditorProposalRecord({
      id,
      path: "/workspace/src/value.ts",
      sourceLabel: "Edit",
      baseContentSha256: "a".repeat(64),
      message: "The daemon restarted before the source could be inspected.",
      discard,
    });
    const changes: AppState[] = [];

    const output = await renderToString(
      <AppStateProvider
        initialState={editorProposalState(id)}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <EditorProposalRail proposalId={id} focused={true} />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("content-free safety commitment");
    expect(output).toContain("explicitly discard");
    expect(output).not.toContain("old_text");
    const handlers = proposalRailHarness.keybindingCalls.find(
      (call) => call.options?.context === "Surface",
    )?.handlers;
    handlers?.["surface:accept"]?.();
    await Promise.resolve();
    expect(discard).not.toHaveBeenCalled();

    handlers?.["surface:reject"]?.();
    await vi.waitFor(() => expect(discard).toHaveBeenCalledTimes(1));
    expect(editorProposalRecord(id)).toBeNull();
    expect(changes.at(-1)?.workbench).toMatchObject({
      rail: null,
      editorRail: null,
      focusedPane: "surface",
      editorFocusedPane: "surface",
    });
  });

  test.each([
    ["surface:accept", "y"],
    ["surface:open", "enter"],
  ] as const)(
    "lets %s (%s) finish content-free acceptance acknowledgement",
    async (binding) => {
      const id = `acceptance-recovery:${binding}`;
      const acknowledge = vi.fn(async () => ({
        ok: true as const,
        action: "accepted" as const,
        proposalId: id,
        changedtick: 23,
      }));
      const discard = vi.fn();
      stageAcceptanceRecovery({ id, acknowledge, discard });
      const changes: AppState[] = [];

      const output = await renderToString(
        <AppStateProvider
          initialState={editorProposalState(id)}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <EditorProposalRail proposalId={id} focused={true} />
        </AppStateProvider>,
        100,
      );

      const normalizedOutput = normalizeRenderedOutput(output);
      expect(normalizedOutput).toContain("EDITOR PROPOSAL RECOVERY");
      expect(normalizedOutput).toContain("no before/after preview is shown");
      expect(normalizedOutput).toContain("live buffer exactly matches");
      expect(normalizedOutput).toContain(
        "Accept finishes daemon acknowledgement",
      );
      expect(normalizedOutput).toContain(
        "Reject/discard removes only the commitment and does not revert",
      );
      latestSurfaceHandlers()[binding]?.();

      await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(1));
      expect(discard).not.toHaveBeenCalled();
      expect(editorProposalRecord(id)).toBeNull();
      expect(changes.at(-1)?.workbench).toMatchObject({
        rail: null,
        editorRail: null,
        focusedPane: "surface",
        editorFocusedPane: "surface",
      });
    },
  );

  test.each([
    ["surface:reject", "n"],
    ["workbench:closeSurface", "q"],
  ] as const)(
    "lets %s (%s) discard only the recovered commitment",
    async (binding) => {
      const id = `discard-recovery:${binding}`;
      const liveBufferBytes = "const value = 2;\n";
      const acknowledge = vi.fn();
      const discard = vi.fn(async () => ({
        ok: true as const,
        action: "rejected" as const,
        proposalId: id,
      }));
      stageAcceptanceRecovery({ id, acknowledge, discard });

      await renderToString(
        <AppStateProvider initialState={editorProposalState(id)}>
          <EditorProposalRail proposalId={id} focused={true} />
        </AppStateProvider>,
        100,
      );
      latestSurfaceHandlers()[binding]?.();

      await vi.waitFor(() => expect(discard).toHaveBeenCalledTimes(1));
      expect(acknowledge).not.toHaveBeenCalled();
      expect(liveBufferBytes).toBe("const value = 2;\n");
      expect(editorProposalRecord(id)).toBeNull();
    },
  );

  test("preserves acknowledgement and error retry behavior during acceptance recovery", async () => {
    const id = "acceptance-recovery-retry";
    const acknowledge = vi.fn<() => Promise<BufferEditorProposalResolution>>();
    acknowledge
      .mockResolvedValueOnce({
        ok: false,
        proposalId: id,
        reason: "accept response lost",
        acknowledgementPending: true,
        acknowledgementAction: "accept",
      })
      .mockRejectedValueOnce(new Error("daemon still unavailable"))
      .mockResolvedValueOnce({
        ok: true,
        action: "accepted",
        proposalId: id,
        changedtick: 23,
      });
    stageAcceptanceRecovery({
      id,
      acknowledge,
      discard: vi.fn(),
    });

    await renderAcceptanceRecovery(id);
    latestSurfaceHandlers()["surface:accept"]?.();
    await vi.waitFor(() =>
      expect(editorProposalRecord(id)).toMatchObject({
        status: "acknowledgement",
        acknowledgementAction: "accept",
      }),
    );

    proposalRailHarness.keybindingCalls = [];
    const acknowledgementOutput = await renderAcceptanceRecovery(id);
    expect(acknowledgementOutput).toContain("accept response lost");
    expect(acknowledgementOutput).toContain("retry apply acknowledgement");
    latestSurfaceHandlers()["surface:open"]?.();
    await vi.waitFor(() =>
      expect(editorProposalRecord(id)).toMatchObject({
        status: "error",
        message: "daemon still unavailable",
      }),
    );

    proposalRailHarness.keybindingCalls = [];
    const errorOutput = await renderAcceptanceRecovery(id);
    expect(errorOutput).toContain("daemon still unavailable");
    expect(errorOutput).toContain("retry acknowledgement");
    latestSurfaceHandlers()["surface:accept"]?.();

    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(3));
    expect(editorProposalRecord(id)).toBeNull();
  });

  test("keeps a stale acceptance recovery review-gated and explicitly discardable", async () => {
    const id = "acceptance-recovery-stale";
    const acknowledge = vi.fn(async () => ({
      ok: false as const,
      proposalId: id,
      reason: "live buffer changed while reviewing",
      stale: true,
    }));
    const discard = vi.fn(async () => ({
      ok: true as const,
      action: "rejected" as const,
      proposalId: id,
    }));
    stageAcceptanceRecovery({ id, acknowledge, discard });

    await renderAcceptanceRecovery(id);
    latestSurfaceHandlers()["surface:accept"]?.();
    await vi.waitFor(() =>
      expect(editorProposalRecord(id)).toMatchObject({
        status: "stale",
        reviewMode: "acceptance_recovery",
      }),
    );
    expect(activeEditorProposalId()).toBe(id);

    proposalRailHarness.keybindingCalls = [];
    const staleOutput = await renderAcceptanceRecovery(id);
    expect(staleOutput).toContain("live buffer changed while reviewing");
    latestSurfaceHandlers()["surface:reject"]?.();
    await vi.waitFor(() => expect(discard).toHaveBeenCalledTimes(1));
    expect(editorProposalRecord(id)).toBeNull();
  });
});

function latestSurfaceHandlers(): Record<string, () => void> {
  const handlers = proposalRailHarness.keybindingCalls
    .filter((call) => call.options?.context === "Surface")
    .at(-1)?.handlers;
  if (!handlers)
    throw new Error("Expected Surface keybindings to be registered.");
  return handlers;
}

function stageAcceptanceRecovery({
  id,
  acknowledge,
  discard,
}: {
  readonly id: string;
  readonly acknowledge: () => Promise<BufferEditorProposalResolution>;
  readonly discard: () => Promise<BufferEditorProposalResolution>;
}): void {
  stageContentFreeEditorProposalRecoveryRecord({
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
}

function renderAcceptanceRecovery(id: string): Promise<string> {
  return renderToString(
    <AppStateProvider initialState={editorProposalState(id)}>
      <EditorProposalRail proposalId={id} focused={true} />
    </AppStateProvider>,
    100,
  );
}

function normalizeRenderedOutput(output: string): string {
  return output.replace(/\s+/gu, " ").trim();
}

function editorProposalState(proposalIdValue: string): AppState {
  const defaults = getDefaultAppState();
  const editor = workbenchReducer(defaults.workbench, {
    type: "switchWorkspaceView",
    view: "editor",
  });
  const withProposal = workbenchReducer(
    workbenchReducer(editor, {
      type: "setRail",
      rail: { kind: "editor-proposal", proposalId: proposalIdValue },
    }),
    { type: "focus", pane: "rail" },
  );
  return { ...defaults, workbench: withProposal };
}

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
