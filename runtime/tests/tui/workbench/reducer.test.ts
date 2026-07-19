import { describe, expect, it } from "vitest";

import {
  attachTaskErrorCommand,
  openBufferCommand,
} from "../../../src/tui/workbench/commands.js";
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

  it("increments buffer open requests even when reopening the same path", () => {
    const first = workbenchReducer(undefined, {
      type: "openBuffer",
      path: "src/index.ts",
      line: 7,
    });
    const retry = workbenchReducer(first, {
      type: "openBuffer",
      path: "src/index.ts",
      line: 7,
    });

    expect(retry).toMatchObject({
      activeSurfaceMode: "buffer",
      activeFilePath: "src/index.ts",
      activeFileLine: 7,
      bufferOpenRequestId: first.bufferOpenRequestId + 1,
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

  it.each([
    ["explorer" as const, { explorerVisible: false }],
    ["agents" as const, { agentsVisible: false }],
  ])("cycles from the visible fallback pane when hidden %s focus is stale", (focusedPane, visibility) => {
    const hiddenSidePaneFocus = {
      ...getDefaultWorkbenchState(),
      focusedPane,
      ...visibility,
    };
    const next = workbenchReducer(hiddenSidePaneFocus, {
      type: "focusNext",
      visiblePanes: ["surface", "composer"],
    });

    expect(visibleWorkbenchPane(hiddenSidePaneFocus)).toBe("surface");
    expect(next.focusedPane).toBe("composer");
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

  it("renames active paths and attached context without touching sibling prefixes", () => {
    const state = {
      ...getDefaultWorkbenchState(),
      activeFilePath: "src/nested/app.ts",
      attachments: [
        {
          id: "file-range:src/nested/app.ts:12-15",
          kind: "file-range" as const,
          label: "src/nested/app.ts:12-15",
          path: "src/nested/app.ts",
          line: 12,
          endLine: 15,
        },
        {
          id: "file:src-old/app.ts",
          kind: "file" as const,
          label: "src-old/app.ts",
          path: "src-old/app.ts",
        },
      ],
      composerAttachmentIds: [
        "file-range:src/nested/app.ts:12-15",
        "file:src-old/app.ts",
      ],
    };
    const next = workbenchReducer(state, {
      type: "renamePathReferences",
      fromPath: "src",
      toPath: "lib",
    });

    expect(next.activeFilePath).toBe("lib/nested/app.ts");
    expect(next.attachments).toEqual([
      {
        id: "file-range:lib/nested/app.ts:12-15",
        kind: "file-range",
        label: "lib/nested/app.ts:12-15",
        path: "lib/nested/app.ts",
        line: 12,
        endLine: 15,
      },
      {
        id: "file:src-old/app.ts",
        kind: "file",
        label: "src-old/app.ts",
        path: "src-old/app.ts",
      },
    ]);
    expect(next.composerAttachmentIds).toEqual([
      "file-range:lib/nested/app.ts:12-15",
      "file:src-old/app.ts",
    ]);
  });

  it("normalizes trailing slash rename targets before rewriting references", () => {
    const state = {
      ...getDefaultWorkbenchState(),
      activeFilePath: "src/nested/app.ts",
      attachments: [
        {
          id: "file-range:src/nested/app.ts:12-15",
          kind: "file-range" as const,
          label: "src/nested/app.ts:12-15",
          path: "src/nested/app.ts",
          line: 12,
          endLine: 15,
        },
      ],
      composerAttachmentIds: ["file-range:src/nested/app.ts:12-15"],
    };
    const next = workbenchReducer(state, {
      type: "renamePathReferences",
      fromPath: "src",
      toPath: "lib/",
    });

    expect(next.activeFilePath).toBe("lib/nested/app.ts");
    expect(next.attachments[0]).toMatchObject({
      id: "file-range:lib/nested/app.ts:12-15",
      label: "lib/nested/app.ts:12-15",
      path: "lib/nested/app.ts",
    });
    expect(next.composerAttachmentIds).toEqual([
      "file-range:lib/nested/app.ts:12-15",
    ]);
  });

  it("normalizes backslash path references before renaming active paths and attachments", () => {
    const state = {
      ...getDefaultWorkbenchState(),
      activeFilePath: "src\\nested\\app.ts",
      attachments: [
        {
          id: "file-range:src\\nested\\app.ts:12-15",
          kind: "file-range" as const,
          label: "src\\nested\\app.ts:12-15",
          path: "src\\nested\\app.ts",
          line: 12,
          endLine: 15,
        },
      ],
      composerAttachmentIds: ["file-range:src\\nested\\app.ts:12-15"],
    };
    const next = workbenchReducer(state, {
      type: "renamePathReferences",
      fromPath: "src",
      toPath: "lib",
    });

    expect(next.activeFilePath).toBe("lib/nested/app.ts");
    expect(next.attachments[0]).toMatchObject({
      id: "file-range:lib/nested/app.ts:12-15",
      label: "lib/nested/app.ts:12-15",
      path: "lib/nested/app.ts",
    });
    expect(next.composerAttachmentIds).toEqual([
      "file-range:lib/nested/app.ts:12-15",
    ]);
  });

  it("normalizes dot-segment references before renaming active paths and attachments", () => {
    const opened = workbenchReducer(
      undefined,
      openBufferCommand("./test/foo.test.tsx", 8, true),
    );
    const state = workbenchReducer(opened, attachTaskErrorCommand({
      taskId: "test-1",
      file: "./test/foo.test.tsx",
      line: 8,
      label: "./test/foo.test.tsx failure",
    }));
    const next = workbenchReducer(state, {
      type: "renamePathReferences",
      fromPath: "test",
      toPath: "spec",
    });

    expect(next.activeFilePath).toBe("spec/foo.test.tsx");
    expect(next.attachments).toEqual([
      {
        id: "task-error:test-1:spec/foo.test.tsx:8",
        kind: "task-error",
        label: "spec/foo.test.tsx failure",
        path: "spec/foo.test.tsx",
        line: 8,
        taskId: "test-1",
      },
    ]);
    expect(next.composerAttachmentIds).toEqual(["task-error:test-1:spec/foo.test.tsx:8"]);
  });

  it("opens the buffer only when rename changes the current active path", () => {
    const affected = workbenchReducer({
      ...getDefaultWorkbenchState(),
      focusedPane: "explorer",
      activeSurfaceMode: "preview",
      activeFilePath: "src/nested/app.ts",
      activeFileLine: 12,
    }, {
      type: "renamePathReferences",
      fromPath: "src",
      toPath: "lib",
      openAffectedBuffer: true,
    });
    const unaffected = workbenchReducer({
      ...getDefaultWorkbenchState(),
      focusedPane: "explorer",
      activeSurfaceMode: "preview",
      activeFilePath: "other.ts",
      activeFileLine: 5,
    }, {
      type: "renamePathReferences",
      fromPath: "src",
      toPath: "lib",
      openAffectedBuffer: true,
    });

    expect(affected).toMatchObject({
      focusedPane: "explorer",
      activeSurfaceMode: "buffer",
      activeFilePath: "lib/nested/app.ts",
      activeFileLine: 12,
    });
    expect(unaffected).toMatchObject({
      focusedPane: "explorer",
      activeSurfaceMode: "preview",
      activeFilePath: "other.ts",
      activeFileLine: 5,
    });
  });

  it("clears active paths and attached context when a workspace path is deleted", () => {
    const state = {
      ...getDefaultWorkbenchState(),
      activeFilePath: "src/nested/app.ts",
      activeFileLine: 12,
      attachments: [
        {
          id: "file-range:src/nested/app.ts:12-15",
          kind: "file-range" as const,
          label: "src/nested/app.ts:12-15",
          path: "src/nested/app.ts",
          line: 12,
          endLine: 15,
        },
        {
          id: "file:src-old/app.ts",
          kind: "file" as const,
          label: "src-old/app.ts",
          path: "src-old/app.ts",
        },
      ],
      composerAttachmentIds: [
        "file-range:src/nested/app.ts:12-15",
        "file:src-old/app.ts",
      ],
    };
    const next = workbenchReducer(state, {
      type: "deletePathReferences",
      path: "src",
    });

    expect(next.activeFilePath).toBeNull();
    expect(next.activeFileLine).toBeNull();
    expect(next.attachments).toEqual([
      {
        id: "file:src-old/app.ts",
        kind: "file",
        label: "src-old/app.ts",
        path: "src-old/app.ts",
      },
    ]);
    expect(next.composerAttachmentIds).toEqual(["file:src-old/app.ts"]);
  });

  it("normalizes backslash path references before deleting active paths and attachments", () => {
    const state = {
      ...getDefaultWorkbenchState(),
      activeFilePath: "src\\nested\\app.ts",
      activeFileLine: 12,
      attachments: [
        {
          id: "file-range:src\\nested\\app.ts:12-15",
          kind: "file-range" as const,
          label: "src\\nested\\app.ts:12-15",
          path: "src\\nested\\app.ts",
          line: 12,
          endLine: 15,
        },
        {
          id: "file:src-old\\app.ts",
          kind: "file" as const,
          label: "src-old\\app.ts",
          path: "src-old\\app.ts",
        },
      ],
      composerAttachmentIds: [
        "file-range:src\\nested\\app.ts:12-15",
        "file:src-old\\app.ts",
      ],
    };
    const next = workbenchReducer(state, {
      type: "deletePathReferences",
      path: "src",
    });

    expect(next.activeFilePath).toBeNull();
    expect(next.activeFileLine).toBeNull();
    expect(next.attachments).toEqual([
      {
        id: "file:src-old\\app.ts",
        kind: "file",
        label: "src-old\\app.ts",
        path: "src-old\\app.ts",
      },
    ]);
    expect(next.composerAttachmentIds).toEqual(["file:src-old\\app.ts"]);
  });

  it("normalizes dot-segment references before deleting active paths and attachments", () => {
    const opened = workbenchReducer(
      undefined,
      openBufferCommand("./test/foo.test.tsx", 8, true),
    );
    const state = workbenchReducer(opened, attachTaskErrorCommand({
      taskId: "test-1",
      file: "./test/foo.test.tsx",
      line: 8,
    }));
    const next = workbenchReducer(state, {
      type: "deletePathReferences",
      path: "test",
    });

    expect(next.activeFilePath).toBeNull();
    expect(next.activeFileLine).toBeNull();
    expect(next.attachments).toEqual([]);
    expect(next.composerAttachmentIds).toEqual([]);
  });

  it("closes the active surface only when delete clears the current active path", () => {
    const affected = workbenchReducer({
      ...getDefaultWorkbenchState(),
      activeSurfaceMode: "buffer",
      activeFilePath: "src/nested/app.ts",
      activeFileLine: 12,
    }, {
      type: "deletePathReferences",
      path: "src",
      closeAffectedSurface: true,
    });
    const unaffected = workbenchReducer({
      ...getDefaultWorkbenchState(),
      activeSurfaceMode: "preview",
      activeFilePath: "other.ts",
      activeFileLine: 5,
    }, {
      type: "deletePathReferences",
      path: "src",
      closeAffectedSurface: true,
    });

    expect(affected).toMatchObject({
      focusedPane: "surface",
      activeSurfaceMode: "transcript",
      activeFilePath: null,
      activeFileLine: null,
    });
    expect(unaffected).toMatchObject({
      activeSurfaceMode: "preview",
      activeFilePath: "other.ts",
      activeFileLine: 5,
    });
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

  it("clears stale diff ids when openDiff receives an explicit null", () => {
    const approvalDiff = workbenchReducer(undefined, {
      type: "openDiff",
      diffId: "approval-1",
    });
    const genericDiff = workbenchReducer(approvalDiff, {
      type: "openDiff",
    });
    const clearedDiff = workbenchReducer(approvalDiff, {
      type: "openDiff",
      diffId: null,
    });

    expect(genericDiff.openDiffId).toBe("approval-1");
    expect(clearedDiff).toMatchObject({
      activeSurfaceMode: "diff",
      openDiffId: null,
    });
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
    const explicitClear = workbenchReducer(first, {
      type: "openSearch",
      selectedMatchId: null,
    });
    const reopened = workbenchReducer(second, {
      type: "openSearch",
    });

    expect(second).toMatchObject({
      searchQuery: "other",
      selectedSearchMatchId: null,
    });
    expect(explicitClear).toMatchObject({
      searchQuery: "needle",
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

describe("toggleFileRail (ctrl+r review rail)", () => {
  it("opens the rail without touching the center surface or focus", () => {
    const state = workbenchReducer(undefined, {
      type: "toggleFileRail",
      path: "src/index.ts",
    });
    expect(state.fileRailPath).toBe("src/index.ts");
    expect(state.activeSurfaceMode).toBe("transcript");
    expect(state.focusedPane).toBe("composer");
  });

  it("closes the rail when no path is given", () => {
    const open = workbenchReducer(undefined, {
      type: "toggleFileRail",
      path: "src/index.ts",
    });
    const closed = workbenchReducer(open, { type: "toggleFileRail" });
    expect(closed.fileRailPath).toBeNull();
  });

  it("falls back to the surface pane when the focused rail closes", () => {
    const open = workbenchReducer(
      { ...getDefaultWorkbenchState(), focusedPane: "rail" },
      { type: "toggleFileRail", path: "src/index.ts" },
    );
    expect(visibleWorkbenchPane(open)).toBe("rail");
    const closed = workbenchReducer(open, { type: "toggleFileRail" });
    expect(visibleWorkbenchPane(closed)).toBe("surface");
  });
});
