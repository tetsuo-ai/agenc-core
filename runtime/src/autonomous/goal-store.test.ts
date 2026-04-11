import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryBackend } from "../memory/in-memory/index.js";
import { GoalStore } from "./goal-store.js";
import { RuntimeSchemaCompatibilityError } from "../workflow/schema-version.js";

describe("GoalStore", () => {
  let now = 1_700_000_000_000;
  let store: GoalStore;

  beforeEach(() => {
    now = 1_700_000_000_000;
    store = new GoalStore({
      memory: new InMemoryBackend(),
      now: () => now,
    });
  });

  it("consolidates duplicate goals instead of creating a second active record", async () => {
    const first = await store.addGoal({
      title: "Stabilize daemon cwd propagation",
      description: "Replace lossy cwd hints with explicit workspace execution envelopes",
      priority: "high",
      source: "meta-planner",
    });

    now += 60_000;
    const second = await store.addGoal({
      title: "Stabilize daemon cwd propagation",
      description: "Replace lossy cwd hints with explicit workspace execution envelopes",
      priority: "critical",
      source: "meta-planner",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.accepted).toBe(false);
    const active = await store.getActiveGoals();
    expect(active).toHaveLength(1);
    expect(active[0]?.priority).toBe("critical");
  });

  it("expires stale active goals during hygiene", async () => {
    const created = await store.addGoal({
      title: "Investigate stale dialog",
      description: "Dismiss the stale error dialog in the workspace",
      priority: "medium",
      source: "awareness",
    });

    now += 8 * 24 * 60 * 60 * 1000;
    const state = await store.getState();
    const expired = state.goals.find((goal) => goal.id === created.goal.id);

    expect(expired?.status).toBe("expired");
    expect(expired?.freshness.score).toBe(0);
  });

  it("migrates legacy unversioned strategic memory state and rewrites it as v1", async () => {
    const memory = new InMemoryBackend();
    store = new GoalStore({
      memory,
      now: () => now,
    });
    await memory.set("strategic:memory:state", {
      goals: [
        {
          id: "goal-1",
          canonicalId: "stabilize-daemon-cwd-propagation",
          title: "Stabilize daemon cwd propagation",
          description: "Replace lossy cwd hints with explicit workspace execution envelopes",
          priority: "high",
          status: "pending",
          source: "meta-planner",
          createdAt: now,
          updatedAt: now,
          attempts: 0,
          maxAttempts: 2,
          freshness: {
            score: 1,
            lastObservedAt: now,
            expiresAt: now + 60_000,
          },
          dependencyGoalIds: [],
          supersedesGoalIds: [],
        },
      ],
      workingNotes: [],
      executionSummaries: [],
      updatedAt: now,
    });

    const state = await store.getState();

    expect(state.version).toBe("v1");
    expect(state.goals).toHaveLength(1);
    const persisted = await memory.get<{ version?: string }>(
      "strategic:memory:state",
    );
    expect(persisted?.version).toBe("v1");
  });

  it("fails loudly when strategic memory state uses an unsupported schema version", async () => {
    const memory = new InMemoryBackend();
    store = new GoalStore({
      memory,
      now: () => now,
    });
    await memory.set("strategic:memory:state", {
      version: "v999",
      goals: [],
      workingNotes: [],
      executionSummaries: [],
      updatedAt: now,
    });

    await expect(store.getState()).rejects.toBeInstanceOf(
      RuntimeSchemaCompatibilityError,
    );
  });

  it("suppresses recreating a terminal goal during the duplicate suppression window", async () => {
    // Audit S1.7 regression: within the SUPPRESSION window (1 day),
    // a duplicate of a recently-terminated goal must be rejected as
    // duplicate_recent_terminal — never reopened.
    const initial = await store.addGoal({
      title: "Investigate stale dialog",
      description: "Dismiss the stale error dialog in the workspace",
      priority: "medium",
      source: "awareness",
    });
    await store.cancelGoal(initial.goal.id);

    // 30 minutes later — well inside SUPPRESSION_MS (1 day) — a
    // duplicate must still be suppressed entirely.
    now += 30 * 60 * 1000;
    const duplicate = await store.addGoal({
      title: "Investigate stale dialog",
      description: "Dismiss the stale error dialog in the workspace",
      priority: "medium",
      source: "awareness",
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.rejectedReason).toBe("duplicate_recent_terminal");
  });

  it("reopens a terminal goal after the suppression window has elapsed but within the reopen window", async () => {
    // Audit S1.7 regression: between SUPPRESSION_MS (1 day) and
    // GOAL_REOPEN_WINDOW_MS (3 days), a duplicate of a recently-
    // terminated goal must be allowed to reopen — the previous code
    // had the constants swapped, leaving canReopen as dead code that
    // always returned false.
    const initial = await store.addGoal({
      title: "Investigate stale dialog",
      description: "Dismiss the stale error dialog in the workspace",
      priority: "medium",
      source: "awareness",
    });
    await store.cancelGoal(initial.goal.id);

    // 36 hours later — past SUPPRESSION (24h) but inside REOPEN_WINDOW
    // (72h) — the duplicate must reopen the existing terminal goal,
    // not be rejected.
    now += 36 * 60 * 60 * 1000;
    const duplicate = await store.addGoal({
      title: "Investigate stale dialog",
      description: "Dismiss the stale error dialog in the workspace",
      priority: "high",
      source: "awareness",
    });
    expect(duplicate.created).toBe(true);
    expect(duplicate.accepted).toBe(true);
  });
});
