/**
 * Existing Edit hooks read `tool_input.file_path`. DeepSeek Light's batch Edit names its target
 * `path`, so the hook-facing input also carries `file_path`, and a hook that echoes or rewrites the
 * input through `file_path` still yields a valid batch Edit that executes.
 */
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../../src/services/lsp/fileNotifications.js", () => ({
  notifyLspFileChanged: vi.fn(),
  collectEditFeedback: vi.fn(async () => ""),
}));

import { ConfiguredHooksRuntime, type HookInstallTarget } from "../../src/hooks/configured-hooks.js";
import { createHookExecutionAuthority } from "../../src/hooks/execution-authority.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { runToolUse } from "../../src/tools/execution.js";
import { createFileBatchEditTool } from "../../src/tools/system/file-edit.js";
import { clearSessionReadState, recordSessionRead, SESSION_ID_ARG } from "../../src/tools/system/filesystem.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import type { Tool } from "../../src/tools/types.js";

const SESSION_ID = "batch-edit-hook-compat";
let root = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-batch-edit-hook-")));
});

afterEach(async () => {
  clearSessionReadState(SESSION_ID, tmpdir());
  await rm(root, { recursive: true, force: true });
});

function hooksWith(command: string): HookInstallTarget {
  const runtime = new ConfiguredHooksRuntime({
    cwd: root,
    env: process.env,
    agencHome: join(root, ".agenc-home"),
    shellPath: process.env.SHELL ?? "/bin/sh",
    executionAuthority: createHookExecutionAuthority({
      runtimeOptions: { simpleMode: false, allowUntrustedHooks: false },
      isWorkspaceTrusted: () => true,
    }),
    admissionRequired: false,
    sandboxExecutionBroker: new SandboxExecutionBroker({ mode: "danger_full_access", cwd: root }),
  });
  const target: HookInstallTarget = {
    preToolUseHooks: [],
    postToolUseHooks: [],
    failureToolUseHooks: [],
    permissionDecisionHooks: [],
    userPromptSubmitHooks: [],
    stopHooks: [],
    stopFailureHooks: [],
  };
  runtime.attachTarget(target);
  (runtime as unknown as { loadForTesting(raw: unknown): void }).loadForTesting({
    PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command }] }],
  });
  return target;
}

/** A user hook written for the classic Edit input: it needs file_path and echoes the input back. */
function classicHook(rewrite: string): string {
  return "node -e 'let s=\"\"; process.stdin.on(\"data\", c => s += c); process.stdin.on(\"end\", () => { " +
    "const input = JSON.parse(s).tool_input; " +
    "if (typeof input.file_path !== \"string\") { process.stderr.write(\"no file_path\"); process.exit(2); } " +
    rewrite + "; " +
    "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: \"PreToolUse\", updatedInput: input } })); })'";
}

async function seed(name: string, content: string): Promise<string> {
  const file = join(root, name);
  await writeFile(file, content, "utf8");
  recordSessionRead(SESSION_ID, file, { content, timestamp: (await stat(file)).mtimeMs, viewKind: "full" });
  return file;
}

async function run(target: HookInstallTarget, args: Record<string, unknown>) {
  const real = createFileBatchEditTool({ allowedPaths: [root], lightMode: true });
  const tool: Tool = { ...real, execute: (input) => real.execute({ ...input, [SESSION_ID_ARG]: SESSION_ID }) };
  const raw = JSON.stringify(args);
  const invocation: ToolInvocation = {
    session: { eventLog: new EventLog(), services: { admissionRequired: false, runtimeOptions: resolveAgentRuntimeOptions({}) } } as never,
    turn: { cwd: root } as never,
    tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
    callId: "c1",
    toolName: { name: "Edit" },
    payload: { kind: "function", arguments: raw },
    source: "direct",
  };
  return runToolUse(raw, {
    tool,
    invocation,
    currentTurnId: "t1",
    eventLog: invocation.session.eventLog,
    preHooks: target.preToolUseHooks,
    approvalResolver: { request: async () => ({ kind: "approved" }) },
  });
}

test("a classic Edit hook that requires file_path and echoes the input lets the batch Edit run", async () => {
  const file = await seed("notes.txt", "alpha\nbeta\n");
  const result = await run(hooksWith(classicHook("void 0")), {
    path: file,
    edits: [{ oldText: "alpha", newText: "one" }, { oldText: "beta", newText: "two" }],
  });
  expect(result.isError).not.toBe(true);
  expect(await readFile(file, "utf8")).toBe("one\ntwo\n");
});

test("a classic Edit hook that redirects file_path redirects the batch Edit", async () => {
  const original = await seed("original.txt", "alpha\n");
  const redirected = await seed("redirected.txt", "alpha\n");
  const result = await run(hooksWith(classicHook(`input.file_path = ${JSON.stringify(redirected)}`)), {
    path: original,
    edits: [{ oldText: "alpha", newText: "one" }],
  });
  expect(result.isError).not.toBe(true);
  expect(await readFile(original, "utf8")).toBe("alpha\n");
  expect(await readFile(redirected, "utf8")).toBe("one\n");
});
