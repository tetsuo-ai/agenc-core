import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { buildToolRegistry } from "../src/tool-registry.js";
import type { Session } from "../src/session/session.js";
import { collectDaemonClientEnvOverrides, mergeDaemonClientEnvironment } from "../src/app-server/client-env-snapshot.js";

function registry(provider: string, model: string, value?: string, lightMode = true) {
  const session = { services: { runtimeOptions: { lightMode },
    providerEnvironment: value === undefined ? {} : { AGENC_EDIT_THEN_RUN: value },
    provider: { name: provider }, providerService: { current: () => ({ provider, model }) },
  } } as unknown as Session;
  return buildToolRegistry({ workspaceRoot: "/workspace", lightMode, getSession: () => session });
}

const baselines: Record<string, readonly [number, string, number]> = {
  "deepseek-flash": [4301, "943cecd0c7411c51aea663e539b9c2864dd4a59995c5f4b1d07ac130a375e3cf", 204],
  "deepseek-reasoner": [4584, "397ee1b0a1bcc670999adc7f43a4ec66169537310a175a6061f7e249fc830c9e", 190],
  "gpt-6-luna": [2347, "df9bdc4d9db2110045dc89dd6c428377a6ad9df87aeca71f9fd9425dac7879d7", 102],
  "claude-sonnet-4-5": [2602, "3bad2ea7bcde5e6f0eb722a291dafb9a750a8bc9597e4d5ff2f142c505c24a54", 190],
};

const routes = [
  ["deepseek", "deepseek-flash"], ["deepseek", "deepseek-reasoner"],
  ["openai", "gpt-6-luna"], ["anthropic", "claude-sonnet-4-5"],
];

describe("edit then run catalog", () => {
  test.each(routes)("disabled %s %s catalog stays byte identical", (provider, model) => {
    const off = JSON.stringify(registry(provider!, model!, "0").toLLMTools());
    const unset = JSON.stringify(registry(provider!, model!).toLLMTools());
    expect(off).toBe(unset);
    expect([Buffer.byteLength(off), createHash("sha256").update(off).digest("hex")]).toEqual(baselines[model!]!.slice(0, 2));
    expect(off).not.toContain('"check":');
  });

  test.each(routes)("enabled %s %s adds only the check string to editors", (provider, model) => {
    const off = registry(provider!, model!, "0").toLLMTools();
    const on = registry(provider!, model!, "1").toLLMTools();
    const restored = on.map(tool => {
      const properties = tool.function.parameters.properties as Record<string, unknown>;
      if (properties.check === undefined) return tool;
      expect(["apply_patch", "Write", "Edit", "MultiEdit"]).toContain(tool.function.name);
      expect(properties.check).toEqual(expect.objectContaining({ type: "string", description: "Shell command to run after a successful edit." }));
      const { check: _check, ...rest } = properties;
      return { ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters, properties: rest } } };
    });
    expect(JSON.stringify(restored)).toBe(JSON.stringify(off));
    expect(JSON.stringify(on)).toContain('"check":');
    expect(Buffer.byteLength(JSON.stringify(on)) - Buffer.byteLength(JSON.stringify(off))).toBe(baselines[model!]![2]);
    const tools = registry(provider!, model!, "1").tools;
    for (const name of ["apply_patch", "Write", "Edit", "MultiEdit"]) {
      expect((tools.find(tool => tool.name === name)!.inputSchema.properties as Record<string, unknown>).check).toBeDefined();
    }
  });

  test("standard catalogs stay unchanged even with the switch enabled", () => {
    expect(JSON.stringify(registry("openai", "gpt-6-luna", "1", false).toLLMTools()))
      .toBe(JSON.stringify(registry("openai", "gpt-6-luna", "0", false).toLLMTools()));
  });

  test("the switch travels in a session-owned client environment snapshot", () => {
    const snapshot = collectDaemonClientEnvOverrides({ AGENC_EDIT_THEN_RUN: "1" });
    expect(snapshot.AGENC_EDIT_THEN_RUN).toBe("1");
    expect(mergeDaemonClientEnvironment({}, snapshot)?.AGENC_EDIT_THEN_RUN).toBe("1");
    expect(mergeDaemonClientEnvironment({ AGENC_EDIT_THEN_RUN: "1" }, collectDaemonClientEnvOverrides({}))?.AGENC_EDIT_THEN_RUN).toBeUndefined();
  });
});
