import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveHomeContext } from "../config/home.js";
import { buildDefaultRegistry } from "./registry.js";
import type { SlashCommandContext } from "./types.js";
import { usageCommand } from "./usage.js";

function commandCtx(agencHome: string): SlashCommandContext {
  const configStore = {
    current: () => ({}),
    homeContext: resolveHomeContext({ AGENC_HOME: agencHome }),
  } as SlashCommandContext["configStore"];
  return {
    session: {
      services: {
        configStore,
        providerService: { environment: () => ({}) },
      },
    } as SlashCommandContext["session"],
    argsRaw: "",
    cwd: agencHome,
    home: agencHome,
    agencHome,
    configStore,
  };
}

describe("/usage", () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  });

  async function makeHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "agenc-usage-command-"));
    homes.push(home);
    return home;
  }

  it("shows provider usage and no AgenC account section", async () => {
    const result = await usageCommand.execute(commandCtx(await makeHome()));
    expect(result.kind).toBe("text");
    expect(result).toEqual(expect.objectContaining({ text: expect.stringContaining("Providers") }));
    expect(result).toEqual(expect.objectContaining({ text: expect.not.stringContaining("AgenC account") }));
  });

  it("routes one argument to the provider detail and rejects more", async () => {
    const agencHome = await makeHome();
    await expect(usageCommand.execute({ ...commandCtx(agencHome), argsRaw: " mistral " })).resolves.toEqual({
      kind: "text",
      text: "Mistral has no balance or usage API that works with an API key.",
    });
    await expect(usageCommand.execute({ ...commandCtx(agencHome), argsRaw: "ollama extra" })).resolves.toEqual({
      kind: "error",
      message: "Usage: /usage [provider]",
    });
    expect(usageCommand.argumentHint).toBe("[provider]");
  });

  it("is registered, and the retired AgenC account commands are not", () => {
    const registry = buildDefaultRegistry();
    expect(registry.find("usage")).toBe(usageCommand);
    for (const name of ["login", "logout", "whoami", "account", "subscription", "billing", "remote"]) {
      expect(registry.find(name)).toBeUndefined();
    }
  });
});
