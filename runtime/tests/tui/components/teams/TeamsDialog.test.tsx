import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { sourceUrl } from "../../../helpers/source-path.ts";

import { createRoot } from "../../ink/root.js";
import { selectAgenCTuiGlyphs } from "../../glyphs.js";
import { stringWidth } from "../../ink/stringWidth.js";
import {
  getSwarmSocketName,
  SWARM_SESSION_NAME,
  SWARM_VIEW_WINDOW_NAME,
} from "../../../utils/swarm/constants.js";
import { TeamsDialog } from "./TeamsDialog.js";
import {
  getTeamListFooterText,
  getTeammateDetailFooterText,
  getTeamsDialogPromptPreview,
} from "./TeamsDialog.layout.js";

type MockTeammateStatus = {
  agentId: string;
  backendType?: "tmux" | "iterm2";
  color?: string;
  cwd?: string;
  isHidden: boolean;
  mode?: string;
  model?: string;
  name: string;
  prompt?: string;
  status: "idle" | "running";
  tmuxPaneId: string;
  worktreePath?: string;
};

const teammateStatusMock = vi.hoisted(() => ({
  statuses: [] as MockTeammateStatus[],
}));

const inputMock = vi.hoisted(() => ({
  handlers: new Set<(input: string, key: Record<string, boolean>) => void>(),
}));

const backendMock = vi.hoisted(() => ({
  backend: {
    hidePane: vi.fn(async () => true),
    killPane: vi.fn(async () => {}),
    showPane: vi.fn(async () => true),
    supportsHideShow: true,
  },
  cachedBackend: {
    supportsHideShow: true,
  } as { supportsHideShow: boolean } | null,
}));

const tasksMock = vi.hoisted(() => ({
  listTasks: vi.fn(async () => []),
  unassignTeammateTasks: vi.fn(async () => ({
    notificationMessage: "tasks unassigned",
  })),
}));

const mailboxMock = vi.hoisted(() => ({
  sendShutdownRequestToMailbox: vi.fn(async () => {}),
  writeToMailbox: vi.fn(async () => {}),
}));

const logMock = vi.hoisted(() => ({
  logError: vi.fn(),
}));

const teamHelpersMock = vi.hoisted(() => ({
  addHiddenPaneId: vi.fn(() => true),
  removeHiddenPaneId: vi.fn(() => true),
  removeMemberFromTeam: vi.fn(() => true),
  setMemberMode: vi.fn(),
  setMultipleMemberModes: vi.fn(),
}));

const execFileNoThrowMock = vi.hoisted(() =>
  vi.fn(async () => ({ code: 0, stderr: "", error: "" })),
);

