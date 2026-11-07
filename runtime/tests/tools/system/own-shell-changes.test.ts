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
import { createFileReadTool } from "./file-read.js";
import { createFileWriteTool } from "./file-write.js";
import {
  clearSessionReadState,
  getSessionReadSnapshot,
  recordSessionRead,
  SESSION_ID_ARG,
} from "./filesystem.js";
import { commandNamesFile } from "./own-shell-changes.js";
import { createWriteStdinTool } from "./write-stdin.js";
import { attachToolRuntimeContext } from "../runtimes/context.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../../unified-exec/types.js";

// The changed-files attachment must not send back what a command of the session
// wrote to a file it named (img32 P2 B1: proof.csv created with Write and
// appended with `printf >>` was attached 39 times). Every other change keeps
// reaching the model, and a Write or Edit after the command still needs a read of
// the bytes the command left (review rv1, probes P1 to P5).

let root: string;
let session: string;
let manager: UnifiedExecProcessManager;
let counter = 0;
const sessions: string[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-own-shell-")));
  session = `own-shell-${process.pid}-${++counter}`;
  sessions.push(session);
  manager = new UnifiedExecProcessManager({ cwd: root });
});

afterEach(async () => {
  await manager.closeAll("test_cleanup");
  for (const id of sessions.splice(0)) clearSessionReadState(id, tmpdir());
  await rm(root, { recursive: true, force: true });
});

type Sandbox = "danger" | "read_only";

/** Tool args as the dispatcher passes them: bypassPermissions without a sandbox (the panel setting), or a read-only sandbox. */
function shellArgs(
  toolName: string,
  args: Record<string, unknown>,
  options: { readonly sandbox?: Sandbox; readonly sessionId?: string } = {},
): Record<string, unknown> {
  const sandboxMode = options.sandbox === "read_only" ? "read_only" : "danger_full_access";
  const withContext: Record<string, unknown> = { ...args, [SESSION_ID_ARG]: options.sessionId ?? session };
  attachToolRuntimeContext(withContext, {
    callId: `call-${toolName}`, toolName, runtimeKind: "function", classification: "exclusive",
    supportsParallelToolCalls: false, source: { type: "model" }, submittedAtMs: 0, approvalPolicy: "never",
    requestedSandboxMode: sandboxMode, sandboxMode, approvalResolved: true,
    rawArgs: "{}",
    invocation: {
      session: {
        permissionModeRegistry: { current: () => ({ mode: options.sandbox === "read_only" ? "default" : "bypassPermissions" }) },
        services: { runtimeOptions: { sessionTempRoot: root } },
      },
      payload: { kind: "function", arguments: "{}" },
      turn: { subId: "turn-own-shell", cwd: root, ...(options.sandbox === "read_only" ? { agencLinuxSandboxExe: "/bin/true" } : {}) },
    },
  } as never);
  return withContext;
}

function exec(cmd: string, extra: Record<string, unknown> = {}, execManager: UnifiedExecProcessManagerLike = manager,
              sandbox: Sandbox = "danger") {
  const tool = createExecCommandTool({ cwd: root, allowedPaths: [root], lightMode: true, unifiedExecManager: execManager });
  const bound = sandbox === "danger" ? bindExplicitDangerBoundary(tool) : tool;
  return bound.execute(shellArgs("exec_command", { cmd, ...extra }, { sandbox }));
}

function poll(sessionId: number, yieldMs: number, execManager: UnifiedExecProcessManagerLike = manager, sandbox: Sandbox = "danger") {
  const tool = createWriteStdinTool({ cwd: root, allowedPaths: [root], lightMode: true, unifiedExecManager: execManager });
  const bound = sandbox === "danger" ? bindExplicitDangerBoundary(tool) : tool;
  return bound.execute(shellArgs("write_stdin", { session_id: sessionId, chars: "", yield_time_ms: yieldMs }, { sandbox }));
}

