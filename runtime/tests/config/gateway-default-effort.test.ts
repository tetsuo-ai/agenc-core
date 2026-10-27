import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadLayeredConfig } from "../../src/config/repository.js";
import { sessionConfigurationFromAgenCConfig } from "../../src/session/configuration.js";

test.each([['venice', 'deepseek-v4-pro'], ['ollama-cloud', 'gpt-oss:120b'], ['abliteration', 'abliterated-model']])(
  "%s does not turn the generic medium default into a user's effort choice", async (provider, model) => {
    const root = await mkdtemp(join(tmpdir(), "gateway-effort-"));
    try {
      const options = { env: { AGENC_HOME: join(root, "home"), HOME: root }, cwd: root,
        managedConfigPath: join(root, "no-managed.toml"), managedDropInDir: join(root, "no-managed.d") };
      const automatic = await loadLayeredConfig({ ...options, cliOverrides: { model_provider: provider, model } });
      expect(automatic.config.reasoning_effort).toBeUndefined();
      expect(sessionConfigurationFromAgenCConfig({ config: automatic.config, workspaceRoot: root, provider, model })
        .collaborationMode.reasoningEffort).toBeUndefined();
      for (const reasoning_effort of ['medium', 'none', 'high'] as const) {
        const explicit = await loadLayeredConfig({ ...options, cliOverrides: { model_provider: provider, model, reasoning_effort } });
        expect(explicit.config.reasoning_effort).toBe(reasoning_effort);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