vi.mock("usehooks-ts", async importOriginal => {
  const actual = await importOriginal<typeof import("usehooks-ts")>();
  return {
    ...actual,
    useInterval: () => {},
  };
});
vi.mock("../../context/overlayContext", () => ({
  useRegisterOverlay: () => {},
}));
vi.mock("../../ink.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../ink.js")>();
  const ReactModule = await import("react");

  return {
    ...actual,
    useInput: (
      handler: (input: string, key: Record<string, boolean>) => void,
    ) => {
      const handlerRef = ReactModule.useRef(handler);
      handlerRef.current = handler;
      ReactModule.useEffect(() => {
        const currentHandler = (input: string, key: Record<string, boolean>) => {
          handlerRef.current(input, key);
        };
        inputMock.handlers.add(currentHandler);
        return () => {
          inputMock.handlers.delete(currentHandler);
        };
      }, []);
    },
  };
});
vi.mock("../../keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: () => {},
}));
vi.mock("../../keybindings/useShortcutDisplay.js", () => ({
  useShortcutDisplay: () => "shift+tab",
}));
vi.mock("../../state/AppState.js", () => ({
  useAppState: (selector: (state: unknown) => unknown) =>
    selector({
      toolPermissionContext: {
        isBypassPermissionsModeAvailable: true,
      },
    }),
  useSetAppState: () => () => {},
}));
vi.mock("../../../utils/teamDiscovery.js", () => ({
  getTeammateStatuses: () => teammateStatusMock.statuses,
}));
vi.mock("../../../utils/swarm/backends/registry.js", () => ({
  ensureBackendsRegistered: async () => {},
  getBackendByType: () => backendMock.backend,
  getCachedBackend: () => backendMock.cachedBackend,
}));
vi.mock("../../../utils/tasks.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../utils/tasks.js")>();
  return {
    ...actual,
    listTasks: tasksMock.listTasks,
    unassignTeammateTasks: tasksMock.unassignTeammateTasks,
  };
});
vi.mock("../../../utils/teammateMailbox.js", () => ({
  createModeSetRequestMessage: (message: unknown) => message,
  sendShutdownRequestToMailbox: mailboxMock.sendShutdownRequestToMailbox,
  writeToMailbox: mailboxMock.writeToMailbox,
}));
vi.mock("../../../utils/log.js", () => ({
  logError: logMock.logError,
}));
vi.mock("../../../utils/swarm/teamHelpers.js", () => ({
  addHiddenPaneId: teamHelpersMock.addHiddenPaneId,
  removeHiddenPaneId: teamHelpersMock.removeHiddenPaneId,
  removeMemberFromTeam: teamHelpersMock.removeMemberFromTeam,
  setMemberMode: teamHelpersMock.setMemberMode,
  setMultipleMemberModes: teamHelpersMock.setMultipleMemberModes,
}));
vi.mock("../../../utils/execFileNoThrow.js", () => ({
  execFileNoThrow: execFileNoThrowMock,
}));
vi.mock("../../../utils/swarm/backends/detection.js", () => ({
  getLeaderPaneId: () => "%leader",
  IT2_COMMAND: "it2",
  isInsideTmuxSync: () => false,
}));

const source = readFileSync(
  sourceUrl("tui/components/teams/TeamsDialog.tsx"),
  "utf8",
);

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";

function defaultTeammateStatuses(): MockTeammateStatus[] {
  return [
    {
      agentId: "agent-fixer",
      backendType: "tmux",
      color: "purple",
      cwd: "/tmp/work",
      isHidden: false,
      mode: "acceptEdits",
      model: "grok-4.3",
      name: "Fixer",
      prompt: "Fix the failing tests",
      status: "running",
      tmuxPaneId: "%1",
    },
    {
      agentId: "agent-planner",
      backendType: "tmux",
      color: "cyan",
      cwd: "/tmp/work",
      isHidden: true,
      mode: "plan",
      model: "gpt-5.4",
      name: "Planner",
      prompt: "Plan the next task",
      status: "idle",
      tmuxPaneId: "%2",
    },
  ];
}

function key(overrides: Record<string, boolean> = {}): Record<string, boolean> {
  return {
    downArrow: false,
    leftArrow: false,
    return: false,
    upArrow: false,
    ...overrides,
  };
}

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null;
  let cursor = 0;

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor);
    if (start === -1) break;

    const contentStart = start + SYNC_START.length;
    const end = output.indexOf(SYNC_END, contentStart);
    if (end === -1) break;

    const frame = output.slice(contentStart, end);
    if (frame.trim().length > 0) {
      lastFrame = frame;
    }
    cursor = end + SYNC_END.length;
  }

  return lastFrame ?? output;
}

async function settle(ms = 30): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function createTeamsDialogHarness(node: React.ReactNode): Promise<{
  getText: () => string;
  press: (
    input: string,
    keyOverrides?: Record<string, boolean>,
    waitMs?: number,
  ) => Promise<void>;
  unmount: () => void;
}> {
  let output = "";
  const stdout = new PassThrough();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = 120;

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  root.render(node);
  await settle();

  return {
    getText: () => stripAnsi(extractLastFrame(output)),
    press: async (
      input: string,
      keyOverrides: Record<string, boolean> = {},
      waitMs = 40,
    ) => {
      for (const handler of [...inputMock.handlers]) {
        handler(input, key(keyOverrides));
      }
      await settle(waitMs);
    },
    unmount: () => {
      root.unmount();
      stdin.end();
      stdout.end();
    },
  };
}

