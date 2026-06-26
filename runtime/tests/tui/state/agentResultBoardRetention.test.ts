// D8 (error recovery & resumability) + D2 (observability): the AGENT FLEET
// "result board" must NOT self-erase a completed/failed agent's row + result
// at the old 30s grace — a fan-out's outcomes have to survive review.
//
// This is a revert-sensitive guard. The pre-fix code set the terminal grace to
// PANEL_GRACE_MS = 30_000, so a completed/failed agent's row was evicted from
// getVisibleAgentTasks() once the panel's 1s tick ran evictTerminalTask() at
// the 30s mark. With the result-board retention (PANEL_GRACE_MS = 1_800_000),
// the row is still visible at +30s. Stash the source change to framework.ts /
// collabAgentTaskSync.ts and "the result board survives 30s" goes RED.

import { describe, expect, it } from "vitest";

import { syncCollabAgentEventToAppState } from "./collabAgentTaskSync.js";
import type { AppState } from "./AppStateStore.js";
import {
  getVisibleAgentTasks,
} from "src/tui/components/CoordinatorAgentStatus.js";
import { evictTerminalTask } from "src/utils/task/framework.js";

const SPAWN_NOW = 1_000;
const OLD_GRACE_MS = 30_000;

function baseState(): AppState {
  return { tasks: {} } as AppState;
}

function applyEvent(state: AppState, event: unknown, now: number): AppState {
  let next = state;
  syncCollabAgentEventToAppState(
    event,
    (updater) => {
      next = updater(next as never) as AppState;
    },
    now,
  );
  return next;
}

/** Drives the panel's 1s-tick eviction (CoordinatorTaskPanel) at a given clock. */
function tickPanelEvictionAt(state: AppState, now: number): AppState {
  const realNow = Date.now;
  // evictTerminalTask compares evictAfter against Date.now(); pin the clock so
  // the test is deterministic across the +30s and +grace boundaries.
  (Date as { now: () => number }).now = () => now;
  try {
    let next = state;
    for (const task of Object.values(state.tasks ?? {})) {
      evictTerminalTask(task.id, (updater) => {
        next = updater(next as never) as AppState;
      });
    }
    return next;
  } finally {
    (Date as { now: () => number }).now = realNow;
  }
}

function spawnRunningAgent(state: AppState, id: string, now: number): AppState {
  return applyEvent(
    state,
    {
      type: "collab_agent_spawn_end",
      payload: {
        newThreadId: id,
        newAgentNickname: id,
        status: { status: "running" },
      },
    },
    now,
  );
}

function markTerminal(
  state: AppState,
  id: string,
  status: "completed" | "errored",
  now: number,
): AppState {
  return applyEvent(
    state,
    {
      type: "collab_agent_status",
      payload: {
        threadId: id,
        status:
          status === "errored"
            ? { status: "errored", error: "boom" }
            : { status: "completed" },
      },
    },
    now,
  );
}

describe("agent fleet result-board retention (D8 / D2)", () => {
  it("keeps a COMPLETED and a FAILED agent row visible past the old 30s grace", () => {
    let state = baseState();
    state = spawnRunningAgent(state, "done_agent", SPAWN_NOW);
    state = spawnRunningAgent(state, "boom_agent", SPAWN_NOW);
    state = markTerminal(state, "done_agent", "completed", SPAWN_NOW);
    state = markTerminal(state, "boom_agent", "errored", SPAWN_NOW);

    // Both terminal rows start visible with a retention deadline far beyond 30s.
    const visibleNow = getVisibleAgentTasks(state.tasks);
    expect(visibleNow.map((t) => t.id).sort()).toEqual([
      "boom_agent",
      "done_agent",
    ]);
    for (const t of visibleNow) {
      expect(t.evictAfter).toBeDefined();
      // The deadline must be well past the old 30s grace — this is what makes
      // the row survive the +30s tick below.
      expect(t.evictAfter! - SPAWN_NOW).toBeGreaterThan(OLD_GRACE_MS);
    }

    // Run the panel's eviction tick at exactly the OLD 30s boundary. Pre-fix
    // (PANEL_GRACE_MS = 30_000) this is where the result board self-erased.
    const afterOldGrace = tickPanelEvictionAt(state, SPAWN_NOW + OLD_GRACE_MS);

    // REVERT-SENSITIVE ASSERTION: both rows are STILL on the board after 30s.
    const visibleAfter = getVisibleAgentTasks(afterOldGrace.tasks);
    expect(visibleAfter.map((t) => t.id).sort()).toEqual([
      "boom_agent",
      "done_agent",
    ]);
    // And their result-bearing fields survive (status + error are the board).
    const failed = visibleAfter.find((t) => t.id === "boom_agent");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("boom");
    expect(
      visibleAfter.find((t) => t.id === "done_agent")?.status,
    ).toBe("completed");
  });

  it("still evicts terminal rows once the retention window elapses (cleanup not regressed)", () => {
    let state = baseState();
    state = spawnRunningAgent(state, "done_agent", SPAWN_NOW);
    state = markTerminal(state, "done_agent", "completed", SPAWN_NOW);

    const deadline = getVisibleAgentTasks(state.tasks)[0]!.evictAfter!;

    // Just before the deadline: still visible.
    const before = tickPanelEvictionAt(state, deadline - 1);
    expect(getVisibleAgentTasks(before.tasks).map((t) => t.id)).toEqual([
      "done_agent",
    ]);

    // At/after the deadline: the row is finally GC'd from the board.
    const after = tickPanelEvictionAt(state, deadline);
    expect(getVisibleAgentTasks(after.tasks)).toEqual([]);
  });

  it("does not retain ACTIVE agents and still honors immediate x-dismiss", () => {
    let state = baseState();
    state = spawnRunningAgent(state, "live_agent", SPAWN_NOW);

    // A running agent has no eviction deadline and is unaffected by the tick.
    const live = getVisibleAgentTasks(state.tasks)[0]!;
    expect(live.status).toBe("running");
    expect(live.evictAfter).toBeUndefined();
    const afterTick = tickPanelEvictionAt(state, SPAWN_NOW + 10_000_000);
    expect(getVisibleAgentTasks(afterTick.tasks).map((t) => t.id)).toEqual([
      "live_agent",
    ]);

    // x-dismiss (evictAfter:0) still hides a row immediately, independent of
    // the retention window.
    const dismissed = {
      tasks: {
        gone: {
          ...getVisibleAgentTasks(
            markTerminal(state, "live_agent", "completed", SPAWN_NOW).tasks,
          )[0]!,
          id: "gone",
          evictAfter: 0,
        },
      },
    } as unknown as AppState;
    expect(getVisibleAgentTasks(dismissed.tasks)).toEqual([]);
  });
});
