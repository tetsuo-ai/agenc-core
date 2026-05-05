import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, test, vi } from "vitest";

import {
  isAppleTerminalBellDisabled,
  parseAppleTerminalBellDisabled,
  sendNotification,
  sendToChannel,
  type TerminalNotification,
} from "./notifier.js";
import {
  CAFFEINATE_TIMEOUT_SECONDS,
  PreventSleepController,
  RESTART_INTERVAL_MS,
} from "./preventSleep.js";
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
  test("dispatches hooks, the configured channel, and analytics metadata", async () => {
    const terminal = createTerminal();
    const hook = vi.fn();
    const logEvent = vi.fn();

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
        logEvent,
        generateKittyId: () => 42,
      },
    );

    expect(hook).toHaveBeenCalledWith({
      message: "done",
      notificationType: "turn_complete",
    });
    expect(terminal.calls).toEqual(["kitty:AgenC:42"]);
    expect(logEvent).toHaveBeenCalledWith("agenc_notification_method_used", {
      configured_channel: "kitty",
      method_used: "kitty",
      term: "kitty",
    });
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

  test("channel exceptions still produce analytics with error method", async () => {
    const terminal = createTerminal();
    terminal.notifyGhostty = () => {
      throw new Error("terminal write failed");
    };
    const logEvent = vi.fn();

    await sendNotification(
      { message: "done", notificationType: "status" },
      terminal,
      {
        preferredChannel: "ghostty",
        terminalName: "ghostty",
        logEvent,
      },
    );

    expect(logEvent).toHaveBeenCalledWith("agenc_notification_method_used", {
      configured_channel: "ghostty",
      method_used: "error",
      term: "ghostty",
    });
  });
});

describe("preventSleep service", () => {
  test("is a no-op on non-macOS while preserving reference count semantics", () => {
    const spawn = vi.fn();
    const controller = new PreventSleepController({
      platform: "linux",
      spawn: spawn as never,
    });

    controller.startPreventSleep();
    controller.startPreventSleep();
    expect(controller.refCount).toBe(2);
    expect(spawn).not.toHaveBeenCalled();

    controller.stopPreventSleep();
    expect(controller.refCount).toBe(1);
    controller.stopPreventSleep();
    expect(controller.refCount).toBe(0);
  });

  test("spawns caffeinate once, registers cleanup, and kills on final stop", () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn();
    child.kill = vi.fn(() => true);
    const spawn = vi.fn(() => child);
    const registerCleanup = vi.fn(() => () => undefined);
    const clearInterval = vi.fn();
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const setInterval = vi.fn(() => timer);
    const log = vi.fn();

    const controller = new PreventSleepController({
      platform: "darwin",
      spawn: spawn as never,
      registerCleanup,
      setInterval: setInterval as never,
      clearInterval,
      logForDebugging: log,
    });

    controller.startPreventSleep();
    controller.startPreventSleep();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("caffeinate", [
      "-i",
      "-t",
      String(CAFFEINATE_TIMEOUT_SECONDS),
    ], { stdio: "ignore" });
    expect(registerCleanup).toHaveBeenCalledWith(
      "prevent-sleep",
      expect.any(Function),
    );
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), RESTART_INTERVAL_MS);
    expect(timer.unref).toHaveBeenCalled();

    controller.stopPreventSleep();
    expect(child.kill).not.toHaveBeenCalled();
    controller.stopPreventSleep();
    expect(clearInterval).toHaveBeenCalledWith(timer);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  test("restart interval refreshes caffeinate while work is active", () => {
    const first = new EventEmitter() as ChildProcess;
    first.unref = vi.fn();
    first.kill = vi.fn(() => true);
    const second = new EventEmitter() as ChildProcess;
    second.unref = vi.fn();
    second.kill = vi.fn(() => true);
    const spawn = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    let restart: (() => void) | undefined;

    const controller = new PreventSleepController({
      platform: "darwin",
      spawn: spawn as never,
      registerCleanup: () => () => undefined,
      setInterval: ((callback: () => void) => {
        restart = callback;
        return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
      }) as never,
      clearInterval: vi.fn(),
      logForDebugging: vi.fn(),
    });

    controller.startPreventSleep();
    restart?.();

    expect(first.kill).toHaveBeenCalledWith("SIGKILL");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(controller.isCaffeinateRunning).toBe(true);
  });

  test("cleanup registration failures do not prevent caffeinate startup", () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn();
    child.kill = vi.fn(() => true);
    const log = vi.fn();
    const controller = new PreventSleepController({
      platform: "darwin",
      spawn: vi.fn(() => child) as never,
      registerCleanup: () => {
        throw new Error("cleanup unavailable");
      },
      setInterval: (() => ({ unref: vi.fn() })) as never,
      clearInterval: vi.fn(),
      logForDebugging: log,
    });

    expect(() => controller.startPreventSleep()).not.toThrow();
    expect(controller.refCount).toBe(1);
    expect(controller.isCaffeinateRunning).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("cleanup registration failed"),
    );
  });

  test("child error and exit handlers clear the running process", () => {
    const erroredChild = new EventEmitter() as ChildProcess;
    erroredChild.unref = vi.fn();
    erroredChild.kill = vi.fn(() => true);
    const errorController = new PreventSleepController({
      platform: "darwin",
      spawn: vi.fn(() => erroredChild) as never,
      registerCleanup: () => () => undefined,
      setInterval: (() => ({ unref: vi.fn() })) as never,
      clearInterval: vi.fn(),
      logForDebugging: vi.fn(),
    });
    errorController.startPreventSleep();
    erroredChild.emit("error", new Error("spawn failed"));
    expect(errorController.isCaffeinateRunning).toBe(false);

    const exitedChild = new EventEmitter() as ChildProcess;
    exitedChild.unref = vi.fn();
    exitedChild.kill = vi.fn(() => true);
    const exitController = new PreventSleepController({
      platform: "darwin",
      spawn: vi.fn(() => exitedChild) as never,
      registerCleanup: () => () => undefined,
      setInterval: (() => ({ unref: vi.fn() })) as never,
      clearInterval: vi.fn(),
      logForDebugging: vi.fn(),
    });
    exitController.startPreventSleep();
    exitedChild.emit("exit", 0, null);
    expect(exitController.isCaffeinateRunning).toBe(false);
  });

  test("registered cleanup callback force-stops the controller", async () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn();
    child.kill = vi.fn(() => true);
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const clearInterval = vi.fn();
    let cleanupTask: (() => void | Promise<void>) | undefined;
    const controller = new PreventSleepController({
      platform: "darwin",
      spawn: vi.fn(() => child) as never,
      registerCleanup: (_name, task) => {
        cleanupTask = task;
        return () => undefined;
      },
      setInterval: (() => timer) as never,
      clearInterval,
      logForDebugging: vi.fn(),
    });

    controller.startPreventSleep();
    controller.startPreventSleep();
    await cleanupTask?.();

    expect(controller.refCount).toBe(0);
    expect(controller.isCaffeinateRunning).toBe(false);
    expect(clearInterval).toHaveBeenCalledWith(timer);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
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
    ).resolves.toBe(10);
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
    ).resolves.toBe(7);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-7" }),
    );

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
    ).resolves.toBe(null);
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
