import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodeRequire = createRequire(import.meta.url);
const requireExtensions = nodeRequire.extensions as Record<
  string,
  (module: { exports: unknown }, filename: string) => void
>;
requireExtensions[".txt"] = (module, filename) => {
  module.exports = readFileSync(filename, "utf8");
};

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../tools.js", () => ({}));
vi.mock("src/tools.js", () => ({}));
vi.mock("../utils/auth.js", () => ({
  getSubscriptionType: () => undefined,
  isOverageProvisioningAllowed: () => true,
  getOauthAccountInfo: () => null,
  hasAnthropicApiKeyAuth: () => false,
  hasproviderApiKeyAuth: () => false,
  isproviderAuthEnabled: () => false,
  isAgenCAISubscriber: () => false,
  isConsumerSubscriber: () => false,
}));
vi.mock("src/utils/auth.js", () => ({
  getSubscriptionType: () => undefined,
  isOverageProvisioningAllowed: () => true,
  getOauthAccountInfo: () => null,
  hasAnthropicApiKeyAuth: () => false,
  hasproviderApiKeyAuth: () => false,
  isproviderAuthEnabled: () => false,
  isAgenCAISubscriber: () => false,
  isConsumerSubscriber: () => false,
}));
vi.mock("../tools/ScheduleCronTool/CronCreateTool.js", () => ({ CronCreateTool: {} }));
vi.mock("../tools/ScheduleCronTool/CronDeleteTool.js", () => ({ CronDeleteTool: {} }));
vi.mock("../tools/ScheduleCronTool/CronListTool.js", () => ({ CronListTool: {} }));

import {
  CommandRegistry,
  buildDefaultRegistry,
  registeredLegacyCommandSurfaceSpecs,
  registeredLegacyCommandSurfaceNames,
} from "./registry.js";
import type {
  SlashCommand,
  SlashCommandContext,
  SlashCommandResult,
} from "./types.js";

function mkCmd(
  name: string,
  aliases?: readonly string[],
  userInvocable?: boolean,
): SlashCommand {
  const cmd: SlashCommand = {
    name,
    description: `test ${name}`,
    execute: async () => ({ kind: "text", text: name } satisfies SlashCommandResult),
  };
  if (aliases !== undefined) {
    (cmd as { aliases?: readonly string[] }).aliases = aliases;
  }
  if (userInvocable !== undefined) {
    (cmd as { userInvocable?: boolean }).userInvocable = userInvocable;
  }
  return cmd;
}

function resolveSpecValue<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

type LegacySurfaceSpec = typeof registeredLegacyCommandSurfaceSpecs[number];

async function loadSpecDescriptor(
  spec: LegacySurfaceSpec,
  modulePath: string,
  exportName: string | undefined = spec.exportName,
): Promise<unknown> {
  const loaded = await import(modulePath) as Record<string, unknown>;
  const exported = exportName === undefined ? loaded.default : loaded[exportName];
  return spec.factory && typeof exported === "function" ? exported() : exported;
}

function expectDescriptorShape(
  descriptor: unknown,
  spec: LegacySurfaceSpec,
): void {
  expect(descriptor, `missing descriptor for /${spec.name}`).toBeTruthy();
  expect((descriptor as { name?: unknown }).name).toBe(spec.name);
  expect((descriptor as { type?: unknown }).type).toBe(spec.type);
}

