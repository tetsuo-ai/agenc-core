import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapLocalRuntimeSession } from "../bin/bootstrap.js";

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

  it("reports a clear BYOK error when no provider key is available", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-ws-"));

    try {
      await expect(
        bootstrapLocalRuntimeSession({
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
    } finally {
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("requires the user OpenRouter key when legacy account model config is present", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-ws-"));

    try {
      await expect(
        bootstrapLocalRuntimeSession({
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
        /openrouter provider requires credentials.*OPENROUTER_API_KEY/,
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
