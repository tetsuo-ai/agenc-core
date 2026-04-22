import { Writable } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runInitCommand } = vi.hoisted(() => ({
  runInitCommand: vi.fn(async () => 0),
}));
const { runOnboardCommand } = vi.hoisted(() => ({
  runOnboardCommand: vi.fn(async () => 0),
}));
const { runInteractiveOnboarding, shouldUseInteractiveOnboarding } =
  vi.hoisted(() => ({
    runInteractiveOnboarding: vi.fn(async () => 0),
    shouldUseInteractiveOnboarding: vi.fn(
      (
        flags: Record<string, string | number | boolean>,
        deps: { stdin?: { isTTY?: boolean }; stdout?: { isTTY?: boolean } },
      ) =>
        deps.stdin?.isTTY === true &&
        deps.stdout?.isTTY === true &&
        flags["non-interactive"] !== true &&
        flags.output !== "json" &&
        flags["output-format"] !== "json" &&
        flags["output-format"] !== "jsonl",
    ),
  }));
const {
  runConnectorListCommand,
  runConnectorStatusCommand,
  runConnectorAddTelegramCommand,
  runConnectorRemoveCommand,
} = vi.hoisted(() => ({
  runConnectorListCommand: vi.fn(async () => 0),
  runConnectorStatusCommand: vi.fn(async () => 0),
  runConnectorAddTelegramCommand: vi.fn(async () => 0),
  runConnectorRemoveCommand: vi.fn(async () => 0),
}));
const {
  runMarketTasksListCommand,
  runMarketTaskCreateCommand,
  runMarketTaskClaimCommand,
  runMarketTaskAcceptCommand,
  runMarketTaskRejectCommand,
  runMarketGovernanceVoteCommand,
  runMarketInspectCommand,
  runMarketReputationSummaryCommand,
} = vi.hoisted(() => ({
  runMarketTasksListCommand: vi.fn(async () => 0),
  runMarketTaskCreateCommand: vi.fn(async () => 0),
  runMarketTaskClaimCommand: vi.fn(async () => 0),
  runMarketTaskAcceptCommand: vi.fn(async () => 0),
  runMarketTaskRejectCommand: vi.fn(async () => 0),
  runMarketGovernanceVoteCommand: vi.fn(async () => 0),
  runMarketInspectCommand: vi.fn(async () => 0),
  runMarketReputationSummaryCommand: vi.fn(async () => 0),
}));
const { runMarketTuiCommand } = vi.hoisted(() => ({
  runMarketTuiCommand: vi.fn(async () => 0),
}));
const { runAgentRegisterCommand } = vi.hoisted(() => ({
  runAgentRegisterCommand: vi.fn(async () => 0),
}));
const { runShellCommand, runShellExecCommand } = vi.hoisted(() => ({
  runShellCommand: vi.fn(async () => 0),
  runShellExecCommand: vi.fn(async () => 0),
}));
const {
  runSessionContinuityListCommand,
  runSessionContinuityInspectCommand,
  runSessionContinuityHistoryCommand,
  runSessionContinuityForkCommand,
} = vi.hoisted(() => ({
  runSessionContinuityListCommand: vi.fn(async () => 0),
  runSessionContinuityInspectCommand: vi.fn(async () => 0),
  runSessionContinuityHistoryCommand: vi.fn(async () => 0),
  runSessionContinuityForkCommand: vi.fn(async () => 0),
}));

vi.mock("./init.js", () => ({
  runInitCommand,
}));

vi.mock("./onboard.js", () => ({
  runOnboardCommand,
}));

vi.mock("../onboarding/tui.js", () => ({
  runInteractiveOnboarding,
  shouldUseInteractiveOnboarding,
}));

vi.mock("./connectors.js", () => ({
  runConnectorListCommand,
  runConnectorStatusCommand,
  runConnectorAddTelegramCommand,
  runConnectorRemoveCommand,
}));

