import { describe, expect, test, vi } from "vitest";

import {
  isAppleTerminalBellDisabled,
  parseAppleTerminalBellDisabled,
  sendNotification,
  sendToChannel,
  type TerminalNotification,
} from "./notifier.js";
import {
  countMessagesTokensWithAPI,
  countTokensViaHaikuFallback,
  countTokensWithAPI,
  extractBedrockModelIdFromArn,
  hasThinkingBlocks,
  isBedrockFoundationModel,
  normalizeAttachmentsForTokenEstimation,
  resolveBedrockCountModelId,
  resolveFallbackTokenCountModel,
  roughTokenCountEstimationForServiceMessages,
  stripToolSearchFieldsFromMessages,
  VERTEX_COUNT_TOKENS_ALLOWED_BETAS,
} from "./tokenEstimation.js";

function createTerminal(): TerminalNotification & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    notifyITerm2: (opts) => calls.push(`iterm2:${opts.message}`),
    notifyKitty: (opts) => calls.push(`kitty:${opts.title}:${opts.id}`),
    notifyGhostty: (opts) => calls.push(`ghostty:${opts.title}`),
    notifyBell: () => calls.push("bell"),
    progress: () => calls.push("progress"),
  };
}

describe("notifier service", () => {
  test("dispatches hooks and the configured channel", async () => {
    const terminal = createTerminal();
    const hook = vi.fn();

    await sendNotification(
      {
        message: "done",
        notificationType: "turn_complete",
      },
      terminal,
      {
        preferredChannel: "kitty",
        terminalName: "kitty",
        executeNotificationHooks: hook,
        generateKittyId: () => 42,
      },
    );

    expect(hook).toHaveBeenCalledWith({
      message: "done",
      notificationType: "turn_complete",
    });
    expect(terminal.calls).toEqual(["kitty:AgenC:42"]);
  });

  test("auto channel selects supported terminal mechanisms", async () => {
    const terminal = createTerminal();

    await expect(
      sendToChannel(
        "auto",
        { message: "body", notificationType: "status" },
        terminal,
        { terminalName: "iTerm.app" },
      ),
    ).resolves.toBe("iterm2");

    await expect(
      sendToChannel(
        "auto",
        { message: "body", notificationType: "status" },
        terminal,
        { terminalName: "ghostty" },
      ),
    ).resolves.toBe("ghostty");

    expect(terminal.calls).toEqual(["iterm2:body", "ghostty:AgenC"]);
  });

  test("disabled and unknown channels return explicit non-delivery methods", async () => {
    const terminal = createTerminal();
    await expect(
      sendToChannel(
        "notifications_disabled",
        { message: "body", notificationType: "status" },
        terminal,
      ),
    ).resolves.toBe("disabled");
    await expect(
      sendToChannel(
        "unknown-channel",
        { message: "body", notificationType: "status" },
        terminal,
      ),
    ).resolves.toBe("none");
    expect(terminal.calls).toEqual([]);
  });

  test("Apple Terminal parser handles nested profile dictionaries", () => {
    expect(
      parseAppleTerminalBellDisabled(
        `<plist><dict>
          <key>Window Settings</key><dict>
            <key>Pro</key><dict>
              <key>Font</key><dict><key>Name</key><string>Mono</string></dict>
              <key>Bell</key><false/>
            </dict>
          </dict>
        </dict></plist>`,
        "Pro",
      ),
    ).toBe(true);
  });

  test("Apple Terminal parser ignores duplicate profile keys outside Window Settings", () => {
    expect(
      parseAppleTerminalBellDisabled(
        `<plist><dict>
          <key>Pro</key><dict><key>Bell</key><false/></dict>
          <key>Window Settings</key><dict>
            <key>Pro</key><dict><key>Bell</key><true/></dict>
          </dict>
        </dict></plist>`,
        "Pro",
      ),
    ).toBe(false);
  });

  test("Apple Terminal bell-disabled profile falls back to terminal bell", async () => {
    const terminal = createTerminal();
    const execFileNoThrow = vi.fn(async (command: string) => {
      if (command === "osascript") {
        return { stdout: "Pro\n", stderr: "", code: 0 };
      }
      return {
        stdout: `
<plist><dict>
  <key>Window Settings</key><dict>
    <key>Pro</key><dict><key>Bell</key><false/></dict>
  </dict>
</dict></plist>`,
        stderr: "",
        code: 0,
      };
    });

    await expect(
      sendToChannel(
        "auto",
        { message: "done", notificationType: "status" },
        terminal,
        {
          terminalName: "Apple_Terminal",
          execFileNoThrow,
        },
      ),
    ).resolves.toBe("terminal_bell");

    expect(terminal.calls).toEqual(["bell"]);
    await expect(
      isAppleTerminalBellDisabled({
        terminalName: "Apple_Terminal",
        execFileNoThrow,
      }),
    ).resolves.toBe(true);
  });

  test("Apple Terminal plist parser treats missing or enabled bell as unavailable", () => {
    expect(parseAppleTerminalBellDisabled("<plist />", "Pro")).toBe(false);
    expect(
      parseAppleTerminalBellDisabled(
        "<key>Pro</key><dict><key>Bell</key><true/></dict>",
        "Pro",
      ),
    ).toBe(false);
    expect(
      parseAppleTerminalBellDisabled(
        `<key>Window Settings</key><dict>
          <key>A&amp;B</key><dict><key>Bell</key><false/></dict>
        </dict>`,
        "A&B",
      ),
    ).toBe(true);
  });

  test("channel exceptions are swallowed", async () => {
    const terminal = createTerminal();
    terminal.notifyGhostty = () => {
      throw new Error("terminal write failed");
    };

    await sendNotification(
      { message: "done", notificationType: "status" },
      terminal,
      {
        preferredChannel: "ghostty",
        terminalName: "ghostty",
      },
    );

    expect(terminal.calls).toEqual([]);
  });
});

