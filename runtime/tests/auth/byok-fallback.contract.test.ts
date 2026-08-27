import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthBackend } from "./backend.js";
import { bootstrapLocalRuntimeSession } from "../bin/bootstrap.js";

function localBackendThatCannotVend(calls: string[]): AuthBackend {
  return {
    login: () => ({ authenticated: true, provider: "local" }),
    logout: () => ({ authenticated: false }),
    whoami: () => ({ authenticated: true, provider: "local" }),
    vendKey: (provider, sessionId) => {
      calls.push(`vendKey:${provider}:${sessionId}`);
      throw new Error("local auth backend cannot vend managed keys");
    },
    inferAgencModel: () => {
      calls.push("inferAgencModel");
      throw new Error("not expected");
    },
    getSubscriptionTier: ({ sessionId } = {}) => {
      calls.push(`getSubscriptionTier:${sessionId ?? ""}`);
      return "free";
    },
  };
}

describe("BYOK fallback", () => {
  it("rejects the retired api_key_env indirection", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-byok-retired-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-byok-retired-ws-"));
    await writeFile(
      join(agencHome, "config.toml"),
      "config_version = 2\n\n[providers.grok]\napi_key_env = \"CUSTOM_GROK_KEY\"\n",
    );

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          conversationId: "conv-retired-config-byok",
          env: {
            AGENC_HOME: agencHome,
            AGENC_WORKSPACE: workspace,
            HOME: agencHome,
          },
        }),
      ).rejects.toThrow(/providers\.grok\.api_key_env.*unknown field/u);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports a clear BYOK fallback error when neither managed nor BYOK keys are available", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-ws-"));
    const calls: string[] = [];

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          authBackend: localBackendThatCannotVend(calls),
          conversationId: "conv-no-key",
          env: {
            AGENC_HOME: agencHome,
            AGENC_WORKSPACE: workspace,
            GROK_API_KEY: "",
            HOME: agencHome,
            XAI_API_KEY: "",
          },
        }),
      ).rejects.toThrow(
        /grok provider requires credentials.*XAI_API_KEY or GROK_API_KEY/,
      );
      expect(calls).toEqual(["getSubscriptionTier:conv-no-key"]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("points at auth.managedKeys.enabled when managed vending is disabled for the live OpenRouter route", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-ws-"));
    const calls: string[] = [];

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          authBackend: localBackendThatCannotVend(calls),
          conversationId: "conv-no-key-openrouter",
          env: {
            AGENC_HOME: agencHome,
            AGENC_AUTH_MANAGED_KEYS_ENABLED: "false",
            AGENC_PROVIDER: "openrouter",
            AGENC_WORKSPACE: workspace,
            HOME: agencHome,
            OPENROUTER_API_KEY: "",
          },
        }),
      ).rejects.toThrow(
        /openrouter provider requires credentials.*OPENROUTER_API_KEY.*auth\.managedKeys\.enabled/,
      );
      expect(calls).toEqual(["getSubscriptionTier:conv-no-key-openrouter"]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
