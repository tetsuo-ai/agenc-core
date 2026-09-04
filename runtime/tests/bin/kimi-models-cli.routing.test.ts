import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(async () => 0),
}));

vi.mock("../../src/bin/kimi-models-cli.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/bin/kimi-models-cli.js")>();
  return { ...actual, runKimiModelsCli: mocks.run };
});

import {
  formatCliHelpText,
  formatCliHelpTopicText,
  main,
} from "../../src/bin/agenc-main.js";

const originalArgv = process.argv;
const originalMoonshotApiKey = process.env.MOONSHOT_API_KEY;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

describe("Kimi model discovery CLI routing", () => {
  afterEach(() => {
    process.argv = originalArgv;
    if (originalMoonshotApiKey === undefined) {
      delete process.env.MOONSHOT_API_KEY;
    } else {
      process.env.MOONSHOT_API_KEY = originalMoonshotApiKey;
    }
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
    mocks.run.mockClear();
  });

  test("advertises kimi-models in top-level and topic help", () => {
    expect(formatCliHelpText()).toContain("agenc kimi-models [--json]");
    expect(formatCliHelpTopicText("kimi-models")).toContain(
      "agenc kimi-models [--json]",
    );
  });

  test("dispatches kimi-models with a provider environment snapshot", async () => {
    process.argv = ["node", "agenc", "kimi-models", "--json"];
    process.env.MOONSHOT_API_KEY = "moonshot-routing-test";
    process.env.OPENAI_API_KEY = "openai-unchanged";

    await expect(main()).resolves.toBe(0);

    expect(mocks.run).toHaveBeenCalledTimes(1);
    const [command, runtime] = mocks.run.mock.calls[0] ?? [];
    expect(command).toEqual({ kind: "list", json: true });
    expect(runtime?.environment.MOONSHOT_API_KEY).toBe(
      "moonshot-routing-test",
    );
    expect(runtime?.environment.OPENAI_API_KEY).toBeUndefined();
    expect(Object.keys(runtime?.environment ?? {})).toEqual([
      "MOONSHOT_API_KEY",
    ]);
    expect(Object.isFrozen(runtime?.environment)).toBe(true);
    expect(process.env.MOONSHOT_API_KEY).toBe("moonshot-routing-test");
    expect(process.env.OPENAI_API_KEY).toBe("openai-unchanged");
  });
});
