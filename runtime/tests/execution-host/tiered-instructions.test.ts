import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskFiles } from "./task-files-fixture.js";
import { clearTieredInstructionsCacheForTesting, loadTieredInstructions } from "../../src/prompts/agenc-md.js";
import { discoverInstructionRulesDetailed, scanInstructionRulePaths } from "../../src/prompts/rules/discovery.js";


const roots: string[] = [];
afterEach(async () => {
  clearTieredInstructionsCacheForTesting();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function controller() {
  const root = await mkdtemp(join(tmpdir(), "agenc-tiered-environment-")); roots.push(root);
  await mkdir(join(root, "rules"));
  await writeFile(join(root, "AGENC.md"), "controller user");
  await writeFile(join(root, "managed.md"), "controller managed");
  await writeFile(join(root, "rules", "baseline.md"), "controller rule");
  return { cwd: root, configHomeDir: root, managedPath: join(root, "managed.md") };
}

it("separates equal task/controller instruction paths and invalidates both namespaces independently", async () => {
  const opts = await controller(), files = new TaskFiles();
  files.put(join(opts.cwd, ".git"), "", true);
  files.put(join(opts.cwd, "AGENC.md"), "task project\n@include include.md");
  files.put(join(opts.cwd, "include.md"), "task include");
  files.put(join(opts.cwd, "AGENC.local.md"), "task local");
  files.put(join(opts.cwd, ".agenc", "rules", "baseline.md"), "task rule");
  const options = { ...opts, executionEnvironment: files.environment() };
  const first = await loadTieredInstructions(options);
  expect(first.user?.content).toContain("controller user");
  expect(first.managed?.content).toContain("controller managed");
  expect(first.managed?.content).toContain("controller rule");
  expect(first.project?.content).toContain("task project");
  expect(first.project?.content).toContain("task include");
  expect(first.project?.content).toContain("task rule");
  expect(first.local?.content).toBe("task local");
  expect(first.project?.executionBinding).toEqual(options.executionEnvironment.binding);
  expect(first.user?.executionBinding).toBeUndefined();
  const reads = files.reads.length;
  expect(await loadTieredInstructions(options)).toBe(first);
  expect(files.reads).toHaveLength(reads);
  files.put(join(opts.cwd, "include.md"), "task include updated");
  const changedTask = await loadTieredInstructions(options);
  expect(changedTask.project?.content).toContain("task include updated");
  expect(changedTask.user?.content).toContain("controller user");
  await writeFile(join(opts.cwd, "AGENC.md"), "controller user updated");
  const changedController = await loadTieredInstructions(options);
  expect(changedController.user?.content).toContain("controller user updated");
  expect(changedController.project?.content).toContain("task project");
  files.put(join(opts.cwd, "AGENC.override.md"), "higher priority task");
  expect((await loadTieredInstructions(options)).project?.content).toContain("higher priority task");
  expect(files.reads).not.toContain(opts.managedPath);
  expect(files.reads).not.toContain(join(opts.cwd, "rules", "baseline.md"));
});

it("keys /app caches by container and generation and propagates loss even on a cache hit", async () => {
  const controllerOpts = await controller();
  const first = new TaskFiles(), second = new TaskFiles();
  first.put("/app/AGENC.md", "one"); second.put("/app/AGENC.md", "two");
  const opts = { ...controllerOpts, cwd: "/app", enabledTiers: ["project"] as const };
  for (const environment of [second.environment("d"), second.environment("a", "e")]) {
    expect((await loadTieredInstructions({ ...opts, executionEnvironment: first.environment() })).project?.content).toBe("one");
    expect((await loadTieredInstructions({ ...opts, executionEnvironment: environment })).project?.content).toBe("two");
  }
  first.unavailable = true;
  await expect(loadTieredInstructions({ ...opts, executionEnvironment: first.environment() }))
    .rejects.toMatchObject({ code: "environment_dead" });
});

it("retains an explicitly selected local backend for cache probes", async () => {
  const opts = await controller(), files = new TaskFiles();
  files.put(join(opts.cwd, "AGENC.md"), "explicit backend");
  const options = { ...opts, enabledTiers: ["project"] as const,
    executionEnvironment: { binding: { kind: "local" as const }, filesystem: files.filesystem } };
  const first = await loadTieredInstructions(options);
  expect(first.project?.content).toBe("explicit backend");
  expect(await loadTieredInstructions(options)).toBe(first);
  files.put(join(opts.cwd, "AGENC.md"), "changed backend");
  expect((await loadTieredInstructions(options)).project?.content).toBe("changed backend");
});

it("discovers conditional task rules with binding evidence and releases a scan that exceeds its cap", async () => {
  const files = new TaskFiles();
  files.put("/app/.agenc/rules/conditional.md", "---\nglobs: [src/**]\n---\ntask conditional");
  files.put("/app/.agenc/rules/plain.md", "task unconditional");
  const opts = { executionEnvironment: files.environment(), rulesDir: "/app/.agenc/rules", boundaryDir: "/app" };
  const discovery = await discoverInstructionRulesDetailed({ ...opts, type: "Project", targetPath: "/app/src/main.ts" });
  expect(discovery.rules.map((rule) => rule.content)).toEqual(["task conditional", "task unconditional"]);
  expect(discovery.rules.every((rule) => rule.executionBinding?.kind === "docker")).toBe(true);
  expect(discovery.files.every((file) => file.executionBinding?.kind === "docker")).toBe(true);
  for (let i = 0; i < 2500; i++) files.put(`/app/.agenc/rules/ignored-${i}`, "");
  files.enumerated = 0;
  const released = files.released;
  expect(await scanInstructionRulePaths(opts)).toMatchObject({ paths: [], overflowed: true });
  expect(files.enumerated).toBe(2001);
  expect(files.released).toBe(released + 1);
});

it("rejects a directory exchanged before binding without enumerating its replacement", async () => {
  const files = new TaskFiles(); files.put("/app/.agenc/rules/file.md", "original");
  files.beforeDirectoryBind = (path) => files.put(path, "", true);
  expect(await scanInstructionRulePaths({ executionEnvironment: files.environment(), rulesDir: "/app/.agenc/rules", boundaryDir: "/app" }))
    .toMatchObject({ paths: [], overflowed: true });
  expect(files.enumerated).toBe(0);
  expect(files.released).toBe(1);
});
