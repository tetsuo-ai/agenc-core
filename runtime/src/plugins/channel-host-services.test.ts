import { describe, expect, it, vi } from "vitest";
import { createChannelHostServices } from "./channel-host-services.js";

describe("createChannelHostServices", () => {
  it("returns concordia memory services when a backend is available", () => {
    const backend = {
      addEntry: vi.fn(),
      getThread: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
    };

    const services = createChannelHostServices({
      memoryBackend: backend as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      workspacePath: "/tmp/agenc-test",
      llmConfig: {
        provider: "grok",
        apiKey: "test-key",
        model: "grok-4.20-beta-0309-reasoning",
        baseUrl: "https://api.x.ai/v1",
      },
    });

    expect(services?.concordia_memory).toBeDefined();
    expect(services?.concordia_memory?.memoryBackend).toBe(backend);
    expect(services?.concordia_memory?.dailyLogManager).toBeDefined();
    expect(services?.concordia_runtime?.llm).toEqual({
      provider: "grok",
      apiKey: "test-key",
      model: "grok-4.20-beta-0309-reasoning",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it("returns undefined when memory is unavailable", () => {
    expect(
      createChannelHostServices({
        memoryBackend: null,
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      }),
    ).toBeUndefined();
  });

  it("returns runtime LLM services even when memory is unavailable", () => {
    const services = createChannelHostServices({
      memoryBackend: null,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      llmConfig: {
        provider: "grok",
        apiKey: "test-key",
      },
    });

    expect(services?.concordia_runtime?.llm.provider).toBe("grok");
    expect(services?.concordia_runtime?.llm.apiKey).toBe("test-key");
    expect(services?.concordia_memory).toBeUndefined();
  });
});
