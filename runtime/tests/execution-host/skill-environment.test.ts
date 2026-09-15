import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLocalSkillsServices, discoverSkillRoots, discoverSkillWatchSources, loadLocalSkillsSnapshot } from "../../src/skills/local-loader.js";
import { ExecutionEnvironmentError } from "../../src/execution/types.js";
import { FileWatcher } from "../../src/file-watcher/index.js";
import { ConfigStore } from "../../src/config/store.js";
import { ExecutionConfigFilesystem } from "../../src/config/workspace-filesystem.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { getCommands } from "../../src/commands.js";
import { TaskFiles } from "./task-files-fixture.js";

const temporaryRoots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function options(files: TaskFiles, workspaceRoot = "/app") {
  const root = await mkdtemp(join(tmpdir(), "agenc-skill-environment-")); temporaryRoots.push(root);
  files.put(workspaceRoot, "", true);
  return { agencHome: join(root, "agenc"), pluginStorageRoot: join(root, "plugins"), workspaceRoot,
    executionEnvironment: files.environment(), env: { HOME: join(root, "home"), AGENC_MANAGED_HOME: join(root, "managed") } };
}
function body(name: string, content = "Task body α", fields = "") {
  return `---\nname: ${name}\ndescription: ${name} guidance\n${fields}---\n${content}\n`;
}
async function hostSkill(path: string, name: string) {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, body(name, "Controller body"));
}

