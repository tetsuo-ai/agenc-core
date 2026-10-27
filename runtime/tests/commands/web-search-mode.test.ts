import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { chooseWebSearchMode } from "../../src/commands/providers-hub-actions.js";
import type { SlashCommandContext } from "../../src/commands/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function fixture(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agenc-web-search-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"); const cwd = join(root, "project");
  mkdirSync(home); mkdirSync(cwd);
  const open = async () => {
    const store = new ConfigStore({ home, cwd, projectRoot: cwd, projectTrusted: true, env: { AGENC_HOME: home } });
    cleanups.push(() => store.stateRepository.close());
    await store.reload(); return store;
  };
  const client = await open(); const daemon = await open();
  const apply = vi.fn(async () => { await daemon.reload(); return { applied: true, sessionId: "live" }; });
  const ctx = { session: { services: { configStore: client, providerEnvironment: env }, applyDaemonConfig: apply },
    configStore: client, argsRaw: "", cwd, home: root, agencHome: home } as unknown as SlashCommandContext;
  return { client, daemon, apply, ctx, open };
}

test("picker saves and updates the daemon before publishing client state, then survives reopen", async () => {
  const f = await fixture();
  const publications: string[] = [];
  f.client.subscribe(config => { expect(f.daemon.current().web_search).toBe(config.web_search); publications.push(config.web_search!); });
  expect(await chooseWebSearchMode(f.ctx, "on")).toMatchObject({ ok: true });
  expect(f.apply).toHaveBeenCalledExactlyOnceWith({ reload: true });
  expect(readFileSync(f.client.homeContext.configTomlPath, "utf8")).toContain('"web_search" = "on"');
  expect((await f.open()).current().web_search).toBe("on");
  expect(await chooseWebSearchMode(f.ctx, "auto")).toMatchObject({ ok: true });
  expect(publications).toEqual(["on", "auto"]);
  expect((await f.open()).current().web_search).toBe("auto");
});

test("picker reports environment overrides without changing them", async () => {
  const f = await fixture({ AGENC_WEB_SEARCH: "auto" });
  expect(await chooseWebSearchMode(f.ctx, "on")).toMatchObject({ ok: true, message: expect.stringContaining("remains Auto") });
  expect(f.daemon.current().web_search).toBe("on");
});

test("failed daemon acknowledgement preserves the last confirmed client state", async () => {
  const f = await fixture();
  f.apply.mockResolvedValueOnce({ applied: false, sessionId: "live" });
  expect(await chooseWebSearchMode(f.ctx, "on")).toMatchObject({ ok: false, message: expect.stringContaining("not confirmed") });
  expect(f.client.current().web_search).toBeUndefined();
  expect((await f.open()).current().web_search).toBe("on");
});
