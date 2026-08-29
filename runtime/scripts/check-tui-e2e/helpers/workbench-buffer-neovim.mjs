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

export async function runEmbeddedNeovimCommand(
  session,
  command,
  { readySession = false } = {},
) {
  // The terminal grid can paint NORMAL before the provider commits the session
  // that receives input. The provider header binds ready state to that
  // committed session, but its coarse "normal" label also covers transient
  // native modes. Normalize the owned session with Escape before entering Ex.
  // The callers prove command delivery through concrete process/file effects;
  // do not make that contract depend on a ConPTY-rendered presentation footer.
  // A caller may bypass the presentation gate only after concrete evidence
  // proves that this same Neovim process is live and already received input.
  if (!readySession) {
    await waitForFrameText(
      session,
      /\[embedded Neovim [^,\n]+,\s*normal,\s*ready(?:,|\])/iu,
      `committed embedded Neovim session before :${command}`,
      5_000,
    );
  }
  await session.waitForIdle({ idleWindow: 200, timeout: 5_000 });
  // A lone ESC is intentionally buffered by the TUI parser so a following
  // byte can complete an Alt/meta sequence. A parent-side delay cannot prove
  // that a render-stalled child flushed that byte first: ESC and ':' can be
  // read together, dropping the Escape normalization that transient native
  // modes require. CSI-u encodes Escape as one complete key, so it remains
  // distinct from the colon even when both writes reach the same stdin read.
  session.send(CSI_U_ESCAPE);
  await sleep(80);
  session.send(":");
  // Neovim's provider footer remains in CMDLINE_NORMAL for the lifetime of
  // command mode. Do not paste the command body until that real editor-state
  // acknowledgement proves the normalized Escape and colon were consumed.
  await waitForFrameText(
    session,
    /CMDLINE_NORMAL/u,
    `embedded Neovim command mode before :${command}`,
    5_000,
  );
  // Deliver the command body through the terminal's real bracketed-paste
  // protocol. BufferSurface routes that one paste event to one acknowledged
  // nvim_paste RPC instead of launching an unobserved nvim_input request for
  // every character. Escape, colon, the command-mode acknowledgement, and
  // Enter remain real editor interactions, so this still exercises the
  // complete PTY input path.
  session.send(`\x1b[200~${command}\x1b[201~`);
  await sleep(80);
  session.send("\r");
  await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
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