async function write(file: string, content: string, sessionId = session) {
  const result = await createFileWriteTool({ allowedPaths: [root] }).execute({
    file_path: file, content, [SESSION_ID_ARG]: sessionId,
  });
  // The next change gets a later mtime even on a coarse clock.
  await delay(20);
  return result;
}

function read(file: string, sessionId = session) {
  return createFileReadTool({ allowedPaths: [root] }).execute({ file_path: file, [SESSION_ID_ARG]: sessionId });
}

function edit(file: string, oldString: string, newString: string, sessionId = session) {
  return createFileEditTool({ allowedPaths: [root] }).execute({
    file_path: file, old_string: oldString, new_string: newString, cwd: root, [SESSION_ID_ARG]: sessionId,
  });
}

function attachments(sessionId = session) {
  const opts: GetAttachmentsOptions = {
    sessionKey: { sessionId },
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

function snippetOf(out: readonly unknown[]): string {
  expect(out).toHaveLength(1);
  return (out[0] as { snippet: string }).snippet;
}

function completed(output = ""): ExecCommandToolOutput {
  return {
    output, stdout: output, stderr: "", exitCode: 0, exit_code: 0, durationMs: 1, wall_time_seconds: 0.001,
    timedOut: false, truncated: false, original_token_count: 1,
  };
}

/** A manager whose commands do nothing but let another writer act while they run. */
function managerWithWriter(writer: () => Promise<void>): UnifiedExecProcessManagerLike {
  return {
    maxTimeoutMs: 30_000,
    execCommand: async () => {
      await writer();
      return { ...completed(), exitCode: null, exit_code: null, process_id: 7, session_id: 7 } as ExecCommandToolOutput;
    },
    writeStdin: async () => {
      await writer();
      return completed("done");
    },
    closeAll: async () => {},
  };
}

test("a CSV made with Write and appended by the session's own commands is not sent back", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,062DC\n");
  expect(await attachments()).toEqual([]);
  for (const [n, code] of [[2, "081CB"], [3, "0A0BA"], [4, "0BFA9"]] as const) {
    const result = await exec(`printf '${n},${code}\\n' >> proof.csv && tail -3 proof.csv`);
    expect(String(result.content)).toContain(`${n},${code}`);
    expect(await attachments()).toEqual([]);
  }
  // The session's view stays on the bytes the model last saw.
  expect(getSessionReadSnapshot(session, csv)?.rawContent).toBe("1,062DC\n");
  // An outside change is sent against that view, so the model sees every line since.
  await outsideAppend(csv, "5,0DE98");
  const snippet = snippetOf(await attachments());
  expect(snippet).toContain("2,081CB");
  expect(snippet).toContain("5,0DE98");
});

test("two of the session's commands naming the file before the next request send nothing", async () => {
  const file = join(root, "notes.md");
  await write(file, "# notes\n");
  expect(await attachments()).toEqual([]);
  await exec("printf 'one\\n' >> notes.md");
  await exec("python3 -c \"import pathlib; p=pathlib.Path('notes.md'); p.write_text(p.read_text().replace('one', 'uno'))\"");
  expect(await readFile(file, "utf8")).toBe("# notes\nuno\n");
  expect(await attachments()).toEqual([]);
});

test("a change made while the session polls a process whose command names the file is its own", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  expect(await attachments()).toEqual([]);
  const started = await exec(
    "while [ ! -e go ]; do sleep 0.05; done; printf '2,B\\n' >> proof.csv; echo appended",
    { yield_time_ms: 200 },
  );
  const sessionId = (started.codeModeResult as { session_id?: number }).session_id;
  expect(sessionId, String(started.content)).toEqual(expect.any(Number));
  const polled = poll(sessionId!, 10_000);
  await delay(300);
  await writeFile(join(root, "go"), "");
  expect(String((await polled).content)).toContain("appended");
  expect(await readFile(csv, "utf8")).toBe("1,A\n2,B\n");
  expect(await attachments()).toEqual([]);
}, 20_000);

