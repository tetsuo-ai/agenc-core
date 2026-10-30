/**
 * What a quiet session's processes are doing.
 *
 * A poll that returns no output looks the same whether the command is
 * computing, blocked, or already dead behind a pipe that stays open. On
 * Terminal-Bench a model polled `python3 analysis.py 2>&1 | tail -40` for
 * 1240 s after the python parent had been killed, and another read
 * `wall_time=521s` as "finished" while its training ran starved on one CPU.
 * When a session has printed nothing for a while, its poll result carries
 * one line with the state and CPU time of the session's processes, the CPU
 * used since the previous check, and members that exited since then.
 *
 * Membership is the session root, every process in its process group, and
 * their descendants: contained commands run as their own process group
 * (Darwin gate, Linux cgroup leaf), and orphans reparented away from a dead
 * parent keep that group. Linux reads /proc; Darwin reads `ps`; other
 * platforms report nothing. Sampling is observation only: it never signals
 * or adopts a process, and it is no part of any cleanup proof.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type ProcessRunState = "running" | "sleeping" | "blocked" | "stopped" | "zombie";

export interface ProcessSample {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly state: ProcessRunState;
  readonly cpuSeconds: number;
  /** Start identity, so a reused pid is never taken for the same process. */
  readonly startToken: string;
  /** Program and first argument, e.g. "python3 train.py". */
  readonly label: string;
}

export type ProcessTable = ReadonlyMap<number, ProcessSample>;

