import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { AgentStatusTracker } from "../agents/status.js";
import { Mailbox } from "../agents/mailbox.js";
import type { LiveAgent } from "../agents/control.js";
import { resolveAgentRole } from "../agents/role.js";
import { AgentThread } from "../agents/thread.js";
import type { AgentMetadata } from "../agents/registry.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { trustProjectSync } from "../permissions/trust/project-trust.js";
import type { AgenCShutdownSignal } from "../lifecycle/signal-handlers.js";
import { openStateDatabases } from "../state/sqlite-driver.js";
import { createAgenCJsonLineDaemonRequestClient } from "./agent-cli.js";
import {
  readAgenCDaemonPid,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonPidPath,
  resolveAgenCDaemonSocketPath,
  runAgenCDaemonCli,
  type AgenCDaemonCliHost,
  type AgenCDaemonCliIo,
} from "./daemon-cli.js";
import {
  AgenCDelegateBackgroundAgentRunner,
  type AgenCBackgroundAgentRunner,
  type AgenCBootstrapFunction,
  type AgenCDelegateFunction,
  type AgenCEnsureAgentControlFunction,
  type AgenCRunAgentFunction,
} from "./background-agent-runner.js";

const execFileAsync = promisify(execFile);
const requireForTest = createRequire(import.meta.url);

function createIo(): AgenCDaemonCliIo & {
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

function createHost(agencHome: string): AgenCDaemonCliHost {
  return {
    env: {
      AGENC_HOME: agencHome,
    },
    userHome: "/home/test",
    entrypointPath: "/opt/agenc/bin/agenc.js",
    execPath: "/usr/bin/node",
    pid: 4100,
    spawnDetachedDaemon: () => 4201,
    isPidRunning: (pid) => pid === 4100 || pid === 4201,
    terminatePid: () => {},
    sleep: async () => {},
  };
}

function createSignalProcess() {
  const listeners = new Map<AgenCShutdownSignal, Set<() => void>>();
  return {
    once: (signal: AgenCShutdownSignal, listener: () => void) => {
      let set = listeners.get(signal);
      if (set === undefined) {
        set = new Set();
        listeners.set(signal, set);
      }
      set.add(listener);
    },
    removeListener: (signal: AgenCShutdownSignal, listener: () => void) => {
      listeners.get(signal)?.delete(listener);
    },
    emit(signal: AgenCShutdownSignal): void {
      for (const listener of [...(listeners.get(signal) ?? [])]) {
        listener();
      }
    },
  };
}

function restoredLiveAgent(
  agentId: string,
  agentPath = `/root/${agentId}`,
): LiveAgent {
  const metadata: AgentMetadata = {
    agentId,
    agentPath,
    agentNickname: agentId,
    agentRole: "default",
    depth: 1,
  };
  return {
    agentId,
    agentPath,
    role: resolveAgentRole(undefined),
    depth: 1,
    nickname: agentId,
    status: new AgentStatusTracker(),
    upInbox: new Mailbox({ threadId: agentId }),
    downInbox: new Mailbox({ threadId: `${agentId}-down` }),
    abortController: new AbortController(),
    metadata,
    messages: [],
    memoryEntries: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

async function waitForPid(pidPath: string): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const pid = await readAgenCDaemonPid(pidPath);
    if (pid !== null) return pid;
    await delay(10);
  }
  throw new Error("timed out waiting for daemon pid");
}

async function waitForSnapshotCount(
  agencHome: string,
  cwd: string,
  sessionId: string,
  minimum: number,
): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const count = snapshotCount(agencHome, cwd, sessionId);
    if (count >= minimum) return count;
    await delay(10);
  }
  throw new Error(`timed out waiting for snapshots for ${sessionId}`);
}

