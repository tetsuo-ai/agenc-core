import { describe, expect, it, vi } from "vitest";

import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "../../../src/llm/types.js";
import { CodePredictionService } from "../../../src/services/code-prediction/service.js";
import type {
  CodePredictionRequest,
  OwnedCodePredictionProvider,
} from "../../../src/services/code-prediction/types.js";

function response(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: {
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    },
    model: "prediction-model",
    finishReason: "stop",
  };
}

function sourceProvider(): LLMProvider {
  return {
    name: "source",
    chat: vi.fn(async () => {
      throw new Error("primary session provider must never be called");
    }),
    chatStream: vi.fn(async () => {
      throw new Error("primary session provider must never be called");
    }),
    healthCheck: vi.fn(async () => true),
  };
}

function request(
  overrides: Partial<CodePredictionRequest> = {},
): CodePredictionRequest {
  const value = {
    requestId: "prediction-1",
    sessionId: "session-1",
    editorInstanceId: "editor-1",
    bufferHandle: 1,
    generation: 1,
    changedtick: 8,
    path: "/workspace/src/main.ts",
    language: "typescript",
    cursor: { line: 0, byteColumn: 12 },
    prefix: "const value = ",
    suffix: ";\n",
    ...overrides,
  };
  return {
    ...value,
    fileBytes:
      overrides.fileBytes ??
      Buffer.byteLength(value.prefix, "utf8") +
        Buffer.byteLength(value.suffix, "utf8"),
  };
}

function owner(
  provider: LLMProvider,
  dispose = vi.fn(async () => {}),
): OwnedCodePredictionProvider {
  return {
    provider,
    providerName: "test",
    model: "prediction-model",
    routeKey: "test\0prediction-model",
    dispose,
  };
}