/** USER_HZ: the unit of /proc/<pid>/stat CPU times on every Linux ABI Node supports. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;
const MAX_TABLE_RECORDS = 8192;
const PS_TIMEOUT_MS = 2_000;
const LABEL_LIMIT = 48;

function linuxState(code: string): ProcessRunState | undefined {
  switch (code) {
    case "R": return "running";
    case "S": case "I": return "sleeping";
    case "D": return "blocked";
    case "T": case "t": return "stopped";
    case "Z": case "X": case "x": return "zombie";
    default: return undefined;
  }
}

function darwinState(code: string): ProcessRunState | undefined {
  switch (code[0]) {
    case "R": return "running";
    case "S": case "I": return "sleeping";
    case "U": case "D": return "blocked";
    case "T": return "stopped";
    case "Z": return "zombie";
    default: return undefined;
  }
}

/** "python3 /tmp/exp.py A" for argv ["python3", "/tmp/exp.py", "A"]: program basename plus arguments, bounded. */
export function processLabel(argv: readonly string[]): string {
  const [program, ...args] = argv.filter((part) => part.length > 0);
  if (program === undefined) return "?";
  const text = [basename(program), ...args].join(" ").replace(/\s+/gu, " ").trim();
  return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT - 3)}...` : text;
}

function readLinuxProcessTable(): ProcessTable | undefined {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return undefined;
  }
  const table = new Map<number, ProcessSample>();
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    if (table.size >= MAX_TABLE_RECORDS) break;
    let stat: string;
    try {
      stat = readFileSync(join("/proc", entry, "stat"), "utf8");
    } catch {
      continue;
    }
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    if (open < 0 || close < open) continue;
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    const state = linuxState(fields[0] ?? "");
    const pid = Number(entry);
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const start = fields[19];
    if (state === undefined || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) ||
        !Number.isFinite(utime) || !Number.isFinite(stime) || start === undefined) continue;
    table.set(pid, {
      pid, ppid, pgid, state,
      cpuSeconds: (utime + stime) / LINUX_CLOCK_TICKS_PER_SECOND,
      startToken: `linux:${start}`,
      label: stat.slice(open + 1, close),
    });
  }
  return table;
}

/** Full argv of the selected Linux processes; the stat name is at most 15 characters. */
function withLinuxCommandLines(samples: readonly ProcessSample[]): ProcessSample[] {
  return samples.map((sample) => {
    try {
      const argv = readFileSync(join("/proc", String(sample.pid), "cmdline"), "utf8").split("\0");
      return argv.some((part) => part.length > 0) ? { ...sample, label: processLabel(argv) } : sample;
    } catch {
      return sample;
    }
  });
}

/** ps cputime: [[dd-]hh:]mm:ss[.ss], minutes may exceed 59 on Darwin. */
export function parsePsCpuTime(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(text.trim());
  if (match === null) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/**
 * `ps -axo pid=,ppid=,pgid=,state=,time=,lstart=,args=` lines. lstart is
 * five words ("Fri Oct 30 00:33:17 2026"); args, last, may hold spaces.
 */
export function parsePsProcessTable(text: string): ProcessTable {
  const table = new Map<number, ProcessSample>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const state = darwinState(match[4]!);
    const cpuSeconds = parsePsCpuTime(match[5]!);
    if (state === undefined || cpuSeconds === undefined) continue;
    const pid = Number(match[1]);
    table.set(pid, {
      pid, ppid: Number(match[2]), pgid: Number(match[3]), state, cpuSeconds,
      startToken: `ps:${match[6]!}`,
      label: processLabel(match[7]!.trim().split(/\s+/u)),
    });
    if (table.size >= MAX_TABLE_RECORDS) break;
  }
  return table;
}

function readDarwinProcessTable(): Promise<ProcessTable | undefined> {
  return new Promise((resolveTable) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,state=,time=,lstart=,args="], {
      encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    }, (error, stdout) => {
      resolveTable(error === null ? parsePsProcessTable(stdout) : undefined);
    });
  });
}

/** Every process the OS lists, or undefined where this platform has no reader. */
export async function readProcessTable(
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessTable | undefined> {
  if (platform === "linux") return readLinuxProcessTable();
  if (platform === "darwin") return readDarwinProcessTable();
  return undefined;
}

/**
 * The session's processes: the root, every member of the root's process
 * group, and the descendants of both. Empty when the root is not a valid
 * process id; pid 1 is never a session root.
 */
export function sessionMembers(table: ProcessTable, rootPid: number): ProcessSample[] {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1) return [];
  const members = new Map<number, ProcessSample>();
  const pending: number[] = [];
  const add = (sample: ProcessSample | undefined): void => {
    if (sample === undefined || sample.pid <= 1 || members.has(sample.pid)) return;
    members.set(sample.pid, sample);
    pending.push(sample.pid);
  };
  const children = new Map<number, ProcessSample[]>();
  for (const sample of table.values()) {
    const siblings = children.get(sample.ppid);
    if (siblings === undefined) children.set(sample.ppid, [sample]);
    else siblings.push(sample);
    if (sample.pgid === rootPid) add(sample);
  }
  add(table.get(rootPid));
  while (pending.length > 0) {
    for (const child of children.get(pending.pop()!) ?? []) add(child);
  }
  return [...members.values()];
}

/** The previous check of a session, kept on its entry for deltas. */
export interface SessionProcessCheck {
  readonly cpuSeconds: number;
  /** "pid:startToken" -> label of every member seen. */
  readonly members: ReadonlyMap<string, string>;
}

export interface SessionProcessReport {
  /** "python3 x4 running (1200s cpu)", busiest first, at most three groups. */
  readonly groups: readonly { readonly label: string; readonly state: ProcessRunState; readonly count: number; readonly cpuSeconds: number }[];
  readonly memberCount: number;
  readonly cpuSeconds: number;
  /** CPU used since the previous check; absent on the first. */
  readonly cpuDeltaSeconds?: number;
  /** Members of the previous check that are gone, at most two. */
  readonly exited: readonly string[];
  readonly check: SessionProcessCheck;
}

const MAX_GROUPS = 3;
const MAX_EXITED = 2;

/**
 * Summarize the session rooted at `rootPid`. Undefined when the platform has
 * no process reader or the root is no longer listed (nothing honest to say).
 */
export async function checkSessionProcesses(
  rootPid: number | undefined,
  previous: SessionProcessCheck | undefined,
  options: { readonly platform?: NodeJS.Platform; readonly table?: ProcessTable } = {},
): Promise<SessionProcessReport | undefined> {
  if (rootPid === undefined) return undefined;
  const platform = options.platform ?? process.platform;
  const table = options.table ?? await readProcessTable(platform);
  if (table === undefined || !table.has(rootPid)) return undefined;
  let members = sessionMembers(table, rootPid);
  if (platform === "linux" && options.table === undefined) members = withLinuxCommandLines(members);
  const cpuSeconds = members.reduce((sum, member) => sum + member.cpuSeconds, 0);
  const grouped = new Map<string, { label: string; state: ProcessRunState; count: number; cpuSeconds: number }>();
  for (const member of members) {
    const name = basename(member.label.split(" ")[0] ?? member.label);
    const key = `${name}\u0000${member.state}`;
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, { label: name, state: member.state, count: 1, cpuSeconds: member.cpuSeconds });
    else { group.count += 1; group.cpuSeconds += member.cpuSeconds; }
  }
  const groups = [...grouped.values()]
    .sort((left, right) => right.cpuSeconds - left.cpuSeconds || right.count - left.count)
    .slice(0, MAX_GROUPS);
  const seen = new Map<string, string>(members.map((member) => [`${member.pid}:${member.startToken}`, member.label]));
  const exited = previous === undefined ? [] : [...previous.members.entries()]
    .filter(([identity]) => !seen.has(identity))
    .map(([identity, label]) => `${label} (pid ${identity.split(":")[0]})`)
    .slice(0, MAX_EXITED);
  return {
    groups,
    memberCount: members.length,
    cpuSeconds,
    ...(previous !== undefined ? { cpuDeltaSeconds: Math.max(0, cpuSeconds - previous.cpuSeconds) } : {}),
    exited,
    check: { cpuSeconds, members: seen },
  };
}

function seconds(value: number): string {
  return value >= 10 ? `${Math.round(value)}s` : `${Math.round(value * 10) / 10}s`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** One line for a quiet poll. */
export function formatSessionProcessReport(report: SessionProcessReport, quietMs: number): string {
  const groups = report.groups.map((group) =>
    `${group.label}${group.count > 1 ? ` x${group.count}` : ""} ${group.state}` +
    (group.cpuSeconds >= 0.5 ? ` (${seconds(group.cpuSeconds)} cpu)` : ""));
  const more = report.memberCount > report.groups.reduce((sum, group) => sum + group.count, 0) ? ", ..." : "";
  const delta = report.cpuDeltaSeconds === undefined ? "" : ` CPU since the last check: ${seconds(report.cpuDeltaSeconds)}.`;
  const exited = report.exited.length === 0 ? "" : ` Exited since then: ${report.exited.join(", ")}.`;
  return `[no output for ${formatDuration(quietMs)}; ${report.memberCount} process${report.memberCount === 1 ? "" : "es"}: ${groups.join(", ")}${more}.${delta}${exited}]`;
}
