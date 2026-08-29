import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DockerContainerRunner } from "../../src/eval-executor/container-runner.js";

const PINNED_IMAGE =
  "registry.example/task@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/**
 * A fake `docker` on PATH that records every argv line and answers the
 * subset of commands the runner issues. Container ids are minted per
 * `create` so the test can assert which ids the cleanup removes, in order.
 */
async function installFakeDocker(root: string): Promise<{ readonly log: string; readonly bin: string }> {
  const bin = path.join(root, "bin");
  const log = path.join(root, "docker.log");
  await rm(bin, { recursive: true, force: true });
  await (await import("node:fs/promises")).mkdir(bin, { recursive: true });
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    'case "$1" in',
    "  version) echo 0.0.0-fake ;;",
    "  create) echo \"container-$(( $(grep -c '^create ' " + JSON.stringify(log) + ") ))\" ;;",
    "  image) echo /work ;;",
    "  start|rm|network) ;;",
    "  *) echo \"unexpected docker command: $*\" >&2; exit 64 ;;",
    "esac",
    "",
  ].join("\n");
  const executable = path.join(bin, "docker");
  await writeFile(executable, script, { mode: 0o755 });
  await chmod(executable, 0o755);
  return { log, bin };
}

async function loggedCommands(log: string): Promise<string[]> {
  try {
    return (await readFile(log, "utf8")).split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

describe.runIf(process.platform !== "win32")("DockerContainerRunner live tracking", () => {
  let root = "";
  let previousPath: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "agenc-eval-runner-"));
    const fake = await installFakeDocker(root);
    previousPath = process.env.PATH;
    process.env.PATH = [fake.bin, previousPath ?? ""].join(path.delimiter);
    DockerContainerRunner.resetAbortStateForTesting();
  });

  afterEach(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    DockerContainerRunner.resetAbortStateForTesting();
    await rm(root, { recursive: true, force: true });
  });

  test("abortAll force-removes every container this process still owns and refuses new ones", async () => {
    const log = path.join(root, "docker.log");
    const runner = new DockerContainerRunner();
    const task = await runner.createTaskContainer(PINNED_IMAGE, []);
    const auxiliary = await runner.createAuxiliaryContainer(PINNED_IMAGE);
    const removedEarly = await runner.createAuxiliaryContainer(PINNED_IMAGE);
    await runner.remove(removedEarly);
    expect(task.id).toBe("container-1");
    expect(auxiliary.id).toBe("container-2");

    await DockerContainerRunner.abortAll();

    const commands = await loggedCommands(log);
    const removals = commands.filter((line) => line.startsWith("rm -f "));
    // The explicit remove happened once, before the sweep; the sweep removed
    // exactly the two containers that were still live, in creation order,
    // and did not remove the already-removed one a second time.
    expect(removals).toEqual([
      `rm -f ${removedEarly.id}`,
      "rm -f container-1",
      "rm -f container-2",
    ]);

    // Once cleanup has started, the run paths cannot create new work that
    // the sweep would miss.
    await expect(runner.createTaskContainer(PINNED_IMAGE, [])).rejects.toThrow(
      /eval-executor is shutting down/u,
    );
    await expect(runner.createAuxiliaryContainer(PINNED_IMAGE)).rejects.toThrow(
      /eval-executor is shutting down/u,
    );
    expect((await loggedCommands(log)).filter((line) => line.startsWith("create "))).toHaveLength(3);

    // A repeated sweep has nothing left to remove.
    await DockerContainerRunner.abortAll();
    expect((await loggedCommands(log)).filter((line) => line.startsWith("rm -f "))).toHaveLength(3);
  });

  test("a container whose start fails is removed and never reappears in the sweep", async () => {
    const log = path.join(root, "docker.log");
    const bin = path.join(root, "bin", "docker");
    const failingStart = (await readFile(bin, "utf8")).replace(
      "  start|rm|network) ;;",
      "  start) echo 'daemon refused' >&2; exit 1 ;;\n  rm|network) ;;",
    );
    await writeFile(bin, failingStart, { mode: 0o755 });
    const runner = new DockerContainerRunner();

    await expect(runner.createTaskContainer(PINNED_IMAGE, [])).rejects.toThrow(
      /docker start failed/u,
    );
    await DockerContainerRunner.abortAll();

    const removals = (await loggedCommands(log)).filter((line) => line.startsWith("rm -f "));
    expect(removals).toEqual(["rm -f container-1"]);
  });
});
