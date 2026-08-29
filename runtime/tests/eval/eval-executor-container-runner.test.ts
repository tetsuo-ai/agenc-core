import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DockerContainerRunner } from "../../src/eval-executor/container-runner.js";
import { buildEgressNetworkPlan } from "../../src/eval-executor/egress.js";

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
    "  logs) echo AGENC_PROXY_READY ;;",
    "  inspect) echo true ;;",
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
    const task = await runner.createTaskContainer(PINNED_IMAGE, {});
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
    await expect(runner.createTaskContainer(PINNED_IMAGE, {})).rejects.toThrow(
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

  test("abortAll removes a live egress lane's containers before its networks", async () => {
    const log = path.join(root, "docker.log");
    const runner = new DockerContainerRunner();
    const plan = buildEgressNetworkPlan("test-run", 42);
    await runner.createEgressLane({
      runId: "test-run",
      subnetOctet: 42,
      taskImage: PINNED_IMAGE,
      overlayHostDir: "/tmp/agenc-overlay",
      allowHost: "api.example.com",
      allowPort: 443,
      pinIps: ["203.0.113.5"],
      proxyListenPort: 3128,
    });

    await DockerContainerRunner.abortAll();

    const commands = await loggedCommands(log);
    expect(commands.filter((line) => line.startsWith("network create"))).toHaveLength(2);
    // Containers detach first; a network with attached containers cannot be
    // removed. The sidecar is created before the agent.
    expect(
      commands.filter((line) => line.startsWith("rm -f ") || line.startsWith("network rm ")),
    ).toEqual([
      "rm -f container-1",
      "rm -f container-2",
      `network rm ${plan.egressNetName}`,
      `network rm ${plan.upstreamNetName}`,
    ]);
  });

  test("abortAll waits for a create that passed the shutdown check before sweeping", async () => {
    const log = path.join(root, "docker.log");
    const bin = path.join(root, "bin", "docker");
    // The fake daemon takes a moment to answer `create`, so the create is in
    // flight when the sweep starts and nothing is live yet.
    const slowCreate = (await readFile(bin, "utf8")).replace(
      "  create) echo",
      "  create) sleep 1; echo",
    );
    await writeFile(bin, slowCreate, { mode: 0o755 });
    const runner = new DockerContainerRunner();

    const pending = runner.createTaskContainer(PINNED_IMAGE, {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    await DockerContainerRunner.abortAll();
    await expect(pending).resolves.toMatchObject({ id: "container-1" });

    // The sweep found nothing on its first pass, waited for the create, then
    // removed what it produced.
    const removals = (await loggedCommands(log)).filter((line) => line.startsWith("rm -f "));
    expect(removals).toEqual(["rm -f container-1"]);
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

    await expect(runner.createTaskContainer(PINNED_IMAGE, {})).rejects.toThrow(
      /docker start failed/u,
    );
    await DockerContainerRunner.abortAll();

    const removals = (await loggedCommands(log)).filter((line) => line.startsWith("rm -f "));
    expect(removals).toEqual(["rm -f container-1"]);
  });
});
