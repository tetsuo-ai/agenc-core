import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function workspaceAnchor(text) {
  const line = text.split(/\n/u).find((entry) => /WORKSPACE|target\.txt|agenc/i.test(entry));
  return line?.trim() ?? "";
}

export function workspaceSnapshot(text) {
  return text
    .split(/\n/u)
    .filter((entry) => /WORKSPACE|target\.txt|agenc|README|package|docs|runtime/u.test(entry))
    .slice(0, 12)
    .map((entry) => entry.trim())
    .join("\n");
}

export async function listNeovimPids() {
  const processes = await listProcesses();
  return processes
    .filter((processInfo) => isNeovimProcess(processInfo))
    .map((processInfo) => processInfo.pid);
}

export async function listDescendantNeovimPids(rootPid) {
  if (!Number.isInteger(rootPid)) return [];
  const processes = await listProcesses();
  const childrenByParent = new Map();
  for (const processInfo of processes) {
    const siblings = childrenByParent.get(processInfo.ppid) ?? [];
    siblings.push(processInfo);
    childrenByParent.set(processInfo.ppid, siblings);
  }
  const descendants = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const processInfo = queue.shift();
    descendants.push(processInfo);
    queue.push(...(childrenByParent.get(processInfo.pid) ?? []));
  }
  return descendants
    .filter((processInfo) => isNeovimProcess(processInfo))
    .map((processInfo) => processInfo.pid);
}

export async function waitForPidsGone(pids, timeoutMs, label = "process") {
  const expected = new Set(pids);
  const deadline = Date.now() + timeoutMs;
  let remaining = [];
  while (Date.now() < deadline) {
    const processes = await listProcesses();
    remaining = processes
      .filter((processInfo) => expected.has(processInfo.pid))
      .map((processInfo) => `${processInfo.pid} ${processInfo.command}`.trim());
    if (remaining.length === 0) return;
    await sleep(100);
  }
  throw new Error(`${label} remained alive: ${remaining.join(", ")}`);
}

async function listProcesses() {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,comm=,args="], { timeout: 2_000 });
    return stdout
      .split(/\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/u);
        if (!match) return null;
        return {
          pid: Number.parseInt(match[1], 10),
          ppid: Number.parseInt(match[2], 10),
          name: match[3],
          command: match[4] ?? "",
        };
      })
      .filter((processInfo) => processInfo && Number.isInteger(processInfo.pid) && Number.isInteger(processInfo.ppid));
  } catch {
    return [];
  }
}

function isNeovimProcess(processInfo) {
  return processInfo.name === "nvim" || /\bnvim\b/u.test(processInfo.command);
}

export async function waitForScreen(session, pattern, { timeout, label }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(session.text)) return;
    await sleep(100);
  }
  throw new Error(`waitForScreen(${label}): timeout after ${timeout}ms`);
}

export async function waitForNoNewNeovimPids(beforePids, timeoutMs, label = "embedded Neovim") {
  const deadline = Date.now() + timeoutMs;
  let newPids = [];
  while (Date.now() < deadline) {
    const afterPids = await listNeovimPids();
    newPids = afterPids.filter((pid) => !beforePids.includes(pid));
    if (newPids.length === 0) return;
    await sleep(100);
  }
  throw new Error(`${label} process remained alive: ${newPids.join(", ")}`);
}
