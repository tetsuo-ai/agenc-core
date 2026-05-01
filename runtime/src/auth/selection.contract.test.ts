import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, mergeConfigs } from "../config/schema.js";
import { LocalAuthBackend } from "./backends/local.js";
import { RemoteAuthBackend } from "./backends/remote.js";
import {
  createAuthBackend,
  InvalidAuthBackendConfigError,
  resolveAuthBackendKind,
} from "./selection.js";

async function makeTempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-auth-selection-"));
}

describe("auth backend selection", () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  });

  it("defaults auth.backend to local and creates LocalAuthBackend", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    const config = defaultConfig();

    expect(resolveAuthBackendKind(config)).toBe("local");
    const backend = createAuthBackend(config, { agencHome });

    expect(backend).toBeInstanceOf(LocalAuthBackend);
    expect((backend as LocalAuthBackend).authFile()).toBe(
      join(agencHome, "auth.json"),
    );
  });

  it("honors auth.backend = remote and creates RemoteAuthBackend", async () => {
    const config = mergeConfigs(defaultConfig(), {
      auth: { backend: "remote" },
    });

    expect(resolveAuthBackendKind(config)).toBe("remote");
    const backend = createAuthBackend(config, {
      remote: {
        keyVendor: ({ provider, sessionId }) => ({
          provider,
          sessionId,
          apiKey: "managed-key",
        }),
      },
    });

    expect(backend).toBeInstanceOf(RemoteAuthBackend);
    await expect(backend.vendKey("grok", "session-1")).resolves.toEqual({
      provider: "grok",
      sessionId: "session-1",
      apiKey: "managed-key",
    });
  });

  it("rejects invalid auth.backend values instead of falling back", () => {
    const config = {
      auth: { backend: "other" },
    } as unknown as ReturnType<typeof defaultConfig>;

    expect(() => resolveAuthBackendKind(config)).toThrow(
      InvalidAuthBackendConfigError,
    );
  });
});
