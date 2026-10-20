import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const delegateMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/agents/delegate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/agents/delegate.js")>()),
  delegate: delegateMock,
}));

import {
  recordAgentJobResult,
  runAgentsOnCsv,
} from "../../../src/agents/jobs/job-orchestrator.js";
import { createCsvInputRootCapability } from "../../../src/agents/jobs/csv-reader.js";
import { CsvAgentJobsRepositoryAuthority } from "../../../src/app-server/csv-agent-jobs-authority.js";
import { bindSessionAgentControl } from "../../../src/bin/delegate-tool.js";
import { createModelFacingTools } from "../../../src/bin/model-facing-tools.js";
import { createRequestUserInputTool } from "../../../src/elicitation/request-user-input.js";
import { resolveHomeContext } from "../../../src/config/home.js";
import { EventLog } from "../../../src/session/event-log.js";
import type { Session } from "../../../src/session/session.js";
import { resolveStateDatabasePaths } from "../../../src/state/sqlite-driver.js";
import { ToolRouter } from "../../../src/tools/router.js";
import { enforceRuntimeSandboxAttempt } from "../../../src/tools/runtimes/sandboxing.js";
import { createFileWriteTool } from "../../../src/tools/system/file-write.js";
import {
  SESSION_AGENC_HOME_ARG,
  withSignedSessionId,
} from "../../../src/tools/system/filesystem.js";
import { createMonitorTool } from "../../../src/tools/system/monitor.js";
import {
  __resetWorktreeSessionsForTesting,
  createEnterWorktreeTool,
  createExitWorktreeTool,
  worktreeWritesStayDeclared,
} from "../../../src/tools/system/worktree.js";
import type { Tool, ToolResult } from "../../../src/tools/types.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";

/**
 * Seven model-facing tools had no path argument and declared no write target,
 * so the runtime sandbox called their writes unverifiable and refused every
 * call under the default workspace_write sandbox (and read_only): Monitor,
 * EnterWorktree, ExitWorktree, WorkflowTool, report_agent_job_result,
 * resolve_csv_job_review and request_user_input. In a live default session
 * the five that open an approval card were then rerun with the sandbox
 * disabled after the user approved, and the CSV workers' reports (no card)
 * stayed refused, so every CSV item ended as an unknown outcome (job sb).
 *
 * Fixed without exemptions: Monitor's command is analysed like exec_command's;
 * the writers declare exactly where they write; request_user_input, which
 * writes nothing, gets the audited no-write classification.
 */
let root: string;
let cwd: string;
let home: string;
let sessionTempRoot: string;
let sandboxHelper: string;

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir, env: GIT_ENV, stdio: "ignore" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--initial-branch=main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "README.md");
  git(dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-sandbox-declared-")));
  cwd = join(root, "project");
  home = join(root, "home");
  sessionTempRoot = join(root, "session-tmp");
  sandboxHelper = join(root, "bin", "agenc-linux-sandbox");
  initRepo(cwd);
  mkdirSync(home);
  mkdirSync(sessionTempRoot);
  mkdirSync(join(root, "bin"));
  writeFileSync(sandboxHelper, "#!/bin/sh\nexit 1\n");
  chmodSync(sandboxHelper, 0o755);
  __resetWorktreeSessionsForTesting();
  delegateMock.mockReset();
});

afterEach(() => {
  __resetWorktreeSessionsForTesting();
  rmSync(root, { recursive: true, force: true });
});

/** Session services; `boundHome: null` leaves the session without a ConfigStore. */
function boundServices(boundHome: string | null) {
  return {
    admissionRequired: false,
    runtimeOptions: { sessionTempRoot },
    ...(boundHome === null
      ? {}
      : {
          configStore: {
            homeContext: resolveHomeContext(
              { AGENC_HOME: boundHome, HOME: boundHome },
              { platformHome: boundHome },
            ),
          },
        }),
  };
}

function tracker() {
  return { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} };
}

interface AttemptOptions {
  readonly sandboxMode?: "workspace_write" | "read_only";
  readonly boundHome?: string | null;
  readonly denyWrite?: readonly string[];
  readonly platformSandbox?: boolean;
  readonly cwd?: string;
}

