import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test, vi } from "vitest";
import { sourceUrl } from "../../../helpers/source-path.ts";

import { createRoot } from "../../ink/root.js";
import { selectAgenCTuiGlyphs } from "../../glyphs.js";
import { stringWidth } from "../../ink/stringWidth.js";
import { TeamsDialog } from "./TeamsDialog.js";
import {
  getTeamListFooterText,
  getTeammateDetailFooterText,
  getTeamsDialogPromptPreview,
} from "./TeamsDialog.layout.js";

const teammateStatusMock = vi.hoisted(() => ({
  statuses: [
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
  ],
}));

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
  getBackendByType: () => ({
    hidePane: async () => true,
    killPane: async () => {},
    showPane: async () => true,
    supportsHideShow: true,
  }),
  getCachedBackend: () => ({
    supportsHideShow: true,
  }),
}));
vi.mock("../../../utils/tasks.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../utils/tasks.js")>();
  return {
    ...actual,
    listTasks: async () => [],
    unassignTeammateTasks: async () => ({
      notificationMessage: "tasks unassigned",
    }),
  };
});
vi.mock("../../../utils/teammateMailbox.js", () => ({
  createModeSetRequestMessage: (message: unknown) => message,
  sendShutdownRequestToMailbox: async () => {},
  writeToMailbox: async () => {},
}));
vi.mock("../../../utils/swarm/teamHelpers.js", () => ({
  addHiddenPaneId: () => true,
  removeHiddenPaneId: () => true,
  removeMemberFromTeam: () => true,
  setMemberMode: () => {},
  setMultipleMemberModes: () => {},
}));
vi.mock("../../../utils/execFileNoThrow.js", () => ({
  execFileNoThrow: async () => ({ code: 0, stderr: "", error: "" }),
}));

const source = readFileSync(
  sourceUrl("tui/components/teams/TeamsDialog.tsx"),
  "utf8",
);

async function renderTeamsDialogToText(node: React.ReactNode): Promise<string> {
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

  try {
    root.render(node);
    await new Promise(resolve => setTimeout(resolve, 30));
    return stripAnsi(output);
  } finally {
    root.unmount();
    stdin.end();
  }
}

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
