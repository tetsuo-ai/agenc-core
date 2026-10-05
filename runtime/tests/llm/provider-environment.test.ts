import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/llm/provider-options.js", () => {
  throw new Error("print bootstrap must not load credential construction");
});
vi.mock("../../src/config/env.js", () => {
  throw new Error("print bootstrap must not load configuration projection");
});
vi.mock("../../src/config/schema.js", () => {
  throw new Error("print bootstrap must not construct settings schemas");
});

import { printMain } from "../../src/bin/print-cli-main.js";
import { RETIRED_CONFIG_DIR_ENV, RetiredConfigDirError } from "../../src/config/home.js";
import { snapshotProviderEnvironment } from "../../src/llm/provider-environment.js";
import { clearCurrentRuntimeSession } from "../../src/session/current-session.js";
import {
  getSelectedProviderEnvironment,
  getSelectedProviderName,
  runWithStartupProviderSelection,
} from "../../src/utils/model/providers.js";

afterEach(() => { clearCurrentRuntimeSession(); });

describe("canonical provider environment leaf", () => {
  it("loads the complete print entry without credential or settings construction", () => {
    expect(typeof printMain).toBe("function");
  });

  it("preserves allowed values and sorted dynamic credentials in a frozen copy", () => {
    const env = {
      OPENAI_API_KEY: "fixture-key",
      OPENAI_AUTH_MODE: "",
      AGENC_CREDENTIAL_Z: "z",
      AGENC_CREDENTIAL_A: "a",
      AGENC_CREDENTIAL_invalid: "omit",
      HOME: "/fixture-home",
      UNKNOWN: "omit",
      XAI_API_KEY: undefined,
    };
    const captured = snapshotProviderEnvironment(env);
    expect(captured).toEqual({
      OPENAI_API_KEY: "fixture-key",
      OPENAI_AUTH_MODE: "",
      AGENC_CREDENTIAL_A: "a",
      AGENC_CREDENTIAL_Z: "z",
    });
    expect(Object.keys(captured).filter((key) => key.startsWith("AGENC_CREDENTIAL_")))
      .toEqual(["AGENC_CREDENTIAL_A", "AGENC_CREDENTIAL_Z"]);
    env.OPENAI_API_KEY = "changed";
    expect(captured.OPENAI_API_KEY).toBe("fixture-key");
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it.each(["", "/retired"])("rejects retired home input %j before snapshot filtering", (value) => {
    expect(() => snapshotProviderEnvironment({ [RETIRED_CONFIG_DIR_ENV]: value }))
      .toThrow(RetiredConfigDirError);
  });

  it("keeps concurrent provider scopes and captured credentials separate", async () => {
    const run = (provider: string, key: string) => runWithStartupProviderSelection({
      provider, model: "fixture-model", environment: { OPENAI_API_KEY: key },
    }, async () => {
      await Promise.resolve();
      return { provider: getSelectedProviderName(), key: getSelectedProviderEnvironment().OPENAI_API_KEY };
    });
    expect(await Promise.all([run("openai", "first"), run("deepseek", "second")])).toEqual([
      { provider: "openai", key: "first" },
      { provider: "deepseek", key: "second" },
    ]);
  });
});
