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
      "Resource limits (cgroup): 1 CPU, 4 GiB memory; nproc/free can show host totals.",
    );
  });

  test("reads a container's own namespace root and fractional quotas", () => {
    write("cpu.max", "150000 100000\n");
    write("memory.max", `${512 * 2 ** 20}\n`);
    const limits = readResourceLimits({ ...host, cgroupRoot: root, procSelfCgroup: "0::/\n" });
    expect(formatResourceLimitsLine(limits)).toBe(
      "Resource limits (cgroup): 1.5 CPUs, 512 MiB memory; nproc/free can show host totals.",
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
  const v1Membership = "12:memory:/docker/x\n4:cpu,cpuacct:/docker/x\n1:name=systemd:/docker/x\n";

  test("reads the v1 controllers on the process's own path: the host view, limits on the leaf", () => {
    write("cpu,cpuacct/cpu.cfs_quota_us", "-1\n");
    write("cpu,cpuacct/cpu.cfs_period_us", "100000\n");
    write("cpu,cpuacct/docker/x/cpu.cfs_quota_us", "100000\n");
    write("cpu,cpuacct/docker/x/cpu.cfs_period_us", "100000\n");
    write("memory/memory.limit_in_bytes", "9223372036854771712\n");
    write("memory/memory.oom_control", "oom_kill_disable 0\nunder_oom 0\noom_kill 0\n");
    write("memory/docker/x/memory.limit_in_bytes", `${2 * GIB}\n`);
    write("memory/docker/x/memory.oom_control", "oom_kill_disable 0\nunder_oom 0\noom_kill 7\n");
    const options = { ...host, cgroupRoot: root, procSelfCgroup: v1Membership };
    expect(readResourceLimits(options)).toMatchObject({ cpuLimit: 1, memoryLimitBytes: 2 * GIB });
    expect(readOomKillCount(options)).toBe(7);
  });

  test("takes the strictest v1 limit on the path and its ancestors", () => {
    write("cpu,cpuacct/docker/cpu.cfs_quota_us", "200000\n");
    write("cpu,cpuacct/docker/cpu.cfs_period_us", "100000\n");
    write("cpu,cpuacct/docker/x/cpu.cfs_quota_us", "-1\n");
    write("cpu,cpuacct/docker/x/cpu.cfs_period_us", "100000\n");
    write("memory/docker/memory.limit_in_bytes", `${8 * GIB}\n`);
    write("memory/docker/x/memory.limit_in_bytes", `${3 * GIB}\n`);
    expect(readResourceLimits({ ...host, cgroupRoot: root, procSelfCgroup: v1Membership }))
      .toMatchObject({ cpuLimit: 2, memoryLimitBytes: 3 * GIB });
  });

  test("reads the controller root when it is the container's own cgroup (the path does not exist inside)", () => {
    write("cpu,cpuacct/cpu.cfs_quota_us", "200000\n");
    write("cpu,cpuacct/cpu.cfs_period_us", "100000\n");
    write("memory/memory.limit_in_bytes", `${2 * GIB}\n`);
    write("memory/memory.oom_control", "oom_kill_disable 0\nunder_oom 0\noom_kill 7\n");
    const options = { ...host, cgroupRoot: root, procSelfCgroup: v1Membership };
    expect(readResourceLimits(options)).toMatchObject({ cpuLimit: 2, memoryLimitBytes: 2 * GIB });
    expect(readOomKillCount(options)).toBe(7);
  });

  test("falls back to the v1 controllers when the v2 path holds no limit (hybrid hierarchy)", () => {
    write("cpu/docker/x/cpu.cfs_quota_us", "50000\n");
    write("cpu/docker/x/cpu.cfs_period_us", "100000\n");
    write("memory/docker/x/memory.limit_in_bytes", `${GIB}\n`);
    const options = { ...host, cgroupRoot: root, procSelfCgroup: `${v1Membership.replace("cpu,cpuacct", "cpu")}0::/docker/x\n` };
    expect(readResourceLimits(options)).toMatchObject({ cpuLimit: 0.5, memoryLimitBytes: GIB });
  });

  test("treats v1 unlimited values as no limit", () => {
    write("cpu/cpu.cfs_quota_us", "-1\n");
    write("cpu/cpu.cfs_period_us", "100000\n");
    write("memory/memory.limit_in_bytes", "9223372036854771712\n");
    expect(readResourceLimits({ ...host, cgroupRoot: root, procSelfCgroup: "" }))
      .toEqual({ hostCpus: 24, hostMemoryBytes: 32 * GIB });
  });

  // A container without its own cgroup namespace sees its cgroup mounted as the
  // hierarchy root: /proc/self/mountinfo names that root (/docker/container),
  // and the membership /docker/container/worker is memory/worker below it.
  test("resolves v1 membership against each mount's root from mountinfo", () => {
    write("memory/memory.limit_in_bytes", "9223372036854771712\n");
    write("memory/memory.oom_control", "oom_kill_disable 0\nunder_oom 0\noom_kill 0\n");
    write("memory/worker/memory.limit_in_bytes", `${GIB}\n`);
    write("memory/worker/memory.oom_control", "oom_kill_disable 0\nunder_oom 0\noom_kill 3\n");
    write("cpu,cpuacct/cpu.cfs_quota_us", "-1\n");
    write("cpu,cpuacct/cpu.cfs_period_us", "100000\n");
    write("cpu,cpuacct/worker/cpu.cfs_quota_us", "50000\n");
    write("cpu,cpuacct/worker/cpu.cfs_period_us", "100000\n");
    const mountInfo = [
      `30 25 0:26 /docker/container ${root}/memory rw,nosuid,nodev,noexec,relatime master:11 - cgroup cgroup rw,memory`,
      `31 25 0:27 /docker/container ${root}/cpu,cpuacct rw,nosuid,nodev,noexec,relatime master:12 - cgroup cgroup rw,cpu,cpuacct`,
      `32 25 0:28 /docker/container ${root}/systemd rw,nosuid,nodev,noexec,relatime master:13 - cgroup cgroup rw,xattr,name=systemd`,
      "33 25 8:1 / /etc/hosts rw,relatime - ext4 /dev/sda1 rw",
    ].join("\n");
    const options = {
      ...host, mountInfo,
      procSelfCgroup: "12:memory:/docker/container/worker\n4:cpu,cpuacct:/docker/container/worker\n1:name=systemd:/docker/container/worker\n",
    };
    expect(readResourceLimits(options)).toMatchObject({ cpuLimit: 0.5, memoryLimitBytes: GIB });
    expect(readOomKillCount(options)).toBe(3);
  });

  test("resolves v2 membership against the cgroup2 mount's root, and decodes mountinfo escapes", () => {
    write("c 1/cpu.max", "max 100000\n");
    write("c 1/app/cpu.max", "100000 100000\n");
    write("c 1/app/memory.max", `${2 * GIB}\n`);
    write("c 1/app/memory.events", "low 0\nhigh 0\nmax 1\noom 4\noom_kill 4\n");
    const mountInfo = `40 25 0:30 /lxc/c1 ${root.replaceAll(" ", "\\040")}/c\\0401 rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup2 rw`;
    const options = { ...host, mountInfo, procSelfCgroup: "0::/lxc/c1/app\n" };
    expect(ownCgroupV2Directory(options)).toBe(join(root, "c 1/app"));
    expect(readResourceLimits(options)).toMatchObject({ cpuLimit: 1, memoryLimitBytes: 2 * GIB });
    expect(readOomKillCount(options)).toBe(4);
  });

  // A hierarchy can be mounted more than once: a bind mount of another cgroup
  // (/sibling) listed before the whole hierarchy must not stand in for the
  // process's own cgroup (/current). Of the mounts whose root is the path or an
  // ancestor of it, the one with the longest root shows it.
  const mountLine = (id: number, mountRoot: string, mountPoint: string, type: "cgroup" | "cgroup2", options = "rw") =>
    `${id} 25 0:${id} ${mountRoot} ${join(root, mountPoint)} rw,relatime - ${type} ${type} ${options}`;

  test("ignores a cgroup2 bind mount of another cgroup listed before the whole hierarchy", () => {
    write("sibling/cpu.max", "25000 100000\n");
    write("sibling/memory.max", `${GIB / 2}\n`);
    write("sibling/memory.events", "oom 9\noom_kill 9\n");
    write("full/current/cpu.max", "50000 100000\n");
    write("full/current/memory.max", `${GIB}\n`);
    write("full/current/memory.events", "oom 2\noom_kill 2\n");
    const mountInfo = [mountLine(41, "/sibling", "sibling", "cgroup2"), mountLine(42, "/", "full", "cgroup2")]
      .join("\n");
    const options = { ...host, mountInfo, procSelfCgroup: "0::/current\n" };
    expect(ownCgroupV2Directory(options)).toBe(join(root, "full/current"));
    expect(readResourceLimits(options)).toMatchObject({ cpuLimit: 0.5, memoryLimitBytes: GIB });
    expect(readOomKillCount(options)).toBe(2);
  });

  test("ignores v1 bind mounts of another cgroup listed before the whole hierarchies", () => {
    write("sibling-cpu/cpu.cfs_quota_us", "25000\n");
    write("sibling-cpu/cpu.cfs_period_us", "100000\n");
    write("sibling-memory/memory.limit_in_bytes", `${GIB / 2}\n`);
    write("sibling-memory/memory.oom_control", "oom_kill_disable 0\nunder_oom 0\noom_kill 9\n");
    write("cpu,cpuacct/current/cpu.cfs_quota_us", "50000\n");
    write("cpu,cpuacct/current/cpu.cfs_period_us", "100000\n");
    write("memory/current/memory.limit_in_bytes", `${GIB}\n`);
    write("memory/current/memory.oom_control", "oom_kill_disable 0\nunder_oom 0\noom_kill 2\n");
    const mountInfo = [
      mountLine(30, "/sibling", "sibling-memory", "cgroup", "rw,memory"),
      mountLine(31, "/sibling", "sibling-cpu", "cgroup", "rw,cpu,cpuacct"),
      mountLine(32, "/", "memory", "cgroup", "rw,memory"),
      mountLine(33, "/", "cpu,cpuacct", "cgroup", "rw,cpu,cpuacct"),
    ].join("\n");
    const options = { ...host, mountInfo, procSelfCgroup: "12:memory:/current\n4:cpu,cpuacct:/current\n" };
    expect(readResourceLimits(options)).toMatchObject({ cpuLimit: 0.5, memoryLimitBytes: GIB });
    expect(readOomKillCount(options)).toBe(2);
  });

  test("takes the cgroup2 mount with the longest root that holds the path", () => {
    // The whole hierarchy is listed first; the container's own cgroup is mounted too.
    write("host/docker/c1/app/memory.max", `${3 * GIB}\n`);
    write("ctr/cpu.max", "100000 100000\n"); // 1 CPU on /docker/c1, an ancestor up to the mount point
    write("ctr/app/memory.max", `${GIB}\n`);
    const mountInfo = [mountLine(41, "/", "host", "cgroup2"), mountLine(42, "/docker/c1", "ctr", "cgroup2")]
      .join("\n");
    const options = { ...host, mountInfo, procSelfCgroup: "0::/docker/c1/app\n" };
    expect(ownCgroupV2Directory(options)).toBe(join(root, "ctr/app"));
    expect(readResourceLimits(options)).toMatchObject({ cpuLimit: 1, memoryLimitBytes: GIB });
  });

  test("takes the v1 mount with the longest root that holds the path, on whole path segments", () => {
    write("memory-all/docker/c1/app/memory.limit_in_bytes", `${3 * GIB}\n`);
    write("memory-c1/app/memory.limit_in_bytes", `${GIB}\n`);
    write("memory-all/docker/c10/app/memory.limit_in_bytes", `${2 * GIB}\n`);
    const mountInfo = [
      mountLine(30, "/docker/c1", "memory-c1", "cgroup", "rw,memory"),
      mountLine(31, "/", "memory-all", "cgroup", "rw,memory"),
    ].join("\n");
    // /docker/c1/app: both mounts hold it, /docker/c1 is the longer root.
    expect(readResourceLimits({ ...host, mountInfo, procSelfCgroup: "12:memory:/docker/c1/app\n" }))
      .toMatchObject({ memoryLimitBytes: GIB });
    // /docker/c10/app: /docker/c1 is a string prefix but not an ancestor, so only the whole hierarchy holds it.
    expect(readResourceLimits({ ...host, mountInfo, procSelfCgroup: "12:memory:/docker/c10/app\n" }))
      .toMatchObject({ memoryLimitBytes: 2 * GIB });
  });

  test("reports no limit when only a bind mount of another cgroup is mounted", () => {
    write("sibling/cpu.max", "25000 100000\n");
    write("sibling/memory.max", `${GIB / 2}\n`);
    write("sibling/memory.events", "oom 9\noom_kill 9\n");
    write("sibling-memory/memory.limit_in_bytes", `${GIB / 2}\n`);
    write("sibling-memory/memory.oom_control", "oom_kill_disable 0\nunder_oom 0\noom_kill 9\n");
    const v2 = { ...host, mountInfo: mountLine(41, "/sibling", "sibling", "cgroup2"), procSelfCgroup: "0::/current\n" };
    expect(ownCgroupV2Directory(v2)).toBeUndefined();
    expect(readResourceLimits(v2)).toEqual({ hostCpus: 24, hostMemoryBytes: 32 * GIB });
    expect(readOomKillCount(v2)).toBeUndefined();
    const v1 = {
      ...host,
      mountInfo: mountLine(30, "/sibling", "sibling-memory", "cgroup", "rw,memory"),
      procSelfCgroup: "12:memory:/current\n",
    };
    expect(readResourceLimits(v1)).toEqual({ hostCpus: 24, hostMemoryBytes: 32 * GIB });
    expect(readOomKillCount(v1)).toBeUndefined();
  });

  test.each(["darwin", "win32"] as const)("reports nothing on %s", (platform) => {
    write("cpu.max", "100000 100000\n");
    const options = { ...host, platform, cgroupRoot: root, procSelfCgroup: "0::/\n" };
    expect(formatResourceLimitsLine(readResourceLimits(options))).toBeNull();
    expect(readOomKillCount(options)).toBeUndefined();
  });
});

describe("environment note", () => {
  test.each([
    { cpuLimit: 1.5, facts: ["1.5 CPUs", "nproc"] },
    { memoryLimitBytes: 512 * 2 ** 20, facts: ["512 MiB memory", "free"] },
    { cpuLimit: 2, memoryLimitBytes: 6 * GIB, facts: ["2 CPUs", "6 GiB memory", "nproc", "free"] },
  ])("keeps quota facts in a compact, host-independent prompt: $facts", ({ facts, ...quota }) => {
    const line = formatResourceLimitsLine({ ...host, ...quota });
    expect(line).not.toBeNull();
    for (const fact of facts) expect(line).toContain(fact);
    expect(line).toContain("cgroup");
    // Repeated on every model call; host capacity is not the usable quota.
    expect(line!.length).toBeLessThanOrEqual(100);
    expect(formatResourceLimitsLine({ ...host, ...quota, hostCpus: 96, hostMemoryBytes: 512 * GIB })).toBe(line);
    expect(line).toContain("host");
  });

  test("carries the limits line when a limit applies and nothing otherwise", () => {
    const line = "Resource limits (cgroup): 1 CPU, 4 GiB memory; nproc/free can show host totals.";
    setResourceLimitsLineForTesting(line);
    expect(buildEnvInfoSection({ model: "deepseek-flash", cwd: root })).toContain(line);
    setResourceLimitsLineForTesting(null);
    expect(buildEnvInfoSection({ model: "deepseek-flash", cwd: root })).not.toContain("Resource limits");
  });
});
