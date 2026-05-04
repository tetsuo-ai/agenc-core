import { beforeEach, describe, expect, it, vi } from "vitest";

import { processUserInput, type ProcessUserInputContext } from "./processUserInput.js";

const mocks = vi.hoisted(() => ({
  executeUserPromptSubmitHooks: vi.fn(async function* () {}),
  getAttachmentMessages: vi.fn(async function* () {}),
  logEvent: vi.fn(),
  logOTelEvent: vi.fn(),
  processBashCommand: vi.fn(async () => ({
    messages: [{ type: "user", message: { content: "bash-result" } }],
    shouldQuery: false,
  })),
  processSlashCommand: vi.fn(async () => ({
    messages: [{ type: "user", message: { content: "slash-result" } }],
    shouldQuery: false,
    resultText: "slash-result",
  })),
  queryCheckpoint: vi.fn(),
  setPromptId: vi.fn(),
  startInteractionSpan: vi.fn(),
  storeImages: vi.fn(async () => new Map<number, string>()),
}));

vi.mock("../../agenc/upstream/bootstrap/state.js", () => ({
  addInvokedSkill: vi.fn(),
  getSessionId: vi.fn(() => "session-test"),
  setPromptId: mocks.setPromptId,
}));

vi.mock("../../agenc/upstream/services/analytics/index.js", () => ({
  logEvent: mocks.logEvent,
}));

vi.mock("../../agenc/upstream/utils/attachments.js", () => ({
  createAttachmentMessage: vi.fn((attachment) => ({
    type: "attachment",
    attachment,
  })),
  getAttachmentMessages: mocks.getAttachmentMessages,
}));

vi.mock("../../agenc/upstream/utils/hooks.js", () => ({
  executeUserPromptSubmitHooks: mocks.executeUserPromptSubmitHooks,
  getUserPromptSubmitHookBlockingMessage: vi.fn(
    (message: string) => message,
  ),
}));

vi.mock("../../agenc/upstream/utils/imageStore.js", () => ({
  storeImages: mocks.storeImages,
}));

vi.mock("../../agenc/upstream/utils/messages.js", () => ({
  createCommandInputMessage: vi.fn((content: string) => ({
    type: "system",
    message: { content },
    subtype: "local_command",
  })),
  createSystemMessage: vi.fn((content: string, level?: string) => ({
    type: "system",
    level,
    message: { content },
  })),
  createUserMessage: vi.fn((input: { content: unknown }) => ({
    type: "user",
    message: {
      role: "user",
      content: input.content,
    },
    ...input,
  })),
  getContentText: vi.fn((input: unknown) =>
    typeof input === "string" ? input : "",
  ),
  prepareUserContent: vi.fn(
    ({ inputString }: { inputString: string }) => inputString,
  ),
}));

vi.mock("../../agenc/upstream/utils/queryProfiler.js", () => ({
  queryCheckpoint: mocks.queryCheckpoint,
}));

vi.mock("../../agenc/upstream/utils/telemetry/events.js", () => ({
  logOTelEvent: mocks.logOTelEvent,
  redactIfDisabled: vi.fn((value: string) => value),
}));

vi.mock("../../agenc/upstream/utils/telemetry/sessionTracing.js", () => ({
  startInteractionSpan: mocks.startInteractionSpan,
}));

vi.mock("../../agenc/upstream/utils/ultraplan/keyword.js", () => ({
  hasUltraplanKeyword: vi.fn(() => false),
  replaceUltraplanKeyword: vi.fn((value: string) => value),
}));

vi.mock("./processBashCommand.js", () => ({
  processBashCommand: mocks.processBashCommand,
}));

vi.mock("./processSlashCommand.js", () => ({
  processSlashCommand: mocks.processSlashCommand,
}));

function context(): ProcessUserInputContext {
  return {
    getAppState: () => ({
      toolPermissionContext: { mode: "default" },
      ultraplanLaunching: false,
      ultraplanSessionUrl: null,
    }),
    options: {
      commands: [],
      isNonInteractiveSession: false,
    },
    requestPrompt: vi.fn(),
  } as unknown as ProcessUserInputContext;
}

describe("processUserInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes regular prompt text to prompt messages", async () => {
    const result = await processUserInput({
      input: "explain the plan",
      mode: "prompt",
      setToolJSX: vi.fn(),
      context: context(),
      pastedContents: {},
    });

    expect(result.shouldQuery).toBe(true);
    expect(JSON.stringify(result.messages)).toContain("explain the plan");
    expect(mocks.processBashCommand).not.toHaveBeenCalled();
    expect(mocks.processSlashCommand).not.toHaveBeenCalled();
  });

  it("routes bash mode input to the bash command processor", async () => {
    const result = await processUserInput({
      input: "pwd",
      mode: "bash",
      setToolJSX: vi.fn(),
      context: context(),
      pastedContents: {},
    });

    expect(result.shouldQuery).toBe(false);
    expect(mocks.processBashCommand).toHaveBeenCalledWith(
      "pwd",
      [],
      [],
      expect.any(Object),
      expect.any(Function),
    );
    expect(mocks.processSlashCommand).not.toHaveBeenCalled();
  });

  it("routes slash-prefixed prompt input to the slash command processor", async () => {
    const result = await processUserInput({
      input: "/help status",
      mode: "prompt",
      setToolJSX: vi.fn(),
      context: context(),
      pastedContents: {},
    });

    expect(result.shouldQuery).toBe(false);
    expect(mocks.processSlashCommand).toHaveBeenCalledWith(
      "/help status",
      [],
      [],
      [],
      expect.any(Object),
      expect.any(Function),
      undefined,
      undefined,
      undefined,
    );
    expect(mocks.processBashCommand).not.toHaveBeenCalled();
  });

  it("treats slash-prefixed input as prompt text when slash commands are skipped", async () => {
    const result = await processUserInput({
      input: "/literal text",
      mode: "prompt",
      setToolJSX: vi.fn(),
      context: context(),
      pastedContents: {},
      skipSlashCommands: true,
    });

    expect(result.shouldQuery).toBe(true);
    expect(JSON.stringify(result.messages)).toContain("/literal text");
    expect(mocks.processSlashCommand).not.toHaveBeenCalled();
  });
});
