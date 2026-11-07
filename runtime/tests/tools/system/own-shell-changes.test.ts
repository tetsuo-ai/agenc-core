import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createModelFacingTools } from "../../bin/model-facing-tools.js";
import { changedFilesProducer } from "../../prompts/attachments/changed-files.js";
import type { GetAttachmentsOptions } from "../../prompts/attachments/orchestrator.js";
import { createBashTool } from "./bash.js";
import { createExecCommandTool } from "./exec-command.js";
import { createFileEditTool } from "./file-edit.js";
import { createFileWriteTool } from "./file-write.js";
import {
  clearSessionReadState,
  getSessionReadSnapshot,
  recordSessionRead,
  SESSION_ID_ARG,
} from "./filesystem.js";
import { createWriteStdinTool } from "./write-stdin.js";
import { attachToolRuntimeContext } from "../runtimes/context.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";

// The changed-files attachment must not send back what the session's own shell
// command wrote (img32 P2 B1: proof.csv created with Write and appended with
// `printf >>` was attached 39 times), and must keep reporting every change that
// did not come from one of its commands.

let root: string;
let session: string;
let manager: UnifiedExecProcessManager;
let counter = 0;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-own-shell-")));
  session = `own-shell-${process.pid}-${++counter}`;
  manager = new UnifiedExecProcessManager({ cwd: root });
});

afterEach(async () => {
  await manager.closeAll("test_cleanup");
  clearSessionReadState(session, tmpdir());
  await rm(root, { recursive: true, force: true });
});

/** Tool args as the dispatcher passes them in a bypassPermissions session (the race and panel setting). */
function shellArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const withContext: Record<string, unknown> = { ...args, [SESSION_ID_ARG]: session };
  attachToolRuntimeContext(withContext, {
    callId: `call-${toolName}`, toolName, runtimeKind: "function", classification: "exclusive",
    supportsParallelToolCalls: false, source: { type: "model" }, submittedAtMs: 0, approvalPolicy: "never",
    requestedSandboxMode: "danger_full_access", sandboxMode: "danger_full_access", approvalResolved: true,
    rawArgs: "{}",
    invocation: {
      session: {
        permissionModeRegistry: { current: () => ({ mode: "bypassPermissions" }) },
        services: { runtimeOptions: { sessionTempRoot: root } },
      },
      payload: { kind: "function", arguments: "{}" },
      turn: { subId: "turn-own-shell", cwd: root },
    },
  } as never);
  return withContext;
}

function exec(cmd: string, extra: Record<string, unknown> = {}) {
  const tool = bindExplicitDangerBoundary(createExecCommandTool({
    cwd: root, allowedPaths: [root], lightMode: true, unifiedExecManager: manager,
  }));
  return tool.execute(shellArgs("exec_command", { cmd, ...extra }));
}

function poll(sessionId: number, yieldMs: number) {
  const tool = bindExplicitDangerBoundary(createWriteStdinTool({
    cwd: root, allowedPaths: [root], lightMode: true, unifiedExecManager: manager,
  }));
  return tool.execute(shellArgs("write_stdin", { session_id: sessionId, chars: "", yield_time_ms: yieldMs }));
}

async function write(file: string, content: string) {
  const result = await createFileWriteTool({ allowedPaths: [root] }).execute({
    file_path: file, content, [SESSION_ID_ARG]: session,
  });
  expect(result.isError, String(result.content)).toBeUndefined();
  // The next change gets a later mtime even on a coarse clock.
  await delay(20);
}

function edit(file: string, oldString: string, newString: string) {
  return createFileEditTool({ allowedPaths: [root] }).execute({
    file_path: file, old_string: oldString, new_string: newString, cwd: root, [SESSION_ID_ARG]: session,
  });
}

function attachments() {
  const opts: GetAttachmentsOptions = {
    sessionKey: { sessionId: session },
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: root,
    subagentDepth: 0,
    signal: new AbortController().signal,
    agencHome: root,
  };
  return changedFilesProducer(opts, {} as never);
}

async function outsideAppend(file: string, line: string) {
  await writeFile(file, `${await readFile(file, "utf8")}${line}\n`);
  await delay(20);
}

test("a CSV made with Write and appended by the session's own commands is not sent back", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,062DC\n");
  for (const [n, code] of [[2, "081CB"], [3, "0A0BA"], [4, "0BFA9"]] as const) {
    const result = await exec(`printf '${n},${code}\\n' >> proof.csv && tail -3 proof.csv`);
    expect(String(result.content)).toContain(`${n},${code}`);
    expect(await attachments()).toEqual([]);
  }
  // The view follows the file as it does after a diff, so a later outside
  // change is diffed against the appended file, not the first one.
  expect(getSessionReadSnapshot(session, csv)?.rawContent).toBe("1,062DC\n2,081CB\n3,0A0BA\n4,0BFA9\n");
  await outsideAppend(csv, "5,0DE98");
  const out = await attachments();
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ kind: "edited_text_file", filename: csv });
  expect((out[0] as { snippet: string }).snippet).toContain("5,0DE98");
});