describe("tokenEstimation service", () => {
  test("returns zero for empty content and delegates API counts for text", async () => {
    const countTokens = vi.fn(async () => ({ input_tokens: 11 }));
    const cacheWrapper = vi.fn(async (_messages, _tools, run) => run());

    await expect(countTokensWithAPI("", {})).resolves.toBe(0);
    await expect(
      countTokensWithAPI("hello", {
        anthropicClient: {
          beta: { messages: { countTokens } },
        },
        withTokenCountCache: cacheWrapper,
      }),
    ).resolves.toBe(11);

    expect(cacheWrapper).toHaveBeenCalledTimes(1);
    expect(countTokens).toHaveBeenCalledWith({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  test("returns null for unavailable provider clients", async () => {
    await expect(countTokensWithAPI("hello")).resolves.toBe(null);
    const logError = vi.fn();
    await expect(
      countMessagesTokensWithAPI([{ role: "user", content: "hi" }], [], {
        provider: "bedrock",
        model: "anthropic.model-v1:0",
        loadBedrockRuntimeModule: async () => {
          throw new Error("missing optional sdk");
        },
        logError,
      }),
    ).resolves.toBe(null);
    expect(logError).toHaveBeenCalled();
  });

  test("filters Vertex count-token betas and enables thinking parameters", async () => {
    const countTokens = vi.fn(async () => ({ input_tokens: 23 }));
    const thinkingMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "step" }],
    } as never;

    await expect(
      countMessagesTokensWithAPI([thinkingMessage], [], {
        provider: "vertex",
        model: "claude-opus-4-7",
        betas: [
          ...VERTEX_COUNT_TOKENS_ALLOWED_BETAS,
          "not-allowed-2026-01-01",
        ],
        anthropicClient: {
          beta: { messages: { countTokens } },
        },
      }),
    ).resolves.toBe(23);

    expect(countTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        betas: [...VERTEX_COUNT_TOKENS_ALLOWED_BETAS],
        thinking: {
          type: "enabled",
          budget_tokens: 1024,
        },
      }),
    );
  });

  test("strips tool-search-only fields before fallback token counting", async () => {
    const create = vi.fn(async () => ({
      usage: {
        input_tokens: 5,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
      },
    }));
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "read",
            input: {},
            caller: { type: "direct" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "tool_reference" }],
          },
        ],
      },
    ] as never;

    expect(hasThinkingBlocks(messages)).toBe(false);
    expect(stripToolSearchFieldsFromMessages(messages)).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "[tool references]" }],
          },
        ],
      },
    ]);

    await expect(
      countTokensViaHaikuFallback(messages, [], {
        anthropicClient: {
          beta: { messages: { countTokens: vi.fn(), create } },
        },
      }),
    ).resolves.toBeGreaterThan(0);
    expect(create).not.toHaveBeenCalled();
  });

  test("selects provider-compatible fallback models and handles create failures", async () => {
    const thinkingMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "step" }],
    } as never;
    expect(
      resolveFallbackTokenCountModel(
        { provider: "vertex", model: "claude-opus-4-7" },
        true,
      ),
    ).toBe("claude-opus-4-7");
    expect(resolveFallbackTokenCountModel({}, false)).toBe("claude-haiku-4-5");

    const create = vi.fn(async () => ({ usage: { input_tokens: 7 } }));
    await expect(
      countTokensViaHaikuFallback([thinkingMessage], [], {
        provider: "vertex",
        model: "claude-opus-4-7",
        anthropicClient: {
          beta: { messages: { countTokens: vi.fn(), create } },
        },
      }),
    ).resolves.toBeGreaterThan(0);
    expect(create).not.toHaveBeenCalled();

    await expect(
      countTokensViaHaikuFallback([], [], {
        anthropicClient: {
          beta: {
            messages: {
              countTokens: vi.fn(),
              create: vi.fn(async () => {
                throw new Error("fallback failed");
              }),
            },
          },
        },
      }),
    ).resolves.toBeGreaterThan(0);
  });

  test("counts Bedrock tokens through a lazily loaded runtime module", async () => {
    const sentCommands: unknown[] = [];
    class CountTokensCommand {
      constructor(readonly input: Record<string, unknown>) {}
    }
    const bedrockClient = {
      send: vi.fn(async (command: unknown) => {
        sentCommands.push(command);
        return { inputTokens: 31 };
      }),
    };

    await expect(
      countMessagesTokensWithAPI(
        [{ role: "user", content: "hi" }],
        [],
        {
          provider: "bedrock",
          model: "us.anthropic.model-v1:0",
          bedrockClient,
          loadBedrockRuntimeModule: async () => ({ CountTokensCommand }),
          resolveInferenceProfileBackingModel: async () =>
            "anthropic.model-v1:0",
        },
      ),
    ).resolves.toBe(31);

    expect(bedrockClient.send).toHaveBeenCalledTimes(1);
    expect((sentCommands[0] as CountTokensCommand).input.modelId).toBe(
      "anthropic.model-v1:0",
    );

    await expect(
      countMessagesTokensWithAPI([{ role: "user", content: "hi" }], [], {
        provider: "bedrock",
        model: "anthropic.model-v1:0",
        bedrockClient: { send: vi.fn(async () => ({})) },
        loadBedrockRuntimeModule: async () => ({ CountTokensCommand }),
      }),
    ).resolves.toBe(null);

    const loaderSend = vi.fn(async () => ({ inputTokens: 19 }));
    const loadBedrockRuntimeModule = vi.fn(async () => ({
      CountTokensCommand,
      BedrockRuntimeClient: class {
        send = loaderSend;
      },
    }));
    await expect(
      countMessagesTokensWithAPI([{ role: "user", content: "hi" }], [], {
        provider: "bedrock",
        model: "anthropic.model-v1:0",
        loadBedrockRuntimeModule,
      }),
    ).resolves.toBe(19);
    expect(loadBedrockRuntimeModule).toHaveBeenCalledTimes(1);
    expect(loaderSend).toHaveBeenCalledTimes(1);
  });

  test("resolves foundation models, ARNs, and inference-profile backing models", async () => {
    expect(isBedrockFoundationModel("anthropic.model-v1:0")).toBe(true);
    expect(isBedrockFoundationModel("us.anthropic.model-v1:0")).toBe(false);
    expect(
      extractBedrockModelIdFromArn(
        "arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.model-v1",
      ),
    ).toBe("us.anthropic.model-v1");
    await expect(
      resolveBedrockCountModelId("anthropic.model-v1:0"),
    ).resolves.toBe("anthropic.model-v1:0");
    await expect(
      resolveBedrockCountModelId("us.anthropic.model-v1:0", {
        resolveInferenceProfileBackingModel: async (profile) =>
          profile === "us.anthropic.model-v1:0"
            ? "anthropic.model-v1:0"
            : null,
      }),
    ).resolves.toBe("anthropic.model-v1:0");
  });

  test("normalizes attachment-shaped messages for rough estimates", () => {
    const normalized = normalizeAttachmentsForTokenEstimation([
      {
        type: "attachment",
        attachment: {
          kind: "edited_image_file",
          filename: "plot.png",
          content: "base64".repeat(20_000),
          mediaType: "image/png",
        },
      },
      {
        type: "attachment",
        attachment: {
          kind: "image_mention",
          images: [
            {
              raw: "@a.png",
              path: "a.png",
              resolved: "/tmp/a.png",
              mediaType: "image/png",
              url: "data:image/png;base64,aaa",
            },
          ],
        },
      },
      {
        type: "attachment",
        attachment: {
          kind: "pdf_mention",
          pdfs: [
            {
              raw: "@a.pdf",
              path: "a.pdf",
              resolved: "/tmp/a.pdf",
              mediaType: "application/pdf",
              data: "base64".repeat(20_000),
              bytes: 120_000,
              filename: "a.pdf",
            },
          ],
        },
      },
      {
        type: "attachment",
        attachment: {
          kind: "edited_text_file",
          filename: "a.ts",
          snippet: "abcdabcd",
        },
      },
    ]);

    expect(normalized).toEqual([
      expect.objectContaining({ content: { type: "image" } }),
      expect.objectContaining({ content: [{ type: "image" }] }),
      expect.objectContaining({ content: [{ type: "document" }] }),
      expect.objectContaining({ content: "abcdabcd" }),
    ]);
    expect(roughTokenCountEstimationForServiceMessages(normalized)).toBe(6002);
  });
});
