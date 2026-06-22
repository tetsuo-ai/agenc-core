import { describe, expect, it } from "vitest";

import { defaultConfig, type AgenCConfig } from "../config/schema.js";
import {
  agencHomeFromCommandContext,
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

  it("prefers the dispatch context over the session services fallback", () => {
    const direct = configWithModel("direct-model");
    const session = configWithModel("session-model");

    expect(readCommandConfig(contextWithStores({ direct, session }))).toBe(
      direct,
    );
  });

  it("returns undefined when neither config store is reachable", () => {
    expect(readCommandConfig(contextWithStores({}))).toBeUndefined();
  });
});

describe("command config paths", () => {
  it("prefers an explicit AgenC home from the command context", () => {
    const ctx = contextWithStores({ agencHome: "/tmp/agenc-home" });

    expect(agencHomeFromCommandContext(ctx)).toBe("/tmp/agenc-home");
  });

  it("falls back to $HOME/.agenc when the command context has no AgenC home", () => {
    const ctx = contextWithStores({ home: "/home/alice" });

    expect(agencHomeFromCommandContext(ctx)).toBe("/home/alice/.agenc");
  });

  it("builds config.toml paths from command contexts and raw homes", () => {
    const ctx = contextWithStores({ agencHome: "/tmp/agenc-home" });

    expect(configFilePathFromCommandContext(ctx)).toBe(
      "/tmp/agenc-home/config.toml",
    );
    expect(getConfigFilePath("/home/alice/.agenc")).toBe(
      "/home/alice/.agenc/config.toml",
    );
  });
});
