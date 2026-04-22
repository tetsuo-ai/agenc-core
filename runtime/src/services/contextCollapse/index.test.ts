import { afterEach, describe, expect, test, vi } from "vitest";

const { sessionStorage } = vi.hoisted(() => ({
  sessionStorage: {
  recordContextCollapseCommit: vi.fn(async () => {}),
  recordContextCollapseSnapshot: vi.fn(async () => {}),
  },
}));

vi.mock("../../utils/sessionStorage.js", () => sessionStorage);
vi.mock("../../utils/debug.js", () => ({
  logForDebugging: vi.fn(),
}));
vi.mock("../../utils/context.js", () => ({
  getContextWindowForModel: vi.fn(() => 100),
}));
vi.mock("../../utils/tokens.js", () => ({
  tokenCountWithEstimation: vi.fn(() => 95),
}));
vi.mock("../../utils/settings/settings.js", () => ({
  getSettings_DEPRECATED: vi.fn(() => ({
    contextManagementStrategy: "collapse",
  })),
}));

import {
  applyCollapsesIfNeeded,
  getStats,
  projectView,
  recoverFromOverflow,
  resetContextCollapse,
  stageContextCollapseForSession,
} from "./index.js";
import { createPersistEntries, restoreFromEntries } from "./persist.js";

function mkUser(uuid: string, content: string) {
  return {
    type: "user",
    message: {
      role: "user",
      content,
    },
    uuid,
    timestamp: new Date().toISOString(),
  };
}

function mkAssistant(uuid: string, content: string) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    uuid,
    timestamp: new Date().toISOString(),
  };
}

afterEach(() => {
  resetContextCollapse();
  vi.clearAllMocks();
});

describe("contextCollapse donor port", () => {
  test("applyCollapsesIfNeeded commits a span and replaces it with a collapsed marker", async () => {
    const messages = [
      mkUser("u1", "one"),
      mkAssistant("a1", "two"),
      mkUser("u2", "three"),
      mkAssistant("a2", "four"),
      mkUser("u3", "five"),
      mkAssistant("a3", "six"),
      mkUser("u4", "seven"),
      mkAssistant("a4", "eight"),
      mkUser("u5", "nine"),
      mkAssistant("a5", "ten"),
      mkUser("u6", "eleven"),
      mkAssistant("a6", "twelve"),
    ];

    const result = await applyCollapsesIfNeeded(messages, {
      options: { mainLoopModel: "stub-model" },
    });

    expect(result.committed).toBe(1);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(
      JSON.stringify(result.messages).includes("<collapsed id="),
    ).toBe(true);
    expect(sessionStorage.recordContextCollapseCommit).toHaveBeenCalledTimes(1);
    expect(sessionStorage.recordContextCollapseSnapshot).toHaveBeenCalledTimes(1);
    expect(getStats().collapsedSpans).toBe(1);
  });

  test("persist helpers restore commits and project them into view", () => {
    restoreFromEntries(
      [
        {
          type: "marble-origami-commit",
          sessionId: "s1" as never,
          collapseId: "0000000000000001",
          summaryUuid: "sum-1",
          summaryContent: '<collapsed id="0000000000000001">summary</collapsed>',
          summary: "summary",
          firstArchivedUuid: "u1",
          lastArchivedUuid: "a2",
        },
      ],
      {
        type: "marble-origami-snapshot",
        sessionId: "s1" as never,
        staged: [],
        armed: false,
        lastSpawnTokens: 0,
      },
    );

    const projected = projectView([
      mkUser("u1", "one"),
      mkAssistant("a1", "two"),
      mkUser("u2", "three"),
      mkAssistant("a2", "four"),
      mkUser("u3", "tail"),
    ]);

    expect(projected).toHaveLength(2);
    expect(JSON.stringify(projected[0])).toContain("<collapsed id=");

    const persisted = createPersistEntries();
    expect(persisted.commits).toHaveLength(1);
    expect(persisted.snapshot).toBeUndefined();
  });

  test("manual staged session seam still drains through recoverFromOverflow", () => {
    stageContextCollapseForSession(
      "conv-1",
      [mkUser("u-collapsed", "collapsed")],
      { committed: 2, collapsedMessages: 5 },
    );

    const drained = recoverFromOverflow(
      [mkUser("u-live", "live")],
      "repl_main_thread",
      { session: { conversationId: "conv-1" } },
    );

    expect(drained.committed).toBe(2);
    expect(drained.messages).toHaveLength(1);
    expect(getStats().health.totalSpawns).toBe(1);
  });
});
