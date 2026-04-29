import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOnboardingProfile } from "../onboarding/profile.js";
import * as gatewayDaemon from "../gateway/daemon.js";
import type { OnboardOptions } from "./types.js";
import { executeOnboardCommand, runOnboardCommand } from "./onboard.js";
import { createContextCapture } from "./test-utils.js";

describe("onboard cli command", () => {
  let workspace = "";
  let configPath = "";
  let keypairPath = "";

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "agenc-onboard-"));
    configPath = join(workspace, "config.json");
    keypairPath = join(workspace, "id.json");
    writeFileSync(keypairPath, "[]", "utf8");
    process.env.SOLANA_KEYPAIR_PATH = keypairPath;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
    delete process.env.SOLANA_KEYPAIR_PATH;
  });

  it("onboard generates config when no existing config is present", async () => {
    vi.spyOn(Connection.prototype, "getSlot").mockResolvedValue(123);

    const { context, outputs } = createContextCapture();
    const options: OnboardOptions = {
      help: false,
      outputFormat: "json",
      strictMode: false,
      rpcUrl: "http://rpc.example",
      programId: undefined,
      storeType: "sqlite",
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      configPathSource: "explicit",
      managedOverrides: {
        rpcUrl: "http://rpc.example",
        storeType: "sqlite",
        idempotencyWindow: 900,
      },
      nonInteractive: true,
      force: false,
    };

    const code = await runOnboardCommand(context, options);
    expect(code).toBe(0);
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(readFileSync(configPath, "utf8")) as any;
    expect(written.connection.rpcUrl).toBe("http://rpc.example");
    expect(written.replay.store.type).toBe("sqlite");
    expect(typeof written.replay.store.sqlitePath).toBe("string");
    expect(written.logging.level).toBe("info");
    expect(written.cli.outputFormat).toBe("json");
    expect(written.cli.strictMode).toBe(false);

    const payload = outputs[0] as any;
    expect(payload.command).toBe("onboard");
    expect(payload.result.configGenerated).toBe(true);
    expect(payload.result.exitCode).toBe(0);
  });

  it("onboard skips existing config when --force is not provided", async () => {
    vi.spyOn(Connection.prototype, "getSlot").mockResolvedValue(123);
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: { port: 3100 },
          agent: { name: "test-agent" },
          connection: { rpcUrl: "http://old.example" },
          llm: { provider: "grok", sentinel: "keep" },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { context, outputs } = createContextCapture();
    const options: OnboardOptions = {
      help: false,
      outputFormat: "json",
      strictMode: false,
      rpcUrl: "http://rpc.example",
      programId: undefined,
      storeType: "sqlite",
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      configPathSource: "explicit",
      nonInteractive: true,
      force: false,
    };

    const code = await runOnboardCommand(context, options);
    expect(code).toBe(1);

    const written = JSON.parse(readFileSync(configPath, "utf8")) as any;
    expect(written.llm.sentinel).toBe("keep");

    const payload = outputs[0] as any;
    expect(payload.result.configGenerated).toBe(false);
    const existsCheck = payload.result.checks.find(
      (c: any) => c.id === "config.exists",
    );
    expect(existsCheck.status).toBe("warn");
  });

  it("onboard overwrites existing config when --force is provided", async () => {
    vi.spyOn(Connection.prototype, "getSlot").mockResolvedValue(123);
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: { port: 3100 },
          agent: { name: "test-agent" },
          connection: { rpcUrl: "http://old.example" },
          llm: { provider: "grok", sentinel: "preserve" },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { context, outputs } = createContextCapture();
    const options: OnboardOptions = {
      help: false,
      outputFormat: "json",
      strictMode: false,
      rpcUrl: "http://new.example",
      programId: undefined,
      storeType: "sqlite",
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      configPathSource: "explicit",
      managedOverrides: {
        rpcUrl: "http://new.example",
        storeType: "sqlite",
      },
      nonInteractive: true,
      force: true,
    };

    const code = await runOnboardCommand(context, options);
    expect(code).toBe(0);

    const written = JSON.parse(readFileSync(configPath, "utf8")) as any;
    expect(written.connection.rpcUrl).toBe("http://new.example");
    expect(written.llm.sentinel).toBe("preserve");

    const payload = outputs[0] as any;
    expect(payload.result.configGenerated).toBe(true);
    expect(payload.result.exitCode).toBe(0);
    expect(typeof payload.result.backupPath).toBe("string");
  });

  it("imports legacy runtime config into canonical gateway config", async () => {
    vi.spyOn(Connection.prototype, "getSlot").mockResolvedValue(123);
    const legacyPath = join(workspace, ".agenc-runtime.json");
    writeFileSync(
      legacyPath,
      JSON.stringify(
        {
          rpcUrl: "http://legacy.example",
          storeType: "memory",
          idempotencyWindow: 123,
        },
        null,
        2,
      ),
      "utf8",
    );

    const { context } = createContextCapture();
    const options: OnboardOptions = {
      help: false,
      outputFormat: "json",
      strictMode: false,
      rpcUrl: undefined,
      programId: undefined,
      storeType: "sqlite",
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      configPathSource: "explicit",
      legacyImportConfigPath: legacyPath,
      managedOverrides: {},
      nonInteractive: true,
      force: false,
    };

    const code = await runOnboardCommand(context, options);
    expect(code).toBe(0);

    const written = JSON.parse(readFileSync(configPath, "utf8")) as any;
    expect(written.connection.rpcUrl).toBe("http://legacy.example");
    expect(written.replay.store.type).toBe("memory");
    expect(written.cli.idempotencyWindow).toBe(123);
  });

  it("refuses to overwrite config while a matching daemon is live", async () => {
    vi.spyOn(Connection.prototype, "getSlot").mockResolvedValue(123);
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: { port: 3100 },
          agent: { name: "test-agent" },
          connection: { rpcUrl: "http://old.example" },
        },
        null,
        2,
      ),
      "utf8",
    );
    vi.spyOn(gatewayDaemon, "readPidFile").mockResolvedValue({
      pid: 4242,
      port: 3100,
      configPath,
    });
    vi.spyOn(gatewayDaemon, "isProcessAlive").mockReturnValue(true);

    const { context, outputs } = createContextCapture();
    const options: OnboardOptions = {
      help: false,
      outputFormat: "json",
      strictMode: false,
      rpcUrl: undefined,
      programId: undefined,
      storeType: "sqlite",
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      configPathSource: "explicit",
      managedOverrides: {
        rpcUrl: "http://new.example",
      },
      nonInteractive: true,
      force: true,
    };

    const code = await runOnboardCommand(context, options);
    expect(code).toBe(2);

    const payload = outputs[0] as any;
    const liveCheck = payload.result.checks.find(
      (entry: any) => entry.id === "config.live-daemon",
    );
    expect(liveCheck.status).toBe("fail");

    const written = JSON.parse(readFileSync(configPath, "utf8")) as any;
    expect(written.connection.rpcUrl).toBe("http://old.example");
  });

  it("writes curated workspace files and uses the configured wallet path for health", async () => {
    vi.spyOn(Connection.prototype, "getSlot").mockResolvedValue(123);
    const workspacePath = join(workspace, "agent-workspace");
    const configuredWalletPath = join(workspace, "configured-id.json");
    writeFileSync(configuredWalletPath, "[]", "utf8");
    process.env.SOLANA_KEYPAIR_PATH = join(workspace, "missing-wallet.json");

    const profile = buildOnboardingProfile({
      apiKey: "xai-test-key",
      model: "grok-4-1-fast-reasoning",
      agentName: "Operator",
      mission: "Run a clean first-run profile.",
      role: "Operator",
      alwaysDoRules: ["Keep outputs factual."],
      soulTraits: ["direct", "disciplined"],
      tone: "Direct and calm",
      verbosity: "balanced",
      autonomy: "balanced",
      toolPosture: "balanced",
      memorySeeds: ["This is a local operator workspace."],
      desktopAutomationEnabled: false,
      walletPath: configuredWalletPath,
      rpcUrl: "http://rpc.example",
      marketplaceEnabled: true,
      socialEnabled: false,
    });
    const finalConfig = structuredClone(profile.config);
    finalConfig.workspace = {
      ...(finalConfig.workspace ?? {}),
      hostPath: workspacePath,
    };

    const options: OnboardOptions = {
      help: false,
      outputFormat: "json",
      strictMode: false,
      rpcUrl: "http://rpc.example",
      programId: undefined,
      storeType: "sqlite",
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      configPathSource: "explicit",
      nonInteractive: true,
      force: false,
    };

    const result = await executeOnboardCommand(options, {
      finalConfig,
      workspace: {
        workspacePath,
        files: profile.workspaceFiles,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.walletDetected).toBe(true);
    expect(result.workspacePath).toBe(workspacePath);
    expect(result.workspaceFilesCreated).toContain("AGENT.md");
    expect(readFileSync(join(workspacePath, "SOUL.md"), "utf8")).toContain(
      "# Soul",
    );
    expect(
      JSON.parse(readFileSync(configPath, "utf8")) as {
        workspace?: { hostPath?: string };
      },
    ).toMatchObject({
      workspace: { hostPath: workspacePath },
    });
  });
});
