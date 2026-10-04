import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

const effects = vi.hoisted(() => ({
  evaluations: 0,
  execute: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("../../src/utils/hooks.js", () => {
  effects.evaluations++;
  return { executeInstructionsLoadedHooks: effects.execute };
});

test("consumes eager reasons without hooks, defers the executor, and preserves audit dispatch and attachment dedup", async () => {
  const [state, config, settings, memory, predicate, attachments, runtimeOptions] = await Promise.all([
    import("../../src/bootstrap/state.js"),
    import("../../src/config/store.js"),
    import("../../src/utils/settings/canonicalAuthority.js"),
    import("../../src/memory/agencmd.js"),
    import("../../src/utils/hooks/instructionsLoaded.js"),
    import("../../src/utils/attachments.js"),
    import("../../src/session/runtime-options.js"),
  ]);
  expect(effects.evaluations).toBe(0);
  const root = await mkdtemp(join(tmpdir(), "instructions-loaded-lazy-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  await mkdir(home);
  await mkdir(join(repo, ".git"), { recursive: true });
  const path = join(repo, "AGENC.md");
  await writeFile(path, "Keep this repository instruction in context.\n");
  const store = new config.ConfigStore({ home, cwd: repo, env: { AGENC_HOME: home, HOME: home } });
  state.resetStateForTests();
  state.setOriginalCwd(repo);
  state.setCwdState(repo);
  state.setProjectRoot(repo);
  try {
    await settings.runWithCanonicalSettingsAuthority(store, async () => {
      memory.resetGetMemoryFilesCache();
      expect(predicate.hasInstructionsLoadedHook()).toBe(false);
      const files = await memory.getMemoryFiles();
      expect(files.some(file => file.path === path && file.content.includes("Keep this repository"))).toBe(true);
      expect(effects.evaluations).toBe(0);
      state.registerHookCallbacks({ InstructionsLoaded: [{ matcher: "*", hooks: [{ type: "callback", callback: async () => ({}) }] }] } as never);
      expect(predicate.hasInstructionsLoadedHook()).toBe(true);
      // A plain cache clear must not revive the consumed session_start reason.
      memory.clearMemoryFileCaches();
      await memory.getMemoryFiles();
      expect(effects.evaluations).toBe(0);
      expect(effects.execute).not.toHaveBeenCalled();

      let finish: (() => void) | undefined;
      effects.execute.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
      memory.resetGetMemoryFilesCache("compact");
      await memory.getMemoryFiles();
      expect(effects.evaluations).toBe(1);
      expect(effects.execute).toHaveBeenCalledWith(path, "Project", "compact", { globs: undefined, parentFilePath: undefined });
      // The loader waited for module loading, but still does not await the hook.
      expect(finish).toBeTypeOf("function");
      finish!();
      const count = effects.execute.mock.calls.length;
      await memory.getMemoryFiles();
      expect(effects.execute).toHaveBeenCalledTimes(count);

      effects.execute.mockClear();
      memory.resetGetMemoryFilesCache("session_start");
      await memory.getMemoryFiles(true);
      expect(effects.execute).not.toHaveBeenCalled();
      await memory.getMemoryFiles(false);
      expect(effects.execute).toHaveBeenCalledWith(path, "Project", "session_start", expect.any(Object));

      effects.execute.mockClear();
      const nested = { path: join(repo, "nested", "AGENC.md"), type: "Project" as const, content: "nested", globs: ["*.ts"] };
      const context = { loadedNestedMemoryPaths: new Set<string>(), readFileState: new Map() } as never;
      const result = attachments.memoryFilesToAttachments([nested], context, join(repo, "file.ts"));
      expect(result).toHaveLength(1);
      const originalPath = nested.path;
      nested.path = "changed-after-dispatch";
      await vi.dynamicImportSettled();
      expect(effects.execute).toHaveBeenCalledWith(originalPath, "Project", "path_glob_match", {
        globs: ["*.ts"], triggerFilePath: join(repo, "file.ts"), parentFilePath: undefined,
      });
      nested.path = originalPath;
      expect(attachments.memoryFilesToAttachments([nested], context)).toEqual([]);
      await vi.dynamicImportSettled();
      expect(effects.execute).toHaveBeenCalledTimes(1);

      await runtimeOptions.runWithAgentRuntimeOptions(
        runtimeOptions.resolveAgentRuntimeOptions({}, { simpleMode: true }),
        async () => {
          expect(predicate.hasInstructionsLoadedHook()).toBe(false);
          memory.resetGetMemoryFilesCache();
          effects.execute.mockClear();
          await memory.getMemoryFiles();
          expect(effects.execute).not.toHaveBeenCalled();
        },
      );
      memory.clearMemoryFileCaches();
      await memory.getMemoryFiles();
      expect(effects.execute).not.toHaveBeenCalled();
    });
  } finally {
    memory.clearMemoryFileCaches();
    state.resetStateForTests();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
