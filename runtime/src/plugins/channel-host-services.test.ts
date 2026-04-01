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
    });

    expect(services?.concordia_memory).toBeDefined();
    expect(services?.concordia_memory?.memoryBackend).toBe(backend);
    expect(services?.concordia_memory?.dailyLogManager).toBeDefined();
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
});
