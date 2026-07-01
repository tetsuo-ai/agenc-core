import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalAuthBackend } from "../auth/backends/local.js";
import {
  formatSubscriptionCommandResult,
  formatUsageCommandResult,
  loginCommand,
  logoutCommand,
  subscriptionCommand,
  usageCommand,
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
      text:
        "Logged in as Local AgenC user (id=local, plan=free) · plan=free · managed keys require Pro (https://id.agenc.ag/pricing)",
    });
    await expect(whoamiCommand.execute(ctx)).resolves.toEqual({
      kind: "text",
      text:
        "Local AgenC user (id=local, plan=free) · plan=free · managed keys require Pro (https://id.agenc.ag/pricing)",
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
        "Plan: free\nBilling: https://id.agenc.ag/subscription\nManaged model access requires Pro or higher.\nBYOK still works without a subscription.",
    });
  });

  it("summarizes paid subscription model access without listing every route", () => {
    const text = formatSubscriptionCommandResult("pro");

    expect(text).toBe(
      "Plan: pro\n" +
        "Billing: https://id.agenc.ag/subscription\n" +
        "Managed models: enabled\n" +
        "Model access: hosted by AgenC\n" +
        "Available models: 19 managed OpenRouter routes\n" +
        "Default route: /model openrouter:x-ai/grok-4.3\n" +
        "Choose/switch models with /provider.",
    );
    expect(text).not.toContain(" or /model ");
    expect(text).not.toContain("claude-haiku-4.5 or");
    expect(text).not.toContain("$10");
    expect(text).not.toContain("LiteLLM");
  });

  it("shows model allowance usage for free local accounts", async () => {
    const agencHome = await makeHome();
    const ctx = localAuthCtx(agencHome);
    await loginCommand.execute(ctx);

    await expect(usageCommand.execute(ctx)).resolves.toEqual({
      kind: "text",
      text:
        "Plan: free\n" +
        "Managed models: not enabled\n" +
        "Hosted model usage requires Pro or higher.\n" +
        "BYOK still works without a subscription.\n" +
        "Billing: https://id.agenc.ag/subscription",
    });
  });

  it("formats paid model allowance usage", () => {
    expect(formatUsageCommandResult({
      managedModelsEnabled: true,
      modelAllowance: {
        allowedModelCount: 19,
        duration: "30d",
        includedUsd: 10,
        percentUsed: 12.3,
        remainingUsd: 8.7654,
        resetsAt: "2026-06-01T00:00:00.000Z",
        status: "active",
        usedUsd: 1.2346,
      },
      subscriptionTier: "pro",
    }, "pro")).toBe(
      "Plan: pro\n" +
        "Managed models: enabled\n" +
        "Usage: active\n" +
        "Included usage: $10.00\n" +
        "Used: $1.23\n" +
        "Remaining: $8.77\n" +
        "Used percent: 12.3%\n" +
        "Resets: 2026-06-01T00:00:00.000Z\n" +
        "Models: 19 hosted routes\n" +
        "Token counts vary by model, so usage is tracked as included USD.",
    );
  });

  it("formats unavailable paid usage without fabricated numbers", () => {
    expect(formatUsageCommandResult({
      managedModelsEnabled: true,
      modelAllowance: {
        allowedModelCount: 19,
        duration: "30d",
        resetsAt: "2026-06-01T00:00:00.000Z",
        status: "unavailable",
      },
      subscriptionTier: "pro",
    }, "pro")).toBe(
      "Plan: pro\n" +
        "Managed models: enabled\n" +
        "Usage: temporarily unavailable\n" +
        "Resets: 2026-06-01T00:00:00.000Z\n" +
        "Models: 19 hosted routes\n" +
        "Token counts vary by model, so usage is tracked as included USD.",
    );
  });

  it("shows the lookup failure reason when usage cannot be loaded", () => {
    expect(formatUsageCommandResult(undefined, "pro", "HTTP 500")).toBe(
      "Plan: pro\n" +
        "Managed model usage is temporarily unavailable.\n" +
        "Reason: HTTP 500\n" +
        "Billing: https://id.agenc.ag/subscription",
    );
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
