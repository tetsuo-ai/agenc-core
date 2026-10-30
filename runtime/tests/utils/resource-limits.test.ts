import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  formatResourceLimitsLine,
  ownCgroupV2Directory,
  readOomKillCount,
  readResourceLimits,
  resetResourceLimitsLineForTesting,
  setResourceLimitsLineForTesting,
} from "../../src/utils/resource-limits.js";
import { buildEnvInfoSection } from "../../src/prompts/system-prompt.js";

// The environment note states the cgroup CPU and memory limits, because
// nproc and free report the host. Terminal-Bench train-fasttext (AgenC
// 0.19.19) ran 12 to 24 training threads on a one-CPU quota: nproc said 24.

const GIB = 2 ** 30;
let root: string;

function write(relative: string, text: string): void {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cgroup-fixture-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetResourceLimitsLineForTesting();
});

const host = { platform: "linux" as const, hostCpus: 24, hostMemoryBytes: 32 * GIB };

describe("cgroup v2", () => {
  test("takes the strictest limit on the process's cgroup path", () => {
    write("cpu.max", "max 100000\n");
    write("memory.max", "max\n");
    write("docker/cpu.max", "100000 100000\n"); // 1 CPU on the parent
    write("docker/abc/cpu.max", "max 100000\n");
    write("docker/abc/memory.max", `${4 * GIB}\n`);
    const options = { ...host, cgroupRoot: root, procSelfCgroup: "0::/docker/abc\n" };
    expect(ownCgroupV2Directory(options)).toBe(join(root, "docker/abc"));
    const limits = readResourceLimits(options);
    expect(limits).toEqual({ cpuLimit: 1, memoryLimitBytes: 4 * GIB, hostCpus: 24, hostMemoryBytes: 32 * GIB });
    expect(formatResourceLimitsLine(limits)).toBe(
      "Resource limits (cgroup): 1 CPU, 4 GiB memory; nproc shows 24 and free shows 32 GiB. " +
        "Size thread counts, parallel jobs and builds to these limits.",
    );
  });

  test("reads a container's own namespace root and fractional quotas", () => {
    write("cpu.max", "150000 100000\n");
    write("memory.max", `${512 * 2 ** 20}\n`);
    const limits = readResourceLimits({ ...host, cgroupRoot: root, procSelfCgroup: "0::/\n" });
    expect(formatResourceLimitsLine(limits)).toBe(
      "Resource limits (cgroup): 1.5 CPUs, 512 MiB memory; nproc shows 24 and free shows 32 GiB. " +
        "Size thread counts, parallel jobs and builds to these limits.",
    );
  });

  test("says nothing when no limit is stricter than the host", () => {
    write("cpu.max", "max 100000\n");
    write("memory.max", "max\n");
    write("big/cpu.max", "6400000 100000\n"); // 64 CPUs on a 24-CPU host
    const limits = readResourceLimits({ ...host, cgroupRoot: root, procSelfCgroup: "0::/big\n" });
    expect(limits).toEqual({ hostCpus: 24, hostMemoryBytes: 32 * GIB });
    expect(formatResourceLimitsLine(limits)).toBeNull();
  });

  test("never leaves the cgroup root and ignores malformed membership", () => {
    expect(ownCgroupV2Directory({ ...host, cgroupRoot: root, procSelfCgroup: "0::/../../etc\n" })).toBeUndefined();
    expect(ownCgroupV2Directory({ ...host, cgroupRoot: root, procSelfCgroup: "0::relative\n" })).toBeUndefined();
    expect(ownCgroupV2Directory({ ...host, cgroupRoot: root, procSelfCgroup: "12:cpu:/x\n" })).toBeUndefined();
  });

  test("counts OOM kills from memory.events", () => {
    write("pod/memory.events", "low 0\nhigh 0\nmax 12\noom 3\noom_kill 2\noom_group_kill 0\n");
    expect(readOomKillCount({ ...host, cgroupRoot: root, procSelfCgroup: "0::/pod\n" })).toBe(2);
    expect(readOomKillCount({ ...host, cgroupRoot: root, procSelfCgroup: "0::/missing\n" })).toBeUndefined();
  });
});

describe("cgroup v1 and other platforms", () => {
  test("reads the v1 CPU and memory controllers", () => {
    write("cpu,cpuacct/cpu.cfs_quota_us", "200000\n");
    write("cpu,cpuacct/cpu.cfs_period_us", "100000\n");
    write("memory/memory.limit_in_bytes", `${2 * GIB}\n`);
    write("memory/memory.oom_control", "oom_kill_disable 0\nunder_oom 0\noom_kill 7\n");
    const options = { ...host, cgroupRoot: root, procSelfCgroup: "4:memory:/docker/x\n" };
    expect(readResourceLimits(options)).toMatchObject({ cpuLimit: 2, memoryLimitBytes: 2 * GIB });
    expect(readOomKillCount(options)).toBe(7);
  });

  test("treats v1 unlimited values as no limit", () => {
    write("cpu/cpu.cfs_quota_us", "-1\n");
    write("cpu/cpu.cfs_period_us", "100000\n");
    write("memory/memory.limit_in_bytes", "9223372036854771712\n");
    expect(readResourceLimits({ ...host, cgroupRoot: root, procSelfCgroup: "" }))
      .toEqual({ hostCpus: 24, hostMemoryBytes: 32 * GIB });
  });

  test.each(["darwin", "win32"] as const)("reports nothing on %s", (platform) => {
    write("cpu.max", "100000 100000\n");
    const options = { ...host, platform, cgroupRoot: root, procSelfCgroup: "0::/\n" };
    expect(formatResourceLimitsLine(readResourceLimits(options))).toBeNull();
    expect(readOomKillCount(options)).toBeUndefined();
  });
});

describe("environment note", () => {
  test("carries the limits line when a limit applies and nothing otherwise", () => {
    const line = "Resource limits (cgroup): 1 CPU, 4 GiB memory; nproc shows 24 and free shows 32 GiB. " +
      "Size thread counts, parallel jobs and builds to these limits.";
    setResourceLimitsLineForTesting(line);
    expect(buildEnvInfoSection({ model: "deepseek-flash", cwd: root })).toContain(line);
    setResourceLimitsLineForTesting(null);
    expect(buildEnvInfoSection({ model: "deepseek-flash", cwd: root })).not.toContain("Resource limits");
  });
});
