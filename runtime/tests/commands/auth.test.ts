import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalAuthBackend } from "../auth/backends/local.js";
import { resolveHomeContext } from "../config/home.js";
import {
  formatSubscriptionCommandResult,
  loginCommand,
  logoutCommand,
  subscriptionCommand,
  usageCommand,
  whoamiCommand,
} from "./auth.js";
import { buildDefaultRegistry } from "./registry.js";
import type { SlashCommandContext } from "./types.js";

function localAuthCtx(agencHome: string): SlashCommandContext {
  const configStore = {
    current: () => ({
      auth: {
        backend: "local",
      },
    }),
    homeContext: resolveHomeContext({ AGENC_HOME: agencHome }),
  } as SlashCommandContext["configStore"];
  return {
    session: {
      services: {
        configStore,
        providerService: { environment: () => ({}) },
      },
    } as SlashCommandContext["session"],
    argsRaw: "",
    cwd: agencHome,
    home: agencHome,
    agencHome,
    configStore,
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
      text:
        "Logged in as Local AgenC user (id=local, plan=free) · plan=free",
    });
    await expect(whoamiCommand.execute(ctx)).resolves.toEqual({
      kind: "text",
      text:
        "Local AgenC user (id=local, plan=free) · plan=free",
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

  it("clears the local auth notice after login completes", async () => {
    const agencHome = await makeHome();
    const setToolJSX = vi.fn();

    await loginCommand.execute({
      ...localAuthCtx(agencHome),
      appState: { setToolJSX },
    });

    expect(setToolJSX).toHaveBeenCalledWith({
      jsx: null,
      shouldHidePromptInput: false,
      clearLocalJSX: true,
    });
  });

  it("registers account as an alias for whoami", () => {
    const registry = buildDefaultRegistry();

    expect(registry.find("account")?.name).toBe("whoami");
  });

  it("registers billing as an alias for subscription", () => {
    const registry = buildDefaultRegistry();

    expect(registry.find("billing")?.name).toBe("subscription");
    expect(registry.find("usage")?.name).toBe("usage");
    expect(subscriptionCommand.description).toContain("plan");
  });

  it("shows subscription details as persistent transcript text", async () => {
    const agencHome = await makeHome();
    const ctx = localAuthCtx(agencHome);
    await loginCommand.execute(ctx);

    await expect(subscriptionCommand.execute(ctx)).resolves.toEqual({
      kind: "text",
      text:
        "Plan: free\n" +
        "Billing: https://id.agenc.ag/subscription",
    });
  });

  it("shows provider usage without requesting account model usage", async () => {
    const agencHome = await makeHome();
    const usage = vi.spyOn(LocalAuthBackend.prototype, "getLlmUsage");
    const identity = vi.spyOn(LocalAuthBackend.prototype, "whoami");
    try {
      const result = await usageCommand.execute(localAuthCtx(agencHome));
      expect(result.kind).toBe("text");
      expect(result).toEqual(expect.objectContaining({ text: expect.stringContaining("Providers") }));
      expect(result).toEqual(expect.objectContaining({ text: expect.not.stringContaining("AgenC account") }));
      expect(usage).not.toHaveBeenCalled();
      expect(identity).not.toHaveBeenCalled();
    } finally {
      usage.mockRestore();
      identity.mockRestore();
    }
  });

  it("routes one argument to the provider detail and rejects more", async () => {
    const agencHome = await makeHome();

    await expect(usageCommand.execute({ ...localAuthCtx(agencHome), argsRaw: " mistral " })).resolves.toEqual({
      kind: "text",
      text: "Mistral has no balance or usage API that works with an API key.",
    });
    await expect(usageCommand.execute({ ...localAuthCtx(agencHome), argsRaw: "ollama extra" })).resolves.toEqual({
      kind: "error",
      message: "Usage: /usage [provider]",
    });
    expect(usageCommand.argumentHint).toBe("[provider]");
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
