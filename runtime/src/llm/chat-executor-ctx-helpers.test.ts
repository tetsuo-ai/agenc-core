import { describe, expect, it, vi } from "vitest";

import { ChatExecutor } from "./chat-executor.js";
import type { ChatExecuteParams } from "./chat-executor.js";
import { createPromptEnvelope } from "./prompt-envelope.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "./types.js";
import type { GatewayMessage } from "../gateway/message.js";

// ============================================================================
// Shared helpers
// ============================================================================

function mockResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: "mock response",
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: "mock-model",
    finishReason: "stop",
    ...overrides,
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value);
}

function createMockProvider(
  name = "primary",
  overrides: Partial<LLMProvider> = {},
): LLMProvider {
  return {
    name,
    chat: vi
      .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
      .mockResolvedValue(mockResponse()),
    chatStream: vi
      .fn<
        [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
        Promise<LLMResponse>
      >()
      .mockResolvedValue(mockResponse()),
    healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

function createMessage(content = "hello"): GatewayMessage {
  return {
    id: "msg-1",
    channel: "test",
    senderId: "user-1",
    senderName: "Test User",
    sessionId: "session-1",
    content,
    timestamp: Date.now(),
    scope: "dm",
  };
}

function createParams(
  overrides: Partial<ChatExecuteParams> = {},
): ChatExecuteParams {
  return {
    message: createMessage(),
    history: [],
    promptEnvelope: createPromptEnvelope("You are a helpful assistant."),
    sessionId: "session-1",
    runtimeContext: { workspaceRoot: "/tmp/chat-executor-test-workspace" },
    ...overrides,
  };
}

// ============================================================================
// Tests for chat-executor-ctx-helpers behavior:
//   - setStopReason: tool-loop stuck detection / no_progress terminal
//   - maybePushRuntimeInstruction: recovery hint injection on tool failures
//   - replaceRuntimeRecoveryHintMessages: stale hint replacement
//   - emitExecutionTrace: trace events for recovery hint and terminal states
// ============================================================================

describe("ChatExecutor ctx-helpers behavior", () => {
  describe("tool loop stop reason and recovery hints", () => {
    it("does not hard-stop the loop just because the same tool call keeps failing", async () => {
      // Simulate the LLM calling desktop.bash with "mkdir" (no directory),
      // which returns exitCode:1 every time. Claude-style behavior is to
      // let the normal runtime round budget stop the loop rather than a
      // local repeated-failure fuse.
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"usage: mkdir dir"}');
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "call-1",
                name: "desktop.bash",
                arguments: '{"command":"mkdir"}',
              },
            ],
          }),
        ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Set up the pong workspace in /workspace."),
          runtimeContext: { workspaceRoot: "/workspace" },
        }),
      );

      expect(result.stopReason).toBe("tool_calls");
      expect(result.stopReasonDetail).toContain("Reached max tool rounds");
      expect(result.toolCalls.length).toBe(11);
      expect(result.toolCalls.every((tc) => tc.name === "desktop.bash")).toBe(
        true,
      );
    });

    it("injects a recovery hint after shell-builtin style system.bash failure", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"spawn set ENOENT"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"set","args":["-euo","pipefail"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "moved on" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("Shell builtins"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("omitting `args`");
    });

    it("injects a recovery hint after missing local binary ENOENT on system.bash", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"spawn tsc ENOENT"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"tsc","args":["--noEmit"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "moved on" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("`npx tsc`"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("host PATH");
      expect(String(injectedHint?.content)).not.toContain("Shell builtins");
    });

    it("injects a recovery hint after malformed grep direct-mode usage", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":1,"stdout":"","stderr":"Command failed: grep -A 20 mapString|example|test packages/core/src/index.ts"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments:
                    '{"command":"grep","args":["-A","20","mapString|example|test","packages/core/src/index.ts"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" }))
          .mockResolvedValue(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("prefer `rg PATTERN PATH`"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("add `-E`");
      expect(String(injectedHint?.content)).toContain("reads stdin instead of searching files");
    });

    it("injects a recovery hint after grep is given a pattern but no search path", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":1,"stdout":"","stderr":"","timedOut":false}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments:
                    '{"command":"grep","args":["-E","enemy|combat|attack","--include=*.{h,cpp}"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" }))
          .mockResolvedValue(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("Direct-mode `grep` with only a pattern reads stdin"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("pair `--include` with `-r`");
      expect(String(injectedHint?.content)).toContain("`rg PATTERN src include`");
    });

    it("injects a recovery hint when npm run targets a missing script", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":1,"stdout":"","stderr":"npm error Missing script: \\"build\\""}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"npm","args":["run","build"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" }))
          .mockResolvedValue(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("does not define the npm script `build`"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("root/workspace script");
      expect(String(injectedHint?.content)).toContain("package-specific command");
    });

    it("injects a recovery hint when npm workspace selectors do not match package names", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":1,"stdout":"","stderr":"npm error No workspaces found:\\nnpm error   --workspace=core --workspace=cli --workspace=web"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments:
                    '{"command":"npm","args":["run","build","--workspace=core","--workspace=cli","--workspace=web"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("could not match one or more `--workspace` selectors"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("`core`");
      expect(String(injectedHint?.content)).toContain("package `name`");
      expect(String(injectedHint?.content)).toContain("--workspace=@scope/pkg");
    });

    it("emits an execution trace event when recovery hints are injected", async () => {
      const events: Array<Record<string, unknown>> = [];
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"spawn set ENOENT"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"set","args":["-euo","pipefail"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "moved on" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(
        createParams({
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "recovery_hints_injected",
            phase: "tool_followup",
            payload: expect.objectContaining({
              count: 1,
              hints: expect.arrayContaining([
                expect.objectContaining({
                  key: "system-bash-shell-builtin",
                }),
              ]),
            }),
          }),
        ]),
      );
    });

    it("injects a recovery hint for TypeScript rootDir scope errors", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":2,"stdout":"error TS6059: File \'/workspace/packages/web/vite.config.ts\' is not under \'rootDir\' \'/workspace/packages/web/src\'.","stderr":"Command failed: npx tsc --build"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"npx","args":["tsc","--build"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("includes files outside `rootDir`"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("vite.config.ts");
      expect(String(injectedHint?.content)).toContain("tsconfig.node.json");
    });

    it("injects a recovery hint for duplicate export compiler errors", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":1,"stdout":"\\n> freight-scheduler-lab@0.1.0 test\\n> vitest run packages/core\\n","stderr":"Error: Transform failed with 1 error:\\n/workspace/packages/core/src/index.ts:257:9: ERROR: Multiple exports with the same name \\"Scheduler\\"\\n  255|\\n  256|  // Re-export main API\\n  257|  export { Scheduler };\\n     |           ^\\n  258|  export default Scheduler;\\n"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"npm","args":["test","--","packages/core"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("exports `Scheduler` more than once"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("export { Scheduler }");
      expect(String(injectedHint?.content)).toContain("rerun the failing build/test");
    });

    it("injects a recovery hint for JSON-escaped source content written into a compiler target", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":101,"stdout":"","stderr":"error: unknown start of token: \\\\\\n --> gridforge-core/src/lib.rs:48:15\\n  |\\n48 |     let map = \\\\\\"S#G\\\\\\";\\n  |               ^\\n\\nerror[E0765]: unterminated double quote string\\n --> gridforge-core/src/lib.rs:48:16\\n  |\\n48 |     let map = \\\\\\"S#G\\\\\\";\\n  |                ^^^^^^^^^\\n\\nerror: could not compile `gridforge-core` due to 2 previous errors"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments:
                    '{"command":"cargo","args":["test","--workspace","--quiet"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("JSON escape sequences"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("raw source code");
      expect(String(injectedHint?.content)).toContain("JSON-encoded representation");
    });

    it("replaces stale recovery hints with the latest timeout hint and traces the active keys", async () => {
      const events: Array<Record<string, unknown>> = [];
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce(
          '{"exitCode":2,"stdout":"error TS6059: File \'/workspace/packages/web/vite.config.ts\' is not under \'rootDir\' \'/workspace/packages/web/src\'.","stderr":"Command failed: npx tsc --build"}',
        )
        .mockResolvedValueOnce(
          '{"exitCode":null,"timedOut":true,"stdout":"Running core tests...\\nBFS test passed, cost: 3\\nUnreachable test passed\\n","stderr":"Command failed: node packages/core/dist/test/index.test.js\\n"}',
        );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"npx","args":["tsc","--build"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-2",
                  name: "system.bash",
                  arguments:
                    '{"command":"node","args":["packages/core/dist/test/index.test.js"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "stopped retrying" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(
        createParams({
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      const thirdCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[2][0] as LLMMessage[];
      const timeoutHint = thirdCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("A test or code path likely hung"),
      );
      const staleRootDirHint = thirdCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("includes files outside `rootDir`"),
      );
      expect(timeoutHint).toBeDefined();
      expect(staleRootDirHint).toBeUndefined();

      const followupPreparedEvents = events.filter(
        (event) =>
          event.type === "model_call_prepared" &&
          event.phase === "tool_followup",
      );
      expect(followupPreparedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              activeRecoveryHintKeys: ["system-bash-typescript-rootdir-scope"],
            }),
          }),
          expect.objectContaining({
            payload: expect.objectContaining({
              activeRecoveryHintKeys: ["system.bash-test-runner-timeout"],
            }),
          }),
        ]),
      );
    });

    it("injects a recovery hint when CommonJS require is used against an exports-only package", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":1,"stdout":"","stderr":"Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No \\"exports\\" main defined in /workspace/node_modules/@demo/core/package.json"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments:
                    "{\"command\":\"node -e \\\"const core = require('@demo/core'); console.log(core)\\\"\"}",
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("Do not verify it with CommonJS `require(...)`"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("node --input-type=module");
      expect(String(injectedHint?.content)).toContain("package `exports` map");
    });

    it("injects a recovery hint when localhost is blocked by system.browse", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Private/loopback address blocked: 127.0.0.1"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.browse",
                  arguments: '{"url":"http://127.0.0.1:8123"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("block localhost/private/internal addresses"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("system.bash");
      expect(String(injectedHint?.content)).toContain("CANNOT reach");
    });

    it("injects a recovery hint when localhost is blocked by system.browserSessionStart", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        safeJson({
          error: {
            family: "browser_session",
            code: "browser_session.domain_blocked",
            message:
              "SSRF target blocked: localhost. system.http*/system.browse intentionally block localhost/private/internal addresses.",
          },
        }),
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.browserSessionStart",
                  arguments: '{"url":"http://127.0.0.1:5173"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("system.browserSession*/system.browserAction"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("system.bash");
      expect(String(injectedHint?.content)).toContain("Playwright/Chromium");
    });

    it("injects a recovery hint when desktop.bash is unavailable", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Tool not found: \\"desktop.bash\\""}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "desktop.bash",
                  arguments: '{"command":"ls"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("Desktop/container tools are unavailable"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("/desktop attach");
      expect(String(injectedHint?.content)).toContain("desktop.bash");
    });

    it("injects a recovery hint when container MCP tools require desktop session", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue("Container MCP tool — requires desktop session");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "mcp.kitty.launch",
                  arguments: '{"instance":"terminal1"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("Desktop/container tools are unavailable"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("/desktop attach");
      expect(String(injectedHint?.content)).toContain("mcp.*");
    });

    it("injects a recovery hint when desktop-targeted command fails on system.bash", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Command \\"gdb\\" is denied"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"gdb","args":["--version"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("host shell"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("/desktop attach");
      expect(String(injectedHint?.content)).toContain("desktop.bash");
    });

    it("injects a recovery hint when node invocation of agenc-runtime is denied", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Command \\"node\\" is denied"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments:
                    '{"command":"node","args":["runtime/dist/bin/agenc-runtime.js","status","--output","json"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes('command:"agenc-runtime"'),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("status");
      expect(String(injectedHint?.content)).toContain("--output");
    });

    it("injects a recovery hint when python is denied on system.bash", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Command \\"python3\\" is denied"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"python3","args":["-c","print(1)"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("Python interpreter commands are blocked"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("/desktop attach");
      expect(String(injectedHint?.content)).toContain("desktop.bash");
    });

    it("injects a recovery hint when filesystem path is outside allowlist", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Access denied: Path is outside allowed directories"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.readFile",
                  arguments: '{"path":"/home/tetsuo/git/AgenC/mcp-terminal-smoke-test-prompt.txt"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("blocked by path allowlisting"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("system.bash");
      expect(String(injectedHint?.content)).toContain("/tmp");
    });

    it("lets repeated failed rounds run until the normal round budget stops the loop", async () => {
      let callCount = 0;
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":""}');
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: `call-${callCount}`,
                  name: "system.bash",
                  arguments:
                    '{"command":"grep","args":["missing|pattern","packages/core/src/index.ts"]}',
                },
              ],
            }),
          );
        }),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });
      const result = await executor.execute(
        createParams({
          trace: {},
        }),
      );

      expect(result.stopReason).toBe("tool_calls");
      expect(result.stopReasonDetail).toContain("Reached max tool rounds");
      expect(toolHandler).toHaveBeenCalledTimes(10);
    });
  });
});
