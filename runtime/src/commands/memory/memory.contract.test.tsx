import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getCommandsSync } from "../../commands.js";
import { buildDefaultRegistry } from "../registry.js";
import { dispatchSlashCommand, parseSlashCommand } from "../dispatcher.js";
import type { SlashCommandContext } from "../types.js";

const root = resolve(process.cwd(), "..");

function fakeContext(): SlashCommandContext {
  return {
    session: {
      conversationId: "memory-test",
      services: {},
    },
    argsRaw: "",
    cwd: "/tmp/project",
    home: "/tmp",
    agencHome: "/tmp/.agenc",
  } as SlashCommandContext;
}

describe("memory command contract", () => {
  it("keeps the copied memory command directory wired into registry and TUI surfaces", () => {
    expect(existsSync(resolve(root, "runtime/src/commands/memory/index.ts"))).toBe(
      true,
    );
    expect(existsSync(resolve(root, "runtime/src/commands/memory/memory.tsx"))).toBe(
      true,
    );
    const registry = readFileSync(
      resolve(root, "runtime/src/commands/registry.ts"),
      "utf8",
    );
    expect(registry).toContain('from "./memory/slash.js"');

    const commandSurface = readFileSync(
      resolve(root, "runtime/src/commands.ts"),
      "utf8",
    );
    expect(commandSurface).toContain('from "./commands/memory/index.js"');
    expect(commandSurface).toContain("LOCAL_JSX_COMMAND_OVERRIDES");

    const memoryIndex = readFileSync(
      resolve(root, "runtime/src/commands/memory/index.ts"),
      "utf8",
    );
    expect(memoryIndex).toContain('import("./memory.js")');
  });

  it("exposes /memory as the interactive local JSX command in the TUI list", () => {
    const memory = getCommandsSync().find(command => command.name === "memory");
    expect(memory).toBeDefined();
    expect(memory?.type).toBe("local-jsx");
    expect(memory?.description).toBe("Edit AgenC memory files");
    expect(memory?.name).toBe("memory");
    expect(memory).not.toHaveProperty("immediate");
  });

  it("keeps a non-throwing dispatcher fallback for headless /memory calls", async () => {
    const parsed = parseSlashCommand("/memory");
    expect(parsed).not.toBeNull();

    const outcome = await dispatchSlashCommand(
      parsed!,
      fakeContext(),
      buildDefaultRegistry(),
    );

    expect(outcome.result).toEqual({
      kind: "text",
      text: expect.stringContaining("agenc memory editor"),
    });
    expect(outcome.immediate).toBe(true);
  });

  it("routes the JSX command body to the live TUI memory components", () => {
    const source = readFileSync(
      resolve(root, "runtime/src/commands/memory/memory.tsx"),
      "utf8",
    );

    expect(source).toContain("../../tui/components/memory/MemoryFileSelector.js");
    expect(source).toContain(
      "../../tui/components/memory/MemoryUpdateNotification.js",
    );
    expect(source).toContain("../../memory/index.js");
    expect(source).toContain("https://agenc.tech/docs/en/memory");
    expect(source).not.toContain("../../components/memory/MemoryFileSelector.js");
  });

  it("records MM-06 parity evidence for every donor source", () => {
    const parity = readFileSync(
      resolve(root, "parity/MM-06-parity.json"),
      "utf8",
    );

    for (const source of [
      "src/commands/memory/index.ts",
      "src/commands/memory/memory.tsx",
      "src/components/memory/MemoryFileSelector.tsx",
      "src/components/memory/MemoryUpdateNotification.tsx",
      "src/components/memory/memoryFileSelectorPaths.ts",
    ]) {
      expect(parity).toContain(source);
    }
  });
});
