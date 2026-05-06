import { beforeEach, describe, expect, it, vi } from "vitest";

import { processSlashCommand } from "./processSlashCommand.js";

const mocks = vi.hoisted(() => ({
  commands: [] as Array<{
    name: string;
    type: "local";
    isSensitive?: boolean;
    load: () => Promise<{
      call: (args: string) => Promise<{ type: "text"; value: string }>;
    }>;
  }>,
  logEvent: vi.fn(),
  recordSkillUsage: vi.fn(),
}));

vi.mock("../../commands.js", () => ({
  builtInCommandNames: vi.fn(() => new Set(["demo"])),
  findCommand: vi.fn((name: string, commands = mocks.commands) =>
    commands.find((command) => command.name === name),
  ),
  getCommand: vi.fn((name: string, commands = mocks.commands) => {
    const command = commands.find((candidate) => candidate.name === name);
    if (!command) throw new Error(`missing command ${name}`);
    return command;
  }),
  getCommandName: vi.fn((command: { name: string }) => command.name),
  hasCommand: vi.fn((name: string, commands = mocks.commands) =>
    commands.some((command) => command.name === name),
  ),
}));

vi.mock("../../bootstrap/state.js", () => ({
  addInvokedSkill: vi.fn(),
  getSessionId: vi.fn(() => "session-test"),
  setPromptId: vi.fn(),
}));

vi.mock("../../services/analytics/index.js", () => ({
  logEvent: mocks.logEvent,
}));

vi.mock("../../services/api/dumpPrompts.js", () => ({
  getDumpPromptsPath: vi.fn(() => "/tmp/prompts"),
}));

vi.mock("../../services/compact/compact.js", () => ({
  buildPostCompactMessages: vi.fn(() => []),
}));

vi.mock("../../services/compact/microCompact.js", () => ({
  resetMicrocompactState: vi.fn(),
}));

vi.mock("../../tools/AgentTool/runAgent.js", () => ({
  runAgent: vi.fn(async function* () {}),
}));

vi.mock("../../tools/AgentTool/UI.js", () => ({
  renderToolUseProgressMessage: vi.fn(() => null),
}));

vi.mock("../../utils/abortController.js", () => ({
  createAbortController: vi.fn(() => new AbortController()),
}));

vi.mock("../../utils/agentContext.js", () => ({
  getAgentContext: vi.fn(() => null),
}));

vi.mock("../../utils/attachments.js", () => ({
  createAttachmentMessage: vi.fn((attachment) => ({ type: "attachment", attachment })),
  getAttachmentMessages: vi.fn(async function* () {}),
}));

vi.mock("../../utils/envUtils.js", () => ({
  isEnvTruthy: vi.fn(() => false),
}));

vi.mock("../../utils/errors.js", () => ({
  AbortError: class AbortError extends Error {},
  MalformedCommandError: class MalformedCommandError extends Error {},
}));

vi.mock("../../utils/file.js", () => ({
  getDisplayPath: vi.fn((value: string) => value),
}));

vi.mock("../../utils/forkedAgent.js", () => ({
  extractResultText: vi.fn(() => "done"),
  prepareForkedCommandContext: vi.fn(),
}));

vi.mock("../../utils/fsOperations.js", () => ({
  getFsImplementation: vi.fn(() => ({
    stat: vi.fn(async () => {
      throw new Error("not found");
    }),
  })),
}));

vi.mock("../../utils/fullscreen.js", () => ({
  isFullscreenEnvEnabled: vi.fn(() => false),
}));

vi.mock("../../utils/hooks/registerSkillHooks.js", () => ({
  registerSkillHooks: vi.fn(),
}));

vi.mock("../../utils/log.js", () => ({
  logError: vi.fn(),
}));

vi.mock("../../utils/messageQueueManager.js", () => ({
  enqueuePendingNotification: vi.fn(),
}));