describe("skill execution environment", () => {
  test("command discovery inherits the owning ConfigStore and retains task read failures", async () => {
    const files = new TaskFiles(), opts = await options(files);
    files.put("/app/.agenc/skills/task-command/SKILL.md", body("task-command", "Task command guidance"));
    const authority = new ConfigStore({ home: opts.agencHome, cwd: "/app", projectRoot: "/app",
      workspaceFilesystem: new ExecutionConfigFilesystem(opts.executionEnvironment) });
    await authority.reload();
    await runWithCanonicalSettingsAuthority(authority, async () => {
      const commands = await getCommands("/app", { pluginStorageRoot: opts.pluginStorageRoot });
      const command = commands.find((entry) => entry.name === "task-command")!;
      expect(command.executionBinding).toEqual(opts.executionEnvironment.binding);
      expect(command.type).toBe("prompt");
      if (command.type === "prompt") expect(JSON.stringify(await command.getPromptForCommand!("", {}))).toContain("Task command guidance");
      const original = files.filesystem.bindFileSnapshot;
      files.filesystem.bindFileSnapshot = async (path) => {
        if (path.endsWith("SKILL.md")) throw new ExecutionEnvironmentError("authority_revoked", "Revoked skill read", false);
        return original(path);
      };
      await expect(getCommands("/app", { pluginStorageRoot: opts.pluginStorageRoot })).rejects.toMatchObject({ code: "authority_revoked" });
    });
  });
  test("retains distinct task and controller sources at equal canonical paths", async () => {
    const files = new TaskFiles(), opts = await options(files);
    const shared = join(opts.agencHome, "skills/shared/SKILL.md");
    const workspaceRoot = opts.agencHome;
    files.put(workspaceRoot, "", true);
    // A plugin directly exposes the same directory as the controller user root.
    files.put(workspaceRoot + "/.agenc-plugin/plugin.json", JSON.stringify({ name: "task" }));
    files.put(shared, body("task"));
    files.put(workspaceRoot + "/.agenc/skills/project/SKILL.md", body("project", "Project bytes"));
    await hostSkill(shared, "operator");
    await hostSkill(workspaceRoot + "/.agenc/skills/project/SKILL.md", "host-shadow");
    await hostSkill(join(opts.env.AGENC_MANAGED_HOME, ".agenc/skills/managed/SKILL.md"), "managed");
    const selected = { ...opts, workspaceRoot, config: { plugins: { enabled: true, plugins: { task: { path: "." } } } } };
    const snapshot = await loadLocalSkillsSnapshot(selected);
    const sharedSkills = snapshot.skills.filter((skill) => skill.path === shared);
    expect(sharedSkills).toHaveLength(2);
    expect(sharedSkills.find((skill) => !skill.executionBinding)?.description).toBe("operator guidance");
    expect(snapshot.skills.find((skill) => skill.name === "managed")?.executionBinding).toBeUndefined();
    expect(snapshot.skills.find((skill) => skill.name === "project")?.executionBinding).toEqual(opts.executionEnvironment.binding);
    expect(snapshot.skills.some((skill) => skill.description === "host-shadow guidance")).toBe(false);
    expect(sharedSkills.find((skill) => skill.executionBinding)?.description).toBe("task guidance");
    const sources = await discoverSkillWatchSources(selected);
    expect(sources.filter((source) => source.path === join(opts.agencHome, "skills"))).toHaveLength(2);
  });

  test("uses task HOME for ancestor discovery and reloads protected bytes and conditional skills", async () => {
    const files = new TaskFiles(), opts = await options(files, "/task/home/app");
    files.put("/task/home/.agenc/skills/excluded/SKILL.md", body("excluded"));
    const path = "/task/home/app/.agenc/skills/docs/SKILL.md";
    files.put(path, body("docs", "Original $ARGUMENTS", "paths: [docs/**]\n"));
    files.put("/task/home/app/docs/file.md", "Document");
    const selected = { ...opts, executionHomePath: "/task/home", env: { ...opts.env, HOME: "/task/home/app" } };
    expect((await discoverSkillRoots(selected)).map((root) => root.path)).not.toContain("/task/home/.agenc/skills");
    const services = createLocalSkillsServices(selected);
    expect((await services.skillsManager.skillsForConfig({}, null)).availableSkills?.some((skill) => skill.name === "docs")).toBe(false);
    await services.skillsManager.discoverSkillDirsForPaths?.(["docs/file.md"]);
    expect((await services.skillsManager.skillsForConfig({}, null)).availableSkills?.some((skill) => skill.name === "docs")).toBe(true);
    expect((await services.skillsManager.renderSkill?.({ name: "docs", args: "input" }))?.content).toContain("Original input");
    files.put(path, body("docs", "Fresh Unicode β\r\n\r\n"));
    expect((await services.skillsManager.renderSkill?.({ name: "docs" }))?.content).toContain("Fresh Unicode β");
    files.unavailable = true;
    await expect(services.skillsManager.resolveSkill?.("docs")).rejects.toMatchObject({ code: "environment_dead" });
  });

  test("separates invocation records by container, generation and session", async () => {
    const files = new TaskFiles(), opts = await options(files);
    const services = [files.environment("a", "b"), files.environment("d", "b"), files.environment("a", "e")]
      .map((executionEnvironment) => createLocalSkillsServices({ ...opts, executionEnvironment, sessionId: "same-session" }));
    for (const [index, service] of services.entries()) service.skillsManager.recordInvokedSkill?.({
      skillName: `skill-${index}`, skillPath: "/app/SKILL.md", content: "body", invokedAt: index, sessionId: "same-session",
    });
    for (const [index, service] of services.entries()) {
      expect([...(service.skillsManager.getInvokedSkillsForAgent?.(undefined, "same-session")?.keys() ?? [])]).toEqual([`skill-${index}`]);
      expect([...(service.skillsManager.getInvokedSkillsForAgent?.(undefined, "other-session")?.keys() ?? [])]).toEqual([]);
      service.skillsManager.clearInvokedSkillsForAgent?.();
    }
  });

  test("preserves exact dropped counts and rejects revoked read authority", async () => {
    const files = new TaskFiles(), opts = await options(files);
    for (let index = 0; index < 5; index++) files.put(`/app/.agenc/skills/skill-${index}/SKILL.md`, body(`skill-${index}`));
    vi.stubEnv("AGENC_MAX_SKILL_FILES_PER_ROOT", "2");
    const snapshot = await loadLocalSkillsSnapshot(opts);
    expect(snapshot.truncatedRoots).toEqual([{ root: "/app/.agenc/skills", loadedCount: 2, droppedCount: 3 }]);
    const original = opts.executionEnvironment;
    const executionEnvironment = { ...original, filesystem: { ...original.filesystem, bindFileSnapshot: async () => {
      throw new ExecutionEnvironmentError("authority_revoked", "Revoked", false);
    } } };
    await expect(loadLocalSkillsSnapshot({ ...opts, executionEnvironment })).rejects.toMatchObject({ code: "authority_revoked" });
  });

  test("watches task roots only through the backend and retains environment failure", async () => {
    const files = new TaskFiles(), opts = await options(files), watcher = FileWatcher.noop();
    const register = vi.spyOn(watcher, "addSubscriber");
    const executeHooks = vi.fn(async () => []);
    const services = createLocalSkillsServices({ ...opts, fileWatcher: watcher, watcherPollIntervalMs: 10,
      watcherDebounceMs: 1, watcherClearRuntimeCaches: false,
      watcherExecuteConfigChangeHooks: executeHooks, watcherHasBlockingResult: () => false });
    cleanups.push(async () => { await services.skillsWatcher.stop(); watcher.close(); });
    await services.skillsWatcher.start();
    expect(register).toHaveBeenCalledTimes(1);
    expect(watcher.watchCountsForTest("/app/.agenc/skills")).toBeNull();
    files.put("/app/.agenc/skills/late/SKILL.md", body("late"));
    await vi.waitFor(() => expect(executeHooks).toHaveBeenCalled(), { timeout: 2_000 });
    expect((await services.skillsManager.resolveSkill?.("late"))?.executionBinding).toEqual(opts.executionEnvironment.binding);
    files.unavailable = true;
    await vi.waitFor(async () => {
      await expect(services.skillsManager.resolveSkill?.("late")).rejects.toMatchObject({ code: "environment_dead" });
    });
    // Once the poller records death, restoring a test transport cannot clear it.
    await new Promise((resolve) => setTimeout(resolve, 40));
    files.unavailable = false;
    await expect(services.skillsManager.resolveSkill?.("late")).rejects.toMatchObject({ code: "environment_dead" });
  });
});