describe("CommandRegistry — basic register/find/has", () => {
  let reg: CommandRegistry;
  beforeEach(() => {
    reg = new CommandRegistry();
  });

  it("register + find by name", () => {
    const help = mkCmd("help");
    reg.register(help);
    expect(reg.find("help")).toBe(help);
  });

  it("find returns undefined for unknown name", () => {
    expect(reg.find("nope")).toBeUndefined();
  });

  it("find by alias", () => {
    const status = mkCmd("status", ["stat", "s"]);
    reg.register(status);
    expect(reg.find("stat")).toBe(status);
    expect(reg.find("s")).toBe(status);
  });

  it("find is case-insensitive", () => {
    const help = mkCmd("help");
    reg.register(help);
    expect(reg.find("HELP")).toBe(help);
    expect(reg.find("Help")).toBe(help);
  });

  it("has() returns true for registered name and alias", () => {
    reg.register(mkCmd("help", ["h"]));
    expect(reg.has("help")).toBe(true);
    expect(reg.has("h")).toBe(true);
    expect(reg.has("HELP")).toBe(true);
  });

  it("has() returns false for unknown", () => {
    expect(reg.has("nope")).toBe(false);
  });
});

describe("CommandRegistry — collision policy", () => {
  let reg: CommandRegistry;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reg = new CommandRegistry();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("throws on duplicate name", () => {
    reg.register(mkCmd("status"));
    expect(() => reg.register(mkCmd("status"))).toThrow(
      /duplicate command name/i,
    );
  });

  it("throws on duplicate name (case-insensitive)", () => {
    reg.register(mkCmd("status"));
    expect(() => reg.register(mkCmd("STATUS"))).toThrow(
      /duplicate command name/i,
    );
  });

  it("throws when a new command name collides with an existing alias", () => {
    reg.register(mkCmd("status", ["help"]));
    expect(() => reg.register(mkCmd("help"))).toThrow(
      /collides with existing alias/i,
    );
  });

  it("throws when a new alias collides with an existing command name", () => {
    reg.register(mkCmd("help"));
    expect(() => reg.register(mkCmd("status", ["help"]))).toThrow(
      /collides with existing command name/i,
    );
  });

  it("warns + drops the colliding alias (first-registered wins)", () => {
    const first = mkCmd("status", ["s"]);
    const second = mkCmd("search", ["s"]);
    reg.register(first);
    reg.register(second);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(reg.find("s")).toBe(first);
    expect(reg.has("search")).toBe(true);
  });

  it("rolls back partial registration on alias-name collision", () => {
    reg.register(mkCmd("help"));
    expect(() => reg.register(mkCmd("status", ["help", "x"]))).toThrow();
    // status itself must NOT have been registered because its alias was invalid
    expect(reg.has("status")).toBe(false);
    // and the attempted-but-rolled-back alias "x" must also be absent
    expect(reg.has("x")).toBe(false);
  });
});

