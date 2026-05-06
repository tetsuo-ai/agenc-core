import { beforeEach, describe, expect, it, vi } from "vitest";

import { processUserInput, type ProcessUserInputContext } from "./processUserInput.js";

const mocks = vi.hoisted(() => ({
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

vi.mock("../../bootstrap/state.js", () => ({
  addInvokedSkill: vi.fn(),
  getSessionId: vi.fn(() => "session-test"),
  setPromptId: mocks.setPromptId,
}));

vi.mock("../../services/analytics/index.js", () => ({
  logEvent: mocks.logEvent,
}));

vi.mock("../../utils/attachments.js", () => ({
  createAttachmentMessage: vi.fn((attachment) => ({
    type: "attachment",
    attachment,
  })),
  getAttachmentMessages: mocks.getAttachmentMessages,
}));

vi.mock("../../utils/imageStore.js", () => ({
  storeImages: mocks.storeImages,
}));

vi.mock("../../utils/messages.js", () => ({
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

vi.mock("../../utils/queryProfiler.js", () => ({
  queryCheckpoint: mocks.queryCheckpoint,
}));

vi.mock("../../utils/telemetry/events.js", () => ({
  logOTelEvent: mocks.logOTelEvent,
  redactIfDisabled: vi.fn((value: string) => value),
}));

vi.mock("../../utils/telemetry/sessionTracing.js", () => ({
  startInteractionSpan: mocks.startInteractionSpan,
}));

vi.mock("../../utils/ultraplan/keyword.js", () => ({
  hasUltraplanKeyword: vi.fn(() => false),
  replaceUltraplanKeyword: vi.fn((value: string) => value),
}));

vi.mock("./processBashCommand.js", () => ({
  processBashCommand: mocks.processBashCommand,
}));

vi.mock("./processSlashCommand.js", () => ({
  processSlashCommand: mocks.processSlashCommand,
}));

function context(
  overrides: Record<string, unknown> = {},
): ProcessUserInputContext {
  const base = {
    cwd: "/workspace",
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
  };
  return { ...base, ...overrides } as unknown as ProcessUserInputContext;
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

  it("runs configured UserPromptSubmit hooks from production-shaped session services", async () => {
    const calls: unknown[] = [];
    const result = await processUserInput({
      input: "explain the plan",
      mode: "prompt",
      setToolJSX: vi.fn(),
      context: context({
        session: {
          services: {
            hooks: {
              userPromptSubmitHooks: [
                (input: unknown) => {
                  calls.push(input);
                  return { additionalContexts: ["policy context"] };
                },
              ],
            },
          },
        },
      }),
      pastedContents: {},
    });

    expect(result.shouldQuery).toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({
        prompt: "explain the plan",
        permissionMode: "default",
        cwd: "/workspace",
      }),
    ]);
    expect(JSON.stringify(result.messages)).toContain("policy context");
  });

  it("blocks prompt submission when a configured UserPromptSubmit hook rejects it", async () => {
    const result = await processUserInput({
      input: "delete everything",
      mode: "prompt",
      setToolJSX: vi.fn(),
      context: context({
        session: {
          services: {
            hooks: {
              userPromptSubmitHooks: [
                () => ({
                  blockingError: { blockingError: "policy denied" },
                }),
              ],
            },
          },
        },
      }),
      pastedContents: {},
    });

    expect(result.shouldQuery).toBe(false);
    expect(JSON.stringify(result.messages)).toContain(
      "UserPromptSubmit operation blocked by hook",
    );
    expect(JSON.stringify(result.messages)).toContain("policy denied");
  });

  it("preserves UserPromptSubmit additional context when blocking", async () => {
    const result = await processUserInput({
      input: "delete everything",
      mode: "prompt",
      setToolJSX: vi.fn(),
      context: context({
        session: {
          services: {
            hooks: {
              userPromptSubmitHooks: [
                () => ({
                  additionalContexts: ["policy context"],
                  blockingError: { blockingError: "policy denied" },
                }),
              ],
            },
          },
        },
      }),
      pastedContents: {},
    });

    expect(result.shouldQuery).toBe(false);
    expect(JSON.stringify(result.messages)).toContain("policy context");
    expect(JSON.stringify(result.messages)).toContain("policy denied");
  });

  it("preserves UserPromptSubmit additional context when stopping", async () => {
    const result = await processUserInput({
      input: "pause here",
      mode: "prompt",
      setToolJSX: vi.fn(),
      context: context({
        session: {
          services: {
            hooks: {
              userPromptSubmitHooks: [
                () => ({
                  additionalContexts: ["stopped context"],
                  preventContinuation: true,
                  stopReason: "pause",
                }),
              ],
            },
          },
        },
      }),
      pastedContents: {},
    });

    expect(result.shouldQuery).toBe(false);
    expect(JSON.stringify(result.messages)).toContain("stopped context");
    expect(JSON.stringify(result.messages)).toContain("Operation stopped by hook");
  });

  it("emits a warning when a configured UserPromptSubmit hook throws", async () => {
    const emitted: unknown[] = [];
    const result = await processUserInput({
      input: "explain the plan",
      mode: "prompt",
      setToolJSX: vi.fn(),
      context: context({
        session: {
          nextInternalSubId: () => "warn-1",
          emit: (event: unknown) => emitted.push(event),
          services: {
            hooks: {
              userPromptSubmitHooks: [
                () => {
                  throw new Error("hook failed");
                },
              ],
            },
          },
        },
      }),
      pastedContents: {},
    });

    expect(result.shouldQuery).toBe(true);
    expect(emitted).toEqual([
      expect.objectContaining({
        id: "warn-1",
        msg: expect.objectContaining({
          type: "warning",
          payload: expect.objectContaining({
            cause: "user_prompt_submit_hook_threw",
            message: expect.stringContaining("hook failed"),
          }),
        }),
      }),
    ]);
  });
});
