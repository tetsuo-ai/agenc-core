import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { computeDocumentDigest } from "../../src/eval-contract/index.js";
import { main } from "../../src/eval-executor/cli.js";
import { DockerContainerRunner } from "../../src/eval-executor/container-runner.js";
import type { PilotSourceLock } from "../../src/eval-executor/types.js";
import {
  findTaskOutputDirectory, prepareOutputDirectory, prepareTaskOutputDirectory,
  readTaskOutputFile, writeTaskOutputFile,
} from "../../src/eval-executor/task-output.js";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";

const workspaces = createTempWorkspaceFixture("agenc-task-output-");
const committedLock = fileURLToPath(new URL("../../eval/suites/competitive-coding/1.0.0/task-sets/pilot/1.0.0/source-lock.json", import.meta.url));
afterEach(async () => { vi.restoreAllMocks(); await workspaces.cleanup(); });

function commandArgs(command: string, lock: string, task: string, output: string): string[] {
  const args = [command, "--lock", lock, command.endsWith("-batch") ? "--tasks" : "--task", task, "--output", output];
  if (command !== "preflight") args.push("--overlay", "unused-overlay");
  if (command.startsWith("run-agent-real")) args.push(
    "--provider-host", "api.example.invalid", "--provider-base-url", "https://api.example.invalid/v1", "--provider-model", "test-model",
  );
  return args;
}

describe("task output containment", () => {
  test.each(["../../outside", "/outside", "C:\\outside", "task/child", "task\\child", ".", "..", "", "CON"])("rejects ID %j before creating or reading directories", async (instanceId) => {
    const root = await workspaces.create();
    const output = path.join(root, "not-created");
    await expect(prepareTaskOutputDirectory(output, instanceId)).rejects.toThrow(/instanceId/u);
    await expect(findTaskOutputDirectory(output, instanceId)).rejects.toThrow(/instanceId/u);
    expect(await readdir(root)).toEqual([]);
  });

  test("keeps create, replace, append, and reads beneath the selected directory", async () => {
    const root = await workspaces.create();
    const output = await prepareTaskOutputDirectory(root, "Owner__Repo-123");
    expect(output.path).toBe(path.join(root, "Owner__Repo-123"));
    await writeTaskOutputFile(output, "report.json", "first");
    await expect(writeTaskOutputFile(output, "report.json", "do not overwrite")).rejects.toMatchObject({ code: "EEXIST" });
    await writeTaskOutputFile(output, "report.json", "second", "replace");
    await writeTaskOutputFile(output, "report.json", ":tail", "append");
    expect(Buffer.from((await readTaskOutputFile(output, "report.json", 128))!).toString()).toBe("second:tail");
    await expect(readTaskOutputFile(output, "report.json", 1)).rejects.toThrow(/exceeds/u);
    expect(await readTaskOutputFile(output, "absent.json", 128)).toBeNull();
    expect(await findTaskOutputDirectory(root, "not-present")).toBeNull();
    expect(await findTaskOutputDirectory(path.join(root, "missing-root"), "task")).toBeNull();
    await expect(lstat(path.join(root, "missing-root"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["../outside", "/outside", "nested/report.json", "C:\\outside"])("rejects output filename %j", async (name) => {
    const root = await workspaces.create();
    const output = await prepareTaskOutputDirectory(root, "task");
    await expect(writeTaskOutputFile(output, name, "bytes")).rejects.toThrow();
    await expect(readTaskOutputFile(output, name, 128)).rejects.toThrow();
    expect(await readdir(output.path)).toEqual([]);
  });

  test.each(["root", "task"])("refuses a replaced %s directory after it was pinned", async (kind) => {
    const root = await workspaces.create();
    const selected = path.join(root, "output");
    const output = await prepareTaskOutputDirectory(selected, "task");
    const replaced = kind === "root" ? selected : output.path;
    await rename(replaced, `${replaced}-retired`);
    await mkdir(replaced);
    await expect(writeTaskOutputFile(output, "report.json", "bytes")).rejects.toThrow(/changed identity/u);
    await expect(readTaskOutputFile(output, "report.json", 128)).rejects.toThrow(/changed identity/u);
    expect(await readdir(replaced)).toEqual([]);
  });

  test.each(["preflight", "run-agent", "run-agent-real", "run-agent-real-batch"])("%s rejects a self-digested unsafe lock before container work or output creation", async (command) => {
    const root = await workspaces.create();
    const original = JSON.parse(await readFile(committedLock, "utf8")) as PilotSourceLock;
    const taskId = "../../outside";
    const changed = { ...original, tasks: original.tasks.map((task, index) => index === 0 ? { ...task, instanceId: taskId } : task) };
    const lock = path.join(root, "source-lock.json");
    await mkdir(path.join(root, "cas", "sha256"), { recursive: true });
    await writeFile(lock, JSON.stringify({ ...changed, documentDigest: computeDocumentDigest(changed) }));
    const output = path.join(root, "output");
    const environment = vi.spyOn(DockerContainerRunner.prototype, "environment").mockRejectedValue(new Error("must not spend"));
    await expect(main(commandArgs(command, lock, taskId, output))).rejects.toThrow(/instanceId/u);
    expect(environment).not.toHaveBeenCalled();
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).sort()).toEqual(["cas", "source-lock.json"]);
  });
});

describe.runIf(process.platform !== "win32")("linked evaluation output", () => {
  test.each(["root", "task"])("refuses a symlinked %s directory", async (kind) => {
    const root = await workspaces.create();
    const outside = await workspaces.create();
    const selected = path.join(root, "output");
    if (kind === "task") await mkdir(selected);
    await symlink(outside, kind === "root" ? selected : path.join(selected, "task"));
    await expect(prepareTaskOutputDirectory(selected, "task")).rejects.toThrow(/non-symlink directory/u);
    await expect(findTaskOutputDirectory(selected, "task")).rejects.toThrow(/non-symlink directory/u);
    expect(await readdir(outside)).toEqual([]);
  });

  test.each(["symlink", "hardlink", "fifo"])("refuses %s files for every read/write mode", async (kind) => {
    const root = await workspaces.create();
    const outside = path.join(await workspaces.create(), "sentinel");
    await writeFile(outside, "unchanged");
    const output = await prepareOutputDirectory(root);
    const file = path.join(root, "report.json");
    if (kind === "symlink") await symlink(outside, file);
    else if (kind === "hardlink") await link(outside, file);
    else execFileSync("mkfifo", [file]);
    await expect(readTaskOutputFile(output, "report.json", 128)).rejects.toThrow(/regular file/u);
    for (const mode of ["create", "replace", "append"] as const) {
      await expect(writeTaskOutputFile(output, "report.json", "attack", mode)).rejects.toThrow(/regular file/u);
    }
    expect(await readFile(outside, "utf8")).toBe("unchanged");
  });

  test.each(["preflight", "run-agent", "run-agent-real", "run-agent-real-batch"])("%s rejects a linked output root before container work", async (command) => {
    const root = await workspaces.create();
    const outside = await workspaces.create();
    const selected = path.join(root, "output");
    await symlink(outside, selected);
    const original = JSON.parse(await readFile(committedLock, "utf8")) as PilotSourceLock;
    const environment = vi.spyOn(DockerContainerRunner.prototype, "environment").mockRejectedValue(new Error("must not spend"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(main(commandArgs(command, committedLock, original.tasks[0]!.instanceId, selected))).rejects.toThrow(/non-symlink directory/u);
    expect(environment).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
  });
});