test("P1: after a command copies other bytes over a read file, a Write from the old view is refused", async () => {
  const app = join(root, "app.js");
  await writeFile(join(root, "upstream.js"), "export const a = 1;\nexport const b = 2;\n");
  await write(app, "export const a = 1;\n");
  expect(await attachments()).toEqual([]);
  await exec("cp upstream.js app.js");
  expect(await attachments()).toEqual([]);
  const overwrite = await write(app, "export const a = 1;\nexport const c = 3;\n");
  expect(overwrite.isError).toBe(true);
  expect(String(overwrite.content)).toContain("modified since read");
  expect(await readFile(app, "utf8")).toBe("export const a = 1;\nexport const b = 2;\n");
  // After a read the model works from the bytes the command left.
  expect((await read(app)).isError).not.toBe(true);
  expect((await write(app, "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n")).isError).toBeUndefined();
});

test("Edit after the session's command needs a read of what the command wrote", async () => {
  const file = join(root, "app.js");
  await write(file, "export const total = 1;\n");
  expect(await attachments()).toEqual([]);
  await exec("sed -i 's/total = 1/total = 2/' app.js");
  expect((await edit(file, "total = 2", "total = 3")).isError).toBe(true);
  expect(await attachments()).toEqual([]);
  const refused = await edit(file, "total = 2", "total = 3");
  expect(refused.isError).toBe(true);
  expect(String(refused.content)).toContain("modified since read");
  expect((await read(file)).isError).not.toBe(true);
  const applied = await edit(file, "total = 2", "total = 3");
  expect(applied.isError, String(applied.content)).not.toBe(true);
  expect(await readFile(file, "utf8")).toBe("export const total = 3;\n");
});

test("P2: a user edit during a command that does not name the file is sent", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  expect(await attachments()).toEqual([]);
  const running = exec("sleep 1; echo slept");
  await delay(300);
  await outsideAppend(csv, "9,USER");
  expect(String((await running).content)).toContain("slept");
  expect(snippetOf(await attachments())).toContain("9,USER");
});

test("P3: another session's Edit during this session's poll is sent to this session", async () => {
  const other = `${session}-second`;
  sessions.push(other);
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  expect(await attachments()).toEqual([]);
  const started = await exec("sleep 1; echo done", { yield_time_ms: 100 });
  const sessionId = (started.codeModeResult as { session_id?: number }).session_id;
  expect(sessionId, String(started.content)).toEqual(expect.any(Number));
  const polled = poll(sessionId!, 10_000);
  await delay(200);
  expect((await read(csv, other)).isError).not.toBe(true);
  const edited = await edit(csv, "1,A", "1,EDITED", other);
  expect(edited.isError, String(edited.content)).not.toBe(true);
  expect(String((await polled).content)).toContain("done");
  expect(snippetOf(await attachments())).toContain("1,EDITED");
}, 20_000);

test("P4: in a read-only sandbox nothing is credited to exec_command, write_stdin or PowerShell", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  expect(await attachments()).toEqual([]);
  let line = 1;
  const writer = managerWithWriter(async () => {
    line += 1;
    await outsideAppend(csv, `${line},OUTSIDE`);
  });
  // exec_command naming the file: the sandbox cannot write it, so the change is not its own.
  const started = await exec("cat proof.csv", {}, writer, "read_only");
  expect(started.isError, String(started.content)).not.toBe(true);
  expect(snippetOf(await attachments())).toContain("2,OUTSIDE");
  // write_stdin polling that process.
  expect((await poll(7, 1_000, writer, "read_only")).isError, "poll").not.toBe(true);
  expect(snippetOf(await attachments())).toContain("3,OUTSIDE");
  // PowerShell, found on PATH, through the same manager.
  await writeFile(join(root, "pwsh"), "");
  const powershell = createModelFacingTools({
    workspaceRoot: root, getSession: () => null, env: { PATH: root }, unifiedExecManager: writer,
  }).find((tool) => tool.name === "PowerShell")!;
  const ran = await powershell.execute(shellArgs("PowerShell", { command: "Get-Content proof.csv" }, { sandbox: "read_only" }));
  expect(ran.isError, String(ran.content)).not.toBe(true);
  expect(snippetOf(await attachments())).toContain("4,OUTSIDE");
});

