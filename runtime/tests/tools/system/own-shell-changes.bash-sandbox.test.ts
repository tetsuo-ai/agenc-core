import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// system.bash in a read-only sandbox (review rv1 finding 3): the launch is
// intercepted; another writer changes the read file while the command runs.
const during: { write?: () => Promise<void> } = {};
vi.mock("../../../src/utils/supervisedProcess.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/utils/supervisedProcess.js")>(
    "../../../src/utils/supervisedProcess.js",
  );
  return {
    ...actual,
    runSupervisedProcess: vi.fn(async () => {
      await during.write?.();
      return {
        exitCode: 0, signal: null, stdout: Buffer.from("1,A\n"), stderr: Buffer.alloc(0),
        forced: false, backstopExpired: false, processStarted: true,
      };
    }),
  };
});

import { changedFilesProducer } from "../../prompts/attachments/changed-files.js";
import type { GetAttachmentsOptions } from "../../prompts/attachments/orchestrator.js";
import { createBashTool } from "./bash.js";
import { createFileWriteTool } from "./file-write.js";
import { clearSessionReadState, SESSION_ID_ARG } from "./filesystem.js";
import { attachToolRuntimeContext } from "../runtimes/context.js";

let root: string;
let session: string;
let counter = 0;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-own-shell-bash-")));
  session = `own-shell-bash-${process.pid}-${++counter}`;
  during.write = undefined;
});

afterEach(async () => {
  clearSessionReadState(session, tmpdir());
  await rm(root, { recursive: true, force: true });
});

function attachments() {
  const opts: GetAttachmentsOptions = {
    sessionKey: { sessionId: session }, userInput: null, loadedTools: [], messages: [],
    permissionContext: { mode: "default" } as never, cwd: root, subagentDepth: 0,
    signal: new AbortController().signal, agencHome: root,
  };
  return changedFilesProducer(opts, {} as never);
}

test("in a read-only sandbox nothing is credited to system.bash, even for a file it names", async () => {
  const csv = join(root, "proof.csv");
  await createFileWriteTool({ allowedPaths: [root] }).execute({ file_path: csv, content: "1,A\n", [SESSION_ID_ARG]: session });
  await delay(20);
  expect(await attachments()).toEqual([]);
  during.write = async () => writeFile(csv, `${await readFile(csv, "utf8")}2,OUTSIDE\n`);
  const args: Record<string, unknown> = { command: "cat proof.csv", [SESSION_ID_ARG]: session };
  attachToolRuntimeContext(args, {
    callId: "call-bash", toolName: "system.bash", runtimeKind: "function", classification: "exclusive",
    supportsParallelToolCalls: false, source: { type: "model" }, submittedAtMs: 0, approvalPolicy: "never",
    requestedSandboxMode: "read_only", sandboxMode: "read_only", approvalResolved: true, rawArgs: "{}",
    invocation: {
      session: {
        permissionModeRegistry: { current: () => ({ mode: "default" }) },
        services: { runtimeOptions: { sessionTempRoot: root } },
      },
      payload: { kind: "function", arguments: "{}" },
      turn: { subId: "turn-bash", cwd: root, agencLinuxSandboxExe: "/bin/true" },
    },
  } as never);
  const ran = await createBashTool({ cwd: root }).execute(args);
  expect(ran.isError, String(ran.content)).not.toBe(true);
  const out = await attachments();
  expect(out).toHaveLength(1);
  expect((out[0] as { snippet: string }).snippet).toContain("2,OUTSIDE");
});
