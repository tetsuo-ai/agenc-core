/**
 * CPU and memory limits the session's commands run under.
 *
 * Inside a container, `nproc`, `os.cpus()` and /proc/meminfo report the host:
 * a Terminal-Bench task with a one-CPU cgroup quota saw 24 CPUs and ran 12 to
 * 24 training threads on one CPU. Linux states the real limits in cgroup v2
 * (`cpu.max`, `memory.max`) on the process's own cgroup and its ancestors, or
 * in the cgroup v1 controllers on the process's path in each controller
 * hierarchy and its ancestors, each path read as the hierarchy's mount shows
 * it (/proc/self/mountinfo: a container without its own cgroup namespace
 * sees its cgroup mounted as the root). Of the mounts of a hierarchy, the one
 * whose root is the longest ancestor of the path shows it; a bind mount of
 * another cgroup never stands in for the process's own. The environment note
 * carries them, and a session's end notice uses the cgroup `oom_kill` counter
 * to tell an out-of-memory kill from another SIGKILL.
 *
 * Other platforms report nothing: macOS has no per-process CPU or memory
 * quota, so the host numbers the model can read are the limits, and Windows
 * Job Object limits need a native query. Every read is best effort: a missing
 * or unreadable file means the limit is unknown, never zero.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";

const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup";
/** cgroup v1 reports "no limit" as a page-rounded maximum near 2^63. */
const CGROUP_V1_UNLIMITED_BYTES = 2 ** 60;

export interface CgroupReadOptions {
  /**
   * Root of the cgroup filesystem, each hierarchy mounted at its root; tests
   * point it at a fixture tree. Without it, /proc/self/mountinfo says where
   * each hierarchy is mounted and which of its directories the mount shows.
   */
  readonly cgroupRoot?: string;
  /** Contents of /proc/self/cgroup; read from the process when absent. */
  readonly procSelfCgroup?: string;
  /** Contents of /proc/self/mountinfo; read from the process when absent and no cgroupRoot is given. */
  readonly mountInfo?: string;
  readonly platform?: NodeJS.Platform;
  /** CPUs the OS reports (what nproc shows); `os.cpus().length` when absent. */
  readonly hostCpus?: number;
  /** Memory the OS reports; `os.totalmem()` when absent. */
  readonly hostMemoryBytes?: number;
}

