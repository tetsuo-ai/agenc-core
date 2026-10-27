import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { parseShellCommand } from "../shell-command/parser.js";
import { shellRestrictionParts } from "./shell-restrictions.js";

interface ProcessRow { readonly pid: number; readonly ppid: number; readonly name: string }
export interface SelfTerminationProbe {
  readonly pid: number;
  readonly processes: () => readonly ProcessRow[];
  readonly matchingPids: (args: readonly string[]) => readonly number[];
}

const nativeProbe: SelfTerminationProbe = {
  pid: process.pid,
  processes: () => execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="],
    { encoding: "utf8", timeout: 1_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
    .trim().split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), name: basename(match[3]!) }] : [];
    }),
  // Use pkill's native regular expressions without executing a shell or signal.
  matchingPids: args => {
    try {
      return execFileSync("/usr/bin/pgrep", [...args], { encoding: "utf8", timeout: 1_000,
        maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "ignore"] })
        .trim().split(/\s+/).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0);
    } catch { return []; }
  },
};

/** Best-effort accident prevention for literal kill commands, not a sandbox. */
export function selfTerminationRisk(command: string, probe: SelfTerminationProbe = nativeProbe): string | null {
  if (!/\b(?:pkill|killall|kill)\b/.test(command)) return null;
  if (probe === nativeProbe && process.platform === "win32") return null;
  let rows: readonly ProcessRow[];
  try { rows = probe.processes(); } catch { return null; }
  const protectedPids = new Set(rows.filter(row => /^agenc(?:$|[- ])/.test(row.name)).map(row => row.pid));
  protectedPids.add(probe.pid);
  const parents = new Map(rows.map(row => [row.pid, row.ppid]));
  let ancestor = probe.pid;
  const ancestors = new Set<number>();
  while (ancestor > 1 && !ancestors.has(ancestor)) {
    ancestors.add(ancestor);
    protectedPids.add(ancestor);
    ancestor = parents.get(ancestor) ?? 0;
  }
  const inspect = (text: string, depth: number): number | undefined => {
    if (depth > 8) return undefined;
    const parts = shellRestrictionParts(text);
    if (parts.commands.length !== 1 || parts.commands[0] !== text) {
      for (const part of parts.commands.slice(0, 64)) {
        if (part === text) continue;
        const match = inspect(part, depth + 1);
        if (match !== undefined) return match;
      }
      return undefined;
    }
    const words = parseShellCommand(text);
    if (!words || !["pkill", "killall", "kill"].includes(words[0]!)) return undefined;
    const name = words[0]!;
    const flags: string[] = [];
    const operands: string[] = [];
    let options = true;
    for (let index = 1; index < words.length; index++) {
      const word = words[index]!;
      if (options && word === "--") { options = false; continue; }
      if (options && (word === "-0" || word === "--signal=0")) return undefined;
      if (options && (word === "-s" || word === "--signal")) {
        if (words[index + 1] === "0") return undefined;
        index++; continue;
      }
      if (options && /^(?:-\d+|-SIG[A-Z]+|-(?:TERM|KILL|INT|HUP)|--signal=\w+)$/.test(word)) continue;
      if (options && /^-[fix]+$/.test(word)) { flags.push(word); continue; }
      if (options && ["--full", "--exact", "--ignore-case"].includes(word)) { flags.push(word); continue; }
      if (options && word.startsWith("-")) return undefined;
      if (/[$`]/.test(word)) return undefined;
      operands.push(word);
    }
    if (name === "kill") return operands.map(Number).find(pid => protectedPids.has(pid));
    if (operands.length !== 1) return undefined;
    const matches = probe.matchingPids(name === "killall"
      ? ["-x", "--", operands[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")]
      : [...flags, "--", operands[0]!]);
    return matches.find(pid => protectedPids.has(pid));
  };
  const pid = inspect(command, 0);
  return pid === undefined ? null
    : `Refused a kill command that matches AgenC or an ancestor (pid ${pid}). Use list_processes and kill_process with an owned session_id, or target the intended worker PID.`;
}