test("P5: a change that kept the old modification time before the command is not credited to it", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  expect(await attachments()).toEqual([]);
  const seen = getSessionReadSnapshot(session, csv)!.timestamp!;
  // cp -p or rsync -t: other bytes, modification time set back to the one the session saw.
  await writeFile(csv, "1,A\n9,USER\n");
  await utimes(csv, new Date(seen), new Date(seen));
  await exec("printf '2,B\\n' >> proof.csv");
  const snippet = snippetOf(await attachments());
  expect(snippet).toContain("9,USER");
  expect(snippet).toContain("2,B");
});

test("an outside change before the session's command is sent with the command's change", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  expect(await attachments()).toEqual([]);
  await outsideAppend(csv, "9,USER");
  await exec("printf '2,B\\n' >> proof.csv");
  const snippet = snippetOf(await attachments());
  expect(snippet).toContain("9,USER");
  expect(snippet).toContain("2,B");
});

test("an outside change after the session's command returned is sent", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  expect(await attachments()).toEqual([]);
  await exec("printf '2,B\\n' >> proof.csv");
  expect(await attachments()).toEqual([]);
  await outsideAppend(csv, "9,USER");
  const snippet = snippetOf(await attachments());
  expect(snippet).toContain("9,USER");
});

test("a file the command does not name is sent even when the command writes it", async () => {
  const lock = join(root, "package-lock.json");
  await write(lock, "{\"v\":1}\n");
  expect(await attachments()).toEqual([]);
  await writeFile(join(root, "gen.sh"), "printf '{\"v\":2}\\n' > package-lock.json\n");
  await exec("sh gen.sh");
  expect(snippetOf(await attachments())).toContain("\"v\":2");
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
  expect(await attachments()).toEqual([]);
  await exec("printf 'new-bytes' > shot.png");
  expect(await attachments()).toEqual([]);
  expect(getSessionReadSnapshot(session, shot)?.rawContent).toBe(Buffer.from("old-bytes").toString("base64"));

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

test("a system.bash command naming the file is the session's own too", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  expect(await attachments()).toEqual([]);
  const bash = bindExplicitDangerBoundary(createBashTool({ cwd: root }));
  const ran = await bash.execute(shellArgs("system.bash", { command: "printf '2,B\\n' >> proof.csv" }));
  expect(ran.isError, String(ran.content)).not.toBe(true);
  expect(await readFile(csv, "utf8")).toBe("1,A\n2,B\n");
  expect(await attachments()).toEqual([]);
});

test("a PowerShell command naming the file is the session's own too", async () => {
  const csv = join(root, "proof.csv");
  await write(csv, "1,A\n");
  expect(await attachments()).toEqual([]);
  // PowerShell runs through unified exec when a PowerShell binary is found; the
  // launch is intercepted here and does what the command would.
  await writeFile(join(root, "pwsh"), "");
  const launch = vi.spyOn(manager, "execCommand").mockImplementation(async () => {
    await writeFile(csv, `${await readFile(csv, "utf8")}2,B\n`);
    return completed();
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

test("a command names a file when the file name appears in it as a whole word", () => {
  const cases: Array<[string, string, boolean]> = [
    ["printf '2,B\\n' >> proof.csv", "/w/proof.csv", true],
    ["cat ./data/proof.csv | wc -l", "/w/data/proof.csv", true],
    ["python3 - <<'PY'\np = Path('src/durable-service.mjs')\nPY", "/w/src/durable-service.mjs", true],
    ["cat \"my notes.md\"", "/w/my notes.md", true],
    ["cp proof.csv.bak backup", "/w/proof.csv", false],
    ["cat xproof.csv", "/w/proof.csv", false],
    ["sleep 1; echo done", "/w/proof.csv", false],
    ["node scripts/capture.mjs", "/w/shots/hero.png", false],
  ];
  for (const [command, path, expected] of cases) {
    expect(commandNamesFile(command, path), `${command} / ${path}`).toBe(expected);
  }
});
