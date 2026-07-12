import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resetModelStringsForTestingOnly,
  setInitialMainLoopModel,
  setMainLoopModelOverride,
} from "../../src/bootstrap/state.js";
import {
  getDefaultMainLoopModelSetting,
} from "../../src/utils/model/model.js";
import { getModelOptions } from "../../src/utils/model/modelOptions.js";
import { resetSettingsCache } from "../../src/utils/settings/settingsCache.js";

const ORIGINAL_ENV = {
  AGENC_CONFIG_DIR: process.env.AGENC_CONFIG_DIR,
  AGENC_HOME: process.env.AGENC_HOME,
  AGENC_USE_GEMINI: process.env.AGENC_USE_GEMINI,
  AGENC_USE_GITHUB: process.env.AGENC_USE_GITHUB,
  AGENC_USE_MISTRAL: process.env.AGENC_USE_MISTRAL,
  AGENC_USE_MINIMAX: process.env.AGENC_USE_MINIMAX,
  AGENC_USE_OPENAI: process.env.AGENC_USE_OPENAI,
  NVIDIA_NIM: process.env.NVIDIA_NIM,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  XAI_API_KEY: process.env.XAI_API_KEY,
};

let tempHome: string | null = null;

function restoreEnv(): void {
  for (const key of Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(async () => {
  restoreEnv();
  tempHome = await mkdtemp(join(tmpdir(), "agenc-xai-model-options-"));
  process.env.AGENC_CONFIG_DIR = tempHome;
  process.env.AGENC_HOME = tempHome;
  delete process.env.AGENC_USE_GEMINI;
  delete process.env.AGENC_USE_GITHUB;
  delete process.env.AGENC_USE_MISTRAL;
  delete process.env.AGENC_USE_MINIMAX;
  delete process.env.AGENC_USE_OPENAI;
  delete process.env.NVIDIA_NIM;
  delete process.env.OPENAI_MODEL;
  process.env.XAI_API_KEY = "xai-test-key";
  setInitialMainLoopModel(null);
  setMainLoopModelOverride(undefined);
  resetModelStringsForTestingOnly();
  resetSettingsCache();
});

afterEach(async () => {
  restoreEnv();
  setInitialMainLoopModel(null);
  setMainLoopModelOverride(undefined);
  resetModelStringsForTestingOnly();
  resetSettingsCache();
  if (tempHome !== null) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

describe("xAI model options", () => {
  it("uses grok-4.5 as the default and hides legacy Anthropic picker rows", () => {
    expect(getDefaultMainLoopModelSetting()).toBe("grok-4.5");

    const options = getModelOptions(false);
    // The grok picker is derived from REGISTERED_MODEL_CATALOG, with the
    // current frontier model leading the older catalog entries.
    expect(options.map((option) => option.value)).toEqual([
      null,
      "grok-4.5",
      "grok-build-0.1",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-multi-agent-0309",
      "grok-composer-2.5-fast",
    ]);
    expect(options.map((option) => option.label)).not.toEqual(
      expect.arrayContaining(["Sonnet", "Opus", "Haiku"]),
    );
  });
});