export interface ResourceLimits {
  /** CPUs the cgroup quota allows, when below what the OS reports. */
  readonly cpuLimit?: number;
  /** The cgroup memory limit, when below what the OS reports. */
  readonly memoryLimitBytes?: number;
  readonly hostCpus: number;
  readonly hostMemoryBytes: number;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** A mounted cgroup hierarchy: where it is mounted and which of its directories the mount shows. */
interface CgroupMount {
  /** The hierarchy directory shown at the mount point ("/" unless a container mounts its own cgroup). */
  readonly root: string;
  readonly mountPoint: string;
  readonly version: 1 | 2;
  /** v1 controllers of the hierarchy (cpu, cpuacct, memory, ...). */
  readonly controllers: ReadonlySet<string>;
}

/** mountinfo escapes space, tab, newline and backslash as octal (`\040`). */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** The cgroup and cgroup2 mounts of /proc/self/mountinfo. */
function parseCgroupMounts(text: string): CgroupMount[] {
  const mounts: CgroupMount[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const fields = line.slice(0, separator).split(" ");
    const [fstype, , superOptions] = line.slice(separator + 3).split(" ");
    if ((fstype !== "cgroup" && fstype !== "cgroup2") || fields.length < 5) continue;
    mounts.push({
      root: unescapeMountField(fields[3]!),
      mountPoint: unescapeMountField(fields[4]!),
      version: fstype === "cgroup2" ? 2 : 1,
      controllers: new Set(fstype === "cgroup" ? (superOptions ?? "").split(",") : []),
    });
  }
  return mounts;
}

/** Hierarchies mounted at their roots under `root`: the v2 tree itself and the usual v1 controller folders. */
function rootedCgroupMounts(root: string, options: CgroupReadOptions): CgroupMount[] {
  const text = options.procSelfCgroup ?? readText("/proc/self/cgroup") ?? "";
  const listed = /^\d+:([^:]*\bcpu\b[^:]*):/mu.exec(text)?.[1];
  const names = [...new Set([...(listed !== undefined ? [listed] : []), "cpu,cpuacct", "cpuacct,cpu", "cpu", "memory"])];
  return [
    { root: "/", mountPoint: root, version: 2, controllers: new Set<string>() },
    ...names.filter((name) => existsSync(join(root, name)))
      .map((name): CgroupMount => ({ root: "/", mountPoint: join(root, name), version: 1, controllers: new Set(name.split(",")) })),
  ];
}

function cgroupMounts(options: CgroupReadOptions): CgroupMount[] {
  if (options.mountInfo === undefined && options.cgroupRoot !== undefined) {
    return rootedCgroupMounts(resolve(options.cgroupRoot), options);
  }
  const mounts = parseCgroupMounts(options.mountInfo ?? readText("/proc/self/mountinfo") ?? "");
  return mounts.length > 0 ? mounts : rootedCgroupMounts(resolve(options.cgroupRoot ?? DEFAULT_CGROUP_ROOT), options);
}

/** The hierarchy directory a mount shows, without trailing slashes ("" for the hierarchy root). */
function shownRoot(mount: CgroupMount): string {
  return mount.root.replace(/\/+$/u, "");
}

/** Whether `mount` shows the cgroup `membership`: its root is the membership or an ancestor of it. */
function showsMembership(mount: CgroupMount, membership: string): boolean {
  const shown = shownRoot(mount);
  return shown === "" || membership === shown || membership.startsWith(`${shown}/`);
}

/**
 * The mount that shows the cgroup `membership`: of the `candidates` whose
 * root is the membership or an ancestor of it, the one with the longest root
 * (the first listed on a tie). None when no candidate shows it, as with only
 * a bind mount of another cgroup: its limits are not the process's.
 */
function mountShowing(candidates: readonly CgroupMount[], membership: string): CgroupMount | undefined {
  let best: CgroupMount | undefined;
  for (const mount of candidates) {
    if (!showsMembership(mount, membership)) continue;
    if (best === undefined || shownRoot(mount).length > shownRoot(best).length) best = mount;
  }
  return best;
}

/**
 * The directory of the cgroup `membership` (a path in the whole hierarchy)
 * as `mount` shows it, or undefined when the mount does not show it or the
 * path would leave the mount.
 */
function membershipDirectory(mount: CgroupMount, membership: string): string | undefined {
  if (!membership.startsWith("/") || membership.includes("\0") || !showsMembership(mount, membership)) {
    return undefined;
  }
  const base = resolve(mount.mountPoint);
  const relative = membership.slice(shownRoot(mount).length) || "/";
  const directory = resolve(base, `.${relative}`);
  return directory === base || directory.startsWith(`${base}/`) ? directory : undefined;
}

interface OwnCgroupV2 {
  readonly directory: string;
  /** The mount point of the cgroup2 mount that shows the directory: the last directory whose limits apply. */
  readonly mountPoint: string;
}

/**
 * This process's cgroup v2 directory (`0::/path`) as the cgroup2 mount that
 * shows it presents it. Undefined on cgroup v1, outside Linux, when no mount
 * shows the path, or for a path that would leave the mount.
 */
function ownCgroupV2(options: CgroupReadOptions): OwnCgroupV2 | undefined {
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  const line = (options.procSelfCgroup ?? readText("/proc/self/cgroup"))
    ?.split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("0::"));
  if (line === undefined) return undefined;
  const membership = line.slice(3).trim();
  const mount = mountShowing(cgroupMounts(options).filter((candidate) => candidate.version === 2), membership);
  if (mount === undefined) return undefined;
  const directory = membershipDirectory(mount, membership);
  return directory === undefined ? undefined : { directory, mountPoint: resolve(mount.mountPoint) };
}

/**
 * The directory of this process's cgroup v2 membership (`0::/path`) as the
 * cgroup2 mount that shows it presents it, or undefined on cgroup v1, outside
 * Linux, when no mount shows the path, or for a path that would leave the mount.
 */
export function ownCgroupV2Directory(options: CgroupReadOptions = {}): string | undefined {
  return ownCgroupV2(options)?.directory;
}

/** `directory` and each ancestor up to and including `root`. */
function selfAndAncestors(directory: string, root: string): string[] {
  const chain: string[] = [];
  let current = directory;
  for (;;) {
    chain.push(current);
    if (current === root) return chain;
    const parent = dirname(current);
    if (parent === current || !parent.startsWith(root)) return chain;
    current = parent;
  }
}