async function waitForFile(path: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

type RunningDaemon = {
  readonly signalProcess: ReturnType<typeof createSignalProcess>;
  readonly running: Promise<number>;
};

async function startForegroundDaemon(
  agencHome: string,
  runner: AgenCBackgroundAgentRunner,
): Promise<RunningDaemon> {
  const host = createHost(agencHome);
  const io = createIo();
  const signalProcess = createSignalProcess();
  const running = runAgenCDaemonCli(
    { kind: "command", action: "run" },
    { host, io, signalProcess, runner },
  );
  await expect(waitForPid(resolveAgenCDaemonPidPath(host.env, host.userHome)))
    .resolves.toBe(4100);
  return { signalProcess, running };
}

async function stopForegroundDaemon(daemon: RunningDaemon): Promise<void> {
  daemon.signalProcess.emit("SIGTERM");
  await expect(daemon.running).resolves.toBe(0);
}

async function daemonAuthCookie(agencHome: string): Promise<string> {
  const cookiePath = resolveAgenCDaemonCookiePath({ AGENC_HOME: agencHome });
  return (await readFile(cookiePath, "utf8")).trim();
}

function simulateCrashPersistedRunningAgent(
  agencHome: string,
  cwd: string,
  runId: string,
  sessionId: string,
): void {
  // The in-process foreground daemon harness can only stop gracefully. Restore
  // the persisted shape a process crash would leave: a running agent row with
  // its last session still current, ready for startup recovery to hydrate.
  const driver = openStateDatabases({ cwd, agencHome });
  try {
    driver
      .prepareState<[string, string]>(
        `UPDATE agent_runs
         SET status = 'running',
             current_session_id = ?
         WHERE id = ?`,
      )
      .run(sessionId, runId);
  } finally {
    driver.close();
  }
}

function readAgentRunStatus(
  agencHome: string,
  cwd: string,
  runId: string,
): string | undefined {
  const driver = openStateDatabases({ cwd, agencHome });
  try {
    return driver
      .prepareState<[string], { status: string }>(
        `SELECT status
         FROM agent_runs
         WHERE id = ?`,
      )
      .get(runId)?.status;
  } finally {
    driver.close();
  }
}

function snapshotCount(
  agencHome: string,
  cwd: string,
  sessionId: string,
): number {
  const driver = openStateDatabases({ cwd, agencHome });
  try {
    return (
      driver
        .prepareState<[string], { count: number }>(
          `SELECT COUNT(*) AS count
           FROM session_state_snapshots
           WHERE session_id = ?`,
        )
        .get(sessionId)?.count ?? 0
    );
  } finally {
    driver.close();
  }
}

async function writeAgencProcessEntry(
  workspace: string,
  agentCliSourcePath: string,
): Promise<{ entryPath: string; loaderPath: string }> {
  const entryPath = join(workspace, "agenc-entry.mjs");
  const loaderPath = join(workspace, "md-loader.mjs");
  await writeFile(
    loaderPath,
    [
      "export async function load(url, context, nextLoad) {",
      "  if (url.endsWith('.md')) {",
      "    return { format: 'module', source: 'export default \"\";', shortCircuit: true };",
      "  }",
      "  return nextLoad(url, context);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    entryPath,
    [
      "import { pathToFileURL } from 'node:url';",
      `const mod = await import(pathToFileURL(${JSON.stringify(agentCliSourcePath)}).href);`,
      "const command = mod.parseAgenCAgentCliArgs(process.argv.slice(2));",
      "if (command === null) {",
      "  process.stderr.write('agenc: command was not routed to agent CLI\\n');",
      "  process.exit(2);",
      "}",
      "const code = await mod.runAgenCAgentCli(command, {",
      "  cwd: process.cwd(),",
      "  env: process.env,",
      "});",
      "process.exit(code);",
      "",
    ].join("\n"),
    "utf8",
  );
  return { entryPath, loaderPath };
}

async function runAgencProcess(params: {
  readonly entryPath: string;
  readonly loaderPath: string;
  readonly workspace: string;
  readonly agencHome: string;
  readonly args: readonly string[];
}): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(
    process.execPath,
    [
      "--loader",
      params.loaderPath,
      "--import",
      requireForTest.resolve("tsx"),
      params.entryPath,
      ...params.args,
    ],
    {
      cwd: params.workspace,
      env: {
        ...process.env,
        AGENC_HOME: params.agencHome,
        AGENC_DAEMON_AUTOSTART: "0",
        AGENC_CLI_ENTRY_DISABLE: "1",
        HOME: params.agencHome,
        NODE_OPTIONS: "--no-warnings",
      },
      timeout: 5_000,
    },
  );
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

async function writeSmallCCompiler(compilerPath: string): Promise<void> {
  await writeFile(
    compilerPath,
    [
      "#!/usr/bin/env node",
      "const { chmodSync, readFileSync, writeFileSync } = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const inputPath = args[0];",
      "const outputFlagIndex = args.indexOf('-o');",
      "const outputPath = outputFlagIndex >= 0 ? args[outputFlagIndex + 1] : 'a.out';",
      "if (!inputPath || !outputPath) {",
      "  console.error('usage: smallcc <source.c> -o <program>');",
      "  process.exit(64);",
      "}",
      "const source = readFileSync(inputPath, 'utf8');",
      "const match = /return\\s+(-?\\d+)\\s*;/.exec(source);",
      "if (!match) {",
      "  console.error('smallcc supports integer return statements');",
      "  process.exit(65);",
      "}",
      "const exitCode = Number(match[1]);",
      "writeFileSync(outputPath, '#!/usr/bin/env node\\nprocess.exit(' + JSON.stringify(exitCode) + ');\\n');",
      "chmodSync(outputPath, 0o755);",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(compilerPath, 0o755);
}

function createCompilerRunner(params: {
  readonly agentId: string;
  readonly workspace: string;
  readonly compilerPath: string;
  readonly incrementRestoreRunCount: () => number;
}): AgenCBackgroundAgentRunner {
  const permissionModeRegistry = {
    current: () => createEmptyToolPermissionContext(),
    update: vi.fn(async () => {}),
  };
  const bootstrap = (async () => ({
    session: {
      conversationId: "compiler-e2e",
      permissionModeRegistry,
      services: {},
    },
    registry: {},
    shutdown: async () => {},
  })) as AgenCBootstrapFunction;
  const live = restoredLiveAgent(params.agentId, `/root/${params.agentId}`);
  const control = {
    resumeAgentFromRollout: vi.fn(async () => ({
      resumedCount: 1,
      rootLive: live,
    })),
    sendInput: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {
      live.status.markInterrupted("compiler-e2e", "daemon shutdown");
    }),
    interrupt: vi.fn(),
  };
  const ensureAgentControl = (() => ({
    control,
    registry: {},
  })) as AgenCEnsureAgentControlFunction;
  const delegateFn = (async (opts) => {
    const thread = new AgentThread(
      {
        live,
        initialMessages: [],
        taskPrompt: opts.taskPrompt,
      },
      {
        parent: opts.parent,
        control,
        registry: opts.registry,
        parentPath: opts.parentPath,
        joinPromise: new Promise(() => {}),
      },
    );
    await writeFile(
      join(params.workspace, "agent-started.txt"),
      `${opts.taskPrompt}\n`,
      "utf8",
    );
    return { kind: "async_launched", thread };
  }) as AgenCDelegateFunction;
  const runAgentFn = (async function* (runParams) {
    const runNumber = params.incrementRestoreRunCount();
    runParams.live.status.markRunning(`compiler-restore-${runNumber}`);
    yield { kind: "status", text: `restore ${runNumber}` };
    if (runNumber >= 2) {
      await writeSmallCCompiler(params.compilerPath);
    }
    await new Promise(() => {});
  }) as AgenCRunAgentFunction;

  return new AgenCDelegateBackgroundAgentRunner({
    bootstrap,
    delegateFn,
    ensureAgentControl,
    runAgentFn,
    now: () => "2026-05-01T12:00:00.000Z",
  });
}

describe("canonical agent c-compiler e2e", () => {
  it("runs agenc agent start across multiple daemon restarts and produces a working compiler", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-c-compiler-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-c-compiler-work-"));
    await mkdir(join(workspace, ".git"));
    const processEntry = await writeAgencProcessEntry(
      workspace,
      join(process.cwd(), "src/app-server/agent-cli.ts"),
    );
    const agentId = "agent-small-c-compiler";
    const compilerPath = join(workspace, "smallcc");
    const runningDaemons = new Set<RunningDaemon>();
    let restoreRunCount = 0;
    const runner = createCompilerRunner({
      agentId,
      workspace,
      compilerPath,
      incrementRestoreRunCount: () => {
        restoreRunCount += 1;
        return restoreRunCount;
      },
    });
    const env = {
      AGENC_HOME: agencHome,
      HOME: agencHome,
    };

    try {
      trustProjectSync({ agencHome, projectRoot: workspace, env });
      const first = await startForegroundDaemon(agencHome, runner);
      runningDaemons.add(first);
      const startResult = await runAgencProcess({
        entryPath: processEntry.entryPath,
        loaderPath: processEntry.loaderPath,
        workspace,
        agencHome,
        args: ["agent", "start", "build a small c compiler"],
      });
      expect(startResult).toEqual({
        stdout: `${agentId}\n`,
        stderr: "",
      });

      const firstCookie = await daemonAuthCookie(agencHome);
      const socketPath = resolveAgenCDaemonSocketPath({ AGENC_HOME: agencHome });
      const firstClient = createAgenCJsonLineDaemonRequestClient({
        socketPath,
        authCookie: firstCookie,
        timeoutMs: 1000,
      });
      const firstList = await firstClient.request("agent.list", {});
      expect(firstList.agents).toEqual([
        expect.objectContaining({
          agentId,
          objective: "build a small c compiler",
          status: "running",
        }),
      ]);
      const sessionId = firstList.agents[0]?.activeSessionIds?.[0];
      if (sessionId === undefined) throw new Error("session id missing");
      await expect(
        waitForSnapshotCount(agencHome, workspace, sessionId, 1),
      ).resolves.toBeGreaterThanOrEqual(1);
      expect(readAgentRunStatus(agencHome, workspace, agentId)).toBe("running");

      await stopForegroundDaemon(first);
      runningDaemons.delete(first);
      simulateCrashPersistedRunningAgent(
        agencHome,
        workspace,
        agentId,
        sessionId,
      );

      const second = await startForegroundDaemon(agencHome, runner);
      runningDaemons.add(second);
      expect(restoreRunCount).toBe(1);
      await stopForegroundDaemon(second);
      runningDaemons.delete(second);
      simulateCrashPersistedRunningAgent(
        agencHome,
        workspace,
        agentId,
        sessionId,
      );

      const third = await startForegroundDaemon(agencHome, runner);
      runningDaemons.add(third);
      await waitForFile(compilerPath);
      expect(restoreRunCount).toBe(2);
      const thirdCookie = await daemonAuthCookie(agencHome);
      const thirdClient = createAgenCJsonLineDaemonRequestClient({
        socketPath,
        authCookie: thirdCookie,
        timeoutMs: 1000,
      });
      const recoveredList = await thirdClient.request("agent.list", {});
      expect(recoveredList.agents).toEqual([
        expect.objectContaining({
          agentId,
          objective: "build a small c compiler",
          metadata: expect.objectContaining({
            recovery: expect.objectContaining({
              runtimeRestore: "available",
              runnable: true,
            }),
          }),
        }),
      ]);

      const programSource = join(workspace, "hello.c");
      const programPath = join(workspace, "hello");
      await writeFile(
        programSource,
        [
          "int main(void) {",
          "  return 7;",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      await expect(
        execFileAsync(compilerPath, [programSource, "-o", programPath], {
          cwd: workspace,
        }),
      ).resolves.toMatchObject({ stdout: "" });
      await expect(execFileAsync(programPath, [], { cwd: workspace }))
        .rejects.toMatchObject({ code: 7 });

      await stopForegroundDaemon(third);
      runningDaemons.delete(third);
    } finally {
      for (const daemon of runningDaemons) {
        daemon.signalProcess.emit("SIGTERM");
        await daemon.running.catch(() => {});
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(agencHome, { recursive: true, force: true });
    }
  });
});
