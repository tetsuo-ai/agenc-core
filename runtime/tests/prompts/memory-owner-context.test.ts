import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { getProjectRoot, setProjectRoot } from "../../src/bootstrap/state.js";
import { resolveMemoryOnRequest, resolveMemoryPromptInputs } from "../../src/prompts/system-prompt.js";
import { buildMemoryInstructionLines, LIGHT_MEMORY_RULES_MARKER, MEMORY_RULES_MARKER } from "../../src/memory/memdir.js";
import {
  resolveAutoMemoryDirectory,
  resolveGlobalMemoryDirectory,
  sessionDurableMemoryWriteRoots,
} from "../../src/services/extractMemories/memory-paths.js";
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
    // Runs without a human keep the rules and directories in the fixed prefix.
    const first = await owner("first", "", { nonInteractive: true });
    const second = await owner("second", "", { nonInteractive: true });
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

  test("one-shot Light omits automatic saving guidance but keeps memory access and host constraints", async () => {
    const target = await owner("light", "", { lightMode: true, nonInteractive: true,
      coworkMemoryExtraGuidelines: "HOST_MEMORY_CONSTRAINT" });
    const prompt = await resolveMemoryPromptInputs(target.session, target.cwd);
    const project = await resolveAutoMemoryDirectory(target.options);
    expect(prompt.memoryInstructions).toBe("");
    expect(prompt.memoryPrompt).toContain(project.path);
    expect(prompt.memoryPrompt).toContain(await resolveGlobalMemoryDirectory(target.options));
    expect(prompt.memoryPrompt).toContain("HOST_MEMORY_CONSTRAINT");
    expect(prompt.memoryPrompt).toContain("ignore if asked");
    expect(prompt.memoryPrompt).not.toContain("Write to them directly");
    // Interactive Light with empty memory keeps the rules out of its fixed
    // prefix and resolves them for the memory-on-request reminder.
    const interactive = await owner("interactive", "", { lightMode: true });
    const onRequest = await resolveMemoryOnRequest(interactive.session, interactive.cwd);
    // Both prefix halves stay empty; the on-request text comes along for /context.
    expect(await resolveMemoryPromptInputs(interactive.session, interactive.cwd))
      .toEqual({ memoryInstructions: "", memoryPrompt: "", memoryOnRequest: onRequest });
    expect(onRequest).toContain("# auto memory");
    expect(onRequest).toContain((await resolveAutoMemoryDirectory(interactive.options)).path);
    // It names the directories the runtime sandbox admits memory writes to.
    const writeRoots = sessionDurableMemoryWriteRoots(interactive.session.services, interactive.cwd);
    expect(writeRoots).toHaveLength(2);
    for (const root of writeRoots!) expect(onRequest).toContain(root);
    // Once an index has content the rules ride the fixed prefix again.
    writeFileSync(join(await resolveGlobalMemoryDirectory(interactive.options), "MEMORY.md"), "- [Editor](editor.md): vim\n");
    const withMemory = await resolveMemoryPromptInputs(interactive.session, interactive.cwd);
    expect(withMemory.memoryInstructions).toContain("# auto memory");
    expect(withMemory.memoryPrompt).toContain("# Memory directories");
    expect(withMemory.memoryOnRequest).toBeUndefined();
    expect(await resolveMemoryOnRequest(interactive.session, interactive.cwd))
      .toBe([withMemory.memoryInstructions, withMemory.memoryPrompt].join("\n\n"));
  });

  test("Desktop presentation uses the captured client even when the shell environment differs", async () => {
    const target = await owner("desktop", "", { lightMode: true, nonInteractive: true });
    const session = { services: { ...target.session.services,
      providerEnvironment: { ...target.session.services.providerEnvironment, AGENC_AGENT_SDK_CLIENT_APP: "agenc-desktop-rich-v1" },
    } };
    const prompt = await resolveMemoryPromptInputs(session, target.cwd);
    expect(prompt.memoryPrompt).toContain("Read memory when requested; verify past claims against current files. Ignore memory if the user asks.");
    expect(prompt.memoryPrompt).toContain((await resolveAutoMemoryDirectory(target.options)).path);
    expect(prompt.memoryPrompt).toContain(await resolveGlobalMemoryDirectory(target.options));
  });

  test("uses the owner's tilde expansion and keeps the global root separate", async () => {
    const target = await owner("override", 'autoMemoryDirectory = "~/saved-project-memory"', { nonInteractive: true });
    const prompt = await resolveMemoryPromptInputs(target.session, target.cwd);
    expect(prompt.memoryPrompt).toContain(join(target.root, "saved-project-memory"));
    expect(prompt.memoryPrompt).toContain(join(target.home, "memory"));
    // An interactive session with empty memory names the same directories in its on-request text.
    const interactive = await owner("override-interactive", 'autoMemoryDirectory = "~/saved-project-memory"');
    const onRequest = await resolveMemoryOnRequest(interactive.session, interactive.cwd);
    expect(onRequest).toContain(join(interactive.root, "saved-project-memory"));
    expect(onRequest).toContain(join(interactive.home, "memory"));
  });

  test("an interactive standard session with empty memory sends its rules on request only", async () => {
    const interactive = await owner("standard-interactive");
    const onRequest = await resolveMemoryOnRequest(interactive.session, interactive.cwd);
    expect(await resolveMemoryPromptInputs(interactive.session, interactive.cwd))
      .toEqual({ memoryInstructions: "", memoryPrompt: "", memoryOnRequest: onRequest });
    // The standard rules (not Light's) and the standard directory block.
    expect(onRequest).toContain(MEMORY_RULES_MARKER);
    expect(onRequest).not.toContain(LIGHT_MEMORY_RULES_MARKER);
    expect(onRequest).toContain("# Memory directories");
    const writeRoots = sessionDurableMemoryWriteRoots(interactive.session.services, interactive.cwd);
    expect(writeRoots).toHaveLength(2);
    for (const root of writeRoots!) expect(onRequest).toContain(root);
    // Once an index has content the rules ride the fixed prefix again, unchanged.
    writeFileSync(join(await resolveGlobalMemoryDirectory(interactive.options), "MEMORY.md"), "- [Editor](editor.md): vim\n");
    const withMemory = await resolveMemoryPromptInputs(interactive.session, interactive.cwd);
    expect(withMemory.memoryInstructions).toBe(buildMemoryInstructionLines().join("\n"));
    expect(withMemory.memoryOnRequest).toBeUndefined();
    expect(withMemory.memoryPrompt).toContain("# Memory directories");
    // A scheduled routine keeps the rules in its prefix whatever the memory holds.
    const routine = await owner("standard-routine", "", { routineRun: true });
    expect((await resolveMemoryPromptInputs(routine.session, routine.cwd)).memoryInstructions)
      .toBe(buildMemoryInstructionLines().join("\n"));
  });

  test("fails closed without an owning configuration store", async () => {
    expect(await resolveMemoryPromptInputs({ services: {} }, originalProjectRoot))
      .toEqual({ memoryInstructions: "", memoryPrompt: "" });
    expect(await resolveMemoryOnRequest({ services: {} }, originalProjectRoot)).toBeUndefined();
  });
});
