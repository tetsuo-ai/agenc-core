import { readFileSync } from "node:fs";
import { posix } from "node:path";

export interface DaemonMemoryEvidence {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly maxRssKb: number;
  readonly cgroup?: Readonly<Record<string, number>>;
}

/** Numeric cgroup counters only. Never persist paths, environment or cmdline. */
export function readCgroupMemoryEvidence(
  read: (path: string) => string = path => readFileSync(path, "utf8"),
): Readonly<Record<string, number>> | undefined {
  try {
    const entry = read("/proc/self/cgroup").split("\n").find(line => line.startsWith("0::"));
    if (!entry) return undefined;
    const relative = posix.normalize("/" + entry.slice(3));
    const roots = [...new Set([`/sys/fs/cgroup${relative === "/" ? "" : relative}`, "/sys/fs/cgroup"])];
    for (const root of roots) {
      const result: Record<string, number> = {};
      const numeric = (key: string, text: string): void => {
        const value = Number(text.trim());
        if (/^\d+$/.test(text.trim()) && Number.isSafeInteger(value) && value >= 0) result[key] = value;
      };
      for (const [file, key] of [["memory.current", "currentBytes"], ["memory.max", "limitBytes"], ["memory.peak", "peakBytes"]]) {
        try { numeric(key!, read(`${root}/${file}`)); } catch { /* unavailable on this kernel */ }
      }
      try {
        for (const line of read(`${root}/memory.events`).split("\n")) {
          const [key, value] = line.trim().split(/\s+/);
          if (key && value && ["oom", "oom_kill", "oom_group_kill", "high", "max"].includes(key)) numeric(key, value);
        }
      } catch { /* cgroup v2 may be unavailable */ }
      if (Object.keys(result).length > 0) return result;
    }
  } catch { /* non-Linux or inaccessible procfs */ }
  return undefined;
}

export function daemonMemoryEvidence(): DaemonMemoryEvidence {
  const memory = process.memoryUsage();
  const cgroup = process.platform === "linux" ? readCgroupMemoryEvidence() : undefined;
  return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
    maxRssKb: process.resourceUsage().maxRSS, ...(cgroup ? { cgroup } : {}) };
}
