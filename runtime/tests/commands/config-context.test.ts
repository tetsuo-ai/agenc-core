import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { defaultConfig, type AgenCConfig } from "../config/schema.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";
import {
  agencHomeFromCommandContext,
  configStoreFromCommandContext,
  configFilePathFromCommandContext,
  getConfigFilePath,
  readCommandConfig,
} from "./config-context.js";
import type { SlashCommandContext } from "./types.js";

function contextWithStores(params: {
  readonly direct?: AgenCConfig;
  readonly session?: AgenCConfig;
  readonly home?: string;
  readonly agencHome?: string;
}): SlashCommandContext {
  return {
    session: {
      services: {
        ...(params.session !== undefined
          ? { configStore: { current: () => params.session } }
          : {}),
      },
    } as unknown as SlashCommandContext["session"],
    argsRaw: "",
    cwd: "/ws",
    home: params.home ?? "/home/test",
    ...(params.agencHome !== undefined ? { agencHome: params.agencHome } : {}),
    ...(params.direct !== undefined
      ? {
          configStore: {
            current: () => params.direct,
          } as SlashCommandContext["configStore"],
        }
      : {}),
  };
}

function configWithModel(model: string): AgenCConfig {
  return { ...defaultConfig(), model };
}

describe("readCommandConfig", () => {
  it("uses the dispatch context config store when available", () => {
    const direct = configWithModel("direct-model");

    expect(readCommandConfig(contextWithStores({ direct }))).toBe(direct);
  });

  it("falls back to session services when no dispatch config store is wired", () => {
    const session = configWithModel("session-model");

    expect(readCommandConfig(contextWithStores({ session }))).toBe(session);
  });

  it("rejects conflicting dispatch and session config authorities", () => {
    const direct = configWithModel("direct-model");
    const session = configWithModel("session-model");

    expect(() =>
      readCommandConfig(contextWithStores({ direct, session })),
    ).toThrow(/conflicting ConfigStore authorities/);
  });

  it("returns undefined when neither config store is reachable", () => {
    expect(readCommandConfig(contextWithStores({}))).toBeUndefined();
    expect(configStoreFromCommandContext(contextWithStores({}))).toBeNull();
  });

  it("ignores array-shaped config store surfaces", () => {
    const directCurrent = vi.fn(() => configWithModel("direct-spoof"));
    const sessionCurrent = vi.fn(() => configWithModel("session-spoof"));
    const ctx = {
      ...contextWithStores({}),
      configStore: Object.assign(["direct"], {
        current: directCurrent,
      }) as unknown as SlashCommandContext["configStore"],
      session: {
        services: {
          configStore: Object.assign(["session"], {
            current: sessionCurrent,
          }),
        },
      } as unknown as SlashCommandContext["session"],
    };

    expect(readCommandConfig(ctx)).toBeUndefined();
    expect(configStoreFromCommandContext(ctx)).toBeNull();
    expect(directCurrent).not.toHaveBeenCalled();
    expect(sessionCurrent).not.toHaveBeenCalled();
  });
});

describe("command config paths", () => {
  // AgenC homes resolve to their real path. macOS reaches /tmp and /home
  // through symlinks, so these homes sit under the canonical temp directory.
  it("prefers an explicit AgenC home from the command context", () => {
    const agencHome = join(canonicalTmpdir(), "agenc-home");
    const ctx = contextWithStores({ agencHome });

    expect(agencHomeFromCommandContext(ctx)).toBe(agencHome);
  });

  it("falls back to $HOME/.agenc when the command context has no AgenC home", () => {
    const home = join(canonicalTmpdir(), "alice");
    const ctx = contextWithStores({ home });

    expect(agencHomeFromCommandContext(ctx)).toBe(join(home, ".agenc"));
  });

  it("builds config.toml paths from command contexts and raw homes", () => {
    const agencHome = join(canonicalTmpdir(), "agenc-home");
    const ctx = contextWithStores({ agencHome });

    expect(configFilePathFromCommandContext(ctx)).toBe(
      join(agencHome, "config.toml"),
    );
    expect(getConfigFilePath("/home/alice/.agenc")).toBe(
      "/home/alice/.agenc/config.toml",
    );
  });
});
