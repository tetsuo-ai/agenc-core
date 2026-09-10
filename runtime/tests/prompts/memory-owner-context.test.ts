import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { getProjectRoot, setProjectRoot } from "../../src/bootstrap/state.js";
import { resolveMemoryPromptInputs } from "../../src/prompts/system-prompt.js";
import { resolveAutoMemoryDirectory, resolveGlobalMemoryDirectory } from "../../src/services/extractMemories/memory-paths.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { clearCurrentRuntimeSession, setCurrentRuntimeSession } from "../../src/session/current-session.js";
import type { Session } from "../../src/session/session.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";

const roots: string[] = [];
const originalProjectRoot = getProjectRoot();
afterEach(() => {
  clearCurrentRuntimeSession();
  setProjectRoot(originalProjectRoot);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function owner(name: string, configText = "", runtime = {}) {
  const root = mkdtempSync(join(tmpdir(), `agenc-memory-${name}-`));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(cwd);
  writeFileSync(join(home, "config.toml"), `config_version = 2\n${configText}\n`);
  const env = { HOME: root, AGENC_HOME: home };
  const configStore = new ConfigStore({ home, cwd, env });
  await configStore.reload();
  const runtimeOptions = resolveAgentRuntimeOptions({}, runtime);
  const session = { services: { configStore, runtimeOptions, providerEnvironment: env,
    userShell: { childEnvironment: env } } };
  return { root, home, cwd, session, options: { cwd, configStore, env, runtimeOptions } };
}

describe("memory prompt owner context", () => {
  test("matches extraction roots across concurrent sessions despite daemon-global project state", async () => {
    const first = await owner("first");
    const second = await owner("second");
    setCurrentRuntimeSession(first.session as unknown as Session);
    setCurrentRuntimeSession(second.session as unknown as Session);
    setProjectRoot(second.home);
    const prompts = await runWithCanonicalSettingsAuthority(second.session.services.configStore, () =>
      Promise.all([resolveMemoryPromptInputs(first.session, first.cwd), resolveMemoryPromptInputs(second.session, second.cwd)]));
    for (const [index, target] of [first, second].entries()) {
      const project = await resolveAutoMemoryDirectory(target.options);
      const global = await resolveGlobalMemoryDirectory(target.options);
      expect(prompts[index]!.memoryPrompt).toContain(project.path);
      expect(prompts[index]!.memoryPrompt).toContain(global);
      expect(existsSync(project.path!)).toBe(true);
      expect(prompts[index]!.memoryPrompt).not.toContain(index === 0 ? second.home : first.home);
    }
  });

  test.each([
    ["autoMemoryEnabled = false", {}],
    ["", { simpleMode: true }],
    ["", { remoteMode: true }],
  ])("honors the owner's memory disable gate", async (config, runtime) => {
    const target = await owner("disabled", config, runtime);
    expect(await resolveMemoryPromptInputs(target.session, target.cwd))
      .toEqual({ memoryInstructions: "", memoryPrompt: "" });
    expect(existsSync(join(target.home, "memory"))).toBe(false);
  });

  test("uses the owner's tilde expansion and keeps the global root separate", async () => {
    const target = await owner("override", 'autoMemoryDirectory = "~/saved-project-memory"');
    const prompt = await resolveMemoryPromptInputs(target.session, target.cwd);
    expect(prompt.memoryPrompt).toContain(join(target.root, "saved-project-memory"));
    expect(prompt.memoryPrompt).toContain(join(target.home, "memory"));
  });

  test("fails closed without an owning configuration store", async () => {
    expect(await resolveMemoryPromptInputs({ services: {} }, originalProjectRoot))
      .toEqual({ memoryInstructions: "", memoryPrompt: "" });
  });
});
