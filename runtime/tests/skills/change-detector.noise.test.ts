import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileWatcher } from "../file-watcher/index.js";
import {
  createSkillChangeDetector,
  type SkillChangeDetector,
} from "./change-detector.js";
import { createLocalSkillsServices } from "./local-loader.js";

const tempDirs: string[] = [];
let detector: SkillChangeDetector;

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agenc-${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  detector = createSkillChangeDetector();
});

afterEach(async () => {
  await detector.dispose();
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function reloadsFor(root: string, paths: readonly string[]) {
  const watcher = FileWatcher.noop();
  const onReload = vi.fn();
  await detector.initialize({
    fileWatcher: watcher,
    getWatchRoots: async () => [root],
    onReload,
    debounceMs: 10,
    clearRuntimeCaches: false,
    runConfigChangeHooks: false,
  });
  await watcher.sendPathsForTest(paths);
  await flushPromises();
  await vi.advanceTimersByTimeAsync(10);
  await flushPromises();
  return onReload;
}

describe("skill watcher noise", () => {
  it("does not reload for files that cannot change the catalog", async () => {
    const root = tempDir("noise-root");
    const skill = join(root, "pptx");
    mkdirSync(join(skill, "scripts"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\ndescription: Slides\n---\n");
    writeFileSync(join(skill, "scripts", "build.py"), "print(1)\n");
    writeFileSync(join(root, ".DS_Store"), "finder");
    writeFileSync(join(skill, ".SKILL.md.swp"), "scratch");
    writeFileSync(join(skill, "4913"), "scratch");
    const onReload = await reloadsFor(root, [
      join(skill, "scripts", "build.py"),
      join(root, ".DS_Store"),
      join(skill, ".SKILL.md.swp"),
      join(skill, "4913"),
    ]);
    expect(onReload).not.toHaveBeenCalled();
  });

  it("still reloads for a SKILL.md, a new directory, a deletion and a manifest", async () => {
    const root = tempDir("noise-root");
    mkdirSync(join(root, "fresh"), { recursive: true });
    mkdirSync(join(root, ".agenc-plugin"), { recursive: true });
    writeFileSync(join(root, ".agenc-plugin", "plugin.json"), "{}");
    const changed = [
      join(root, "pptx", "SKILL.md"),
      join(root, "fresh"),
      join(root, "gone", "notes.md"),
      join(root, ".agenc-plugin", "plugin.json"),
    ];
    const onReload = await reloadsFor(root, changed);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledWith({ changedPaths: [...changed].sort() });
  });

  it("reloads when an imported skill directory has a scratch-looking name", async () => {
    const root = tempDir("noise-root");
    const staging = tempDir("noise-staging");
    mkdirSync(join(staging, "new.tmp"));
    writeFileSync(join(staging, "new.tmp", "SKILL.md"), "---\ndescription: Imported\n---\nBody\n");
    const imported = join(root, "new.tmp");
    renameSync(join(staging, "new.tmp"), imported);
    const onReload = await reloadsFor(root, [imported]);
    expect(onReload).toHaveBeenCalledWith({ changedPaths: [imported] });
  });

  it("reloads when a vanished scratch-looking path might have been a directory", async () => {
    const root = tempDir("noise-root");
    const vanished = join(root, "gone.tmp");
    const onReload = await reloadsFor(root, [vanished]);
    expect(onReload).toHaveBeenCalledWith({ changedPaths: [vanished] });
  });
});

describe("skill watcher restarts", () => {
  it("keeps the watcher when a setting outside the plugin section changes", async () => {
    const agencHome = tempDir("restart-home");
    const workspaceRoot = tempDir("restart-workspace");
    const watcher = FileWatcher.noop();
    const initialize = vi.spyOn(detector, "initialize");
    const dispose = vi.spyOn(detector, "dispose");
    const services = createLocalSkillsServices({
      agencHome,
      pluginStorageRoot: join(agencHome, "plugins"),
      workspaceRoot,
      fileWatcher: watcher,
      skillChangeDetector: detector,
      skillChangeEventSink: createSkillChangeDetector(),
      watcherClearRuntimeCaches: false,
      watcherRunConfigChangeHooks: false,
      config: { plugins: { enabled: true } } as never,
      env: {},
    });
    await services.skillsWatcher.start();
    await services.skillsManager.skillsForConfig(
      { model: "a", plugins: { enabled: true } },
      null,
    );
    await services.skillsManager.skillsForConfig(
      { model: "b", permissions: { allow: ["Read"] }, plugins: { enabled: true } },
      null,
    );
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();

    await services.skillsManager.skillsForConfig(
      { model: "b", plugins: { enabled: false } },
      null,
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(2);
    await services.skillsWatcher.stop();
  });
});
