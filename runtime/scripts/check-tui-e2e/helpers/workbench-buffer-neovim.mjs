import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { renderPtyRows } from "../harness.mjs";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CSI_U_ESCAPE = "\x1b[27u";

export async function anchorWorkbenchProjectRoot(cwd) {
  // Project trust resolves the nearest ancestor marker. Pin each generated
  // fixture locally so an unrelated /tmp/package.json cannot turn the trust
  // target into the shared temp root. A hidden marker avoids changing the
  // explorer selection whose Enter key opens target.txt in these scenarios.
  await mkdir(join(cwd, ".git"));
}

export function workspaceAnchor(text) {
  const line = text.split(/\n/u).find((entry) => /WORKSPACE|target\.txt|agenc/i.test(entry));
  return line?.trim() ?? "";
}

export function workspaceSnapshot(text) {
  const workspaceColumnWidth = 21;
  return text
    .split(/\n/u)
    .map((entry) => entry.slice(0, workspaceColumnWidth).trimEnd())
    .filter((entry) => !/^AgenC Workbench/u.test(entry))
    .filter((entry) => /WORKSPACE|target\.txt|agenc|README|package|docs|runtime/u.test(entry))
    .slice(0, 12)
    .map((entry) => entry.trim())
    .join("\n");
}

export function frameText(session) {
  return renderPtyRows(session.raw, { cols: session.cols, rows: session.rows }).join("\n");
}

export async function waitForFrameText(session, pattern, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let frame = "";
  while (Date.now() < deadline) {
    session.throwIfAborted?.();
    frame = frameText(session);
    if (pattern.test(frame)) return;
    if (session.exited === true) {
      throw new Error(
        `${label} did not render before the TUI exited ` +
          `(code=${session.exitInfo?.exitCode}, signal=${session.exitInfo?.signal}): ` +
          frame.slice(-1200),
      );
    }
    await sleep(100);
  }
  throw new Error(`${label} did not render in the latest PTY frame: ${frame.slice(-1200)}`);
}

export async function waitForExactFileText(
  path,
  expected,
  timeoutMs,
  label,
  {
    readText = (candidatePath) => readFile(candidatePath, "utf8"),
    wait = sleep,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await readText(path);
    } catch {
      last = "";
    }
    if (last === expected) return last;
    await wait(50);
  }
  throw new Error(
    `${label} did not become exact at ${path} within ${timeoutMs}ms: ` +
      `expected ${JSON.stringify(expected)}, last ${JSON.stringify(last)}`,
  );
}

export function sendEmbeddedNeovimInput(session, text) {
  session.send(text);
}

export function enableNeovimInputTrace(session) {
  session.neovimInputTracePath = join(session.cwd, ".agenc-neovim-input-trace.jsonl");
  session.envOverrides.AGENC_TEST_NEOVIM_INPUT_TRACE = session.neovimInputTracePath;
}

export async function readNeovimInputTrace(session) {
  if (!session.neovimInputTracePath) throw new Error("Neovim input trace was not enabled before TUI startup");
  const text = await readFile(session.neovimInputTracePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text.split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
}

export async function runEmbeddedNeovimCommand(
  session,
  command,
  { readTrace = () => readNeovimInputTrace(session), wait = sleep, timeoutMs = 5_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let owner = null;
  let sequence = 0;
  let latest = {};
  const fail = (reason) => new Error(
    `Embedded Neovim input acknowledgement ${reason}: ${JSON.stringify(latest)}; latest frame: ${frameText(session).slice(-1200)}`,
  );
  const poll = async (kind = null, expectedMode = null) => {
    while (Date.now() < deadline) {
      session.throwIfAborted?.();
      const records = await readTrace();
      latest = summarizeNeovimInputTrace(records, owner, sequence, kind);
      if (session.exited === true) throw fail("failed because the TUI exited");
      assertNeovimInputOwner(latest, fail);
      if (!kind) {
        if (neovimInputTraceReady(latest)) {
          owner = latest.state.sessionId;
          sequence = latest.lastSequence;
          return;
        }
      } else if (neovimInputTraceComplete(latest, expectedMode, fail)) {
        return;
      }
      await wait(10);
    }
    throw fail("timed out without resending input");
  };
  await poll();
  for (const [bytes, kind, mode] of [
    [CSI_U_ESCAPE, "escape", "n"],
    [":", "colon", "c"],
    [`\x1b[200~${command}\x1b[201~`, "paste", "c"],
  ]) {
    sequence += 1;
    session.send(bytes);
    await poll(kind, mode);
  }
  session.send("\r");
  await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
}

function summarizeNeovimInputTrace(records, owner, sequence, kind) {
  const state = records.findLast((record) => record.type === "state");
  const inputs = new Map();
  for (const record of records) {
    if (
      record.type === "input" &&
      record.sessionId === (owner ?? state?.sessionId)
    ) inputs.set(record.sequence, record);
  }
  const lastSequence = Math.max(0, ...inputs.keys());
  const pending = [...inputs.values()].some(
    (record) => !["complete", "failed", "retired", "skipped"].includes(record.phase),
  );
  return {
    owner, state, lastSequence, pending,
    expectedSequence: sequence,
    expectedKind: kind,
    lastInput: inputs.get(lastSequence),
    input: inputs.get(sequence),
  };
}

function assertNeovimInputOwner({ owner, state }, fail) {
  if (owner && (state?.sessionId !== owner || state.focusOwner !== "buffer")) {
    throw fail("lost its owning session or BUFFER focus");
  }
}

function neovimInputTraceReady({ state, pending }) {
  return state?.sessionId && state.providerStatus === "ready" &&
    state.focusOwner === "buffer" && !pending;
}

function neovimInputTraceComplete(latest, expectedMode, fail) {
  const { input, lastSequence, expectedSequence, expectedKind } = latest;
  if (!input) return false;
  if (input.kind !== expectedKind || lastSequence !== expectedSequence) {
    throw fail("received an unexpected input sequence");
  }
  if (["failed", "retired", "skipped"].includes(input.phase)) {
    throw fail(`failed in ${input.phase}`);
  }
  return input.phase === "complete" && input.rpcCompleted === true &&
    input.mode === expectedMode;
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
