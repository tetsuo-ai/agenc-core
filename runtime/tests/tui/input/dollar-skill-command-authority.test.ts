import { beforeEach, describe, expect, test, vi } from "vitest";

const authorityMocks = vi.hoisted(() => ({
  addInvokedSkill: vi.fn(),
  registerSkillHooks: vi.fn(),
  restrictedToPluginOnly: vi.fn(() => false),
  sourceAdminTrusted: vi.fn(() => false),
}));

vi.mock("../../../src/bootstrap/state.js", () => ({
  addInvokedSkill: authorityMocks.addInvokedSkill,
  getSessionId: () => "dollar-skill-authority-session",
}));

vi.mock("../../../src/utils/hooks/registerSkillHooks.js", () => ({
  registerSkillHooks: authorityMocks.registerSkillHooks,
}));

vi.mock("../../../src/utils/settings/pluginOnlyPolicy.js", () => ({
  isRestrictedToPluginOnly: authorityMocks.restrictedToPluginOnly,
  isSourceAdminTrusted: authorityMocks.sourceAdminTrusted,
}));

import { loadDollarSkillCommandForTurn } from "../../../src/tui/input/dollar-skill-command.js";

const hooks = {
  UserPromptSubmit: [
    {
      hooks: [{ type: "command", command: "printf approved" }],
    },
  ],
};

function context() {
  return {
    setAppState: vi.fn(),
  } as never;
}

function command(source: string) {
  return {
    type: "prompt" as const,
    name: "authority-skill",
    description: "Exercise skill authority",
    loadedFrom: source === "plugin" ? ("plugin" as const) : ("skills" as const),
    source,
    skillRoot: "/skills/authority-skill",
    hooks,
    allowedTools: ["Bash(git status), Read"],
    model: "grok-4.5",
    effort: "high" as const,
    progressMessage: "loading",
    contentLength: 12,
    getPromptForCommand: async () => [
      { type: "text" as const, text: "authority body" },
    ],
  };
}

describe("dollar skill trust authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorityMocks.restrictedToPluginOnly.mockReturnValue(false);
    authorityMocks.sourceAdminTrusted.mockReturnValue(false);
  });

  test("repository-controlled skills cannot grant hooks, tools, models, or effort", async () => {
    const loaded = await loadDollarSkillCommandForTurn(
      { commandName: "authority-skill", args: "" },
      command("projectSettings") as never,
      context(),
    );

    expect(loaded).toMatchObject({
      skillContent: "authority body",
      allowedTools: [],
      model: undefined,
      effort: undefined,
    });
    expect(loaded.skillInvocation).toBeUndefined();
    expect(authorityMocks.registerSkillHooks).not.toHaveBeenCalled();
    expect(authorityMocks.addInvokedSkill).toHaveBeenCalledOnce();
  });

  test("a user skill carries its model, effort and grants to the turn it starts", async () => {
    const loaded = await loadDollarSkillCommandForTurn(
      { commandName: "authority-skill", args: "" },
      command("userSettings") as never,
      context(),
    );

    expect(loaded.skillInvocation).toEqual({
      name: "authority-skill",
      model: "grok-4.5",
      effort: "high",
      allowedTools: ["Bash(git status)", "Read"],
    });
  });

  test("a skill without settings starts an ordinary turn", async () => {
    const plain = {
      ...command("userSettings"),
      allowedTools: [],
      model: undefined,
      effort: undefined,
    };
    const loaded = await loadDollarSkillCommandForTurn(
      { commandName: "authority-skill", args: "" },
      plain as never,
      context(),
    );

    expect(loaded.skillInvocation).toBeUndefined();
  });

  test("a built-in skill carries only allowlisted grants; a user skill keeps its own", async () => {
    const shellHeavy = [
      "FileRead, exec_command(git status:*)",
      "PowerShell",
      "write_stdin",
      "mcp__terminal__exec_command mcp__terminal__*",
    ];
    const builtIn = {
      ...command("bundled"),
      loadedFrom: "bundled" as const,
      allowedTools: shellHeavy,
    };
    const builtInLoaded = await loadDollarSkillCommandForTurn(
      { commandName: "authority-skill", args: "" },
      builtIn as never,
      context(),
    );
    expect(builtInLoaded.allowedTools).toEqual(["FileRead"]);
    expect(builtInLoaded.skillInvocation?.allowedTools).toEqual(["FileRead"]);

    const userLoaded = await loadDollarSkillCommandForTurn(
      { commandName: "authority-skill", args: "" },
      { ...command("userSettings"), allowedTools: shellHeavy } as never,
      context(),
    );
    expect(userLoaded.allowedTools).toEqual([
      "FileRead",
      "exec_command(git status:*)",
      "PowerShell",
      "write_stdin",
      "mcp__terminal__exec_command",
      "mcp__terminal__*",
    ]);
  });

  test("plugin-only policy rejects user hooks but admits plugin authority", async () => {
    authorityMocks.restrictedToPluginOnly.mockReturnValue(true);
    authorityMocks.sourceAdminTrusted.mockImplementation(
      (source) => source === "plugin",
    );

    const userLoaded = await loadDollarSkillCommandForTurn(
      { commandName: "authority-skill", args: "" },
      command("userSettings") as never,
      context(),
    );
    expect(userLoaded).toMatchObject({
      allowedTools: ["Bash(git status)", "Read"],
      model: "grok-4.5",
      effort: "high",
    });
    expect(authorityMocks.registerSkillHooks).not.toHaveBeenCalled();

    const pluginContext = context();
    const pluginCommand = command("plugin");
    const pluginLoaded = await loadDollarSkillCommandForTurn(
      { commandName: "authority-skill", args: "" },
      pluginCommand as never,
      pluginContext,
    );
    expect(pluginLoaded).toMatchObject({
      allowedTools: ["Bash(git status)", "Read"],
      model: "grok-4.5",
      effort: "high",
    });
    expect(authorityMocks.registerSkillHooks).toHaveBeenCalledOnce();
    expect(authorityMocks.registerSkillHooks).toHaveBeenCalledWith(
      pluginContext.setAppState,
      "dollar-skill-authority-session",
      hooks,
      "authority-skill",
      "/skills/authority-skill",
    );
  });
});
