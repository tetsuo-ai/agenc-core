import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { runCli } from "./index.js";

const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

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

describe("runtime root CLI", () => {
  afterEach(() => {
    vi.clearAllMocks();
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