test("two of the session's commands before the next request send nothing", async () => {
  const file = join(root, "notes.md");
  await write(file, "# notes\n");
  await exec("printf 'one\\n' >> notes.md");
  await exec("python3 -c \"import pathlib; p=pathlib.Path('notes.md'); p.write_text(p.read_text().replace('one', 'uno'))\"");
  expect(await readFile(file, "utf8")).toBe("# notes\nuno\n");
  expect(await attachments()).toEqual([]);
});

test("a change made while the session waits on its own background command is its own", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  const started = await exec(
    "while [ ! -e go ]; do sleep 0.05; done; printf '2,B\\n' >> proof.csv; echo appended",
    { yield_time_ms: 200 },
  );
  const sessionId = (started.codeModeResult as { session_id?: number }).session_id;
  expect(sessionId, String(started.content)).toEqual(expect.any(Number));
  expect(await readFile(csv, "utf8")).toBe("1,A\n");
  const polled = poll(sessionId!, 10_000);
  await delay(300);
  await writeFile(join(root, "go"), "");
  expect(String((await polled).content)).toContain("appended");
  expect(await readFile(csv, "utf8")).toBe("1,A\n2,B\n");
  expect(await attachments()).toEqual([]);
}, 20_000);

test("a change from outside the session's commands is still sent", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  await outsideAppend(csv, "2,B");
  const out = await attachments();
  expect(out).toHaveLength(1);
  expect((out[0] as { snippet: string }).snippet).toContain("2,B");
});

test("an outside change before the session's command is sent with the command's change", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  await outsideAppend(csv, "9,USER");
  await exec("printf '2,B\\n' >> proof.csv");
  const out = await attachments();
  expect(out).toHaveLength(1);
  const snippet = (out[0] as { snippet: string }).snippet;
  expect(snippet).toContain("9,USER");
  expect(snippet).toContain("2,B");
});

test("an outside change after the session's command returned is sent", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  await exec("printf '2,B\\n' >> proof.csv");
  await outsideAppend(csv, "9,USER");
  const out = await attachments();
  expect(out).toHaveLength(1);
  expect((out[0] as { snippet: string }).snippet).toContain("9,USER");
});

test("read-before-write checks see the session's command as before: stale until the next request", async () => {
  const file = join(root, "app.js");
  await write(file, "export const total = 1;\n");
  await exec("sed -i 's/total = 1/total = 2/' app.js");
  // Same step as the command: the view is still the one before it.
  const refused = await edit(file, "total = 2", "total = 3");
  expect(refused.isError).toBe(true);
  expect(String(refused.content)).toContain("modified since read");
  // The next request refreshes the view without sending the file.
  expect(await attachments()).toEqual([]);
  const applied = await edit(file, "total = 2", "total = 3");
  expect(applied.isError, String(applied.content)).not.toBe(true);
  expect(await readFile(file, "utf8")).toBe("export const total = 3;\n");
});

test("an image the session's own command rewrote is not sent; an outside rewrite is", async () => {
  const shot = join(root, "shot.png");
  await writeFile(shot, "old-bytes");
  const past = new Date(Date.now() - 60_000);
  await utimes(shot, past, past);
  recordSessionRead(session, shot, {
    rawContent: Buffer.from("old-bytes").toString("base64"),
    timestamp: past.getTime(),
    viewKind: "full",
  });
  await exec("printf 'new-bytes' > shot.png");
  expect(await attachments()).toEqual([]);
  expect(getSessionReadSnapshot(session, shot)?.rawContent).toBe(Buffer.from("new-bytes").toString("base64"));

  await delay(20);
  await writeFile(shot, "outside-bytes");
  const out = await attachments();
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({
    kind: "edited_image_file",
    filename: shot,
    content: Buffer.from("outside-bytes").toString("base64"),
  });
});

test("a system.bash command is the session's own too", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  const bash = bindExplicitDangerBoundary(createBashTool({ cwd: root }));
  const ran = await bash.execute(shellArgs("system.bash", { command: "printf '2,B\\n' >> proof.csv" }));
  expect(ran.isError, String(ran.content)).not.toBe(true);
  expect(await readFile(csv, "utf8")).toBe("1,A\n2,B\n");
  expect(await attachments()).toEqual([]);
});

test("a PowerShell command is the session's own too", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  // PowerShell runs through unified exec when a PowerShell binary is found; the
  // launch is intercepted here and does what the command would.
  await writeFile(join(root, "pwsh"), "");
  const launch = vi.spyOn(manager, "execCommand").mockImplementation(async () => {
    await writeFile(csv, `${await readFile(csv, "utf8")}2,B\n`);
    return {
      output: "", stdout: "", stderr: "", exitCode: 0, exit_code: 0, durationMs: 0, wall_time_seconds: 0,
      timedOut: false, truncated: false, original_token_count: 0,
    };
  });
  try {
    const powershell = createModelFacingTools({
      workspaceRoot: root, getSession: () => null, env: { PATH: root }, unifiedExecManager: manager,
    }).find((tool) => tool.name === "PowerShell")!;
    const result = await powershell.execute(shellArgs("PowerShell", { command: "Add-Content proof.csv '2,B'" }));
    expect(result.isError, String(result.content)).not.toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    launch.mockRestore();
  }
  expect(await readFile(csv, "utf8")).toBe("1,A\n2,B\n");
  expect(await attachments()).toEqual([]);
});