describe("CommandRegistry — list()", () => {
  it("returns commands in registration order", () => {
    const reg = new CommandRegistry();
    reg.register(mkCmd("zeta"));
    reg.register(mkCmd("alpha"));
    reg.register(mkCmd("mu"));
    const names = reg.list().map((c) => c.name);
    expect(names).toEqual(["zeta", "alpha", "mu"]);
  });

  it("returns a stable snapshot (does not expose internal Map)", () => {
    const reg = new CommandRegistry();
    reg.register(mkCmd("a"));
    const snap1 = reg.list();
    reg.register(mkCmd("b"));
    const snap2 = reg.list();
    // snap1 must not have been mutated by the later register()
    expect(snap1.map((c) => c.name)).toEqual(["a"]);
    expect(snap2.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("returns an empty array for an empty registry", () => {
    expect(new CommandRegistry().list()).toEqual([]);
  });
});

describe("CommandRegistry — fromCommands()", () => {
  it("registers every command in order", () => {
    const reg = CommandRegistry.fromCommands([
      mkCmd("a"),
      mkCmd("b", ["bb"]),
    ]);
    expect(reg.has("a")).toBe(true);
    expect(reg.has("b")).toBe(true);
    expect(reg.has("bb")).toBe(true);
  });

  it("propagates registration errors", () => {
    expect(() =>
      CommandRegistry.fromCommands([mkCmd("dup"), mkCmd("dup")]),
    ).toThrow(/duplicate/i);
  });
});

describe("CommandRegistry — dynamic command replacement", () => {
  it("replaces one dynamic source without rebuilding the registry", () => {
    const reg = CommandRegistry.fromCommands([mkCmd("help")]);
    const first = mkCmd("sample:hello", ["sample:hi"]);
    const second = mkCmd("sample:bye");

    reg.replaceDynamicCommands("plugins", [first]);
    expect(reg.find("sample:hello")).toBe(first);
    expect(reg.find("sample:hi")).toBe(first);
    expect(reg.has("help")).toBe(true);

    reg.replaceDynamicCommands("plugins", [second]);
    expect(reg.find("sample:hello")).toBeUndefined();
    expect(reg.find("sample:hi")).toBeUndefined();
    expect(reg.find("sample:bye")).toBe(second);
    expect(reg.has("help")).toBe(true);
  });

  it("keeps the previous dynamic source when replacement collides", () => {
    const reg = CommandRegistry.fromCommands([mkCmd("help")]);
    const first = mkCmd("sample:hello");
    reg.replaceDynamicCommands("plugins", [first]);

    expect(() =>
      reg.replaceDynamicCommands("plugins", [mkCmd("help")]),
    ).toThrow(/duplicate command name/i);
    expect(reg.find("sample:hello")).toBe(first);
    expect(reg.find("help")).toBeDefined();
  });
});

describe("buildDefaultRegistry()", () => {
  it("includes help and status", () => {
    const reg = buildDefaultRegistry();
    expect(reg.has("help")).toBe(true);
    expect(reg.has("status")).toBe(true);
  });

  it("exposes AgenC-facing aliases like /provider and /approvals", () => {
    const reg = buildDefaultRegistry();
    expect(reg.has("provider")).toBe(true);
    expect(reg.has("approvals")).toBe(true);
  });

  it("includes the worktree adapters", () => {
    const reg = buildDefaultRegistry();
    expect(reg.has("enter-worktree")).toBe(true);
    expect(reg.has("exit-worktree")).toBe(true);
  });

  it("includes retained command surfaces", () => {
    const reg = buildDefaultRegistry();
    expect(reg.has("copy")).toBe(true);
    expect(reg.has("mcp")).toBe(true);
    expect(reg.has("memory")).toBe(true);
    expect(reg.has("skills")).toBe(true);
  });

  it("registers legacy command surfaces that still have executable modules", () => {
    const reg = buildDefaultRegistry();
    const names = registeredLegacyCommandSurfaceNames();
    expect(names).toContain("agents");
    // Upstream-product commands /dream, /voice, /chrome, /desktop, etc.
    // were intentionally removed in the cleanup pass — they're gated to
    // build-flavors AgenC's distribution doesn't ship. The remaining
    // legacy commands all map to executable modules.
    expect(names).not.toContain("btw");
    expect(names).not.toContain("buddy");
    for (const name of names) {
      expect(reg.has(name)).toBe(true);
    }
    expect(reg.has("remote-control")).toBe(false);
    expect(reg.has("rc")).toBe(false);
    expect(reg.has("terminal-setup")).toBe(true);
  });

  it("preserves registry metadata for every legacy command surface", () => {
    const reg = buildDefaultRegistry();

    for (const spec of registeredLegacyCommandSurfaceSpecs) {
      if (spec.register === false) continue;
      const command = reg.find(spec.name);
      expect(command, `missing /${spec.name}`).toBeDefined();
      expect(command?.description).toBe(resolveSpecValue(spec.description));
      expect(command?.aliases).toEqual(spec.aliases);
      expect(command?.supportsNonInteractive).toBe(spec.supportsNonInteractive);
      expect((command as { isHidden?: boolean } | undefined)?.isHidden).toBe(
        spec.isHidden === undefined ? undefined : resolveSpecValue(spec.isHidden),
      );
      expect(command?.immediate).toBe(
        spec.immediate === undefined ? undefined : resolveSpecValue(spec.immediate),
      );
      expect(command?.userInvocable).toBe(spec.userInvocable);
      expect(command?.isEnabled?.()).toBe(spec.isEnabled?.());
    }
  });

  it("loads every shared legacy command descriptor export", async () => {
    for (const spec of registeredLegacyCommandSurfaceSpecs) {
      const registryDescriptor = await loadSpecDescriptor(spec, spec.modulePath);
      expectDescriptorShape(registryDescriptor, spec);

      const tuiModulePath = `../${spec.tuiModulePath.slice(2)}`;
      const tuiDescriptor = await loadSpecDescriptor(spec, tuiModulePath);
      expectDescriptorShape(tuiDescriptor, spec);

      if (spec.nonInteractiveExportName !== undefined) {
        const alternate = await loadSpecDescriptor(
          spec,
          spec.modulePath,
          spec.nonInteractiveExportName,
        );
        expect((alternate as { name?: unknown }).name).toBe(spec.name);
        expect((alternate as { type?: unknown }).type).toBe("local");
      }
    }
  });

  it("executes representable local legacy command surfaces through the registry", async () => {
    const reg = buildDefaultRegistry();
    const command = reg.find("rewind");
    expect(command).toBeDefined();

    const result = await command?.execute({
      argsRaw: "",
      cwd: "/tmp",
      home: "/tmp",
      session: {} as never,
    });

    expect(result).toEqual({
      kind: "skip",
    });
  });

  it("executes representable prompt legacy command surfaces through the registry", async () => {
    const reg = buildDefaultRegistry();
    const command = reg.find("pr-comments");
    expect(command).toBeDefined();

    const result = await command?.execute({
      argsRaw: "123",
      cwd: "/tmp",
      home: "/tmp",
      session: {} as never,
    });

    expect(result).toMatchObject({
      kind: "prompt",
      content: expect.stringContaining("fetch and display comments"),
    });
  });

  it("does not dispatch prompt legacy commands that need interactive context", async () => {
    const reg = buildDefaultRegistry();
    for (const name of ["commit", "review"]) {
      const command = reg.find(name);
      expect(command).toBeDefined();

      const result = await command?.execute({
        argsRaw: "",
        cwd: "/tmp",
        home: "/tmp",
        session: {} as never,
      });

      expect(result).toEqual({
        kind: "error",
        message: `/${name} requires the interactive prompt command surface.`,
      });
    }
  });

  it("documents that JSX-only legacy surfaces require the interactive TUI", async () => {
    const reg = buildDefaultRegistry();
    const command = reg.find("agents");
    expect(command).toBeDefined();

    const result = await command?.execute({
      argsRaw: "",
      cwd: "/tmp",
      home: "/tmp",
      session: {} as never,
    });

    expect(result).toEqual({
      kind: "error",
      message: "/agents requires the interactive TUI command surface.",
    });
  });

  it("returns the curated presentation order", () => {
    const reg = buildDefaultRegistry();
    const names = reg.list().map((c) => c.name);
    expect(names.slice(0, 4)).toEqual([
      "model",
      "model-provider",
      "permissions",
      "config",
    ]);
  });

  it("rejects invalid /exit-worktree args instead of treating them as keep", async () => {
    const reg = buildDefaultRegistry();
    const command = reg.find("exit-worktree");
    expect(command).toBeDefined();
    const setPendingWorktreeState = vi.fn();
    const ctx = {
      session: {
        pendingWorktreeState: {
          handle: { path: "/tmp/agenc-worktree" },
          baseCommit: "abc123",
        },
        setPendingWorktreeState,
      },
      argsRaw: "remove discard",
      cwd: "/tmp/project",
      home: "/home/test",
    } as unknown as SlashCommandContext;

    const result = await command!.execute(ctx);

    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toMatch(/Usage/);
    expect(setPendingWorktreeState).not.toHaveBeenCalled();
  });
});
