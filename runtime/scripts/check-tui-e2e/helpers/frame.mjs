import { readFile } from "node:fs/promises";

import { renderPtyRows } from "../harness.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
