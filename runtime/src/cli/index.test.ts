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
  runMarketGovernanceVoteCommand,
} = vi.hoisted(() => ({
  runMarketTasksListCommand: vi.fn(async () => 0),
  runMarketTaskCreateCommand: vi.fn(async () => 0),
  runMarketTaskClaimCommand: vi.fn(async () => 0),
  runMarketGovernanceVoteCommand: vi.fn(async () => 0),
}));
const { runMarketTuiCommand } = vi.hoisted(() => ({
  runMarketTuiCommand: vi.fn(async () => 0),
}));
const { runAgentRegisterCommand } = vi.hoisted(() => ({
  runAgentRegisterCommand: vi.fn(async () => 0),
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
    runMarketGovernanceVoteCommand,
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
    expect(stdout.data()).toContain("agent [--help] <command> [options]");
    expect(stdout.data()).toContain("market [--help] <domain> <command> [options]");
    expect(stdout.data()).toContain("market tui");
    expect(stdout.data()).toContain(
      "init      Generate an AGENC.md contributor guide for the current repo",
    );
    expect(stdout.data()).toContain("agenc-runtime init");
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
});