/** The runtime sandbox decision for one call, as the executor makes it: "allow" or the refusal. */
function decide(tool: Tool, args: Record<string, unknown>, options: AttemptOptions = {}): string {
  const sandboxMode = options.sandboxMode ?? "workspace_write";
  const turnCwd = options.cwd ?? cwd;
  const turn = {
    cwd: turnCwd,
    ...(options.platformSandbox === false ? {} : { agencLinuxSandboxExe: sandboxHelper }),
    ...(options.denyWrite === undefined
      ? {}
      : {
          fileSystemSandboxPolicy: {
            allowWrite: [turnCwd],
            denyWrite: options.denyWrite,
            allowRead: [],
            denyRead: [],
          },
        }),
  };
  try {
    enforceRuntimeSandboxAttempt({
      tool,
      args,
      context: {
        callId: "declared-writes", toolName: tool.name, runtimeKind: "function",
        classification: { kind: "exclusive" }, supportsParallelToolCalls: false,
        source: "direct", submittedAtMs: 0, approvalPolicy: "never",
        requestedSandboxMode: sandboxMode, sandboxMode,
        approvalResolved: false, rawArgs: "{}",
        invocation: {
          session: {
            conversationId: "declared-writes-session",
            services: boundServices(options.boundHome === undefined ? home : options.boundHome),
          },
          turn,
          tracker: tracker(),
          callId: "declared-writes", toolName: { name: tool.name },
          payload: { kind: "function", arguments: "{}" }, source: "direct",
        },
      } as never,
    });
    return "allow";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function monitor(): Tool {
  return createMonitorTool({ cwd, unifiedExecManager: {} as never });
}

/** exec_command as the runtime sandbox sees it (name and metadata). */
function execCommand(): Tool {
  return {
    name: "exec_command",
    description: "",
    inputSchema: { type: "object" },
    metadata: { family: "terminal", source: "builtin", mutating: true },
    isReadOnly: false,
    recoveryCategory: "side-effecting",
    execute: async () => ({ content: "not reached" }),
  };
}

function stub(name: string, metadata: Tool["metadata"]): Tool {
  return {
    name,
    description: "",
    inputSchema: { type: "object" },
    metadata,
    execute: async () => ({ content: "not reached" }),
  };
}

function modelFacing(
  options: { readonly getSession?: () => Session | null; readonly authority?: boolean } = {},
): Map<string, Tool> {
  const tools = createModelFacingTools({
    workspaceRoot: cwd,
    agencHome: home,
    getSession: options.getSession ?? (() => null),
    env: {},
    ...(options.authority === false
      ? {}
      : { csvAgentJobsRepositories: new CsvAgentJobsRepositoryAuthority({ agencHome: home }) }),
  });
  return new Map(tools.map((tool) => [tool.name, tool] as const));
}

function routerSession(): Session {
  return {
    conversationId: "declared-writes-session",
    eventLog: new EventLog(),
    services: boundServices(home),
  } as unknown as Session;
}

function dispatcher(tools: readonly Tool[], session: Session) {
  const router = new ToolRouter(tools.map((tool) => ({ tool, supportsParallelToolCalls: false })));
  let call = 0;
  return (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    call += 1;
    return router.dispatchModelToolCall(
      { id: `call-declared-${call}`, name, arguments: JSON.stringify(args) },
      {
        session,
        turn: {
          subId: `turn-declared-${call}`,
          cwd,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "workspace_write" },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
      },
    );
  };
}

describe("Monitor command analysis", () => {
  it("admits a Monitor command under workspace_write with the platform sandbox", () => {
    const tool = monitor();
    expect(decide(tool, {
      command: "for i in 1 2 3; do echo tick $i; sleep 1; done",
      description: "Print three ticks",
    })).toBe("allow");
    expect(decide(tool, { command: "tail -f build.log", description: "Watch the build" })).toBe("allow");
    // Analysed, not exempted.
    expect(tool.metadata?.virtualNoFsWrites).not.toBe(true);
    expect(tool.metadata?.fixedWriteTargets).toBeUndefined();
    expect(tool.isReadOnly).not.toBe(true);
  });

  it("decides every command exactly like exec_command, in every mode", () => {
    const commands = [
      "ls",
      "cat README.md",
      "for i in 1 2 3; do echo tick $i; sleep 1; done",
      "tail -f build.log",
      "echo ok > out.txt",
      `echo x > ${join(root, "outside.txt")}`,
      "D=/tmp; echo x > $D/y",
      "echo x > .git/config",
      "rm -rf src",
      "cat ~/.ssh/id_rsa",
    ];
    const normalize = (decision: string, name: string) => decision.replaceAll(name, "<tool>");
    for (const command of commands) {
      for (const sandboxMode of ["workspace_write", "read_only"] as const) {
        for (const platformSandbox of [true, false]) {
          const options = { sandboxMode, platformSandbox };
          expect(
            normalize(decide(monitor(), { command, description: "d" }, options), "Monitor"),
            `${command} ${sandboxMode} platform=${platformSandbox}`,
          ).toBe(normalize(decide(execCommand(), { cmd: command }, options), "exec_command"));
        }
      }
    }
  });

  it("refuses writes outside the workspace, into denied paths, without a platform sandbox and under read_only", () => {
    const tool = monitor();
    expect(decide(tool, { command: `echo x > ${join(root, "outside.txt")}`, description: "d" }))
      .toMatch(/blocked write outside workspace: .*outside\.txt/);
    mkdirSync(join(cwd, "secret"));
    expect(decide(tool, { command: "echo x > secret/y", description: "d" }, { denyWrite: [join(cwd, "secret")] }))
      .toMatch(/blocked write outside workspace: .*secret/);
    expect(decide(tool, { command: "echo ok", description: "d" }, { platformSandbox: false }))
      .toMatch(/blocked Monitor without platform sandbox context/);
    expect(decide(tool, { command: "echo ok > out.txt", description: "d" }, { sandboxMode: "read_only" }))
      .toMatch(/read_only/);
  });

  it("analyses only the command Monitor runs, in the workspace it runs in", () => {
    // Monitor ignores cmd, cwd and workdir: a stray key cannot move or replace
    // the analysed command.
    expect(decide(monitor(), {
      command: "echo x > ../escape.txt",
      description: "d",
      cmd: "true",
      cwd: join(cwd, "a", "b"),
      workdir: join(cwd, "a", "b"),
    })).toMatch(/blocked write outside workspace: .*escape\.txt/);
  });
});

describe("EnterWorktree and ExitWorktree declare where git writes", () => {
  it("admits them under workspace_write by verifying the worktree store and the repository metadata", () => {
    const enter = createEnterWorktreeTool({ cwd });
    const exit = createExitWorktreeTool({ cwd });
    for (const tool of [enter, exit]) {
      expect(tool.metadata?.virtualNoFsWrites).not.toBe(true);
      expect(tool.metadata?.fixedWriteTargets?.()).toEqual([
        join(cwd, ".agenc", "worktrees"),
        join(cwd, ".git"),
      ]);
    }
    expect(decide(enter, { name: "demo" })).toBe("allow");
    expect(decide(exit, { action: "keep" })).toBe("allow");
    expect(decide(exit, { action: "remove", discard_changes: true })).toBe("allow");
    expect(decide(enter, { name: "demo" }, { sandboxMode: "read_only" }))
      .toBe("sandbox read_only blocked write-capable operation EnterWorktree");
    expect(decide(exit, { action: "keep" }, { sandboxMode: "read_only" }))
      .toBe("sandbox read_only blocked write-capable operation ExitWorktree");
  });

  it("keeps operator denies on the repository metadata and the worktree store", () => {
    const enter = createEnterWorktreeTool({ cwd });
    expect(decide(enter, { name: "demo" }, { denyWrite: [join(cwd, ".git")] }))
      .toMatch(/blocked write outside workspace: .*\.git/);
    expect(decide(enter, { name: "demo" }, { denyWrite: [join(cwd, ".agenc")] }))
      .toMatch(/blocked write outside workspace: .*worktrees/);
  });

  it("refuses a workspace inside a larger repository, whose worktrees would land outside it", () => {
    const inner = join(cwd, "packages", "inner");
    mkdirSync(inner, { recursive: true });
    const enter = createEnterWorktreeTool({ cwd: inner });
    expect(enter.metadata?.fixedWriteTargets?.()).toEqual([
      join(cwd, ".agenc", "worktrees"),
      join(cwd, ".git"),
    ]);
    expect(decide(enter, { name: "demo" }, { cwd: inner }))
      .toMatch(/blocked write outside workspace/);
  });

  it("keeps model-directed writes out of the same locations", () => {
    const write = createFileWriteTool({ allowedPaths: [cwd] });
    expect(decide(write, { file_path: join(cwd, ".agenc", "worktrees", "demo", "a.txt"), content: "x" }))
      .toMatch(/blocked write outside workspace/);
    expect(decide(write, { file_path: join(cwd, ".git", "config"), content: "x" }))
      .toMatch(/blocked write outside workspace/);
    expect(decide(execCommand(), { cmd: "echo x > .git/config" })).not.toBe("allow");
    // A declared .git or .agenc location of some other tool stays its own.
    expect(decide(stub("Declared", { mutating: true, fixedWriteTargets: () => [join(root, "elsewhere", ".git")] }), {}))
      .toMatch(/blocked write outside workspace/);
  });

  it("declares the repository git discovers, so an empty .git is walked past", () => {
    // An empty .git directory is not a repository: git walks past it to the
    // outer one, and so does the declaration. A workspace there is refused.
    const inner = join(cwd, "inner");
    mkdirSync(join(inner, ".git"), { recursive: true });
    const enter = createEnterWorktreeTool({ cwd: inner });
    expect(enter.metadata?.fixedWriteTargets?.()).toEqual([
      join(cwd, ".agenc", "worktrees"),
      join(cwd, ".git"),
    ]);
    expect(decide(enter, { name: "demo" }, { cwd: inner }))
      .toMatch(/blocked write outside workspace/);
  });

  it("refuses before any git mutation when git resolves another repository than the declared one", async () => {
    // GIT_DIR/GIT_WORK_TREE inherited by the daemon point git at another
    // repository: the worktree would land there, outside what the sandbox
    // verified for this workspace.
    const other = join(root, "other-repo");
    initRepo(other);
    expect(worktreeWritesStayDeclared(cwd, cwd)).toBe(true);
    expect(worktreeWritesStayDeclared(cwd, other)).toBe(false);
    const link = join(root, "project-link");
    symlinkSync(cwd, link);
    expect(worktreeWritesStayDeclared(link, cwd)).toBe(true);

    const enter = bindExplicitDangerBoundary(createEnterWorktreeTool({ cwd }));
    const args = {
      ...withSignedSessionId({ name: "demo" }, "declared-writes-session"),
      [SESSION_AGENC_HOME_ARG]: home,
    };
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    let result: ToolResult;
    try {
      result = await enter.execute(args);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.tree;
    }
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain(`git resolves the repository to ${other}`);
    expect(existsSync(join(other, ".agenc"))).toBe(false);
    expect(existsSync(join(cwd, ".agenc"))).toBe(false);
    expect(execFileSync("git", ["-C", other, "branch", "--list"], { env: GIT_ENV, encoding: "utf8" }))
      .not.toContain("demo");
  });

  it("still creates and removes its own worktree", async () => {
    const enter = bindExplicitDangerBoundary(createEnterWorktreeTool({ cwd }));
    const exit = bindExplicitDangerBoundary(createExitWorktreeTool({ cwd }));
    const session = (args: Record<string, unknown>) => ({
      ...withSignedSessionId(args, "declared-writes-session"),
      [SESSION_AGENC_HOME_ARG]: home,
    });
    const entered = await enter.execute(session({ name: "demo" }));
    expect(entered.isError).toBeUndefined();
    expect(existsSync(join(cwd, ".agenc", "worktrees", "demo", "README.md"))).toBe(true);
    const exited = await exit.execute(session({ action: "remove", discard_changes: true }));
    expect(exited.isError).toBeUndefined();
    expect(existsSync(join(cwd, ".agenc", "worktrees", "demo"))).toBe(false);
  });
});

describe("WorkflowTool and the CSV job tools declare their project stores", () => {
  it("admits WorkflowTool under workspace_write by verifying its databases and handoff store", () => {
    const tool = modelFacing().get("WorkflowTool")!;
    const paths = resolveStateDatabasePaths({ cwd, agencHome: home });
    expect(tool.metadata?.virtualNoFsWrites).not.toBe(true);
    expect(tool.metadata?.fixedWriteTargets?.()).toEqual([
      paths.stateDbPath,
      paths.logsDbPath,
      join(paths.projectDir, "workflow-handoffs"),
    ]);
    expect(decide(tool, { name: "hello" })).toBe("allow");
    expect(decide(tool, { name: "hello" }, { sandboxMode: "read_only" }))
      .toBe("sandbox read_only blocked write-capable operation WorkflowTool");
  });

  it.each(["report_agent_job_result", "resolve_csv_job_review"])(
    "admits %s under workspace_write by verifying the workspace's job store",
    (name) => {
      const tool = modelFacing().get(name)!;
      const store = new CsvAgentJobsRepositoryAuthority({ agencHome: home }).stateDatabasePath(cwd);
      expect(store).toBe(resolveStateDatabasePaths({ cwd, agencHome: home }).stateDbPath);
      expect(tool.metadata?.virtualNoFsWrites).not.toBe(true);
      expect(tool.metadata?.fixedWriteTargets?.()).toEqual([store]);
      expect(decide(tool, { job_id: "j", item_id: "i" })).toBe("allow");
      expect(decide(tool, { job_id: "j", item_id: "i" }, { sandboxMode: "read_only" }))
        .toBe(`sandbox read_only blocked write-capable operation ${name}`);
      // Without a repository authority that can name its store, nothing is
      // declared and the call stays unverifiable.
      expect(decide(modelFacing({ authority: false }).get(name)!, { job_id: "j", item_id: "i" }))
        .toBe(`sandbox workspace_write could not verify write targets for ${name}`);
    },
  );

  it("honors operator denies and the session's bound home for every project store", () => {
    const tools = modelFacing();
    const otherHome = join(root, "other-home");
    mkdirSync(otherHome);
    for (const name of ["WorkflowTool", "report_agent_job_result", "resolve_csv_job_review"]) {
      const tool = tools.get(name)!;
      expect(decide(tool, {}, { denyWrite: [home] }), name).toMatch(/blocked write outside workspace/);
      expect(decide(tool, {}, { denyWrite: [join(home, "projects")] }), name)
        .toMatch(/blocked write outside workspace/);
      expect(decide(tool, {}, { boundHome: null }), name).toMatch(/blocked write outside workspace/);
      expect(decide(tool, {}, { boundHome: otherHome }), name).toMatch(/blocked write outside workspace/);
    }
  });

  it("admits a declared project store only by its exact name and depth", () => {
    const projectDir = resolveStateDatabasePaths({ cwd, agencHome: home }).projectDir;
    for (const target of [
      join(projectDir, "sessions"),
      join(projectDir, "memory"),
      join(projectDir, "file-history"),
      join(projectDir, "agenc-state_1.sqlite", "nested"),
      join(projectDir, "workflow-handoffs", "artifact"),
      join(projectDir, "agenc-state_2.sqlite"),
      join(home, "agenc-state_1.sqlite"),
      join(home, "projects", "agenc-state_1.sqlite"),
      join(root, "elsewhere", ".agenc", "projects", "x", "agenc-state_1.sqlite"),
    ]) {
      expect(decide(stub("Declared", { mutating: true, fixedWriteTargets: () => [target] }), {}), target)
        .toMatch(/blocked write outside workspace/);
    }
    // The same stores stay closed to model-directed and shell writes.
    const state = join(projectDir, "agenc-state_1.sqlite");
    const write = createFileWriteTool({ allowedPaths: [cwd] });
    expect(decide(write, { file_path: state, content: "x" })).toMatch(/blocked write outside workspace/);
    expect(decide(execCommand(), { cmd: `printf x > ${state}` })).toMatch(/blocked/);
  });

  it("runs a workflow under the workspace_write sandbox", async () => {
    mkdirSync(join(cwd, ".agenc", "workflows"), { recursive: true });
    writeFileSync(
      join(cwd, ".agenc", "workflows", "hello.json"),
      JSON.stringify({ format_version: 2, kind: "agent_dag", steps: [{ id: "greet", message: "Say HELLO" }] }),
      { mode: 0o600 },
    );
    const session = routerSession();
    bindSessionAgentControl(session, {
      control: { shutdown: vi.fn(async () => {}) } as never,
      registry: { maxThreads: 64, acquireSpawnPermit: vi.fn(async () => ({ cancel: vi.fn() })) } as never,
    });
    delegateMock.mockImplementation(async (options: {
      readonly agentName?: string;
      readonly finalMessageSink: { reset(): void; writeCanonicalDelta(delta: string): void };
    }) => ({
      kind: "async_launched",
      thread: {
        threadId: `thread-${options.agentName ?? "step"}`,
        live: { agentId: "agent", abortController: new AbortController(), status: { value: { status: "running" } } },
        async join() {
          options.finalMessageSink.reset();
          options.finalMessageSink.writeCanonicalDelta("HELLO");
          return { threadId: `thread-${options.agentName ?? "step"}`, durationMs: 1, outcome: "completed" as const };
        },
      },
    }));
    const tools = modelFacing({ getSession: () => session });
    const dispatch = dispatcher([tools.get("WorkflowTool")!], session);

    const result = await dispatch("WorkflowTool", { name: "hello" });

    expect(result.content).not.toMatch(/could not verify write targets/);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('"outcome":"completed"');
    expect(result.content).toContain('"preview":"HELLO"');
    const handoffs = join(resolveStateDatabasePaths({ cwd, agencHome: home }).projectDir, "workflow-handoffs");
    expect(existsSync(handoffs)).toBe(true);
    expect(readdirSync(cwd).sort()).toEqual([".agenc", ".git", "README.md"]);
  });

  it("dispatches a CSV worker report under the workspace_write sandbox", async () => {
    const session = routerSession();
    const dispatch = dispatcher([...modelFacing().values()], session);

    const report = await dispatch("report_agent_job_result", {
      job_id: "csv_job_unknown",
      item_id: "csv_item_unknown",
      result: { upper: "ADA" },
    });

    expect(report.content).not.toMatch(/could not verify write targets/);
    expect(report.content).toContain("unknown job_id: csv_job_unknown");
  });

  it("records a worker result in this workspace's job and refuses a job that records elsewhere", async () => {
    const report = modelFacing().get("report_agent_job_result")!;
    writeFileSync(join(cwd, "people.csv"), "name\nada\n");
    const runJob = async (authority: CsvAgentJobsRepositoryAuthority, workspace: string) => {
      const reports: ToolResult[] = [];
      await authority.withRepository(workspace, (repository) =>
        runAgentsOnCsv({
          csvPath: join(cwd, "people.csv"),
          inputRootCapability: createCsvInputRootCapability(cwd),
          instruction: "Return the name in uppercase",
          repository,
          spawn: {
            async spawn(ctx) {
              queueMicrotask(() => {
                void (async () => {
                  const result = await report.execute({
                    job_id: ctx.jobId,
                    item_id: ctx.itemId,
                    result: { upper: "ADA" },
                  });
                  reports.push(result);
                  if (result.isError) {
                    recordAgentJobResult({ jobId: ctx.jobId, itemId: ctx.itemId, result: { upper: "direct" } });
                  }
                })();
              });
            },
            async cancelOutstanding() {},
          },
        }));
      await authority.close();
      return reports;
    };

    // The job runs in this workspace's store: the report is recorded.
    const own = await runJob(new CsvAgentJobsRepositoryAuthority({ agencHome: home }), cwd);
    expect(own.map((result) => result.content)).toEqual([JSON.stringify({ status: "recorded" })]);

    // A job recording in another home's store is refused with no effect.
    const otherHome = join(root, "other-home");
    mkdirSync(otherHome);
    const other = await runJob(new CsvAgentJobsRepositoryAuthority({ agencHome: otherHome }), cwd);
    expect(other).toHaveLength(1);
    expect(other[0]!.isError).toBe(true);
    expect(String(other[0]!.content)).toContain("records its results outside this workspace's job store");
  });
});

describe("request_user_input writes nothing", () => {
  it("is admitted under every sandbox mode by its audited no-write classification", () => {
    const tool = modelFacing().get("request_user_input")!;
    expect(tool.metadata?.virtualNoFsWrites).toBe(true);
    expect(tool.metadata?.fixedWriteTargets).toBeUndefined();
    const args = { questions: [{ id: "color", header: "Color", question: "Which color?" }] };
    expect(decide(tool, args)).toBe("allow");
    expect(decide(tool, args, { sandboxMode: "read_only" })).toBe("allow");
  });

  it("asks through the session and leaves the workspace and home untouched", async () => {
    const asked: unknown[] = [];
    const session = {
      features: { enabled: () => false },
      permissionModeRegistry: { current: () => ({ mode: "plan" }) },
      sessionConfiguration: { sessionSource: "cli" },
      async requestUserInput(_callId: string, args: unknown) {
        asked.push(args);
        return { answers: { color: { answers: ["blue"] } } };
      },
    } as unknown as Session;
    const tool = createRequestUserInputTool({ getSession: () => session as never });
    const before = [readdirSync(cwd).sort(), readdirSync(home).sort()];

    const result = await tool.execute({
      questions: [{ id: "color", header: "Color", question: "Which color?" }],
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("blue");
    expect(asked).toHaveLength(1);
    expect([readdirSync(cwd).sort(), readdirSync(home).sort()]).toEqual(before);
  });
});