async function renderTeamsDialogToText(node: React.ReactNode): Promise<string> {
  const harness = await createTeamsDialogHarness(node);
  try {
    return harness.getText();
  } finally {
    harness.unmount();
  }
}

beforeEach(() => {
  teammateStatusMock.statuses = defaultTeammateStatuses();
  inputMock.handlers.clear();
  backendMock.backend.hidePane.mockClear();
  backendMock.backend.killPane.mockClear();
  backendMock.backend.showPane.mockClear();
  backendMock.backend.supportsHideShow = true;
  backendMock.cachedBackend = { supportsHideShow: true };
  tasksMock.listTasks.mockReset();
  tasksMock.listTasks.mockResolvedValue([]);
  tasksMock.unassignTeammateTasks.mockClear();
  tasksMock.unassignTeammateTasks.mockResolvedValue({
    notificationMessage: "tasks unassigned",
  });
  mailboxMock.sendShutdownRequestToMailbox.mockClear();
  mailboxMock.writeToMailbox.mockClear();
  logMock.logError.mockClear();
  teamHelpersMock.addHiddenPaneId.mockClear();
  teamHelpersMock.removeHiddenPaneId.mockClear();
  teamHelpersMock.removeMemberFromTeam.mockClear();
  teamHelpersMock.setMemberMode.mockClear();
  teamHelpersMock.setMemberMode.mockReturnValue(true);
  teamHelpersMock.setMultipleMemberModes.mockClear();
  teamHelpersMock.setMultipleMemberModes.mockReturnValue(true);
  execFileNoThrowMock.mockReset();
  execFileNoThrowMock.mockResolvedValue({ code: 0, stderr: "", error: "" });
});

