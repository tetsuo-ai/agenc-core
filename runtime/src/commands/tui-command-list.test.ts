import { describe, it, expect } from "vitest";

import { vi } from "vitest";

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
  buildDefaultRegistry,
  registeredLegacyCommandSurfaceSpecs,
  registeredLegacyCommandSurfaceNames,
} from "./registry.js";
import {
  builtInCommandNames,
  clearCommandMemoizationCaches,
  filterCommandsForRemoteMode,
  getCommandsSync,
  listTuiCommandList,
  type Command,
} from "../commands.js";

function resolveSpecValue<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

describe("listTuiCommandList (TUI slash-command wiring)", () => {
  it("returns exactly the user-invocable subset of the registry", () => {
    const previousUserType = process.env.USER_TYPE;
    delete process.env.USER_TYPE;
    const expected = buildDefaultRegistry()
      .list()
      .filter(
        (cmd) =>
          cmd.userInvocable !== false &&
          (cmd as { isHidden?: boolean }).isHidden !== true &&
          (cmd.isEnabled?.() ?? true),
      ).length;
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
      expect(["local", "local-jsx", "prompt"]).toContain(
        (cmd as { type: string }).type,
      );
    }
  });

  it("uses the interactive local JSX descriptor for /memory", () => {
    const memory = listTuiCommandList().find((cmd) => cmd.name === "memory");
    expect(memory).toBeDefined();
    expect(memory?.type).toBe("local-jsx");
    expect(memory?.description).toBe("Edit AgenC memory files");
  });

  it("projects registered legacy command surfaces to executable descriptors", () => {
    const commands = new Map(getCommandsSync().map((cmd) => [cmd.name, cmd]));
    for (const name of registeredLegacyCommandSurfaceNames()) {
      expect(commands.has(name)).toBe(true);
      expect(commands.get(name)?.description).toBeTruthy();
    }

    expect(commands.get("agents")?.type).toBe("local-jsx");
    expect(commands.get("rewind")?.type).toBe("local");
    expect(commands.get("commit")?.type).toBe("prompt");
    expect(commands.get("install")?.type).toBe("local-jsx");
  });

  it("preserves shared metadata for every legacy command surface", () => {
    const commands = new Map(getCommandsSync().map((cmd) => [cmd.name, cmd]));

    for (const spec of registeredLegacyCommandSurfaceSpecs) {
      const command = commands.get(spec.name);
      expect(command, `missing /${spec.name}`).toBeDefined();
      expect(command?.type).toBe(spec.type);
      expect(command?.description).toBe(resolveSpecValue(spec.description));
      expect(command?.aliases).toEqual(spec.aliases);
      expect(command?.argumentHint).toBe(spec.argumentHint);
      expect(command?.availability).toEqual(spec.availability);
      expect(command?.supportsNonInteractive).toBe(
        spec.type === "local"
          ? spec.supportsNonInteractive ?? false
          : spec.supportsNonInteractive,
      );
      expect(command?.immediate).toBe(
        spec.immediate === undefined ? undefined : resolveSpecValue(spec.immediate),
      );
      expect(command?.isHidden).toBe(
        spec.isHidden === undefined ? undefined : resolveSpecValue(spec.isHidden),
      );
      expect(command?.isEnabled?.()).toBe(spec.isEnabled?.());
      if (command?.type === "prompt") {
        expect(command.progressMessage).toBe(spec.progressMessage ?? "running");
        expect(command.contentLength).toBe(spec.contentLength ?? 0);
        expect(command.allowedTools).toEqual(spec.allowedTools);
        expect(command.source).toBe(spec.source ?? "builtin");
      }
    }
  });

  it("preserves representative legacy descriptor metadata", async () => {
    const commands = new Map(getCommandsSync().map((cmd) => [cmd.name, cmd]));
    const command = (name: string): Command => {
      const got = commands.get(name);
      expect(got).toBeDefined();
      return got!;
    };

    const commit = command("commit") as Extract<Command, { type: "prompt" }>;
    expect(commit.type).toBe("prompt");
    expect(commit.allowedTools).toEqual([
      "Bash(git add:*)",
      "Bash(git status:*)",
      "Bash(git commit:*)",
    ]);
    expect(commit.contentLength).toBe(0);
    expect(commit.progressMessage).toBe("creating commit");
    expect(commit.source).toBe("builtin");

    const knowledgeSource = (await import("./knowledge/index.js")).default;
    const knowledge = command("knowledge") as Extract<Command, { type: "local" }>;
    expect(knowledge.type).toBe(knowledgeSource.type);
    expect(knowledge.supportsNonInteractive).toBe(
      knowledgeSource.supportsNonInteractive,
    );
    expect(knowledge.argumentHint).toBe(knowledgeSource.argumentHint);

    const rewindSource = (await import("./rewind/index.js")).default;
    const rewind = command("rewind") as Extract<Command, { type: "local" }>;
    expect(rewind.aliases).toEqual(rewindSource.aliases);
    expect(rewind.argumentHint).toBe(rewindSource.argumentHint);
    expect(rewind.supportsNonInteractive).toBe(
      rewindSource.supportsNonInteractive,
    );

    const heapdumpSource = (await import("./heapdump/index.js")).default;
    const heapdump = command("heapdump") as Extract<Command, { type: "local" }>;
    expect(heapdump.description).toBe(heapdumpSource.description);
    expect(heapdump.isHidden).toBe(heapdumpSource.isHidden);
    expect(heapdump.supportsNonInteractive).toBe(
      heapdumpSource.supportsNonInteractive,
    );
  });

  it("keeps hidden legacy surfaces addressable but out of the palette", () => {
    const commands = new Map(getCommandsSync().map((cmd) => [cmd.name, cmd]));
    const paletteNames = new Set(listTuiCommandList().map((cmd) => cmd.name));

    // /heapdump is the only hidden legacy surface still wired in after the
    // upstream-product cleanup. /output-style /rate-limit-options
    // /thinkback-play and the others were deleted because their
    // gates make them effectively unreachable in AgenC's distribution.
    for (const name of ["heapdump"]) {
      expect(commands.get(name)?.isHidden).toBe(true);
      expect(paletteNames.has(name)).toBe(false);
    }
  });

  it("excludes commands marked userInvocable=false", () => {
    const registry = buildDefaultRegistry();
    const expected = registry
      .list()
      .filter(
        (cmd) =>
          cmd.userInvocable !== false &&
          (cmd as { isHidden?: boolean }).isHidden !== true &&
          (cmd.isEnabled?.() ?? true),
      )
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
      if ((cmd as { isHidden?: boolean }).isHidden === true) continue;
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
      .filter(
        (cmd) =>
          cmd.userInvocable !== false &&
          (cmd as { isHidden?: boolean }).isHidden !== true &&
          (cmd.isEnabled?.() ?? true),
      )
      .map((cmd) => cmd.name);
    const projectedNames = listTuiCommandList().map((cmd) => cmd.name);
    expect(projectedNames).toEqual(registryNames);
  });

  it("includes /files in the TUI command list for AgenC users", () => {
    const previousUserType = process.env.USER_TYPE;
    try {
      delete process.env.USER_TYPE;
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
      expect(files?.isEnabled?.() ?? true).toBe(true);
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