vi.mock("./marketplace-cli.js", async () => {
  const actual = await vi.importActual<typeof import("./marketplace-cli.js")>(
    "./marketplace-cli.js",
  );
  return {
    ...actual,
    runMarketTasksListCommand,
    runMarketTaskCreateCommand,
    runMarketTaskClaimCommand,
    runMarketTaskAcceptCommand,
    runMarketTaskRejectCommand,
    runMarketGovernanceVoteCommand,
    runMarketInspectCommand,
    runMarketReputationSummaryCommand,
  };
});

vi.mock("./marketplace-tui.js", async () => {
  const actual = await vi.importActual<typeof import("./marketplace-tui.js")>(
    "./marketplace-tui.js",
  );
  return {
    ...actual,
    runMarketTuiCommand,
  };
});

vi.mock("./agent-cli.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-cli.js")>(
    "./agent-cli.js",
  );
  return {
    ...actual,
    runAgentRegisterCommand,
  };
});

vi.mock("./shell.js", () => ({
  runShellCommand,
  runShellExecCommand,
}));

vi.mock("./session-continuity.js", () => ({
  runSessionContinuityListCommand,
  runSessionContinuityInspectCommand,
  runSessionContinuityHistoryCommand,
  runSessionContinuityForkCommand,
}));

import { runCli } from "./index.js";

const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const TEST_ENV_KEYS = [
  "AGENC_CONFIG",
  "AGENC_RUNTIME_CONFIG",
  "AGENC_RUNTIME_STORE_TYPE",
  "AGENC_RUNTIME_RPC_URL",
  "AGENC_RUNTIME_PROGRAM_ID",
  "AGENC_RUNTIME_SQLITE_PATH",
  "AGENC_RUNTIME_TRACE_ID",
  "AGENC_RUNTIME_STRICT_MODE",
  "AGENC_RUNTIME_IDEMPOTENCY_WINDOW",
  "AGENC_RUNTIME_OUTPUT",
  "AGENC_RUNTIME_LOG_LEVEL",
];

function captureStream(): { stream: Writable; data: () => string } {
  let data = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    data: () => data,
  };
}

function setStdinTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value,
  });
}

function createTempWorkspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "agenc-root-cli-"));
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeGatewayConfig(directory: string): string {
  const configPath = join(directory, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      gateway: { port: 3100 },
      agent: { name: "cli-root-test-agent" },
      connection: { rpcUrl: "https://api.devnet.solana.com" },
      replay: { store: { type: "memory" } },
    }),
    "utf8",
  );
  return configPath;
}