describe("TeamsDialog pane visibility actions", () => {
  test("hide calls backend before mutating hidden-pane state", () => {
    expect(source).toMatch(/backend\.hidePane\(teammate\.tmuxPaneId/);
    expect(source.indexOf("if (!hidden)")).toBeLessThan(
      source.indexOf("addHiddenPaneId(teamName, teammate.tmuxPaneId)"),
    );
  });

  test("show calls backend before removing hidden-pane state", () => {
    expect(source).toMatch(/backend\.showPane\(/);
    expect(source.indexOf("if (!shown)")).toBeLessThan(
      source.indexOf("removeHiddenPaneId(teamName, teammate.tmuxPaneId)"),
    );
  });

  test("show never uses the hidden teammate pane as its own join target", () => {
    expect(source).not.toContain("process.env.TMUX_PANE ?? teammate.tmuxPaneId");
    expect(source).toContain("`${SWARM_SESSION_NAME}:${SWARM_VIEW_WINDOW_NAME}`");
    expect(source).toMatch(/if \(targetPane === teammatePaneId\) return null/);
  });

  test("missing pane id or backend returns before backend lookup", () => {
    expect(source).toMatch(/if \(!teammate\.tmuxPaneId \|\| !teammate\.backendType\) \{/);
    expect(source).toContain("missing pane metadata");
  });

  test("team actions render failure messages instead of only logging", () => {
    expect(source).toContain("Cannot kill @");
    expect(source).toContain("Cannot view teammate output");
    expect(source).toContain("Cannot hide or show");
    expect(source).toContain("<ActionNotice notice={actionNotice} />");
  });

  test("task rows expose loading/error/empty states and avoid raw symbolic bullets", () => {
    expect(source).toContain("Loading tasks...");
    expect(source).toContain("Unable to load tasks:");
    expect(source).toContain("No tasks");
    expect(source).not.toContain("\\u25FC");
    expect(source).not.toContain("figures.tick");
  });
});

describe("TeamsDialog rendering", () => {
  test("renders teammate list rows with mode, model, idle, and hidden state", async () => {
    const output = await renderTeamsDialogToText(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    expect(output).toContain("Team alpha");
    expect(output).toContain("2 teammates");
    expect(output).toContain("@Fixer");
    expect(output).toContain("grok-4.3");
    expect(output).toContain("@Planner");
    expect(output).toContain("gpt-5.4");
    expect(output).toContain("[hidden]");
    expect(output).toContain("[idle]");
    expect(output).toContain("shift+tab");
  });

  test("renders empty team list state", async () => {
    teammateStatusMock.statuses = [];

    const output = await renderTeamsDialogToText(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    expect(output).toContain("Team alpha");
    expect(output).toContain("0 teammates");
    expect(output).toContain("No teammates");
  });

  test("opens teammate detail with loaded task rows, prompt preview, and worktree subtitle", async () => {
    const longPrompt = "Implement TeamsDialog coverage ".repeat(8);
    teammateStatusMock.statuses = [
      {
        ...defaultTeammateStatuses()[0],
        prompt: longPrompt,
        worktreePath: "/tmp/worktrees/fixer",
      },
    ];
    tasksMock.listTasks.mockResolvedValue([
      {
        id: "task-done",
        owner: "agent-fixer",
        status: "completed",
        subject: "Ship tests",
      },
      {
        id: "task-active",
        owner: "Fixer",
        status: "in_progress",
        subject: "Cover detail state",
      },
      {
        id: "task-other",
        owner: "agent-other",
        status: "pending",
        subject: "Ignore unrelated task",
      },
    ] as never);
    const harness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await harness.press("\r", { return: true }, 80);
      const output = harness.getText();

      expect(output).toContain("@Fixer");
      expect(output).toContain("grok-4.3");
      expect(output).toContain("worktree: /tmp/worktrees/fixer");
      expect(output).toContain("Tasks");
      expect(output).toContain("done Ship tests");
      expect(output).toContain("in_progress Cover detail state");
      expect(output).not.toContain("Ignore unrelated task");
      expect(output).toContain("Prompt");
      expect(output).toContain("(p to expand)");
      expect(output).toContain("Left back");
    } finally {
      harness.unmount();
    }
  });

  test("renders task loading and error states in teammate detail", async () => {
    tasksMock.listTasks.mockReturnValue(new Promise(() => {}) as never);
    const loadingHarness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await loadingHarness.press("\r", { return: true });
      expect(loadingHarness.getText()).toContain("Loading tasks...");
    } finally {
      loadingHarness.unmount();
    }

    tasksMock.listTasks.mockRejectedValue(new Error("task store offline"));
    const errorHarness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await errorHarness.press("\r", { return: true }, 80);
      expect(errorHarness.getText()).toContain(
        "Unable to load tasks: task store offline",
      );
    } finally {
      errorHarness.unmount();
    }
  });

  test("toggles teammate prompt expansion from detail view", async () => {
    teammateStatusMock.statuses = [
      {
        ...defaultTeammateStatuses()[0],
        prompt: `${"Keep this prompt collapsed ".repeat(8)}EXPANDED-TAIL`,
      },
    ];
    const harness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await harness.press("\r", { return: true }, 80);
      expect(harness.getText()).toContain("(p to expand)");
      expect(harness.getText()).not.toContain("EXPANDED-TAIL");

      await harness.press("p");
      const output = harness.getText();
      expect(output).toContain("EXPANDED-TAIL");
      expect(output).not.toContain("(p to expand)");
    } finally {
      harness.unmount();
    }
  });

  test("renders visibility unsupported notices for individual and bulk actions", async () => {
    backendMock.cachedBackend = { supportsHideShow: false };
    const harness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await harness.press("h");
      expect(harness.getText()).toContain(
        "Cannot hide or show @Fixer: current backend does not support pane visibility.",
      );

      await harness.press("H");
      expect(harness.getText()).toContain(
        "Cannot hide or show all teammates: current backend does not support pane visibility.",
      );
    } finally {
      harness.unmount();
    }
  });

  test("renders view-output failure notice and keeps dialog open", async () => {
    const onDone = vi.fn();
    execFileNoThrowMock.mockResolvedValue({
      code: 1,
      error: "",
      stderr: "pane disappeared",
    });
    const harness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={onDone} />,
    );

    try {
      await harness.press("\r", { return: true }, 80);
      await harness.press("\r", { return: true }, 80);

      expect(harness.getText()).toContain(
        "Cannot view teammate output: pane disappeared",
      );
      expect(harness.getText()).toContain("@Fixer");
      expect(onDone).not.toHaveBeenCalled();
    } finally {
      harness.unmount();
    }
  });

  test("logs rejected view-output commands and keeps dialog open", async () => {
    const onDone = vi.fn();
    const error = new Error("pane command crashed");
    execFileNoThrowMock.mockRejectedValue(error);
    const harness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={onDone} />,
    );

    try {
      await harness.press("\r", { return: true }, 80);
      await harness.press("\r", { return: true }, 80);

      expect(logMock.logError).toHaveBeenCalledWith(error);
      expect(harness.getText()).toContain(
        "Cannot view teammate output: pane command crashed",
      );
      expect(harness.getText()).toContain("@Fixer");
      expect(onDone).not.toHaveBeenCalled();
    } finally {
      harness.unmount();
    }
  });

  test("navigates the list, opens teammate detail, and returns with left arrow", async () => {
    const harness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await harness.press("", { downArrow: true });
      await harness.press("\r", { return: true }, 80);
      expect(harness.getText()).toContain("@Planner");

      await harness.press("", { leftArrow: true });
      const output = harness.getText();
      expect(output).toContain("Team alpha");
      expect(output).toContain("@Fixer");
      expect(output).toContain("@Planner");

      await harness.press("", { upArrow: true });
      await harness.press("\r", { return: true }, 80);
      expect(harness.getText()).toContain("@Fixer");
    } finally {
      harness.unmount();
    }
  });

  test("successful teammate output selection closes the dialog", async () => {
    const onDone = vi.fn();
    const harness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={onDone} />,
    );

    try {
      await harness.press("\r", { return: true }, 80);
      await harness.press("\r", { return: true }, 80);

      expect(execFileNoThrowMock).toHaveBeenCalledWith("tmux", [
        "-L",
        getSwarmSocketName(),
        "select-pane",
        "-t",
        "%1",
      ]);
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      harness.unmount();
    }
  });

  test("kill actions update team state and surface failures", async () => {
    const harness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await harness.press("k", {}, 80);

      expect(backendMock.backend.killPane).toHaveBeenCalledWith("%1", true);
      expect(teamHelpersMock.removeMemberFromTeam).toHaveBeenCalledWith(
        "alpha",
        "%1",
      );
      expect(tasksMock.unassignTeammateTasks).toHaveBeenCalledWith(
        "alpha",
        "agent-fixer",
        "Fixer",
        "terminated",
      );
    } finally {
      harness.unmount();
    }

    teammateStatusMock.statuses = [
      {
        ...defaultTeammateStatuses()[0],
        backendType: undefined,
        name: "Legacy",
      },
    ];
    const failureHarness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await failureHarness.press("k", {}, 80);

      expect(failureHarness.getText()).toContain(
        "Cannot kill @Legacy: missing pane backend metadata.",
      );
    } finally {
      failureHarness.unmount();
    }
  });

  test("surfaces team config removal exceptions during kill actions", async () => {
    const error = new Error("team file locked");
    teamHelpersMock.removeMemberFromTeam.mockImplementationOnce(() => {
      throw error;
    });
    const harness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await harness.press("k", {}, 80);

      expect(harness.getText()).toContain(
        "Killed @Fixer, but could not remove it from team alpha: team file locked",
      );
      expect(logMock.logError).toHaveBeenCalledWith(error);
    } finally {
      harness.unmount();
    }
  });

  test("shutdown actions call teammate mailboxes and surface errors", async () => {
    const harness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await harness.press("s", {}, 80);
      expect(mailboxMock.sendShutdownRequestToMailbox).toHaveBeenCalledWith(
        "Fixer",
        "alpha",
        "Graceful shutdown requested by team lead",
      );

      mailboxMock.sendShutdownRequestToMailbox.mockRejectedValueOnce(
        new Error("mailbox offline"),
      );
      await harness.press("s", {}, 80);

      expect(harness.getText()).toContain(
        "Cannot request shutdown for @Fixer: mailbox offline",
      );
    } finally {
      harness.unmount();
    }
  });

  test("individual hide and show actions use backend visibility APIs", async () => {
    const harness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await harness.press("h", {}, 80);
      expect(backendMock.backend.hidePane).toHaveBeenCalledWith("%1", true);
      expect(teamHelpersMock.addHiddenPaneId).toHaveBeenCalledWith("alpha", "%1");

      await harness.press("", { downArrow: true });
      await harness.press("h", {}, 80);
      expect(backendMock.backend.showPane).toHaveBeenCalledWith(
        "%2",
        `${SWARM_SESSION_NAME}:${SWARM_VIEW_WINDOW_NAME}`,
        true,
      );
      expect(teamHelpersMock.removeHiddenPaneId).toHaveBeenCalledWith(
        "alpha",
        "%2",
      );
    } finally {
      harness.unmount();
    }
  });

  test("bulk hide/show and prune operate on teammate groups", async () => {
    const harness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await harness.press("H", {}, 80);
      expect(backendMock.backend.hidePane).toHaveBeenCalledWith("%1", true);
      expect(backendMock.backend.hidePane).toHaveBeenCalledWith("%2", true);
    } finally {
      harness.unmount();
    }

    teammateStatusMock.statuses = defaultTeammateStatuses().map(teammate => ({
      ...teammate,
      isHidden: true,
    }));
    backendMock.backend.hidePane.mockClear();
    const showHarness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await showHarness.press("H", {}, 80);
      expect(backendMock.backend.showPane).toHaveBeenCalledWith(
        "%1",
        `${SWARM_SESSION_NAME}:${SWARM_VIEW_WINDOW_NAME}`,
        true,
      );
      expect(backendMock.backend.showPane).toHaveBeenCalledWith(
        "%2",
        `${SWARM_SESSION_NAME}:${SWARM_VIEW_WINDOW_NAME}`,
        true,
      );
    } finally {
      showHarness.unmount();
    }

    backendMock.backend.killPane.mockClear();
    teammateStatusMock.statuses = defaultTeammateStatuses();
    const pruneHarness = await createTeamsDialogHarness(
      <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
    );

    try {
      await pruneHarness.press("p", {}, 80);
      expect(backendMock.backend.killPane).toHaveBeenCalledTimes(1);
      expect(backendMock.backend.killPane).toHaveBeenCalledWith("%2", true);
    } finally {
      pruneHarness.unmount();
    }
  });
});

