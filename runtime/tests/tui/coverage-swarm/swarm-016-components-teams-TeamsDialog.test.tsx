import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

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

const keybindingMock = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
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

const detectionMock = vi.hoisted(() => ({
  insideTmux: false,
  leaderPaneId: "%leader" as string | null,
}));

const appStateMock = vi.hoisted(() => ({
  state: {
    teamContext: {
      teammates: {
        "agent-fixer": {},
        "agent-planner": {},
      } as Record<string, unknown>,
    },
    inbox: {
      messages: [] as Array<{ text: string }>,
    },
  },
}));

vi.mock("usehooks-ts", async importOriginal => {
  const actual = await importOriginal<typeof import("usehooks-ts")>();
  return {
    ...actual,
    useInterval: () => {},
  };
});
vi.mock("../../../src/tui/context/overlayContext.js", () => ({
  useRegisterOverlay: () => {},
}));
vi.mock("../../../src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 120, rows: 30 }),
}));
vi.mock("../../../src/tui/ink.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/tui/ink.js")>();
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
vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: (handlers: Record<string, () => void>) => {
    for (const [action, handler] of Object.entries(handlers)) {
      keybindingMock.handlers.set(action, handler);
    }
  },
}));
vi.mock("../../../src/tui/keybindings/useShortcutDisplay.js", () => ({
  useShortcutDisplay: () => "shift+tab",
}));
vi.mock("../../../src/tui/state/AppState.js", () => ({
  useAppState: (selector: (state: unknown) => unknown) =>
    selector({
      toolPermissionContext: {
        isBypassPermissionsModeAvailable: true,
      },
    }),
  useSetAppState: () => (updater: (prev: typeof appStateMock.state) => typeof appStateMock.state) => {
    appStateMock.state = updater(appStateMock.state);
  },
}));
vi.mock("../../../src/utils/teamDiscovery.js", () => ({
  getTeammateStatuses: () => teammateStatusMock.statuses,
}));
vi.mock("../../../src/utils/swarm/backends/registry.js", () => ({
  ensureBackendsRegistered: async () => {},
  getBackendByType: () => backendMock.backend,
  getCachedBackend: () => backendMock.cachedBackend,
}));
vi.mock("../../../src/utils/tasks.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/utils/tasks.js")>();
  return {
    ...actual,
    listTasks: tasksMock.listTasks,
    unassignTeammateTasks: tasksMock.unassignTeammateTasks,
  };
});
vi.mock("../../../src/utils/teammateMailbox.js", () => ({
  createModeSetRequestMessage: (message: unknown) => message,
  sendShutdownRequestToMailbox: mailboxMock.sendShutdownRequestToMailbox,
  writeToMailbox: mailboxMock.writeToMailbox,
}));
vi.mock("../../../src/utils/swarm/teamHelpers.js", () => ({
  addHiddenPaneId: teamHelpersMock.addHiddenPaneId,
  removeHiddenPaneId: teamHelpersMock.removeHiddenPaneId,
  removeMemberFromTeam: teamHelpersMock.removeMemberFromTeam,
  setMemberMode: teamHelpersMock.setMemberMode,
  setMultipleMemberModes: teamHelpersMock.setMultipleMemberModes,
}));
vi.mock("../../../src/utils/execFileNoThrow.js", () => ({
  execFileNoThrow: execFileNoThrowMock,
}));
vi.mock("../../../src/utils/swarm/backends/detection.js", () => ({
  getLeaderPaneId: () => detectionMock.leaderPaneId,
  IT2_COMMAND: "it2",
  isInsideTmuxSync: () => detectionMock.insideTmux,
}));

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
      model: "gpt-5.4",
      name: "Fixer",
      prompt: "Fix the failing tests",
      status: "running",
      tmuxPaneId: "%1",
    },
    {
      agentId: "agent-planner",
      backendType: "tmux",
      cwd: "/tmp/work",
      isHidden: true,
      mode: "plan",
      model: "grok-4.3",
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

async function createTeamsDialogHarness(): Promise<{
  getText: () => string;
  press: (
    input: string,
    keyOverrides?: Record<string, boolean>,
    waitMs?: number,
  ) => Promise<void>;
  unmount: () => void;
}> {
  const { createRoot } = await import("../../../src/tui/ink/root.js");
  const { TeamsDialog } = await import(
    "../../../src/tui/components/teams/TeamsDialog.js"
  );
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

  root.render(
    <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />,
  );
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

beforeEach(() => {
  teammateStatusMock.statuses = defaultTeammateStatuses();
  inputMock.handlers.clear();
  keybindingMock.handlers.clear();
  backendMock.backend.hidePane.mockReset();
  backendMock.backend.hidePane.mockResolvedValue(true);
  backendMock.backend.killPane.mockReset();
  backendMock.backend.killPane.mockResolvedValue(undefined);
  backendMock.backend.showPane.mockReset();
  backendMock.backend.showPane.mockResolvedValue(true);
  backendMock.backend.supportsHideShow = true;
  backendMock.cachedBackend = { supportsHideShow: true };
  tasksMock.listTasks.mockReset();
  tasksMock.listTasks.mockResolvedValue([]);
  tasksMock.unassignTeammateTasks.mockReset();
  tasksMock.unassignTeammateTasks.mockResolvedValue({
    notificationMessage: "tasks unassigned",
  });
  mailboxMock.sendShutdownRequestToMailbox.mockReset();
  mailboxMock.sendShutdownRequestToMailbox.mockResolvedValue(undefined);
  mailboxMock.writeToMailbox.mockReset();
  mailboxMock.writeToMailbox.mockResolvedValue(undefined);
  teamHelpersMock.addHiddenPaneId.mockReset();
  teamHelpersMock.addHiddenPaneId.mockReturnValue(true);
  teamHelpersMock.removeHiddenPaneId.mockReset();
  teamHelpersMock.removeHiddenPaneId.mockReturnValue(true);
  teamHelpersMock.removeMemberFromTeam.mockReset();
  teamHelpersMock.removeMemberFromTeam.mockReturnValue(true);
  teamHelpersMock.setMemberMode.mockReset();
  teamHelpersMock.setMultipleMemberModes.mockReset();
  execFileNoThrowMock.mockReset();
  execFileNoThrowMock.mockResolvedValue({ code: 0, stderr: "", error: "" });
  detectionMock.insideTmux = false;
  detectionMock.leaderPaneId = "%leader";
  appStateMock.state = {
    teamContext: {
      teammates: {
        "agent-fixer": {},
        "agent-planner": {},
      },
    },
    inbox: {
      messages: [],
    },
  };
});

describe("TeamsDialog coverage-swarm detail actions", () => {
  test("cycles a teammate mode from detail view", async () => {
    const harness = await createTeamsDialogHarness();

    try {
      await harness.press("\r", { return: true });
      keybindingMock.handlers.get("confirm:cycleMode")?.();
      await settle();

      expect(teamHelpersMock.setMemberMode).toHaveBeenCalledWith(
        "alpha",
        "Fixer",
        "plan",
      );
      expect(mailboxMock.writeToMailbox).toHaveBeenCalledWith(
        "Fixer",
        expect.objectContaining({
          from: "team-lead",
          text: JSON.stringify({ mode: "plan", from: "team-lead" }),
        }),
        "alpha",
      );
      expect(teamHelpersMock.setMultipleMemberModes).not.toHaveBeenCalled();
    } finally {
      harness.unmount();
    }
  });

  test("shutdown from detail view requests shutdown and returns to list", async () => {
    const harness = await createTeamsDialogHarness();

    try {
      await harness.press("\r", { return: true });
      await harness.press("s", {}, 80);

      expect(mailboxMock.sendShutdownRequestToMailbox).toHaveBeenCalledWith(
        "Fixer",
        "alpha",
        "Graceful shutdown requested by team lead",
      );
      expect(harness.getText()).toContain("Team alpha");
      expect(harness.getText()).toContain("2 teammates");
    } finally {
      harness.unmount();
    }
  });

  test("kill from detail view updates team context and inbox", async () => {
    const harness = await createTeamsDialogHarness();

    try {
      await harness.press("\r", { return: true });
      await harness.press("k", {}, 80);

      expect(backendMock.backend.killPane).toHaveBeenCalledWith("%1", true);
      expect(teamHelpersMock.removeMemberFromTeam).toHaveBeenCalledWith(
        "alpha",
        "%1",
      );
      expect(appStateMock.state.teamContext.teammates).not.toHaveProperty(
        "agent-fixer",
      );
      expect(JSON.parse(appStateMock.state.inbox.messages[0]?.text ?? "{}")).toEqual({
        type: "teammate_terminated",
        message: "tasks unassigned",
      });
      expect(harness.getText()).toContain("Team alpha");
    } finally {
      harness.unmount();
    }
  });

  test("kill from detail view surfaces task cleanup failures", async () => {
    tasksMock.unassignTeammateTasks.mockRejectedValueOnce(
      new Error("task store offline"),
    );
    const harness = await createTeamsDialogHarness();

    try {
      await harness.press("\r", { return: true });
      await harness.press("k", {}, 80);

      expect(harness.getText()).toContain(
        "Killed @Fixer, but task cleanup failed: task store offline",
      );
    } finally {
      harness.unmount();
    }
  });
});

describe("TeamsDialog coverage-swarm pane and backend branches", () => {
  test("uses iterm2 focus when viewing an iterm teammate output", async () => {
    teammateStatusMock.statuses = [
      {
        ...defaultTeammateStatuses()[0],
        backendType: "iterm2",
        tmuxPaneId: "session-1",
      },
    ];
    const harness = await createTeamsDialogHarness();

    try {
      await harness.press("\r", { return: true });
      await harness.press("\r", { return: true }, 80);

      expect(execFileNoThrowMock).toHaveBeenCalledWith("it2", [
        "session",
        "focus",
        "-s",
        "session-1",
      ]);
    } finally {
      harness.unmount();
    }
  });

  test("uses the current tmux server when already inside tmux", async () => {
    detectionMock.insideTmux = true;
    const harness = await createTeamsDialogHarness();

    try {
      await harness.press("\r", { return: true });
      await harness.press("\r", { return: true }, 80);

      expect(execFileNoThrowMock).toHaveBeenCalledWith("tmux", [
        "select-pane",
        "-t",
        "%1",
      ]);
    } finally {
      harness.unmount();
    }
  });

  test("falls back to exit code when view-output returns no error text", async () => {
    execFileNoThrowMock.mockResolvedValueOnce({
      code: 7,
      error: "",
      stderr: "",
    });
    const harness = await createTeamsDialogHarness();

    try {
      await harness.press("\r", { return: true });
      await harness.press("\r", { return: true }, 80);

      expect(harness.getText()).toContain(
        "Cannot view teammate output: exit code 7",
      );
    } finally {
      harness.unmount();
    }
  });

  test("surfaces individual hide metadata and backend failures", async () => {
    teammateStatusMock.statuses = [
      {
        ...defaultTeammateStatuses()[0],
        tmuxPaneId: "",
      },
    ];
    const missingMetadataHarness = await createTeamsDialogHarness();
    try {
      await missingMetadataHarness.press("h", {}, 80);
      expect(missingMetadataHarness.getText()).toContain(
        "Cannot hide @Fixer: missing pane metadata.",
      );
    } finally {
      missingMetadataHarness.unmount();
    }

    backendMock.backend.supportsHideShow = false;
    teammateStatusMock.statuses = defaultTeammateStatuses();
    const unsupportedHarness = await createTeamsDialogHarness();
    try {
      await unsupportedHarness.press("h", {}, 80);
      expect(unsupportedHarness.getText()).toContain(
        "Cannot hide @Fixer: backend does not support pane visibility.",
      );
    } finally {
      unsupportedHarness.unmount();
    }

    backendMock.backend.supportsHideShow = true;
    teammateStatusMock.statuses = defaultTeammateStatuses();
    backendMock.backend.hidePane.mockResolvedValueOnce(false);
    const refusedHarness = await createTeamsDialogHarness();
    try {
      await refusedHarness.press("h", {}, 80);
      expect(refusedHarness.getText()).toContain(
        "Cannot hide @Fixer: backend refused the hide request.",
      );
    } finally {
      refusedHarness.unmount();
    }
  });

  test("surfaces hidden-state write failures for hide and show", async () => {
    teamHelpersMock.addHiddenPaneId.mockReturnValueOnce(false);
    const hideHarness = await createTeamsDialogHarness();
    try {
      await hideHarness.press("h", {}, 80);
      expect(hideHarness.getText()).toContain(
        "Hidden @Fixer, but could not record hidden state for team alpha.",
      );
    } finally {
      hideHarness.unmount();
    }

    teammateStatusMock.statuses = [
      {
        ...defaultTeammateStatuses()[0],
        isHidden: true,
      },
    ];
    teamHelpersMock.removeHiddenPaneId.mockReturnValueOnce(false);
    const showHarness = await createTeamsDialogHarness();
    try {
      await showHarness.press("h", {}, 80);
      expect(showHarness.getText()).toContain(
        "Shown @Fixer, but could not update hidden state for team alpha.",
      );
    } finally {
      showHarness.unmount();
    }
  });

  test("surfaces show target and backend refusal failures", async () => {
    teammateStatusMock.statuses = [
      {
        ...defaultTeammateStatuses()[0],
        isHidden: true,
      },
    ];
    detectionMock.insideTmux = true;
    detectionMock.leaderPaneId = "%1";
    const noTargetHarness = await createTeamsDialogHarness();
    try {
      await noTargetHarness.press("h", {}, 80);
      expect(noTargetHarness.getText()).toContain(
        "Cannot show @Fixer: no valid target pane is available.",
      );
    } finally {
      noTargetHarness.unmount();
    }

    detectionMock.insideTmux = false;
    backendMock.backend.showPane.mockResolvedValueOnce(false);
    const refusedHarness = await createTeamsDialogHarness();
    try {
      await refusedHarness.press("h", {}, 80);
      expect(refusedHarness.getText()).toContain(
        "Cannot show @Fixer: backend refused the show request.",
      );
    } finally {
      refusedHarness.unmount();
    }
  });

  test("surfaces bulk visibility and prune failures", async () => {
    backendMock.backend.hidePane.mockResolvedValueOnce(false);
    const bulkHarness = await createTeamsDialogHarness();
    try {
      await bulkHarness.press("H", {}, 80);
      expect(bulkHarness.getText()).toContain(
        "Cannot hide @Fixer: backend refused the hide request.",
      );
    } finally {
      bulkHarness.unmount();
    }

    teammateStatusMock.statuses = [
      {
        ...defaultTeammateStatuses()[1],
        backendType: undefined,
      },
    ];
    const pruneHarness = await createTeamsDialogHarness();
    try {
      await pruneHarness.press("p", {}, 80);
      expect(pruneHarness.getText()).toContain(
        "Cannot kill @Planner: missing pane backend metadata.",
      );
    } finally {
      pruneHarness.unmount();
    }
  });
});