describe("runtime root CLI", () => {
  let workspace = "";
  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    workspace = createTempWorkspace();
    const configPath = writeGatewayConfig(workspace);
    const previous = new Map<string, string | undefined>();

    for (const key of TEST_ENV_KEYS) {
      previous.set(key, process.env[key]);
      process.env[key] = "";
    }

    process.env.AGENC_CONFIG = configPath;
    restoreEnv = () => {
      for (const key of TEST_ENV_KEYS) {
        const value = previous.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreEnv?.();
    restoreEnv = undefined;
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
      workspace = "";
    }
    if (stdinTtyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinTtyDescriptor);
      return;
    }
    delete (process.stdin as { isTTY?: boolean }).isTTY;
  });

  it("includes init in root help output", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["--help"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(stdout.data()).toContain("init [--help] [options]");
    expect(stdout.data()).toContain("shell [profile] [--help] [options]");
    expect(stdout.data()).toContain(
      "agents [roles|list|spawn|assign|inspect|stop] [--help] [options]",
    );
    expect(stdout.data()).toContain("agent [--help] <command> [options]");
    expect(stdout.data()).toContain("market [--help] <domain> <command> [options]");
    expect(stdout.data()).toContain("market inspect <surface> [subject]");
    expect(stdout.data()).toContain("market tui");
    expect(stdout.data()).toContain(
      "inspect <surface> [subject]                  Inspect a shared marketplace surface",
    );
    expect(stdout.data()).toContain(
      "init      Generate an AGENC.md contributor guide for the current repo",
    );
    expect(stdout.data()).toContain("agenc-runtime init");
    expect(stdout.data()).toContain("agenc-runtime shell coding");
  });

  it("routes shell flags through the root CLI command surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "shell",
        "coding",
        "--pid-path",
        "/tmp/agenc.pid",
        "--port",
        "4555",
        "--new",
        "--session",
        "session-123",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runShellCommand).toHaveBeenCalledTimes(1);
    expect(runShellCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        configPath: process.env.AGENC_CONFIG,
        pidPath: "/tmp/agenc.pid",
        controlPlanePort: 4555,
        profile: "coding",
        newSession: true,
        sessionId: "session-123",
      }),
    );
  });

  it("routes coding grep aliases through one-shot shell execution", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "grep",
        "shellProfile",
        "--glob",
        "src/**/*.ts",
        "--context",
        "2",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runShellExecCommand).toHaveBeenCalledTimes(1);
    expect(runShellExecCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profile: "coding",
        quietConnection: true,
        commandText:
          '/grep {"pattern":"shellProfile","filePatterns":["src/**/*.ts"],"contextLines":2}',
      }),
    );
  });

  it("routes git aliases through one-shot shell execution", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["git", "diff", "--staged", "--files", "src/a.ts,src/b.ts"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runShellExecCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profile: "coding",
        quietConnection: true,
        commandText:
          '/git {"subcommand":"diff","staged":true,"filePaths":["src/a.ts","src/b.ts"]}',
      }),
    );
  });

  it("routes plan workflow commands through one-shot shell execution", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "plan",
        "enter",
        "--objective",
        "Ship Phase 4",
        "--worktrees",
        "child",
        "--delegate",
        "--staged",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runShellExecCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profile: "coding",
        quietConnection: true,
        commandText:
          '/plan {"subcommand":"enter","objective":"Ship Phase 4","worktreeMode":"child","delegate":true,"staged":true}',
      }),
    );
  });

  it("routes session status through one-shot shell execution", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["session"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runShellExecCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profile: "general",
        quietConnection: true,
        commandText: "/session",
      }),
    );
  });

  it("routes session list through the continuity control-plane surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["session", "list", "--active-only", "--limit", "5", "--profile", "coding"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runSessionContinuityListCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        activeOnly: true,
        limit: 5,
        profile: "coding",
      }),
    );
  });

  it("routes session inspect through the continuity control-plane surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["session", "inspect", "session-123"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runSessionContinuityInspectCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "session-123",
      }),
    );
  });

  it("routes session history through the continuity control-plane surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["session", "history", "session-123", "--limit", "20", "--include-tools"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runSessionContinuityHistoryCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "session-123",
        limit: 20,
        includeTools: true,
      }),
    );
  });

  it("routes session fork through the continuity control-plane surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "session",
        "fork",
        "session-123",
        "--objective",
        "Investigate regression",
        "--profile",
        "research",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runSessionContinuityForkCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "session-123",
        objective: "Investigate regression",
        profile: "research",
      }),
    );
  });

  it("routes resume to the interactive shell path with coding default profile", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["resume", "--session", "session-456"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runShellCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profile: "coding",
        sessionId: "session-456",
      }),
    );
  });

  it("routes session resume to the interactive shell path", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["session", "resume", "session-789"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runShellCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profile: "general",
        sessionId: "session-789",
      }),
    );
  });

  it("routes delegated review through one-shot shell execution", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["review", "--delegate", "--staged"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runShellExecCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profile: "coding",
        quietConnection: true,
        commandText: '/review {"staged":true,"delegate":true}',
      }),
    );
  });

  it("routes agent-role listing through one-shot shell execution", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["agents", "roles"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runShellExecCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profile: "coding",
        quietConnection: true,
        commandText: "/agents roles",
      }),
    );
  });

  it("routes agent spawning through one-shot shell execution", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "agents",
        "spawn",
        "coding",
        "--objective",
        "Implement the task",
        "--bundle",
        "coding-core",
        "--worktree",
        "auto",
        "--wait",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runShellExecCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profile: "coding",
        quietConnection: true,
        commandText:
          '/agents {"subcommand":"spawn","roleId":"coding","objective":"Implement the task","toolBundle":"coding-core","worktree":"auto","wait":true}',
      }),
    );
  });

  it("routes skills aliases through one-shot shell execution", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["skills", "inspect", "local-skill"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runShellExecCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profile: "general",
        quietConnection: true,
        commandText: "/skills inspect local-skill",
      }),
    );
  });

  it("keeps plugin commands on the direct CLI path instead of the shell alias", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const previousCwd = process.cwd();
    process.chdir(workspace);

    try {
      const code = await runCli({
        argv: ["plugin", "list"],
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(code).toBe(0);
      expect(runShellExecCommand).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("routes init flags through the root CLI command surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "init",
        "--path",
        "/tmp/demo",
        "--force",
        "--pid-path",
        "/tmp/agenc.pid",
        "--port",
        "3222",
        "--config",
        "/tmp/agenc-config.json",
        "--output",
        "json",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(runInitCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        path: "/tmp/demo",
        force: true,
        pidPath: "/tmp/agenc.pid",
        controlPlanePort: 3222,
        configPath: "/tmp/agenc-config.json",
      }),
    );
  });

  it("routes agent registration through the root CLI command surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "agent",
        "register",
        "--rpc",
        "https://api.devnet.solana.com",
        "--capabilities",
        "3",
        "--endpoint",
        "https://agent.example.com",
        "--metadata-uri",
        "https://agent.example.com/meta.json",
        "--agent-id",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(runAgentRegisterCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rpcUrl: "https://api.devnet.solana.com",
        capabilities: "3",
        endpoint: "https://agent.example.com",
        metadataUri: "https://agent.example.com/meta.json",
        agentId:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    );
  });

  it("routes connector lifecycle flags through the root CLI command surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "connector",
        "add",
        "telegram",
        "--config",
        "/tmp/agenc-config.json",
        "--pid-path",
        "/tmp/agenc.pid",
        "--bot-token-env",
        "TELEGRAM_BOT_TOKEN",
        "--restart",
        "false",
        "--allowed-users",
        "123,456",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(runConnectorAddTelegramCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        configPath: "/tmp/agenc-config.json",
        pidPath: "/tmp/agenc.pid",
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        restart: false,
        allowedUsers: [123, 456],
      }),
    );
  });

  it("routes market task claims through the root CLI command surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "market",
        "tasks",
        "claim",
        "Task111111111111111111111111111111111111111",
        "--worker-agent-pda",
        "Agent11111111111111111111111111111111111111",
        "--job-spec-store-dir",
        "/tmp/agenc-job-specs",
        "--output",
        "json",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(runMarketTaskClaimCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        taskPda: "Task111111111111111111111111111111111111111",
        workerAgentPda: "Agent11111111111111111111111111111111111111",
        jobSpecStoreDir: "/tmp/agenc-job-specs",
      }),
    );
  });

  it("routes market task creation through the root CLI command surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "market",
        "tasks",
        "create",
        "--description",
        "Public task from CLI test",
        "--reward",
        "50000000",
        "--required-capabilities",
        "1",
        "--validation-mode",
        "creator-review",
        "--review-window-secs",
        "120",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(runMarketTaskCreateCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        description: "Public task from CLI test",
        reward: "50000000",
        requiredCapabilities: "1",
        validationMode: "creator-review",
        reviewWindowSecs: 120,
      }),
    );
  });

  it("routes market task acceptance through the root CLI command surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "market",
        "tasks",
        "accept",
        "Task111111111111111111111111111111111111111",
        "--worker-agent-pda",
        "Agent11111111111111111111111111111111111111",
        "--output",
        "json",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(runMarketTaskAcceptCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        taskPda: "Task111111111111111111111111111111111111111",
        workerAgentPda: "Agent11111111111111111111111111111111111111",
      }),
    );
  });

  it("routes market task rejection through the root CLI command surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "market",
        "tasks",
        "reject",
        "Task111111111111111111111111111111111111111",
        "--worker-agent-pda",
        "Agent11111111111111111111111111111111111111",
        "--reason",
        "Need another pass on the delivery",
        "--output",
        "json",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(runMarketTaskRejectCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        taskPda: "Task111111111111111111111111111111111111111",
        workerAgentPda: "Agent11111111111111111111111111111111111111",
        reason: "Need another pass on the delivery",
      }),
    );
  });

  it("routes market inspect through the root CLI command surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "market",
        "inspect",
        "tasks",
        "--status",
        "open,in_progress",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(runMarketInspectCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        surface: "tasks",
        statuses: ["open", "in_progress"],
      }),
    );
  });

  it("routes market reputation summaries through the root CLI command surface with configured keypair paths", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const configuredKeypairPath = join(workspace, "configured-id.json");
    writeFileSync(
      process.env.AGENC_CONFIG!,
      JSON.stringify({
        gateway: { port: 3100 },
        agent: { name: "cli-root-test-agent" },
        connection: {
          rpcUrl: "https://api.devnet.solana.com",
          keypairPath: configuredKeypairPath,
        },
        replay: { store: { type: "memory" } },
      }),
      "utf8",
    );

    const code = await runCli({
      argv: ["market", "reputation", "summary"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(runMarketReputationSummaryCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rpcUrl: "https://api.devnet.solana.com",
        keypairPath: configuredKeypairPath,
      }),
    );
  });

  it("routes market governance votes through the root CLI command surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "market",
        "governance",
        "vote",
        "Prop111111111111111111111111111111111111111",
        "yes",
        "--voter-agent-pda",
        "Agent11111111111111111111111111111111111111",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(runMarketGovernanceVoteCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        proposalPda: "Prop111111111111111111111111111111111111111",
        approve: true,
        voterAgentPda: "Agent11111111111111111111111111111111111111",
      }),
    );
  });

  it("routes market tui through the root CLI command surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["market", "tui"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(runMarketTuiCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        outputFormat: "table",
      }),
    );
  });

  it("routes onboard through the interactive TUI for tty sessions", async () => {
    setStdinTTY(true);
    const stdout = captureStream();
    const stderr = captureStream();
    (stdout.stream as Writable & { isTTY?: boolean }).isTTY = true;

    const code = await runCli({
      argv: ["onboard", "--config", "/tmp/agenc-config.json"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runInteractiveOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: "/tmp/agenc-config.json",
      }),
      expect.objectContaining({
        stdin: process.stdin,
        stdout: stdout.stream,
      }),
    );
    expect(runOnboardCommand).not.toHaveBeenCalled();
  });

  it("keeps onboard on the structured path for json output", async () => {
    setStdinTTY(true);
    const stdout = captureStream();
    const stderr = captureStream();
    (stdout.stream as Writable & { isTTY?: boolean }).isTTY = true;

    const code = await runCli({
      argv: [
        "onboard",
        "--config",
        "/tmp/agenc-config.json",
        "--output",
        "json",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runOnboardCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        configPath: "/tmp/agenc-config.json",
      }),
    );
    expect(runInteractiveOnboarding).not.toHaveBeenCalled();
  });

  it("treats onboard --help as help text instead of entering onboarding flows", async () => {
    setStdinTTY(true);
    const stdout = captureStream();
    const stderr = captureStream();
    (stdout.stream as Writable & { isTTY?: boolean }).isTTY = true;

    const code = await runCli({
      argv: ["onboard", "--help"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(runInteractiveOnboarding).not.toHaveBeenCalled();
    expect(runOnboardCommand).not.toHaveBeenCalled();
    expect(stdout.data()).toContain("onboard [--help] [options]");
  });
});
