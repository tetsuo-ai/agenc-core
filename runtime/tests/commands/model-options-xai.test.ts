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
import { runWithStartupProviderSelection } from "../../src/utils/model/providers.js";

const ORIGINAL_ENV = {
  AGENC_HOME: process.env.AGENC_HOME,
  AGENC_PROVIDER: process.env.AGENC_PROVIDER,
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
  process.env.AGENC_HOME = tempHome;
  process.env.AGENC_PROVIDER = "grok";
  delete process.env.OPENAI_MODEL;
  process.env.XAI_API_KEY = "xai-test-key";
  setInitialMainLoopModel(null);
  setMainLoopModelOverride(undefined);
  resetModelStringsForTestingOnly();
});

afterEach(async () => {
  restoreEnv();
  setInitialMainLoopModel(null);
  setMainLoopModelOverride(undefined);
  resetModelStringsForTestingOnly();
  if (tempHome !== null) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

describe("xAI model options", () => {
  it("uses grok-4.6 as the default and hides legacy Anthropic picker rows", () => {
    const { defaultModel, options } = runWithStartupProviderSelection(
      { provider: "grok", model: "grok-4.6", environment: { ...process.env } },
      () => ({
        defaultModel: getDefaultMainLoopModelSetting(),
        options: getModelOptions(false),
      }),
    );
    expect(defaultModel).toBe("grok-4.6");

    // The grok picker is derived from REGISTERED_MODEL_CATALOG, with the
    // current frontier model leading the older catalog entries. grok-4.6 is
    // both the newest entry and the current default (asserted above).
    expect(options.map((option) => option.value)).toEqual([
      null,
      "grok-4.6",
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
