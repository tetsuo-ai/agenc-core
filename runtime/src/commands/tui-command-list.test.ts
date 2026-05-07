import { describe, it, expect } from "vitest";

import { buildDefaultRegistry } from "./registry.js";
import {
  builtInCommandNames,
  clearCommandMemoizationCaches,
  filterCommandsForRemoteMode,
  getCommandsSync,
  listTuiCommandList,
} from "../commands.js";

describe("listTuiCommandList (TUI slash-command wiring)", () => {
  it("returns exactly the user-invocable subset of the registry", () => {
    const previousUserType = process.env.USER_TYPE;
    delete process.env.USER_TYPE;
    const expected = buildDefaultRegistry()
      .list()
      .filter((cmd) => cmd.userInvocable !== false && (cmd.isEnabled?.() ?? true)).length;
    try {
      const list = listTuiCommandList();
      expect(list.length).toBe(expected);
      expect(list.length).toBeGreaterThanOrEqual(18);
    } finally {
      if (previousUserType === undefined) {
        delete process.env.USER_TYPE;
      } else {
        process.env.USER_TYPE = previousUserType;
      }
    }
  });

  it("every entry carries name, description, and the local command discriminator", () => {
    const list = listTuiCommandList();
    for (const cmd of list) {
      expect(typeof cmd.name).toBe("string");
      expect(cmd.name.length).toBeGreaterThan(0);
      expect(typeof cmd.description).toBe("string");
      expect(cmd.description.length).toBeGreaterThan(0);
      if (cmd.name === "btw" || cmd.name === "memory") {
        expect((cmd as { type: string }).type).toBe("local-jsx");
      } else {
        expect((cmd as { type: string }).type).toBe("local");
      }
    }
  });

  it("uses the interactive local JSX descriptor for /memory", () => {
    const memory = listTuiCommandList().find((cmd) => cmd.name === "memory");
    expect(memory).toBeDefined();
    expect(memory?.type).toBe("local-jsx");
    expect(memory?.description).toBe("Edit AgenC memory files");
  });

  it("uses the interactive local JSX descriptor for /btw", () => {
    const btw = listTuiCommandList().find((cmd) => cmd.name === "btw");
    expect(btw).toBeDefined();
    expect(btw?.type).toBe("local-jsx");
    expect(btw?.immediate).toBe(true);
    expect(btw?.description).toBe(
      "Ask a quick side question without interrupting the main conversation",
    );
  });

  it("excludes commands marked userInvocable=false", () => {
    const registry = buildDefaultRegistry();
    const expected = registry
      .list()
      .filter((cmd) => cmd.userInvocable !== false && (cmd.isEnabled?.() ?? true))
      .map((cmd) => cmd.name)
      .sort();
    const got = listTuiCommandList()
      .map((cmd) => cmd.name)
      .sort();
    expect(got).toEqual(expected);
  });

  it("preserves aliases when present on the AgenC command", () => {
    const list = listTuiCommandList();
    const registry = buildDefaultRegistry();
    for (const cmd of registry.list()) {
      if (cmd.userInvocable === false) continue;
      if (cmd.isEnabled?.() === false) continue;
      const projected = list.find((p) => p.name === cmd.name);
      expect(projected).toBeDefined();
      if (cmd.aliases && cmd.aliases.length > 0) {
        expect(projected?.aliases).toEqual([...cmd.aliases]);
      } else {
        expect(projected?.aliases).toBeUndefined();
      }
    }
  });

  it("load() exposes a non-throwing local command fallback", async () => {
    const list = listTuiCommandList();
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
      .filter((cmd) => cmd.userInvocable !== false && (cmd.isEnabled?.() ?? true))
      .map((cmd) => cmd.name);
    const projectedNames = listTuiCommandList().map((cmd) => cmd.name);
    expect(projectedNames).toEqual(registryNames);
  });

  it("omits disabled commands from the TUI command list", () => {
    const previousUserType = process.env.USER_TYPE;
    try {
      delete process.env.USER_TYPE;
      expect(listTuiCommandList().map((cmd) => cmd.name)).not.toContain("files");
      process.env.USER_TYPE = "ant";
      expect(listTuiCommandList().map((cmd) => cmd.name)).toContain("files");
    } finally {
      if (previousUserType === undefined) {
        delete process.env.USER_TYPE;
      } else {
        process.env.USER_TYPE = previousUserType;
      }
    }
  });

  it("canonical command module exposes the tested runtime command surface", async () => {
    const previousUserType = process.env.USER_TYPE;
    try {
      delete process.env.USER_TYPE;
      expect(builtInCommandNames().has("help")).toBe(true);
      expect(typeof clearCommandMemoizationCaches).toBe("function");

      const commands = getCommandsSync();
      const reloadPlugins = commands.find((cmd) => cmd.name === "reload-plugins");
      const files = commands.find((cmd) => cmd.name === "files");
      expect(reloadPlugins?.supportsNonInteractive).toBe(false);
      expect(files?.supportsNonInteractive).toBe(true);
      expect(files?.isEnabled?.()).toBe(false);
      expect(
        filterCommandsForRemoteMode(commands).map((cmd) => cmd.name),
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
