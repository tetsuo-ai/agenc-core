import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// A writer that lands while the changed-files producer reads a file (review rv1
// finding 5). The read is wrapped so the test can write the file between the
// producer's stat and its read.
const race: { path?: string; write?: () => Promise<void> } = {};
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (race.path !== undefined && args[0] === race.path && race.write !== undefined) {
        const write = race.write;
        race.write = undefined;
        await write();
      }
      return actual.readFile(...args);
    },
  };
});

import { changedFilesProducer } from "../../prompts/attachments/changed-files.js";
import type { GetAttachmentsOptions } from "../../prompts/attachments/orchestrator.js";
import { createExecCommandTool } from "./exec-command.js";
import { createFileWriteTool } from "./file-write.js";
import { clearSessionReadState, getSessionReadSnapshot, SESSION_ID_ARG } from "./filesystem.js";
import { attachToolRuntimeContext } from "../runtimes/context.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";

let root: string;
let session: string;
let manager: UnifiedExecProcessManager;
let counter = 0;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-own-shell-race-")));
  session = `own-shell-race-${process.pid}-${++counter}`;
  manager = new UnifiedExecProcessManager({ cwd: root });
  race.path = undefined;
  race.write = undefined;
});

afterEach(async () => {
  await manager.closeAll("test_cleanup");
  clearSessionReadState(session, tmpdir());
  await rm(root, { recursive: true, force: true });
});

function exec(cmd: string) {
  const args: Record<string, unknown> = { cmd, [SESSION_ID_ARG]: session };
  attachToolRuntimeContext(args, {
    callId: "call-exec", toolName: "exec_command", runtimeKind: "function", classification: "exclusive",
    supportsParallelToolCalls: false, source: { type: "model" }, submittedAtMs: 0, approvalPolicy: "never",
    requestedSandboxMode: "danger_full_access", sandboxMode: "danger_full_access", approvalResolved: true, rawArgs: "{}",
    invocation: {
      session: {
        permissionModeRegistry: { current: () => ({ mode: "bypassPermissions" }) },
        services: { runtimeOptions: { sessionTempRoot: root } },
      },
      payload: { kind: "function", arguments: "{}" },
      turn: { subId: "turn-race", cwd: root },
    },
  } as never);
  return bindExplicitDangerBoundary(createExecCommandTool({
    cwd: root, allowedPaths: [root], lightMode: true, unifiedExecManager: manager,
  })).execute(args);
}

async function attachments(): Promise<string[]> {
  const opts: GetAttachmentsOptions = {
    sessionKey: { sessionId: session }, userInput: null, loadedTools: [], messages: [],
    permissionContext: { mode: "default" } as never, cwd: root, subagentDepth: 0,
    signal: new AbortController().signal, agencHome: root,
  };
  return (await changedFilesProducer(opts, {} as never)).map((a) => (a as { snippet?: string }).snippet ?? "");
}

test("a write landing while the producer handles the session's own change never enters the view unsent", async () => {
  const csv = join(root, "proof.csv");
  await createFileWriteTool({ allowedPaths: [root] }).execute({ file_path: csv, content: "1,A\n", [SESSION_ID_ARG]: session });
  await delay(20);
  const sent: string[] = [...await attachments()];
  await exec("printf '2,B\\n' >> proof.csv");
  race.path = csv;
  race.write = async () => writeFile(csv, `${await readFile(csv, "utf8")}9,USER\n`);
  sent.push(...await attachments());
  sent.push(...await attachments());
  // Every line in the session's view was written by the model's Write or reached it in a block.
  const view = getSessionReadSnapshot(session, csv)?.rawContent ?? "";
  for (const line of view.split("\n").filter(Boolean)) {
    if (line === "1,A") continue;
    expect(sent.join("\n"), `view line ${line}`).toContain(line);
  }
});

test("after a write lands during the producer's read, the next command naming the file is not credited", async () => {
  const csv = join(root, "proof.csv");
  await createFileWriteTool({ allowedPaths: [root] }).execute({ file_path: csv, content: "1,A\n", [SESSION_ID_ARG]: session });
  await delay(20);
  expect(await attachments()).toEqual([]);
  // An outside change, and a second writer that lands between the producer's stat and read.
  await writeFile(csv, "1,A\n2,B\n");
  await delay(20);
  race.path = csv;
  race.write = async () => writeFile(csv, `${await readFile(csv, "utf8")}3,C\n`);
  const first = await attachments();
  expect(first).toHaveLength(1);
  expect(first[0]).toContain("3,C");
  await delay(20);
  await exec("printf '4,D\\n' >> proof.csv");
  const next = await attachments();
  expect(next).toHaveLength(1);
  expect(next[0]).toContain("4,D");
});
