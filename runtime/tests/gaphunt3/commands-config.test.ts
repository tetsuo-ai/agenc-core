import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createConfigCommand,
  parseEditorCommand,
  splitCommandLine,
} from "src/commands/config.js";
import { ConfigStore } from "src/config/store.js";
import { defaultConfig, type AgenCConfig } from "src/config/schema.js";
import type { Session } from "src/session/session.js";
import type { SlashCommandContext } from "src/commands/types.js";

// ─────────────────────────────────────────────────────────────────────
// Stubs (mirror tests/commands/config.test.ts conventions)
// ─────────────────────────────────────────────────────────────────────

function stubSession(): Session {
  const s = {
    services: {},
    pendingProviderSwitch: null,
    setPendingProviderSwitch(next: unknown) {
      (this as { pendingProviderSwitch: unknown }).pendingProviderSwitch = next;
    },
    emit: () => {},
    nextInternalSubId: () => "sub-1",
  };
  return s as unknown as Session;
}

function stubCtx(
  overrides: Partial<SlashCommandContext> = {},
): SlashCommandContext {
  return {
    session: overrides.session ?? stubSession(),
    argsRaw: overrides.argsRaw ?? "",
    cwd: overrides.cwd ?? "/tmp",
    home: overrides.home ?? "/home/test",
    agencHome: overrides.agencHome ?? "/home/test/.agenc",
    configStore: overrides.configStore,
    appState: overrides.appState,
  } as SlashCommandContext;
}

function makeStore(base: Partial<AgenCConfig> = {}): ConfigStore {
  return new ConfigStore({
    base: { ...defaultConfig(), ...base } as AgenCConfig,
  });
}

// ─────────────────────────────────────────────────────────────────────
// gaphunt3 #15 — /config edit tokenizes $EDITOR before spawning
// ─────────────────────────────────────────────────────────────────────

describe("gaphunt3 #15 — parseEditorCommand", () => {
  it("splits an EDITOR string carrying flags into command + args", () => {
    // Before the fix the slash-command path passed the whole string as the
    // executable name; parseEditorCommand separates the binary from its flags.
    expect(parseEditorCommand("code --wait")).toEqual({
      command: "code",
      args: ["--wait"],
    });
    expect(parseEditorCommand("emacsclient -t")).toEqual({
      command: "emacsclient",
      args: ["-t"],
    });
  });

  it("returns no args for a bare editor name", () => {
    expect(parseEditorCommand("vim")).toEqual({ command: "vim", args: [] });
  });

  it("honors quoting in splitCommandLine", () => {
    expect(splitCommandLine('code --wait "a b"')).toEqual([
      "code",
      "--wait",
      "a b",
    ]);
  });
});

describe("gaphunt3 #15 — /config edit spawns tokenized editor", () => {
  it("passes ('code', ['--wait', path]) — NOT ('code --wait', [path])", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gh3-cfg-"));
    try {
      writeFileSync(join(tmp, "config.toml"), 'model = "x"\n');
      const spawner = vi.fn().mockResolvedValue(0);
      const cmd = createConfigCommand({
        env: { EDITOR: "code --wait" } as NodeJS.ProcessEnv,
        spawner,
      });
      const r = await cmd.execute(
        stubCtx({ configStore: makeStore(), argsRaw: "edit", agencHome: tmp }),
      );
      if (r.kind !== "text") throw new Error(`expected text, got ${r.kind}`);
      expect(spawner).toHaveBeenCalledTimes(1);
      // Revert-sensitive: before the fix the executable would be the whole
      // string "code --wait" with args [path]; after the fix it is tokenized.
      expect(spawner.mock.calls[0]![0]).toBe("code");
      expect(spawner.mock.calls[0]![1]).toEqual([
        "--wait",
        join(tmp, "config.toml"),
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("error message references the tokenized command, not the raw string", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gh3-cfg-"));
    try {
      writeFileSync(join(tmp, "config.toml"), "");
      const spawner = vi.fn().mockResolvedValue(2);
      const cmd = createConfigCommand({
        env: { EDITOR: "code --wait" } as NodeJS.ProcessEnv,
        spawner,
      });
      const r = await cmd.execute(
        stubCtx({ configStore: makeStore(), argsRaw: "edit", agencHome: tmp }),
      );
      if (r.kind !== "error") throw new Error("expected error");
      expect(r.message).toContain('Editor "code"');
      expect(r.message).not.toContain('Editor "code --wait"');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("still works for a bare editor name (single token)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gh3-cfg-"));
    try {
      writeFileSync(join(tmp, "config.toml"), 'model = "x"\n');
      const spawner = vi.fn().mockResolvedValue(0);
      const cmd = createConfigCommand({
        env: { EDITOR: "myedit" } as NodeJS.ProcessEnv,
        spawner,
      });
      const r = await cmd.execute(
        stubCtx({ configStore: makeStore(), argsRaw: "edit", agencHome: tmp }),
      );
      if (r.kind !== "text") throw new Error("expected text");
      expect(spawner.mock.calls[0]![0]).toBe("myedit");
      expect(spawner.mock.calls[0]![1]).toEqual([join(tmp, "config.toml")]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
