import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { dispatchSlashCommand, parseSlashCommand } from "../../src/commands/dispatcher.js";
import { CommandRegistry } from "../../src/commands/registry.js";
import { swarmCommand } from "../../src/commands/swarm.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import {
  enterCanonicalSettingsAuthority,
  getCanonicalSettingsAuthority,
  resetCanonicalSettingsAuthorityForTesting,
  runWithCanonicalSettingsAuthority,
} from "../../src/utils/settings/canonicalAuthority.js";

describe("slash command settings authority", () => {
  const roots: string[] = [];
  const stores: ConfigStore[] = [];
  const initialAuthority = getCanonicalSettingsAuthority();
  afterEach(() => {
    for (const store of stores.splice(0)) store.stateRepository.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (initialAuthority !== null) enterCanonicalSettingsAuthority(initialAuthority);
    else resetCanonicalSettingsAuthorityForTesting();
  });

  async function fixture() {
    const root = mkdtempSync(join(tmpdir(), "agenc-command-settings-"));
    roots.push(root);
    const home = join(root, "state");
    const cwd = join(root, "project");
    mkdirSync(home);
    mkdirSync(cwd);
    const store = new ConfigStore({ home, cwd, env: { AGENC_HOME: home } });
    stores.push(store);
    await store.reload();
    let state = { swarmMode: false };
    const ctx: SlashCommandContext = {
      session: {} as SlashCommandContext["session"],
      argsRaw: "",
      cwd,
      home: root,
      agencHome: home,
      configStore: store,
      appState: {
        getAppState: () => state,
        setAppState: (update) => { state = update(state) as typeof state; },
      },
    };
    const registry = new CommandRegistry();
    registry.register(swarmCommand);
    return { store, ctx, registry, state: () => state };
  }

  test("persists /swarm from a detached input callback and survives reload", async () => {
    const f = await fixture();
    resetCanonicalSettingsAuthorityForTesting();
    const outcome = await dispatchSlashCommand(parseSlashCommand("/swarm on")!, f.ctx, f.registry);
    expect(outcome.result.kind).toBe("text");
    expect(f.state().swarmMode).toBe(true);
    expect(readFileSync(f.store.homeContext.configTomlPath, "utf8")).toContain('"swarmMode" = true');
    await f.store.reload();
    expect(f.store.current().swarmMode).toBe(true);
    resetCanonicalSettingsAuthorityForTesting();
    const status = await dispatchSlashCommand(parseSlashCommand("/swarm status")!, f.ctx, f.registry);
    expect(status.result).toMatchObject({ kind: "text", text: expect.stringContaining("saved on") });
  });

  test("writes only the invocation's home when another session is ambient", async () => {
    const a = await fixture();
    const b = await fixture();
    const result = await runWithCanonicalSettingsAuthority(b.store, () =>
      dispatchSlashCommand(parseSlashCommand("/swarm on")!, a.ctx, a.registry));
    expect(result.result.kind).toBe("text");
    expect(a.store.current().swarmMode).toBe(true);
    expect(b.store.current().swarmMode).not.toBe(true);
    expect(b.state().swarmMode).toBe(false);
  });

  test("reports a failed settings write without changing the live badge", async () => {
    const f = await fixture();
    resetCanonicalSettingsAuthorityForTesting();
    const result = await swarmCommand.execute({ ...f.ctx, argsRaw: "on", configStore: undefined });
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("settings authority") });
    expect(f.state().swarmMode).toBe(false);
    expect(f.store.current().swarmMode).not.toBe(true);
  });
});
