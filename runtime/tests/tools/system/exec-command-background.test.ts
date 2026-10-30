import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createExecCommandTool as createUnboundExecCommandTool } from "../../../src/tools/system/exec-command.js";
import { createWriteStdinTool as createUnboundWriteStdinTool } from "../../../src/tools/system/write-stdin.js";
import { UnifiedExecProcessManager } from "../../../src/unified-exec/process-manager.js";
import { buildToolRegistry } from "../../../src/tool-registry.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";

// exec_command's process model after Terminal-Bench (AgenC 0.19.19 vs the
// DeepSeek harness): a timeoutMs that passes leaves the command running as a
// session, `background: true` starts a tracked session, a `nohup`/trailing `&`
// job that would be stopped on return is refused before anything runs, and a
// background session that ends is reported on a later result.

let root: string;
let manager: UnifiedExecProcessManager;
const conversation = (): string => `exec-bg-${Math.random()}`;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "exec-command-bg-")));
  manager = new UnifiedExecProcessManager({ cwd: root });
});

afterEach(async () => {
  await manager.closeAll("test_cleanup");
  rmSync(root, { recursive: true, force: true });
});

function tools() {
  return {
    exec: bindExplicitDangerBoundary(createUnboundExecCommandTool({
      cwd: root, allowedPaths: [root], unifiedExecManager: manager,
    })),
    poll: bindExplicitDangerBoundary(createUnboundWriteStdinTool({
      cwd: root, unifiedExecManager: manager,
    })),
  };
}

describe("unwaited background jobs", () => {
  test.each([
    ["nohup", "touch started-anyway; nohup sleep 30 > /dev/null 2>&1 &\necho launched"],
    ["trailing", "touch started-anyway; sleep 30 > job.log 2>&1 &"],
  ])("refuses a %s job before anything runs and names background: true", async (_kind, cmd) => {
    const { exec } = tools();
    const failure = exec.preflight!({ cmd });
    expect(failure).toMatchObject({ code: "background-job" });
    expect(failure!.message).toContain("background: true");

    const result = await exec.execute({ cmd, __agencSessionId: conversation() });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("This command has not started");
    expect(result.content).toContain("background: true");
    expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
    await delay(200);
    expect(existsSync(join(root, "started-anyway"))).toBe(false);
  });

  test.each([
    "sleep 0.1 & sleep 0.1 & wait; echo waited",
    "sleep 5 & pid=$!; echo checked; kill $pid",
    "echo 'nohup x &'",
  ])("runs a job the command waits for or stops, and quoted text: %s", async (cmd) => {
    const { exec } = tools();
    expect(exec.preflight!({ cmd })).toBeNull();
    const result = await exec.execute({ cmd, __agencSessionId: conversation() });
    expect(result.isError).toBeUndefined();
  });

  test("leaves detach and tty commands to their own rules", () => {
    const { exec } = tools();
    expect(exec.preflight!({ cmd: "nohup server &", detach: true })).toBeNull();
    expect(exec.preflight!({ cmd: "nohup server &", tty: true })).toBeNull();
  });
});

describe("background: true", () => {
  test("returns a live session at once and says how it is reported, once per conversation", async () => {
    const { exec } = tools();
    const session = conversation();
    const startedAt = Date.now();
    const started = await exec.execute({ cmd: "sleep 30", background: true, __agencSessionId: session });
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(started.isError).toBeUndefined();
    const sessionId = (started.codeModeResult as { session_id?: number }).session_id!;
    expect(sessionId).toEqual(expect.any(Number));
    expect(started.content).toContain(`[note: session ${sessionId} runs in the background.`);
    expect(started.metadata).toMatchObject({ background: true, sessionId });

    // `job & sleep N` looks like a server check that waited a fixed time; a
    // background start gets no server-check note.
    const second = await exec.execute({ cmd: "sleep 70 & sleep 30; wait", background: true, __agencSessionId: session });
    expect((second.codeModeResult as { session_id?: number }).session_id).toEqual(expect.any(Number));
    expect(second.content).not.toContain("runs in the background");
    expect(second.content).not.toContain("To check a server");
  });

  test("a later result reports the end of a background session once", async () => {
    const { exec, poll } = tools();
    const session = conversation();
    const started = await exec.execute({
      cmd: "sleep 1.5; echo background-finished", background: true, __agencSessionId: session,
    });
    const sessionId = (started.codeModeResult as { session_id?: number }).session_id!;
    expect(sessionId).toEqual(expect.any(Number));
    await delay(2_200);
    const next = await exec.execute({ cmd: "echo next", __agencSessionId: session });
    expect(next.content).toMatch(new RegExp(
      `\\[session ${sessionId} ended after \\d+s: exit 0 \\(\`sleep 1\\.5; echo background-finished\`\\)\\. write_stdin session_id=${sessionId} returns its remaining output\\.\\]`,
    ));
    expect(next.metadata).toMatchObject({ endedSessions: [sessionId] });
    const output = await poll.execute({ session_id: sessionId, chars: "", __agencSessionId: session });
    expect(output.content).toContain("background-finished");
    // Reported once: the poll that collected the output does not repeat it.
    expect(output.content).not.toContain(`[session ${sessionId} ended`);
  }, 15_000);

  test("is refused together with detach", () => {
    const { exec } = tools();
    expect(exec.preflight!({ cmd: "sleep 1", background: true, detach: true })).toMatchObject({
      code: "invalid-input",
    });
  });
});

describe("timeoutMs", () => {
  test("keeps a command that reaches it running as a session instead of stopping it", async () => {
    const { exec, poll } = tools();
    const session = conversation();
    const result = await exec.execute({
      cmd: "sleep 1; echo outlived-timeout", timeoutMs: 300, yield_time_ms: 10_000, __agencSessionId: session,
    });
    expect(result.isError).toBeUndefined();
    const sessionId = (result.codeModeResult as { session_id?: number }).session_id!;
    expect(sessionId).toEqual(expect.any(Number));
    expect(result.content).toContain(
      `[note: timeoutMs=300 passed and the command is still running; AgenC kept it running as session ${sessionId} instead of stopping it.`,
    );
    expect(result.metadata).toMatchObject({ timeoutBackgroundedMs: 300 });
    const finished = await poll.execute({
      session_id: sessionId, chars: "", yield_time_ms: 5_000, __agencSessionId: session,
    });
    expect(finished.content).toContain("outlived-timeout");
    expect(finished.content).toContain("[exec exit_code=0");
  });
});

describe("Light schema", () => {
  test("the lean exec_command schema offers background and states the timeout plainly", () => {
    const lean = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true }).toLLMTools()
      .find((tool) => tool.function.name === "exec_command")!;
    const properties = lean.function.parameters.properties as Record<string, { description?: string }>;
    expect(Object.keys(properties).sort()).toEqual(["background", "cmd", "timeoutMs", "workdir"]);
    expect(properties.timeoutMs!.description).not.toContain("Hard timeout");
    expect(lean.function.description).toContain("Long jobs: background=true, never & or nohup");
    expect(properties.background).toEqual({ type: "boolean" });
  });
});
