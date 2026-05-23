import { describe, expect, it } from "vitest";

import {
  getDefaultWorkbenchState,
  visibleWorkbenchPane,
  workbenchReducer,
} from "../../../src/tui/workbench/reducer.js";

describe("workbenchReducer", () => {
  it("provides stable defaults", () => {
    expect(getDefaultWorkbenchState()).toMatchObject({
      focusedPane: "composer",
      explorerVisible: true,
      agentsVisible: true,
      activeSurfaceMode: "transcript",
      activeFilePath: null,
      composerAttachmentIds: [],
      attachments: [],
    });
  });

  it("opens preview and focuses the active surface by default", () => {
    const next = workbenchReducer(undefined, {
      type: "openPreview",
      path: "src/index.ts",
      line: 42,
    });

    expect(next.activeSurfaceMode).toBe("preview");
    expect(next.focusedPane).toBe("surface");
    expect(next.activeFilePath).toBe("src/index.ts");
    expect(next.activeFileLine).toBe(42);
  });

  it("can preview without stealing explorer focus", () => {
    const focusedExplorer = workbenchReducer(undefined, {
      type: "focus",
      pane: "explorer",
    });
    const next = workbenchReducer(focusedExplorer, {
      type: "openPreview",
      path: "README.md",
      focus: false,
    });

    expect(next.activeSurfaceMode).toBe("preview");
    expect(next.focusedPane).toBe("explorer");
  });

  it("opens buffers and preserves optional focus behavior", () => {
    const focusedExplorer = workbenchReducer(undefined, {
      type: "focus",
      pane: "explorer",
    });
    const focusedBuffer = workbenchReducer(focusedExplorer, {
      type: "openBuffer",
      path: "src/index.ts",
      line: 7,
    });
    const keepExplorer = workbenchReducer(focusedExplorer, {
      type: "openBuffer",
      path: "src/index.ts",
      focus: false,
    });

    expect(focusedBuffer).toMatchObject({
      activeSurfaceMode: "buffer",
      focusedPane: "surface",
      activeFilePath: "src/index.ts",
      activeFileLine: 7,
    });
    expect(keepExplorer).toMatchObject({
      activeSurfaceMode: "buffer",
      focusedPane: "explorer",
    });
  });

  it("cycles through visible panes", () => {
    const explorer = workbenchReducer(undefined, {
      type: "focus",
      pane: "explorer",
    });
    const surface = workbenchReducer(explorer, {
      type: "focusNext",
      visiblePanes: ["explorer", "surface", "composer"],
    });
    const composer = workbenchReducer(surface, {
      type: "focusNext",
      visiblePanes: ["explorer", "surface", "composer"],
    });

    expect(surface.focusedPane).toBe("surface");
    expect(composer.focusedPane).toBe("composer");
  });

  it("falls back to the surface when hidden panes have stale focus", () => {
    expect(visibleWorkbenchPane({
      ...getDefaultWorkbenchState(),
      focusedPane: "agents",
      agentsVisible: false,
    })).toBe("surface");
    expect(visibleWorkbenchPane({
      ...getDefaultWorkbenchState(),
      focusedPane: "explorer",
      explorerVisible: false,
    })).toBe("surface");
    expect(visibleWorkbenchPane({
      ...getDefaultWorkbenchState(),
      focusedPane: "composer",
    })).toBe("composer");
  });

  it("stores attachment payloads and ids together", () => {
    const next = workbenchReducer(undefined, {
      type: "attach",
      attachment: {
        id: "file:README.md",
        kind: "file",
        label: "README.md",
        path: "README.md",
      },
    });

    expect(next.composerAttachmentIds).toEqual(["file:README.md"]);
    expect(next.attachments).toHaveLength(1);
  });

  it("deduplicates repeated attachments by id before prompt submission", () => {
    const first = workbenchReducer(undefined, {
      type: "attach",
      attachment: {
        id: "file:README.md",
        kind: "file",
        label: "README.md",
        path: "README.md",
      },
    });
    const second = workbenchReducer(first, {
      type: "attach",
      attachment: {
        id: "file:README.md",
        kind: "file",
        label: "README.md",
        path: "README.md",
      },
    });

    expect(second.attachments).toHaveLength(1);
    expect(second.composerAttachmentIds).toEqual(["file:README.md"]);
  });

  it("opens and closes non-transcript surfaces", () => {
    const diff = workbenchReducer(undefined, {
      type: "openDiff",
      diffId: "approval-1",
    });
    const search = workbenchReducer(diff, {
      type: "openSearch",
      query: "needle",
      selectedMatchId: "src/app.ts:4:needle",
    });
    const shell = workbenchReducer(search, {
      type: "openShell",
      taskId: "shell-1",
    });
    const agent = workbenchReducer(shell, {
      type: "openAgent",
      taskId: "agent-1",
    });
    const transcript = workbenchReducer(agent, { type: "closeSurface" });

    expect(diff).toMatchObject({ activeSurfaceMode: "diff", openDiffId: "approval-1" });
    expect(search).toMatchObject({
      activeSurfaceMode: "search",
      searchQuery: "needle",
      selectedSearchMatchId: "src/app.ts:4:needle",
    });
    expect(shell).toMatchObject({ activeSurfaceMode: "shell", selectedShellTaskId: "shell-1" });
    expect(agent).toMatchObject({ activeSurfaceMode: "agent", selectedAgentTaskId: "agent-1" });
    expect(transcript.activeSurfaceMode).toBe("transcript");
  });

  it("clears stale selected search match ids when opening a new query", () => {
    const first = workbenchReducer(undefined, {
      type: "openSearch",
      query: "needle",
      selectedMatchId: "src/app.ts:4:needle",
    });
    const second = workbenchReducer(first, {
      type: "openSearch",
      query: "other",
    });
    const reopened = workbenchReducer(second, {
      type: "openSearch",
    });

    expect(second).toMatchObject({
      searchQuery: "other",
      selectedSearchMatchId: null,
    });
    expect(reopened).toMatchObject({
      searchQuery: "other",
      selectedSearchMatchId: null,
    });
  });

  it("tracks blocked approval overlays and attachment removal", () => {
    const withAttachment = workbenchReducer(undefined, {
      type: "attach",
      attachment: {
        id: "file:README.md",
        kind: "file",
        label: "README.md",
        path: "README.md",
      },
    });
    const blocked = workbenchReducer(withAttachment, {
      type: "blockForApproval",
      requestId: "approval-1",
      attemptedAction: "delete file",
    });
    const removed = workbenchReducer(blocked, {
      type: "removeAttachment",
      id: "file:README.md",
    });
    const cleared = workbenchReducer(removed, { type: "clearBlockedOverlay" });

    expect(blocked.pendingBlockedOverlay).toEqual({
      kind: "approval",
      requestId: "approval-1",
      attemptedAction: "delete file",
    });
    expect(removed.attachments).toEqual([]);
    expect(cleared.pendingBlockedOverlay).toBeNull();
  });
});
