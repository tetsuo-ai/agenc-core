import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { formatUnifiedExecToolContent } from "./exec-result-format.js";
import { SESSION_ID_ARG } from "./filesystem.js";
import {
  provePrintedRead,
  rememberPrintedOutput,
  resetPrintedOutputsForTest,
  stableWorkspaceText,
} from "./printed-read-proof.js";
import type { ExecCommandToolOutput } from "../../unified-exec/types.js";

const MONEY = "export function toCents(amount) {\n  return Math.floor(amount * 100);\n}\n";

let root: string;
let session: string;
let counter = 0;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-printed-read-proof-")));
  counter += 1;
  session = `session-printed-read-proof-${process.pid}-${counter}`;
  resetPrintedOutputsForTest();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function finished(stdout: string): ExecCommandToolOutput {
  return {
    output: stdout, stdout, stderr: "", exitCode: 0, exit_code: 0, durationMs: 1,
    wall_time_seconds: 0.001, timedOut: false, truncated: false, original_token_count: 1,
  };
}

async function record(cmd: string, output: ExecCommandToolOutput): Promise<void> {
  rememberPrintedOutput({
    cmd, output, visible: formatUnifiedExecToolContent(output), cwd: root,
    args: { [SESSION_ID_ARG]: session },
  });
}

async function snapshot(path: string) {
  return stableWorkspaceText(path, [root], { [SESSION_ID_ARG]: session });
}

test("a quoted or backslash-tainted path does not name the file for a printed read", async () => {
  const file = join(root, "money.js");
  await writeFile(file, MONEY, "utf8");
  await record("cat 'money.js'", finished(MONEY));
  expect(await provePrintedRead(session, file, [root], { [SESSION_ID_ARG]: session })).toBe(false);
  resetPrintedOutputsForTest();
  await record("cat money\\.js", finished(MONEY));
  expect(await provePrintedRead(session, file, [root], { [SESSION_ID_ARG]: session })).toBe(false);
});

test("stableWorkspaceText keeps a regular file and refuses outside the allowed roots", async () => {
  const file = join(root, "money.js");
  await writeFile(file, MONEY, "utf8");
  expect(await snapshot(file)).toMatchObject({ text: MONEY, canonical: file });
  expect(await snapshot(join(root, "missing.js"))).toBeUndefined();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "agenc-printed-read-outside-")));
  try {
    const hidden = join(outside, "secret.js");
    await writeFile(hidden, MONEY, "utf8");
    expect(await snapshot(hidden)).toBeUndefined();
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("stableWorkspaceText refuses empty, NUL, invalid UTF-8 and U+FFFD text", async () => {
  const empty = join(root, "empty.js");
  const nul = join(root, "nul.js");
  const invalid = join(root, "invalid.js");
  const replacement = join(root, "replacement.js");
  await writeFile(empty, "", "utf8");
  await writeFile(nul, Buffer.from(`hello\0${MONEY}`));
  await writeFile(invalid, Buffer.from([0x80, 0x81, 0x82, 0x83]));
  await writeFile(replacement, `\uFFFD${MONEY}`, "utf8");
  expect(await snapshot(empty)).toBeUndefined();
  expect(await snapshot(nul)).toBeUndefined();
  expect(await snapshot(invalid)).toBeUndefined();
  expect(await snapshot(replacement)).toBeUndefined();
});

test("stableWorkspaceText refuses a directory or FIFO without waiting", async () => {
  const dir = join(root, "dir");
  await mkdir(dir);
  expect(await snapshot(dir)).toBeUndefined();
  if (process.platform === "win32" || (fsConstants.O_NONBLOCK ?? 0) === 0) return;
  const fifo = join(root, "pipe");
  execFileSync("mkfifo", [fifo], { stdio: "ignore" });
  expect(await snapshot(fifo)).toBeUndefined();
});