describe("CodePredictionService", () => {
  it("requires persisted consent in the safe default mode", async () => {
    const createProvider = vi.fn();
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      createProvider,
      readIgnoreFile: async () => undefined,
      realpath: async (path) => path,
    });

    await expect(
      service.complete({
        ...request(),
        // Treat an untrusted legacy/client assertion as hostile input. The
        // daemon's loaded config is the only prediction authorization.
        consentGranted: true,
      } as CodePredictionRequest),
    ).resolves.toMatchObject({
      status: "suppressed",
      reason: "consent_required",
    });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("applies a live consent config reload without recreating the service", async () => {
    const chat = vi.fn(async () => response("enabled"));
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      createProvider: async () =>
        owner({
          name: "test",
          chat,
          chatStream: vi.fn(async () => response("")),
          healthCheck: vi.fn(async () => true),
        }),
      readIgnoreFile: async () => undefined,
      realpath: async (path) => path,
    });

    await expect(service.complete(request())).resolves.toMatchObject({
      status: "suppressed",
      reason: "consent_required",
    });
    await service.updateConfig({ enabled: "on" });
    await expect(
      service.complete(
        request({
          requestId: "prediction-after-consent",
          generation: 2,
        }),
      ),
    ).resolves.toMatchObject({
      status: "completed",
      text: "enabled",
    });
    expect(chat).toHaveBeenCalledOnce();
  });

  it("keeps an in-flight prediction across an identical config reload", async () => {
    let resolveChat!: (value: LLMResponse) => void;
    const chat = vi.fn(
      async () =>
        await new Promise<LLMResponse>((resolve) => {
          resolveChat = resolve;
        }),
    );
    const dispose = vi.fn(async () => {});
    const config = {
      enabled: "on",
      debounce_ms: 160,
      timeout_ms: 2_500,
      max_output_tokens: 256,
      provider: "test",
      model: "prediction-model",
    } as const;
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config,
      createProvider: async () =>
        owner(
          {
            name: "test",
            chat,
            chatStream: vi.fn(async () => response("")),
            healthCheck: vi.fn(async () => true),
          },
          dispose,
        ),
      readIgnoreFile: async () => undefined,
      realpath: async (path) => path,
    });

    const pending = service.complete(request());
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
    await service.updateConfig({ ...config });
    expect(dispose).not.toHaveBeenCalled();

    resolveChat(response("survived identical reload"));
    await expect(pending).resolves.toMatchObject({
      status: "completed",
      text: "survived identical reload",
    });
    expect(dispose).not.toHaveBeenCalled();
    await service.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("uses an independently-owned, tool-free provider and caches by context", async () => {
    const chat = vi.fn(
      async (_messages: LLMMessage[], options): Promise<LLMResponse> => {
        expect(options).toMatchObject({
          maxOutputTokens: 256,
          temperature: 0,
          toolChoice: "none",
          tools: [],
          singleWireAttempt: true,
          skipCacheWrite: true,
        });
        return response("answer");
      },
    );
    const predictionProvider: LLMProvider = {
      name: "test",
      chat,
      chatStream: vi.fn(async () => response("")),
      healthCheck: vi.fn(async () => true),
    };
    const disposals: Array<ReturnType<typeof vi.fn>> = [];
    const createProvider = vi.fn(async () => {
      const dispose = vi.fn(async () => {});
      disposals.push(dispose);
      return owner(predictionProvider, dispose);
    });
    const primary = sourceProvider();
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: primary,
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider,
      readIgnoreFile: async () => undefined,
      realpath: async (path) => path,
    });

    const first = await service.complete(request());
    const second = await service.complete(
      request({
        requestId: "prediction-2",
        generation: 2,
        changedtick: 9,
      }),
    );

    expect(first).toMatchObject({
      status: "completed",
      text: "answer",
      cached: false,
    });
    expect(second).toMatchObject({
      status: "completed",
      text: "answer",
      cached: true,
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(primary.chat).not.toHaveBeenCalled();
    expect(createProvider).toHaveBeenCalledTimes(1);
    await service.dispose();
    expect(disposals[0]).toHaveBeenCalledTimes(1);
  });

  it("prefers a provider-native fill-in-the-middle implementation", async () => {
    const predictCode = vi.fn(async () => ({
      text: "nativeCompletion",
      model: "fim-model",
    }));
    const chat = vi.fn(async () => response("chatCompletion"));
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider: async () =>
        owner({
          name: "test",
          predictCode,
          chat,
          chatStream: vi.fn(async () => response("")),
          healthCheck: vi.fn(async () => true),
        }),
      readIgnoreFile: async () => undefined,
      realpath: async (path) => path,
    });

    await expect(service.complete(request())).resolves.toMatchObject({
      status: "completed",
      text: "nativeCompletion",
      model: "fim-model",
    });
    expect(predictCode).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: "const value = ",
        suffix: ";\n",
        path: "src/main.ts",
      }),
      expect.objectContaining({
        tools: [],
        toolChoice: "none",
        singleWireAttempt: true,
      }),
    );
    expect(chat).not.toHaveBeenCalled();
  });

  it("cancels a superseded generation and never stages its late result", async () => {
    let resolveFirst!: (value: LLMResponse) => void;
    const chat = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          await new Promise<LLMResponse>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(response("new"));
    const predictionProvider: LLMProvider = {
      name: "test",
      chat,
      chatStream: vi.fn(async () => response("")),
      healthCheck: vi.fn(async () => true),
    };
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider: async () => owner(predictionProvider),
      readIgnoreFile: async () => undefined,
      realpath: async (path) => path,
    });

    const first = service.complete(request());
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    const second = service.complete(
      request({
        requestId: "prediction-2",
        generation: 2,
        changedtick: 9,
        prefix: "const value = n",
      }),
    );
    await expect(second).resolves.toMatchObject({
      status: "completed",
      text: "new",
      generation: 2,
    });
    resolveFirst(response("old"));
    await expect(first).resolves.toMatchObject({
      status: "suppressed",
      reason: "stale",
      generation: 1,
    });
  });

  it("rate limits bursts without dispatching a fourth provider call", async () => {
    const chat = vi.fn(async () => response("x"));
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider: async () =>
        owner({
          name: "test",
          chat,
          chatStream: vi.fn(async () => response("")),
          healthCheck: vi.fn(async () => true),
        }),
      readIgnoreFile: async () => undefined,
      realpath: async (path) => path,
      now: () => 1_000,
    });

    for (let index = 0; index < 3; index += 1) {
      await service.complete(
        request({
          requestId: `prediction-${index}`,
          generation: index,
          changedtick: index,
          prefix: `const value${index} = `,
        }),
      );
    }
    await expect(
      service.complete(
        request({
          requestId: "prediction-4",
          generation: 4,
          changedtick: 4,
          prefix: "const fourth = ",
        }),
      ),
    ).resolves.toMatchObject({
      status: "suppressed",
      reason: "rate_limited",
    });
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it("records only content-free request and feedback metrics", async () => {
    const metrics: unknown[] = [];
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider: async () =>
        owner({
          name: "test",
          chat: vi.fn(async () => response("completion")),
          chatStream: vi.fn(async () => response("")),
          healthCheck: vi.fn(async () => true),
        }),
      readIgnoreFile: async () => undefined,
      realpath: async (path) => path,
      emitMetric: (metric) => metrics.push(metric),
    });
    await service.complete(request({ prefix: "top secret source text" }));
    service.feedback({
      sessionId: "session-1",
      editorInstanceId: "editor-1",
      requestId: "prediction-1",
      kind: "accepted",
      acceptedCharacters: 10,
    });

    const serialized = JSON.stringify(metrics);
    expect(serialized).not.toContain("top secret source text");
    expect(serialized).not.toContain("completion");
    expect(metrics).toHaveLength(2);
  });

  it("resolves symlinks before deciding that a path is inside the workspace", async () => {
    const createProvider = vi.fn();
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider,
      readIgnoreFile: async () => undefined,
      realpath: async (path) => {
        if (path === "/workspace") return "/real/workspace";
        if (path === "/workspace/src/main.ts") {
          return "/real/outside/secret.ts";
        }
        return path;
      },
    });

    await expect(service.complete(request())).resolves.toMatchObject({
      status: "suppressed",
      reason: "outside_workspace",
    });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("applies ignore and sensitive-path rails to symlink aliases before canonicalization", async () => {
    const createProvider = vi.fn();
    const realpath = async (path: string): Promise<string> => {
      if (path === "/workspace") return "/real/workspace";
      if (path === "/workspace/src/private-link.ts") {
        return "/real/workspace/src/public.ts";
      }
      if (path === "/workspace/.env") {
        return "/real/workspace/src/public.ts";
      }
      return path;
    };
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider,
      readIgnoreFile: async (path) =>
        path === "/workspace/.agencignore"
          ? "src/private-link.ts\n"
          : undefined,
      realpath,
    });

    await expect(
      service.complete(
        request({
          requestId: "ignored-symlink-alias",
          path: "/workspace/src/private-link.ts",
          prefix: "ignored alias content",
        }),
      ),
    ).resolves.toMatchObject({
      status: "suppressed",
      reason: "sensitive_path",
    });
    await expect(
      service.complete(
        request({
          requestId: "sensitive-symlink-alias",
          generation: 2,
          changedtick: 9,
          path: "/workspace/.env",
          prefix: "innocuous looking content",
        }),
      ),
    ).resolves.toMatchObject({
      status: "suppressed",
      reason: "sensitive_path",
    });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("allows a benign in-workspace symlink after lexical and canonical checks", async () => {
    const chat = vi.fn(async () => response("safe alias completion"));
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider: async () =>
        owner({
          name: "test",
          chat,
          chatStream: vi.fn(async () => response("")),
          healthCheck: vi.fn(async () => true),
        }),
      readIgnoreFile: async () => undefined,
      realpath: async (path) => {
        if (path === "/workspace") return "/real/workspace";
        if (path === "/workspace/src/alias.ts") {
          return "/real/workspace/src/target.ts";
        }
        return path;
      },
    });

    await expect(
      service.complete(
        request({
          requestId: "benign-symlink-alias",
          path: "/workspace/src/alias.ts",
        }),
      ),
    ).resolves.toMatchObject({
      status: "completed",
      text: "safe alias completion",
    });
    expect(chat).toHaveBeenCalledOnce();
    expect(JSON.stringify(chat.mock.calls)).toContain("src/target.ts");
  });

  it("honors root and nested gitignore rules before sending source", async () => {
    const chat = vi.fn(async () => response("safe"));
    const ignoreFiles = new Map<string, string>([
      ["/workspace/.gitignore", "private/**\n"],
      ["/workspace/src/.gitignore", "generated/**\n!generated/keep.ts\n"],
    ]);
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider: async () =>
        owner({
          name: "test",
          chat,
          chatStream: vi.fn(async () => response("")),
          healthCheck: vi.fn(async () => true),
        }),
      readIgnoreFile: async (path) => ignoreFiles.get(path),
      realpath: async (path) => path,
    });

    await expect(
      service.complete(
        request({
          requestId: "root-gitignored",
          generation: 1,
          path: "/workspace/private/secret.ts",
          prefix: "root private bytes",
        }),
      ),
    ).resolves.toMatchObject({
      status: "suppressed",
      reason: "sensitive_path",
    });
    await expect(
      service.complete(
        request({
          requestId: "nested-gitignored",
          generation: 2,
          changedtick: 9,
          path: "/workspace/src/generated/drop.ts",
          prefix: "nested private bytes",
        }),
      ),
    ).resolves.toMatchObject({
      status: "suppressed",
      reason: "sensitive_path",
    });
    await expect(
      service.complete(
        request({
          requestId: "nested-reincluded",
          generation: 3,
          changedtick: 10,
          path: "/workspace/src/generated/keep.ts",
          prefix: "explicitly retained source",
        }),
      ),
    ).resolves.toMatchObject({
      status: "completed",
      text: "safe",
    });

    expect(chat).toHaveBeenCalledOnce();
    expect(JSON.stringify(chat.mock.calls)).not.toContain("private bytes");
  });

  it("retains last-known ignore rules through an atomic-replace gap", async () => {
    const chat = vi.fn(async () => response("safe"));
    let agencIgnore: string | undefined = "private/**\n";
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider: async () =>
        owner({
          name: "test",
          chat,
          chatStream: vi.fn(async () => response("")),
          healthCheck: vi.fn(async () => true),
        }),
      readIgnoreFile: async (path) =>
        path === "/workspace/.agencignore" ? agencIgnore : undefined,
      realpath: async (path) => path,
    });

    await expect(
      service.complete(
        request({
          requestId: "prime-ignore-cache",
          path: "/workspace/src/public.ts",
        }),
      ),
    ).resolves.toMatchObject({ status: "completed" });

    // Atomic replacements may momentarily remove the directory entry. The
    // previously observed privacy rule must remain effective in that gap.
    agencIgnore = undefined;
    await expect(
      service.complete(
        request({
          requestId: "ignore-replace-gap",
          generation: 2,
          changedtick: 9,
          path: "/workspace/private/secret.ts",
          prefix: "must never reach the provider",
        }),
      ),
    ).resolves.toMatchObject({
      status: "suppressed",
      reason: "sensitive_path",
    });
    expect(chat).toHaveBeenCalledOnce();
    expect(JSON.stringify(chat.mock.calls)).not.toContain(
      "must never reach the provider",
    );
  });

  it("excludes related buffers whose canonical path escapes the workspace", async () => {
    const chat = vi.fn(async (messages: LLMMessage[]) => {
      expect(messages[0]?.content).not.toContain("externalSecret");
      expect(messages[0]?.content).toContain("publicValue");
      return response("safe");
    });
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider: async () =>
        owner({
          name: "test",
          chat,
          chatStream: vi.fn(async () => response("")),
          healthCheck: vi.fn(async () => true),
        }),
      readIgnoreFile: async () => undefined,
      realpath: async (path) => {
        if (path === "/workspace") return "/real/workspace";
        if (path === "/workspace/src/main.ts") {
          return "/real/workspace/src/main.ts";
        }
        if (path === "/workspace/src/external.ts") {
          return "/real/outside/external.ts";
        }
        if (path === "/workspace/src/public.ts") {
          return "/real/workspace/src/public.ts";
        }
        return path;
      },
    });

    await expect(
      service.complete(
        request({
          relatedBuffers: [
            {
              path: "/workspace/src/external.ts",
              content: "export const externalSecret = true;",
            },
            {
              path: "/workspace/src/public.ts",
              content: "export const publicValue = true;",
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      status: "completed",
      text: "safe",
    });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("disposes a provider created across a configuration reload", async () => {
    let resolveOwner!: (value: OwnedCodePredictionProvider) => void;
    const dispose = vi.fn(async () => {});
    const chat = vi.fn(async () => response("must not run"));
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider: async () =>
        await new Promise<OwnedCodePredictionProvider>((resolve) => {
          resolveOwner = resolve;
        }),
      readIgnoreFile: async () => undefined,
      realpath: async (path) => path,
    });

    const pending = service.complete(request());
    await vi.waitFor(() => expect(resolveOwner).toBeTypeOf("function"));
    await service.updateConfig({ enabled: "off" });
    resolveOwner(
      owner(
        {
          name: "test",
          chat,
          chatStream: vi.fn(async () => response("")),
          healthCheck: vi.fn(async () => true),
        },
        dispose,
      ),
    );

    await expect(pending).resolves.toMatchObject({
      status: "suppressed",
      reason: "stale",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
  });

  it("disposes only the terminated session route and creates a fresh route if reused", async () => {
    const chat = vi.fn(async () => response("answer"));
    const disposals: Array<ReturnType<typeof vi.fn>> = [];
    const createProvider = vi.fn(async () => {
      const dispose = vi.fn(async () => {});
      disposals.push(dispose);
      return owner(
        {
          name: "test",
          chat,
          chatStream: vi.fn(async () => response("")),
          healthCheck: vi.fn(async () => true),
        },
        dispose,
      );
    });
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider,
      readIgnoreFile: async () => undefined,
      realpath: async (path) => path,
    });

    await service.complete(request());
    await service.complete(
      request({
        requestId: "prediction-session-2",
        sessionId: "session-2",
        generation: 2,
        prefix: "const second = ",
      }),
    );

    await service.disposeSession("session-1");
    expect(disposals[0]).toHaveBeenCalledTimes(1);
    expect(disposals[1]).not.toHaveBeenCalled();

    await service.complete(
      request({
        requestId: "prediction-session-1-reused",
        generation: 3,
        changedtick: 10,
        prefix: "const reused = ",
      }),
    );
    expect(createProvider).toHaveBeenCalledTimes(3);
    expect(disposals[2]).not.toHaveBeenCalled();

    await service.dispose();
    expect(disposals[1]).toHaveBeenCalledTimes(1);
    expect(disposals[2]).toHaveBeenCalledTimes(1);
  });

  it("disposes a provider that finishes initializing after its session terminates", async () => {
    let resolveOwner!: (value: OwnedCodePredictionProvider) => void;
    const dispose = vi.fn(async () => {});
    const chat = vi.fn(async () => response("must not run"));
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: sourceProvider(),
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider: async () =>
        await new Promise<OwnedCodePredictionProvider>((resolve) => {
          resolveOwner = resolve;
        }),
      readIgnoreFile: async () => undefined,
      realpath: async (path) => path,
    });

    const pending = service.complete(request());
    await vi.waitFor(() => expect(resolveOwner).toBeTypeOf("function"));
    await service.disposeSession("session-1");
    resolveOwner(
      owner(
        {
          name: "test",
          chat,
          chatStream: vi.fn(async () => response("")),
          healthCheck: vi.fn(async () => true),
        },
        dispose,
      ),
    );

    await expect(pending).resolves.toMatchObject({
      status: "suppressed",
      reason: "stale",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
  });

  it("disposes the previous owned route when the live session provider changes", async () => {
    let primary = sourceProvider();
    const chat = vi.fn(async () => response("answer"));
    const disposals: Array<ReturnType<typeof vi.fn>> = [];
    const createProvider = vi.fn(async () => {
      const dispose = vi.fn(async () => {});
      disposals.push(dispose);
      return owner(
        {
          name: "test",
          chat,
          chatStream: vi.fn(async () => response("")),
          healthCheck: vi.fn(async () => true),
        },
        dispose,
      );
    });
    const service = new CodePredictionService({
      resolveSource: () => ({
        provider: primary,
        workspaceRoot: "/workspace",
      }),
      config: { enabled: "on" },
      createProvider,
      readIgnoreFile: async () => undefined,
      realpath: async (path) => path,
    });

    await service.complete(request());
    primary = sourceProvider();
    await service.complete(
      request({
        requestId: "prediction-after-switch",
        generation: 2,
        changedtick: 9,
        prefix: "const switched = ",
      }),
    );

    expect(createProvider).toHaveBeenCalledTimes(2);
    expect(disposals[0]).toHaveBeenCalledTimes(1);
    expect(disposals[1]).not.toHaveBeenCalled();
    await service.dispose();
    expect(disposals[1]).toHaveBeenCalledTimes(1);
  });
});
