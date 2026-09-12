import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { applyCanonicalConfigPatchSync } from "../../src/config/update-sync.js";
import { dispatchSlashCommand, parseSlashCommand } from "../../src/commands/dispatcher.js";
import { CommandRegistry } from "../../src/commands/registry.js";
import { swarmCommand } from "../../src/commands/swarm.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import { swarmModeProducer } from "../../src/prompts/attachments/swarm-mode.js";
import {
  enterCanonicalSettingsAuthority,
  getCanonicalSettingsAuthority,
  resetCanonicalSettingsAuthorityForTesting,
  runWithCanonicalSettingsAuthority,
} from "../../src/utils/settings/canonicalAuthority.js";

describe("daemon swarm configuration propagation", () => {
  const cleanups: Array<() => void> = [];
  const initialAuthority = getCanonicalSettingsAuthority();
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    if (initialAuthority === null) resetCanonicalSettingsAuthorityForTesting();
    else enterCanonicalSettingsAuthority(initialAuthority);
  });

  async function fixture() {
    const root = mkdtempSync(join(tmpdir(), "agenc-swarm-propagation-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "state");
    const cwd = join(root, "workspace");
    mkdirSync(home);
    mkdirSync(cwd);
    const openStore = async () => {
      const store = new ConfigStore({ home, cwd, projectRoot: cwd, projectTrusted: true, env: { AGENC_HOME: home } });
      cleanups.push(() => store.stateRepository.close());
      await store.reload();
      return store;
    };
    const clientStore = await openStore();
    const daemonStore = await openStore();
    let state = { swarmMode: false };
    // Match AppStateProvider: publishing the client config updates the badge.
    const publications: boolean[] = [];
    clientStore.subscribe((config) => {
      state = { swarmMode: config.swarmMode === true };
      publications.push(state.swarmMode);
    });
    const applyDaemonConfig = vi.fn(async (_params: { reload?: boolean }) => {
      await daemonStore.reload();
      return { sessionId: "live-session", applied: true, summary: "config reloaded" };
    });
    const ctx: SlashCommandContext = {
      session: { services: { configStore: clientStore }, applyDaemonConfig } as unknown as SlashCommandContext["session"],
      configStore: clientStore, argsRaw: "", cwd, home: root, agencHome: home,
      appState: {
        getAppState: () => state,
        setAppState: (update) => { state = update(state) as typeof state; },
      },
    };
    const registry = new CommandRegistry();
    registry.register(swarmCommand);
    const dispatch = (mode: "on" | "off" | "status") => dispatchSlashCommand(parseSlashCommand(`/swarm ${mode}`)!, ctx, registry);
    const attachments = (turnId: string) => runWithCanonicalSettingsAuthority(daemonStore, () => swarmModeProducer({
      subagentDepth: 0, loadedTools: [], permissionContext: { mode: "default" },
      turnProvenance: { turnId, rootHumanTurn: { turnId, text: "Review the project" } },
    } as never, {} as never));
    return { clientStore, daemonStore, openStore, applyDaemonConfig, dispatch, attachments, publications, state: () => state };
  }

  test("updates the active daemon prompt authority before confirming on/off and persists across reopen", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.applyDaemonConfig.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      await f.daemonStore.reload();
      return { sessionId: "live-session", applied: true, summary: "config reloaded" };
    });
    const enabling = f.dispatch("on");
    try {
      await entered.promise;
      expect(readFileSync(f.clientStore.homeContext.configTomlPath, "utf8")).toContain('"swarmMode" = true');
      expect(f.state().swarmMode).toBe(false);
      expect(f.publications).toEqual([]);
      expect(await f.attachments("before-ack")).toEqual([]);
    } finally {
      release.resolve();
    }
    expect((await enabling).result).toMatchObject({ kind: "text", text: expect.stringContaining("swarm mode ON") });
    expect(f.applyDaemonConfig).toHaveBeenCalledExactlyOnceWith({ reload: true });
    expect(f.state().swarmMode).toBe(true);
    expect(await f.attachments("after-on")).toHaveLength(1);
    expect((await f.openStore()).current().swarmMode).toBe(true);

    expect((await f.dispatch("off")).result).toMatchObject({ kind: "text", text: expect.stringContaining("swarm mode OFF") });
    expect(await f.attachments("after-off")).toEqual([]);
    expect(f.state().swarmMode).toBe(false);
    expect((await f.openStore()).current().swarmMode).toBe(false);
  });

  test.each(["rejected", "unapplied", "reply lost after commit"] as const)(
    "retains the last confirmed badge and reports saved-but-unconfirmed state when %s", async (failure) => {
      const f = await fixture();
      f.applyDaemonConfig.mockImplementationOnce(async () => {
        if (failure === "reply lost after commit") await f.daemonStore.reload();
        if (failure === "unapplied") return { sessionId: "live-session", applied: false, summary: "not available" };
        throw new Error("reload failed");
      });
      expect((await f.dispatch("on")).result).toMatchObject({
        kind: "error", message: expect.stringContaining("Swarm preference saved on, but the live daemon update could not be confirmed"),
      });
      expect(f.state().swarmMode).toBe(false);
      expect(f.publications).toEqual([]);
      expect(readFileSync(f.clientStore.homeContext.configTomlPath, "utf8")).toContain('"swarmMode" = true');
      expect((await f.dispatch("status")).result).toMatchObject({
        kind: "text", text: expect.stringContaining("swarm mode: off (saved on)"),
      });
      expect(await f.attachments("after-failure")).toHaveLength(failure === "reply lost after commit" ? 1 : 0);
      expect((await f.dispatch("on")).result.kind).toBe("text");
      expect(f.state().swarmMode).toBe(true);
      expect(await f.attachments("after-retry")).toHaveLength(1);
    },
  );

  test("accepts the deferred bridge's explicit first-conversation receipt", async () => {
    const f = await fixture();
    f.applyDaemonConfig.mockResolvedValueOnce({ sessionId: "pending", applied: false, summary: "first conversation will use it" });
    expect((await f.dispatch("on")).result.kind).toBe("text");
    expect(f.applyDaemonConfig).toHaveBeenCalledExactlyOnceWith({ reload: true });
    expect(f.state().swarmMode).toBe(true);
    expect((await f.openStore()).current().swarmMode).toBe(true);
  });

  test.each([true, false])("reports a saved preference separately from a trusted project override of %s", async (override) => {
    const f = await fixture();
    const projectDir = join(f.clientStore.projectRoot, ".agenc");
    mkdirSync(projectDir);
    applyCanonicalConfigPatchSync(join(projectDir, "config.toml"), { swarmMode: override }, "project");
    const requested = override ? "off" : "on";
    const outcome = await f.dispatch(requested);
    expect(outcome.result).toMatchObject({
      kind: "text", text: expect.stringContaining(`Swarm preference saved ${requested}; effective swarm mode remains ${override ? "ON" : "off"}`),
    });
    expect(f.state().swarmMode).toBe(override);
    expect(await f.attachments("after-override")).toHaveLength(override ? 1 : 0);
    expect((await f.dispatch("status")).result).toMatchObject({
      kind: "text", text: expect.stringContaining(`swarm mode: ${override ? "ON" : "off"} (saved ${requested})`),
    });
    expect((await f.openStore()).current().swarmMode).toBe(override);
  });
});
