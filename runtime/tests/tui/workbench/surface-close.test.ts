import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDefaultAppState, type AppState } from "../../../src/tui/state/AppStateStore.js";
import { applyWorkbenchCommand } from "../../../src/tui/workbench/state.js";
import { requestWorkbenchSurfaceClose } from "../../../src/tui/workbench/surfaces/closeSurface.js";
import type { ActiveSurfaceMode } from "../../../src/tui/workbench/types.js";

const provider = vi.hoisted(() => ({ dirty: false }));

vi.mock("../../../src/tui/workbench/buffer/providers/BufferProviderController.js", () => ({
  getWorkbenchBufferProviderController: () => ({
    getSnapshot: () => provider,
  }),
}));

beforeEach(() => {
  provider.dirty = false;
});

function surfaceState(mode: ActiveSurfaceMode): AppState {
  const state = getDefaultAppState();
  return {
    ...state,
    workbench: { ...state.workbench, activeSurfaceMode: mode, focusedPane: "surface" },
  };
}

describe("workbench close policy", () => {
  it.each(["transcript", "preview", "diff", "shell", "test", "search", "task-detail", "buffer"] as const)(
    "closes clean %s without a keybinding",
    (mode) => {
      const state = surfaceState(mode);
      const closed = requestWorkbenchSurfaceClose(state);
      expect(closed.status).toBe("closed");
      expect(closed.state.workbench).toMatchObject({
        activeSurfaceMode: "transcript",
        focusedPane: "composer",
        pendingBlockedOverlay: null,
      });
      expect(state.workbench.activeSurfaceMode).toBe(mode);
    },
  );

  it("requires confirmation using live dirty state and blocks repeated requests", () => {
    const state = surfaceState("buffer");
    provider.dirty = true;
    const pending = requestWorkbenchSurfaceClose(state);
    expect(pending.status).toBe("needs_confirmation");
    expect(pending.state.workbench.activeSurfaceMode).toBe("buffer");
    expect(pending.state.workbench.pendingBlockedOverlay).toMatchObject({
      requestId: "buffer-dirty-surface-switch",
      deferredCommand: { type: "closeSurface" },
    });
    expect(requestWorkbenchSurfaceClose(pending.state)).toEqual({
      status: "blocked",
      state: pending.state,
    });
  });

  it("does not bypass a pending unrelated approval", () => {
    const state = applyWorkbenchCommand(surfaceState("preview"), {
      type: "blockForApproval",
      requestId: "approval-1",
      attemptedAction: "opening a file",
      deferredCommand: { type: "openSurface", mode: "diff" },
    });
    const closed = requestWorkbenchSurfaceClose(state);
    expect(closed.status).toBe("blocked");
    expect(closed.state).toBe(state);
  });

  it("rechecks dirty state before deferred close can complete", () => {
    provider.dirty = true;
    const pending = requestWorkbenchSurfaceClose(surfaceState("buffer"));
    const resolve = {
      type: "resolveBlockedOverlay",
      requestId: "buffer-dirty-surface-switch",
    } as const;
    expect(applyWorkbenchCommand(pending.state, resolve)).toBe(pending.state);
    provider.dirty = false;
    const closed = applyWorkbenchCommand(pending.state, resolve);
    expect(closed.workbench.activeSurfaceMode).toBe("transcript");
    expect(closed.workbench.pendingBlockedOverlay).toBeNull();
  });

  it("allows cancellation without losing the dirty buffer", () => {
    provider.dirty = true;
    const pending = requestWorkbenchSurfaceClose(surfaceState("buffer"));
    const cancelled = applyWorkbenchCommand(pending.state, { type: "clearBlockedOverlay" });
    expect(cancelled.workbench.activeSurfaceMode).toBe("buffer");
    expect(cancelled.workbench.pendingBlockedOverlay).toBeNull();
    expect(requestWorkbenchSurfaceClose(cancelled).status).toBe("needs_confirmation");
  });

  it("does not demand confirmation for a non-buffer surface with a dirty background buffer", () => {
    provider.dirty = true;
    expect(requestWorkbenchSurfaceClose(surfaceState("search")).status).toBe("closed");
  });
});