/** `cpu.max` is "<quota> <period>" or "max <period>"; the quota in CPUs. */
function parseCpuMax(text: string | undefined): number | undefined {
  const match = /^\s*(\d+|max)\s+(\d+)\s*$/u.exec(text ?? "");
  if (match === null || match[1] === "max") return undefined;
  const quota = Number(match[1]);
  const period = Number(match[2]);
  return quota > 0 && period > 0 ? quota / period : undefined;
}

/** `memory.max` is a byte count or "max". */
function parseMemoryMax(text: string | undefined): number | undefined {
  const value = text?.trim();
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const bytes = Number(value);
  return bytes > 0 && bytes < CGROUP_V1_UNLIMITED_BYTES ? bytes : undefined;
}

function minDefined(values: readonly (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0 ? undefined : Math.min(...defined);
}

/** cgroup v1 memberships from /proc/self/cgroup (`id:controllers:path`): controller name to path. */
function cgroupV1Memberships(options: CgroupReadOptions): Map<string, string> {
  const memberships = new Map<string, string>();
  const text = options.procSelfCgroup ?? readText("/proc/self/cgroup");
  for (const line of text?.split(/\r?\n/u) ?? []) {
    const match = /^\d+:([^:]*):(.*)$/u.exec(line.trim());
    // The v2 line has no controllers; a named hierarchy (name=systemd) holds no limits.
    if (match === null || match[1]!.length === 0) continue;
    const path = match[2]!.trim();
    if (!path.startsWith("/") || path.includes("\0")) continue;
    for (const controller of match[1]!.split(",")) memberships.set(controller, path);
  }
  return memberships;
}

/**
 * The v1 directories whose limits apply to this process for `controller`,
 * leaf first: its path as the mount of the controller's hierarchy that shows
 * it presents it, then each ancestor up to the mount point. Without a listed
 * path, the first such mount point (a container's own cgroup); none when no
 * mount shows the path.
 */
function cgroupV1Directories(
  controller: string,
  mounts: readonly CgroupMount[],
  memberships: ReadonlyMap<string, string>,
): string[] {
  const candidates = mounts.filter((candidate) => candidate.version === 1 && candidate.controllers.has(controller));
  const membership = memberships.get(controller);
  if (membership === undefined) return candidates.length === 0 ? [] : [resolve(candidates[0]!.mountPoint)];
  const mount = mountShowing(candidates, membership);
  if (mount === undefined) return [];
  const leaf = membershipDirectory(mount, membership);
  return leaf === undefined ? [] : selfAndAncestors(leaf, resolve(mount.mountPoint));
}

/**
 * cgroup v1: the smallest CPU quota and memory limit on the process's path in
 * each controller hierarchy and its ancestors. A quota of -1 or an unlimited
 * memory value means no limit.
 */
function cgroupV1Limits(options: CgroupReadOptions): { readonly cpu?: number; readonly memory?: number } {
  const memberships = cgroupV1Memberships(options);
  const mounts = cgroupMounts(options);
  const cpu = minDefined(cgroupV1Directories("cpu", mounts, memberships)
    .map((directory) => {
      const quota = Number(readText(join(directory, "cpu.cfs_quota_us"))?.trim());
      const period = Number(readText(join(directory, "cpu.cfs_period_us"))?.trim());
      return Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0 ? quota / period : undefined;
    }));
  const memory = minDefined(cgroupV1Directories("memory", mounts, memberships)
    .map((directory) => parseMemoryMax(readText(join(directory, "memory.limit_in_bytes")))));
  return { ...(cpu !== undefined ? { cpu } : {}), ...(memory !== undefined ? { memory } : {}) };
}

/**
 * The CPU and memory limits that are stricter than what the OS reports. The
 * effective limit of a cgroup v2 path is the smallest one set on it or on any
 * ancestor. Outside Linux both are absent.
 */
export function readResourceLimits(options: CgroupReadOptions = {}): ResourceLimits {
  const hostCpus = options.hostCpus ?? Math.max(1, cpus().length);
  const hostMemoryBytes = options.hostMemoryBytes ?? totalmem();
  const unlimited: ResourceLimits = { hostCpus, hostMemoryBytes };
  if ((options.platform ?? process.platform) !== "linux") return unlimited;
  const own = ownCgroupV2(options);
  let cpu: number | undefined;
  let memory: number | undefined;
  if (own !== undefined) {
    const chain = selfAndAncestors(own.directory, own.mountPoint);
    cpu = minDefined(chain.map((directory) => parseCpuMax(readText(join(directory, "cpu.max")))));
    memory = minDefined(chain.map((directory) => parseMemoryMax(readText(join(directory, "memory.max")))));
  }
  // cgroup v1, or a hybrid hierarchy whose v2 part has no CPU or memory controller.
  if (cpu === undefined || memory === undefined) {
    const v1 = cgroupV1Limits(options);
    cpu ??= v1.cpu;
    memory ??= v1.memory;
  }
  return {
    ...unlimited,
    ...(cpu !== undefined && cpu < hostCpus ? { cpuLimit: cpu } : {}),
    ...(memory !== undefined && memory < hostMemoryBytes ? { memoryLimitBytes: memory } : {}),
  };
}

function formatCpus(count: number): string {
  const rounded = Math.round(count * 10) / 10;
  return `${rounded} CPU${rounded === 1 ? "" : "s"}`;
}

export function formatBytes(bytes: number): string {
  const gib = bytes / 2 ** 30;
  if (gib >= 1) return `${Math.round(gib * 10) / 10} GiB`;
  return `${Math.max(1, Math.round(bytes / 2 ** 20))} MiB`;
}

/**
 * One line for the environment note, or null when no limit is stricter than
 * what the OS reports (always null outside Linux).
 */
export function formatResourceLimitsLine(limits: ResourceLimits): string | null {
  const parts: string[] = [];
  const host: string[] = [];
  if (limits.cpuLimit !== undefined) {
    parts.push(formatCpus(limits.cpuLimit));
    host.push(`nproc shows ${limits.hostCpus}`);
  }
  if (limits.memoryLimitBytes !== undefined) {
    parts.push(`${formatBytes(limits.memoryLimitBytes)} memory`);
    host.push(`free shows ${formatBytes(limits.hostMemoryBytes)}`);
  }
  if (parts.length === 0) return null;
  return `Resource limits (cgroup): ${parts.join(", ")}; ${host.join(" and ")}. ` +
    "Size thread counts, parallel jobs and builds to these limits.";
}

let cachedLimitsLine: { readonly line: string | null } | undefined;

/**
 * The environment-note line for this process, read once: the limits of a
 * running container do not change, and a stable line keeps the prompt cache.
 */
export function resourceLimitsLine(): string | null {
  cachedLimitsLine ??= { line: formatResourceLimitsLine(readResourceLimits()) };
  return cachedLimitsLine.line;
}

/** Tests only: forget the cached line. */
export function resetResourceLimitsLineForTesting(): void {
  cachedLimitsLine = undefined;
}

/** Tests only: make {@link resourceLimitsLine} return `line` until reset. */
export function setResourceLimitsLineForTesting(line: string | null): void {
  cachedLimitsLine = { line };
}

/**
 * The cgroup's count of processes killed by the OOM killer: `oom_kill` in
 * cgroup v2 `memory.events` (hierarchical, so it covers every command's
 * private leaf below this process's cgroup), or in cgroup v1
 * `memory.oom_control` of the process's own memory cgroup (the nearest
 * directory on its path that exists, up to the mount point). Undefined
 * when unknown (outside Linux, at the cgroup v2 root, which has no
 * memory.events, or on an older kernel).
 */
export function readOomKillCount(options: CgroupReadOptions = {}): number | undefined {
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  const parse = (text: string | undefined): number | undefined => {
    const match = /(?:^|\n)oom_kill (\d+)(?:\n|$)/u.exec(text ?? "");
    return match === null ? undefined : Number(match[1]);
  };
  const own = ownCgroupV2Directory(options);
  if (own !== undefined) {
    const count = parse(readText(join(own, "memory.events")));
    if (count !== undefined) return count;
  }
  for (const directory of cgroupV1Directories("memory", cgroupMounts(options), cgroupV1Memberships(options))) {
    const count = parse(readText(join(directory, "memory.oom_control")));
    if (count !== undefined) return count;
  }
  return undefined;
}
