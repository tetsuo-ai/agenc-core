import React from "react";
import { describe, expect, it, vi } from "vitest";

const keybindingHarness = vi.hoisted(() => ({
  action: "",
  handler: undefined as undefined | (() => void),
  options: undefined as undefined | Record<string, unknown>,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: (
    action: string,
    handler: () => void,
    options: Record<string, unknown>,
  ) => {
    keybindingHarness.action = action;
    keybindingHarness.handler = handler;
    keybindingHarness.options = options;
  },
  useKeybindings: () => {},
}));

import { AppStateProvider, getDefaultAppState, type AppState } from "../../../src/tui/state/AppState.js";
import { ApprovalSurfaceBridge } from "../../../src/tui/workbench/approvals/ApprovalSurfaceBridge.js";
import { renderToString } from "../../../src/utils/staticRender.js";

describe("ApprovalSurfaceBridge", () => {
  it("renders nothing (headless): the card owns the visible hint now", async () => {
    const request = pendingRequest({
      id: "approval-1",
      description: "Run shell command",
      input: { command: "rm -rf /tmp/agenc-danger" },
      toolName: "Bash",
    });

    const output = await renderToString(
      <AppStateProvider initialState={getDefaultAppState()}>
        <ApprovalSurfaceBridge request={request} />
      </AppStateProvider>,
      80,
    );

    // The bridge used to paint a duplicate "risk X - press d…" row that fused
    // with the approval card below ("reviewall"). It must stay invisible.
    expect(output).not.toContain("Approval pending:")
    expect(output).not.toContain("risk destructive")
    // …while STILL registering the opt-in openDiff keybinding for it.
    expect(keybindingHarness).toMatchObject({
      action: "workbench:openDiff",
      options: { context: "Confirmation", isActive: true },
    })
  });

  it("classifies destructive approval risk from split command arguments", async () => {
    const request = pendingRequest({
      id: "approval-argv",
      description: "Run shell command",
      input: { command: "rm", args: ["-rf", "/tmp/agenc-danger"] },
      toolName: "Bash",
    });

    const output = await renderToString(
      <AppStateProvider initialState={getDefaultAppState()}>
        <ApprovalSurfaceBridge request={request} />
      </AppStateProvider>,
      80,
    );

    expect(output).not.toContain("Approval pending:")
    expect(keybindingHarness).toMatchObject({
      action: "workbench:openDiff",
      options: { context: "Confirmation", isActive: true },
    })
  });

  it("classifies destructive approval risk from structured command arguments", async () => {
    const request = pendingRequest({
      id: "approval-structured-argv",
      description: "Run shell command",
      input: { command: "bash", args: [{ script: "rm -rf /tmp/agenc-danger" }] },
      toolName: "Bash",
    });

    const output = await renderToString(
      <AppStateProvider initialState={getDefaultAppState()}>
        <ApprovalSurfaceBridge request={request} />
      </AppStateProvider>,
      80,
    );

    expect(output).not.toContain("Approval pending:")
    expect(keybindingHarness).toMatchObject({
      action: "workbench:openDiff",
      options: { context: "Confirmation", isActive: true },
    })
  });

  it("opens the diff surface for the active approval request", async () => {
    const changes: AppState[] = [];
    const request = pendingRequest({
      id: "approval-diff",
      description: "Edit file",
      input: { command: "apply patch" },
      toolName: "Edit",
    });

    await renderToString(
      <AppStateProvider
        initialState={getDefaultAppState()}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <ApprovalSurfaceBridge request={request} />
      </AppStateProvider>,
      80,
    );

    expect(keybindingHarness).toMatchObject({
      action: "workbench:openDiff",
      options: { context: "Confirmation", isActive: true },
    });

    keybindingHarness.handler?.();

    expect(changes.at(-1)?.workbench).toMatchObject({
      activeSurfaceMode: "diff",
      focusedPane: "surface",
      openDiffId: "approval-diff",
    });
  });
});

function pendingRequest({
  id,
  description,
  input,
  toolName,
}: {
  readonly id: string;
  readonly description: string;
  readonly input: Record<string, unknown>;
  readonly toolName: string;
}) {
  return {
    id,
    description,
    input,
    ctx: {
      toolName,
      invocation: { payload: {} },
    },
    resolve: vi.fn(),
  } as any;
}
