import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalAuthBackend } from "../auth/backends/local.js";
import {
  loginCommand,
  logoutCommand,
  whoamiCommand,
} from "./auth.js";
import { buildDefaultRegistry } from "./registry.js";
import type { SlashCommandContext } from "./types.js";

function localAuthCtx(agencHome: string): SlashCommandContext {
  return {
    session: {} as SlashCommandContext["session"],
    argsRaw: "",
    cwd: agencHome,
    home: agencHome,
    agencHome,
    configStore: {
      current: () => ({
        auth: {
          backend: "local",
        },
      }),
    } as SlashCommandContext["configStore"],
  };
}

describe("auth slash commands", () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  });

  async function makeHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "agenc-auth-command-"));
    homes.push(home);
    return home;
  }

  it("logs in, reports the current account, and logs out using the configured backend", async () => {
    const agencHome = await makeHome();
    const ctx = localAuthCtx(agencHome);

    await expect(loginCommand.execute(ctx)).resolves.toEqual({
      kind: "text",
      text: "Logged in as Local AgenC user (id=local, plan=free)",
    });
    await expect(whoamiCommand.execute(ctx)).resolves.toEqual({
      kind: "text",
      text: "Local AgenC user (id=local, plan=free) · tier=free",
    });
    await expect(logoutCommand.execute(ctx)).resolves.toEqual({
      kind: "text",
      text: "Logged out. Saved BYOK provider keys were kept.",
    });
    await expect(whoamiCommand.execute(ctx)).resolves.toEqual({
      kind: "text",
      text: "Not logged in. Run /login to sign in with Google.",
    });
  });

  it("keeps saved BYOK provider keys when logging out", async () => {
    const agencHome = await makeHome();
    const backend = new LocalAuthBackend({ agencHome });
    await backend.saveByokKey({ provider: "grok", apiKey: "xai-test-key" });
    await loginCommand.execute(localAuthCtx(agencHome));

    await logoutCommand.execute(localAuthCtx(agencHome));

    await expect(backend.readByokKey("grok")).resolves.toBe("xai-test-key");
  });

  it("registers account as an alias for whoami", () => {
    const registry = buildDefaultRegistry();

    expect(registry.find("account")?.name).toBe("whoami");
  });

  it("rejects unexpected arguments", async () => {
    const agencHome = await makeHome();
    const ctx = {
      ...localAuthCtx(agencHome),
      argsRaw: "extra",
    };

    await expect(loginCommand.execute(ctx)).resolves.toEqual({
      kind: "error",
      message: "Usage: /login",
    });
  });
});
