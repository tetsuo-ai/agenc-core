import { describe, it, expect } from "vitest";

import { buildDefaultRegistry } from "./registry.js";
import type * as RuntimeCommands from "../commands.js";
import { loadUpstreamCommandList } from "../agenc/adapters/upstream-commands.js";

async function importLegacyCommandShim(): Promise<typeof RuntimeCommands> {
  const legacyPrefix = "../agenc/upstream/";
  return import(legacyPrefix + "commands.js") as Promise<typeof RuntimeCommands>;
}

describe("loadUpstreamCommandList (TUI slash-command wiring)", () => {
  it("returns exactly the user-invocable subset of the registry", () => {
    const expected = buildDefaultRegistry()
      .list()
      .filter((cmd) => cmd.userInvocable !== false).length;
    const list = loadUpstreamCommandList();
    expect(list.length).toBe(expected);
    expect(list.length).toBeGreaterThanOrEqual(18);
  });

  it("every entry carries name, description, and the upstream local-type discriminator", () => {
    const list = loadUpstreamCommandList();
    for (const cmd of list) {
      expect(typeof cmd.name).toBe("string");
      expect(cmd.name.length).toBeGreaterThan(0);
      expect(typeof cmd.description).toBe("string");
      expect(cmd.description.length).toBeGreaterThan(0);
      expect((cmd as { type: string }).type).toBe("local");
    }
  });

  it("excludes commands marked userInvocable=false", () => {
    const registry = buildDefaultRegistry();
    const expected = registry
      .list()
      .filter((cmd) => cmd.userInvocable !== false)
      .map((cmd) => cmd.name)
      .sort();
    const got = loadUpstreamCommandList()
      .map((cmd) => cmd.name)
      .sort();
    expect(got).toEqual(expected);
  });

  it("preserves aliases when present on the AgenC command", () => {
    const list = loadUpstreamCommandList();
    const registry = buildDefaultRegistry();
    for (const cmd of registry.list()) {
      if (cmd.userInvocable === false) continue;
      const projected = list.find((p) => p.name === cmd.name);
      expect(projected).toBeDefined();
      if (cmd.aliases && cmd.aliases.length > 0) {
        expect(projected?.aliases).toEqual([...cmd.aliases]);
      } else {
        expect(projected?.aliases).toBeUndefined();
      }
    }
  });

  it("upstream load() exposes a non-throwing legacy adapter", async () => {
    const list = loadUpstreamCommandList();
    const sample = list[0];
    expect(sample).toBeDefined();
    expect((sample as { type: string }).type).toBe("local");
    const local = sample as Extract<typeof sample, { type: "local" }>;
    const loaded = await local.load();
    await expect(loaded.call("", {} as never)).resolves.toMatchObject({
      type: "text",
      value: expect.stringContaining("requires a live session context"),
    });
  });

  it("registration order from buildDefaultRegistry is preserved", () => {
    const registryNames = buildDefaultRegistry()
      .list()
      .filter((cmd) => cmd.userInvocable !== false)
      .map((cmd) => cmd.name);
    const projectedNames = loadUpstreamCommandList().map((cmd) => cmd.name);
    expect(projectedNames).toEqual(registryNames);
  });

  it("legacy command-module shim re-exports the tested runtime command surface", async () => {
    const previousUserType = process.env.USER_TYPE;
    try {
      delete process.env.USER_TYPE;
      const shim = await importLegacyCommandShim();
      expect(shim.builtInCommandNames().has("help")).toBe(true);
      expect(typeof shim.clearCommandMemoizationCaches).toBe("function");

      const commands = shim.getCommandsSync();
      const reloadPlugins = commands.find((cmd) => cmd.name === "reload-plugins");
      const files = commands.find((cmd) => cmd.name === "files");
      expect(reloadPlugins?.supportsNonInteractive).toBe(false);
      expect(files?.supportsNonInteractive).toBe(true);
      expect(files?.isEnabled?.()).toBe(false);
      expect(
        shim.filterCommandsForRemoteMode(commands).map((cmd) => cmd.name),
      ).not.toContain("reload-plugins");
    } finally {
      if (previousUserType === undefined) {
        delete process.env.USER_TYPE;
      } else {
        process.env.USER_TYPE = previousUserType;
      }
    }
  });
});