describe("TeamsDialog layout helpers", () => {
  test("ASCII footers use shared glyphs and clamp to terminal width", () => {
    const glyphs = selectAgenCTuiGlyphs({ AGENC_TUI_GLYPHS: "ascii" });
    const listFooter = getTeamListFooterText({
      glyphs,
      supportsHideShow: true,
      cycleModeShortcut: "shift+tab",
      columns: 44,
    });
    const detailFooter = getTeammateDetailFooterText({
      glyphs,
      supportsHideShow: true,
      cycleModeShortcut: "shift+tab",
      columns: 44,
    });

    expect(stringWidth(listFooter)).toBeLessThanOrEqual(43);
    expect(stringWidth(detailFooter)).toBeLessThanOrEqual(43);
    expect(listFooter).toContain("^/v select");
    expect(detailFooter).toContain("Left back");
    expect(listFooter).not.toContain("·");
    expect(detailFooter).not.toContain("←");
  });

  test("prompt preview reserves space for the expand hint and ASCII ellipsis", () => {
    const preview = getTeamsDialogPromptPreview(
      "write a detailed implementation plan ".repeat(8),
      40,
      false,
      "...",
    );

    expect(preview.showExpandHint).toBe(true);
    expect(preview.text).toContain("...");
    expect(stringWidth(`${preview.text} (p to expand)`)).toBeLessThanOrEqual(36);
  });

  test("expanded prompt preview returns full prompt", () => {
    const prompt = "write a detailed implementation plan ".repeat(8);
    expect(getTeamsDialogPromptPreview(prompt, 40, true, "...")).toEqual({
      text: prompt,
      showExpandHint: false,
    });
  });
});
