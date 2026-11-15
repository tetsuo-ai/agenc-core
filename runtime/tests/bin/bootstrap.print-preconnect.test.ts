import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapLocalRuntimeSession } from "./bootstrap.js";
import { resolveAgentRuntimeOptions } from "../session/runtime-options.js";
import * as providers from "../llm/provider.js";
import { StaticModelsManager } from "../llm/models-manager.js";

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map(p => rm(p, { recursive: true, force: true })));
});

describe("print bootstrap socket ownership", () => {
  it.each([
    ["openai", "1", true, true],
    ["openai", "0", true, false],
    ["openai", undefined, true, false],
    ["openai", "1", false, false],
    ["deepseek", "1", true, false],
  ])("starts early only for selected print sessions: %s %s %s", async (name, setting, nonInteractive, expected) => {
    const home = await mkdtemp(join(tmpdir(), "fc36-bootstrap-"));
    homes.push(home);
    const prewarmStartup = vi.fn();
    const dispose = vi.fn();
    vi.spyOn(providers, "createProvider").mockReturnValue({
      name, prewarmStartup, dispose, chat: vi.fn(),
    } as never);
    const failure = new Error("model metadata failed before session construction");
    vi.spyOn(StaticModelsManager.prototype, "getModelInfoForProvider").mockImplementation(async () => {
      expect(prewarmStartup).toHaveBeenCalledTimes(expected ? 1 : 0);
      if (expected) expect(prewarmStartup).toHaveBeenCalledWith({
        conversationId: "fc36-print", threadId: "fc36-print", lightSession: true,
      });
      throw failure;
    });
    await expect(bootstrapLocalRuntimeSession({
      conversationId: "fc36-print", resumeConversation: false,
      apiKey: "offline-test-key", cwd: home,
      runtimeOptions: resolveAgentRuntimeOptions(process.env, { lightMode: true, nonInteractive }),
      deferAgentStartupSideEffects: true,
      env: { ...process.env, HOME: home, AGENC_HOME: home,
        AGENC_PROVIDER: name, AGENC_MODEL: name === "openai" ? "gpt-6-luna" : "deepseek-chat",
        AGENC_OPENAI_PRINT_PRECONNECT: setting },
      fetchImpl: vi.fn().mockRejectedValue(new Error("offline")),
    })).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(expected ? 1 : 0);
  });
});
