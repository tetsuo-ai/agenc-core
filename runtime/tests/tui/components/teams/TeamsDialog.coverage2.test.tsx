import { PassThrough } from "node:stream";
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  KeybindingContextName,
  ParsedKeystroke,
} from "../../keybindings/types.js";

type MockTeammateStatus = {
  agentId: string;
  backendType?: "tmux" | "iterm2";
  cwd?: string;
  isHidden: boolean;
  mode?: string;
  name: string;
  status: "idle" | "running";
  tmuxPaneId: string;
};

type HandlerRegistration = {
  action: string;
  context: KeybindingContextName;
  handler: () => void;
};

const teammateStatusMock = vi.hoisted(() => ({
  statuses: [] as MockTeammateStatus[],
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
  },
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
vi.mock("../../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 120, rows: 30 }),
}));
vi.mock("../../ink.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../ink.js")>();
  return {
    ...actual,
    useInput: () => {},
  };
});
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
    listTasks: vi.fn(async () => []),
    unassignTeammateTasks: vi.fn(async () => ({
      notificationMessage: "tasks unassigned",
    })),
  };
});
vi.mock("../../../utils/teammateMailbox.js", () => ({
  createModeSetRequestMessage: (message: unknown) => message,
  sendShutdownRequestToMailbox: mailboxMock.sendShutdownRequestToMailbox,
  writeToMailbox: mailboxMock.writeToMailbox,
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

function defaultTeammateStatuses(): MockTeammateStatus[] {
  return [
    {
      agentId: "agent-fixer",
      backendType: "tmux",
      cwd: "/tmp/work",
      isHidden: false,
      mode: "acceptEdits",
      name: "Fixer",
      status: "running",
      tmuxPaneId: "%1",
    },
    {
      agentId: "agent-planner",
      backendType: "tmux",
      cwd: "/tmp/work",
      isHidden: false,
      mode: "plan",
      name: "Planner",
      status: "running",
      tmuxPaneId: "%2",
    },
  ];
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30));
}

async function waitForRegisteredHandler(
  handlerRegistryRef: React.RefObject<Map<string, Set<HandlerRegistration>>>,
  action: string,
): Promise<HandlerRegistration> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const handler = [...(handlerRegistryRef.current?.get(action) ?? [])][0];
    if (handler) return handler;
    await settle();
  }

  throw new Error(`Timed out waiting for keybinding: ${action}`);
}

async function mountTeamsDialog(node: React.ReactNode): Promise<{
  unmount: () => void;
}> {
  const { createRoot } = await import("../../ink/root.js");
  const stdout = new PassThrough();
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
    unmount: () => {
      root.unmount();
      stdin.end();
      stdout.end();
    },
  };
}

beforeEach(() => {
  teammateStatusMock.statuses = defaultTeammateStatuses();
  backendMock.backend.hidePane.mockClear();
  backendMock.backend.killPane.mockClear();
  backendMock.backend.showPane.mockClear();
  backendMock.cachedBackend = { supportsHideShow: true };
  mailboxMock.sendShutdownRequestToMailbox.mockClear();
  mailboxMock.writeToMailbox.mockClear();
  teamHelpersMock.addHiddenPaneId.mockClear();
  teamHelpersMock.removeHiddenPaneId.mockClear();
  teamHelpersMock.removeMemberFromTeam.mockClear();
  teamHelpersMock.setMemberMode.mockClear();
  teamHelpersMock.setMemberMode.mockReturnValue(true);
  teamHelpersMock.setMultipleMemberModes.mockClear();
  teamHelpersMock.setMultipleMemberModes.mockReturnValue(true);
  execFileNoThrowMock.mockClear();
});

describe("TeamsDialog mode cycling coverage", () => {
  test("resets mixed teammate modes to default through the list keybinding", async () => {
    const { KeybindingProvider } = await import(
      "../../keybindings/KeybindingContext.js"
    );
    const { TeamsDialog } = await import("./TeamsDialog.js");
    const activeContexts = new Set<KeybindingContextName>(["Confirmation"]);
    const pendingChordRef = {
      current: null,
    } as React.RefObject<ParsedKeystroke[] | null>;
    const handlerRegistryRef = {
      current: new Map<string, Set<HandlerRegistration>>(),
    } as React.RefObject<Map<string, Set<HandlerRegistration>>>;
    const harness = await mountTeamsDialog(
      <KeybindingProvider
        activeContexts={activeContexts}
        bindings={[]}
        handlerRegistryRef={handlerRegistryRef}
        pendingChord={null}
        pendingChordRef={pendingChordRef}
        registerActiveContext={context => {
          activeContexts.add(context);
        }}
        setPendingChord={pending => {
          pendingChordRef.current = pending;
        }}
        unregisterActiveContext={context => {
          activeContexts.delete(context);
        }}
      >
        <TeamsDialog initialTeams={[{ name: "alpha" } as never]} onDone={() => {}} />
      </KeybindingProvider>,
    );

    try {
      const cycleModeHandler = await waitForRegisteredHandler(
        handlerRegistryRef,
        "confirm:cycleMode",
      );

      cycleModeHandler.handler();
      await settle();

      expect(teamHelpersMock.setMultipleMemberModes).toHaveBeenCalledWith(
        "alpha",
        [
          { memberName: "Fixer", mode: "default" },
          { memberName: "Planner", mode: "default" },
        ],
      );
      expect(teamHelpersMock.setMemberMode).not.toHaveBeenCalled();
      expect(mailboxMock.writeToMailbox).toHaveBeenCalledTimes(2);
      expect(mailboxMock.writeToMailbox.mock.calls.map(call => call[0])).toEqual([
        "Fixer",
        "Planner",
      ]);
      for (const call of mailboxMock.writeToMailbox.mock.calls) {
        const message = call[1] as { from: string; text: string };
        expect(message.from).toBe("team-lead");
        expect(JSON.parse(message.text)).toEqual({
          from: "team-lead",
          mode: "default",
        });
        expect(call[2]).toBe("alpha");
      }
    } finally {
      harness.unmount();
    }
  });
});
