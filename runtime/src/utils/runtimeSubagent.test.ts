import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  childCtorArgs: [] as unknown[],
  runTurn: vi.fn(),
  shutdown: vi.fn(async () => {}),
}));

vi.mock("../session/session.js", () => ({
  Session: class MockRuntimeSession {
    constructor(args: unknown) {
      mocks.childCtorArgs.push(args);
    }

    runTurn(userMessage: string, opts: unknown) {
      return mocks.runTurn(userMessage, opts);
    }

    shutdown() {
      return mocks.shutdown();
    }
  },
}));

import {
  mapLegacyAllowlistToCodex,
  streamRuntimeSubagent,
} from "./runtimeSubagent.js";

function makeParentSession() {
  return {
    conversationId: "parent-session",
    sessionConfiguration: {},
    features: {},
    services: {
      registry: {
        tools: [
          {
            name: "system.readFile",
            description: "Read a file",
            inputSchema: { type: "object" },
          },
          {
            name: "custom.tool",
            description: "Custom tool",
            inputSchema: { type: "object" },
          },
        ],
        toLLMTools() {
          return [];
        },
        async dispatch() {
          return { content: "ok", isError: false };
        },
      },
    },
    jsRepl: {},
    config: {},
    modelInfo: {},
  };
}

async function drain<T>(
  iter: AsyncGenerator<T, unknown, void>,
): Promise<{ yielded: T[]; result: unknown }> {
  const yielded: T[] = [];
  while (true) {
    const step = await iter.next();
    if (step.done) {
      return { yielded, result: step.value };
    }
    yielded.push(step.value);
  }
}

describe("runtimeSubagent", () => {
  beforeEach(() => {
    mocks.childCtorArgs.length = 0;
    mocks.runTurn.mockReset();
    mocks.shutdown.mockClear();
  });

  it("preserves unknown allowlist entries while mapping legacy tool names", () => {
    expect(
      mapLegacyAllowlistToCodex(["Read(/tmp/x)", "custom.tool", "Bash(*)"]),
    ).toEqual(["system.readFile", "custom.tool", "system.bash"]);
  });

  it("forwards system prompt and context through the child session turn", async () => {
    async function* fakeTurn() {
      yield { type: "assistant_text", content: "done" } as const;
      return { stopReason: "completed" };
    }
    mocks.runTurn.mockReturnValue(fakeTurn());

    const iter = streamRuntimeSubagent({
      session: makeParentSession() as never,
      initialMessages: [
        {
          type: "user",
          message: { content: "finish the task" },
        } as never,
      ],
      taskPrompt: "fallback prompt",
      systemPrompt: ["base one", "base two"],
      userContext: { currentDate: "Today's date is 2026-04-21." },
      systemContext: { gitStatus: "Current branch: feature/test" },
      childConversationId: "child-session",
    });

    const { yielded, result } = await drain(iter);

    expect(yielded).toHaveLength(1);
    expect(mocks.runTurn).toHaveBeenCalledTimes(1);
    expect(mocks.runTurn.mock.calls[0]?.[0]).toBe("finish the task");
    expect(mocks.runTurn.mock.calls[0]?.[1]).toMatchObject({
      history: [
        {
          role: "user",
          content: expect.stringContaining("currentDate"),
        },
      ],
      systemPrompt: expect.stringContaining("gitStatus"),
    });
    expect(mocks.runTurn.mock.calls[0]?.[1]?.systemPrompt).toContain(
      "base one",
    );
    expect(mocks.runTurn.mock.calls[0]?.[1]?.systemPrompt).toContain(
      "base two",
    );
    expect(mocks.childCtorArgs[0]).toMatchObject({
      conversationId: "child-session",
    });
    expect(result).toMatchObject({
      finalMessage: "done",
      stopReason: "completed",
      toolCallCount: 0,
    });
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
  });
});
