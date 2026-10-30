/**
 * CPU and memory limits the session's commands run under.
 *
 * Inside a container, `nproc`, `os.cpus()` and /proc/meminfo report the host:
 * a Terminal-Bench task with a one-CPU cgroup quota saw 24 CPUs and ran 12 to
 * 24 training threads on one CPU. Linux states the real limits in cgroup v2
 * (`cpu.max`, `memory.max`) on the process's own cgroup and its ancestors, or
 * in the cgroup v1 controllers. The environment note carries them, and a
 * session's end notice uses the cgroup `oom_kill` counter to tell an
 * out-of-memory kill from another SIGKILL.
 *
 * Other platforms report nothing: macOS has no per-process CPU or memory
 * quota, so the host numbers the model can read are the limits, and Windows
 * Job Object limits need a native query. Every read is best effort: a missing
 * or unreadable file means the limit is unknown, never zero.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";

const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup";
/** cgroup v1 reports "no limit" as a page-rounded maximum near 2^63. */
const CGROUP_V1_UNLIMITED_BYTES = 2 ** 60;

export interface CgroupReadOptions {
  /** Root of the cgroup filesystem; tests point it at a fixture tree. */
  readonly cgroupRoot?: string;
  /** Contents of /proc/self/cgroup; read from the process when absent. */
  readonly procSelfCgroup?: string;
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

/**
 * The directory of this process's cgroup v2 membership (`0::/path`) under
 * `root`, or undefined on cgroup v1, outside Linux, or for a path that would
 * leave the root.
 */
export function ownCgroupV2Directory(options: CgroupReadOptions = {}): string | undefined {
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  const membership = (options.procSelfCgroup ?? readText("/proc/self/cgroup"))
    ?.split(/\r?\n/u)
    .find((line) => line.startsWith("0::"));
  if (membership === undefined) return undefined;
  const relative = membership.slice(3).trim();
  if (!relative.startsWith("/") || relative.includes("\0")) return undefined;
  const root = resolve(options.cgroupRoot ?? DEFAULT_CGROUP_ROOT);
  const directory = resolve(root, `.${relative}`);
  if (directory !== root && !directory.startsWith(`${root}/`)) return undefined;
  return directory;
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

/** cgroup v1: a quota of -1 or an unlimited memory value means no limit. */
function cgroupV1Limits(root: string): { readonly cpu?: number; readonly memory?: number } {
  const cpuDirectory = ["cpu,cpuacct", "cpu"]
    .map((name) => join(root, name))
    .find((path) => readText(join(path, "cpu.cfs_quota_us")) !== undefined);
  let cpu: number | undefined;
  if (cpuDirectory !== undefined) {
    const quota = Number(readText(join(cpuDirectory, "cpu.cfs_quota_us"))?.trim());
    const period = Number(readText(join(cpuDirectory, "cpu.cfs_period_us"))?.trim());
    if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
      cpu = quota / period;
    }
  }
  const memory = parseMemoryMax(readText(join(root, "memory", "memory.limit_in_bytes")));
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
  const root = resolve(options.cgroupRoot ?? DEFAULT_CGROUP_ROOT);
  const own = ownCgroupV2Directory(options);
  let cpu: number | undefined;
  let memory: number | undefined;
  if (own !== undefined) {
    const chain = selfAndAncestors(own, root);
    cpu = minDefined(chain.map((directory) => parseCpuMax(readText(join(directory, "cpu.max")))));
    memory = minDefined(chain.map((directory) => parseMemoryMax(readText(join(directory, "memory.max")))));
  } else {
    const v1 = cgroupV1Limits(root);
    cpu = v1.cpu;
    memory = v1.memory;
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
 * `memory.oom_control`. Undefined when unknown (outside Linux, at the cgroup
 * v2 root, which has no memory.events, or on an older kernel).
 */
export function readOomKillCount(options: CgroupReadOptions = {}): number | undefined {
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  const root = resolve(options.cgroupRoot ?? DEFAULT_CGROUP_ROOT);
  const own = ownCgroupV2Directory(options);
  const text = own !== undefined
    ? readText(join(own, "memory.events"))
    : readText(join(root, "memory", "memory.oom_control"));
  const match = /(?:^|\n)oom_kill (\d+)(?:\n|$)/u.exec(text ?? "");
  return match === null ? undefined : Number(match[1]);
}
