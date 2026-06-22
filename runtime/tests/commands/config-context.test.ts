import { describe, expect, it } from "vitest";

import { defaultConfig, type AgenCConfig } from "../config/schema.js";
import { readCommandConfig } from "./config-context.js";
import type { SlashCommandContext } from "./types.js";

function contextWithStores(params: {
  readonly direct?: AgenCConfig;
  readonly session?: AgenCConfig;
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
    home: "/home/test",
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