vi.mock("../../utils/messages.js", () => ({
  createCommandInputMessage: vi.fn((content: string) => ({
    type: "system",
    message: { content },
    subtype: "local_command",
  })),
  createSyntheticUserCaveatMessage: vi.fn(() => ({
    type: "system",
    message: { content: "synthetic caveat" },
  })),
  createSystemMessage: vi.fn((content: string, level?: string) => ({
    type: "system",
    level,
    message: { content },
  })),
  createUserInterruptionMessage: vi.fn(() => ({
    type: "user",
    message: { content: "interrupted" },
  })),
  createUserMessage: vi.fn((input: { content: unknown }) => ({
    type: "user",
    message: { role: "user", content: input.content },
    ...input,
  })),
  formatCommandInputTags: vi.fn(
    (name: string, args: string) => `/${name}${args ? ` ${args}` : ""}`,
  ),
  isCompactBoundaryMessage: vi.fn(() => false),
  isSystemLocalCommandMessage: vi.fn((message: { type?: string }) =>
    message.type === "system",
  ),
  normalizeMessages: vi.fn((messages: unknown[]) => messages),
  prepareUserContent: vi.fn(
    ({ inputString }: { inputString: string }) => inputString,
  ),
}));

vi.mock("../../utils/permissions/permissionSetup.js", () => ({
  parseToolListFromCLI: vi.fn(() => []),
}));

vi.mock("../../utils/permissions/permissions.js", () => ({
  hasPermissionsToUseTool: vi.fn(),
}));

vi.mock("../../utils/plugins/pluginIdentifier.js", () => ({
  isOfficialMarketplaceName: vi.fn(() => false),
  parsePluginIdentifier: vi.fn(() => ({ marketplace: undefined })),
}));

vi.mock("../../utils/settings/pluginOnlyPolicy.js", () => ({
  isRestrictedToPluginOnly: vi.fn(() => false),
  isSourceAdminTrusted: vi.fn(() => true),
}));

vi.mock("../../utils/sleep.js", () => ({
  sleep: vi.fn(),
}));

vi.mock("../../utils/suggestions/skillUsageTracking.js", () => ({
  recordSkillUsage: mocks.recordSkillUsage,
}));

vi.mock("../../utils/telemetry/events.js", () => ({
  logOTelEvent: vi.fn(),
  redactIfDisabled: vi.fn((value: string) => value),
}));

vi.mock("../../utils/telemetry/pluginTelemetry.js", () => ({
  buildPluginCommandTelemetryFields: vi.fn(() => ({})),
}));

vi.mock("../../utils/tokens.js", () => ({
  getAssistantMessageContentLength: vi.fn(() => 0),
}));

vi.mock("../../utils/uuid.js", () => ({
  createAgentId: vi.fn(() => "agent-test"),
}));

vi.mock("../../utils/workloadContext.js", () => ({
  getWorkload: vi.fn(() => undefined),
}));

vi.mock("../../utils/debug.js", () => ({
  logForDebugging: vi.fn(),
}));

describe("processSlashCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.commands = [
      {
        name: "demo",
        type: "local",
        load: async () => ({
          call: async (args: string) => ({
            type: "text",
            value: `ran ${args}`,
          }),
        }),
      },
    ];
  });

  it("executes a real local slash command fixture", async () => {
    const result = await processSlashCommand(
      "/demo sample",
      [],
      [],
      [],
      {
        options: { commands: mocks.commands },
      } as never,
      vi.fn(),
    );

    expect(result.shouldQuery).toBe(false);
    expect(JSON.stringify(result.messages)).toContain("/demo sample");
    expect(JSON.stringify(result.messages)).toContain(
      "<local-command-stdout>ran sample</local-command-stdout>",
    );
    expect(mocks.logEvent).toHaveBeenCalledWith(
      "agenc_input_command",
      expect.objectContaining({
        input: "demo",
        invocation_trigger: "user-slash",
      }),
    );
  });

  it("falls back to an unknown skill message for missing command names", async () => {
    const result = await processSlashCommand(
      "/missing value",
      [],
      [],
      [],
      {
        options: { commands: mocks.commands },
      } as never,
      vi.fn(),
    );

    expect(result.shouldQuery).toBe(false);
    expect(result.resultText).toBe("Unknown skill: missing");
    expect(JSON.stringify(result.messages)).toContain("Unknown skill: missing");
    expect(JSON.stringify(result.messages)).toContain(
      "Args from unknown skill: value",
    );
  });
});
