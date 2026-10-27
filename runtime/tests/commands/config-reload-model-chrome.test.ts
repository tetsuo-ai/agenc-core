import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { configCommand } from "../../src/commands/config.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
it("shows the canonical model accepted by live config reload", async () => {
  const home = mkdtempSync(join(tmpdir(), "reload-model-"));
  const store = new ConfigStore({ home, cwd: home, env: {} });
  const setModel = vi.fn();
  try {
    await store.reload();
    const session = { services: { configStore: store }, applyDaemonConfig: async () => ({ sessionId: "live", applied: true, provider: "deepseek", model: "deepseek-v4-pro", runtimeSettingsEventId: "settings-2", summary: "canonical reload" }) };
    const result = await configCommand.execute({ session, argsRaw: "reload", cwd: home, home, appState: { setModel } } as unknown as SlashCommandContext);
    expect(result.kind).toBe("text");
    expect(setModel).toHaveBeenCalledExactlyOnceWith("deepseek-v4-pro");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
