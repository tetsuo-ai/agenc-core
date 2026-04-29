import { describe, expect, it } from "vitest";
import { createMemoryBackend } from "./memory-backend-factory.js";
import { resolveRuntimePersistencePaths } from "./runtime-persistence.js";
import { silentLogger } from "../utils/logger.js";

describe("createMemoryBackend", () => {
  it("defaults to sqlite durability when memory config is omitted", async () => {
    const backend = await createMemoryBackend({
      config: {
        gateway: { port: 3100 },
        agent: { name: "test-agent" },
        connection: { rpcUrl: "https://api.devnet.solana.com" },
      } as any,
      logger: silentLogger,
    });

    expect(backend.name).toBe("sqlite");
    await backend.close();
  });

  it("keeps explicit in-memory mode available for dev flows", async () => {
    const backend = await createMemoryBackend({
      config: {
        gateway: { port: 3100 },
        agent: { name: "test-agent" },
        connection: { rpcUrl: "https://api.devnet.solana.com" },
        memory: { backend: "memory" },
      } as any,
      logger: silentLogger,
    });

    expect(backend.name).toBe("in-memory");
    await backend.close();
  });

  it("resolves sqlite to the shared runtime persistence path by default", async () => {
    const backend = await createMemoryBackend({
      config: {
        gateway: { port: 3100 },
        agent: { name: "test-agent" },
        connection: { rpcUrl: "https://api.devnet.solana.com" },
        memory: { backend: "sqlite" },
      } as any,
      logger: silentLogger,
    });

    expect(resolveRuntimePersistencePaths().memoryDbPath).toContain(".agenc");
    expect(backend.name).toBe("sqlite");
    await backend.close();
  });
});
