import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCanonicalDefaultConfigPath,
  loadCliConfigContract,
  resolveCliConfigPath,
} from "./config-contract.js";

function writeJson(path: string, body: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(body, null, 2), "utf8");
}

describe("cli config contract", () => {
  let workspace = "";

  afterEach(() => {
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
      workspace = "";
    }
  });

  it("resolves config path precedence as explicit > AGENC_CONFIG > AGENC_RUNTIME_CONFIG > canonical", () => {
    workspace = mkdtempSync(join(tmpdir(), "agenc-config-contract-"));

    const explicit = resolveCliConfigPath({
      explicitConfigPath: "./explicit.json",
      env: {
        AGENC_CONFIG: "./canonical.json",
        AGENC_RUNTIME_CONFIG: "./legacy.json",
      },
      cwd: workspace,
    });
    expect(explicit.configPath).toBe(join(workspace, "explicit.json"));
    expect(explicit.configPathSource).toBe("explicit");

    const canonicalEnv = resolveCliConfigPath({
      env: {
        AGENC_CONFIG: "./canonical.json",
        AGENC_RUNTIME_CONFIG: "./legacy.json",
      },
      cwd: workspace,
    });
    expect(canonicalEnv.configPath).toBe(join(workspace, "canonical.json"));
    expect(canonicalEnv.configPathSource).toBe("env:AGENC_CONFIG");

    const legacyEnv = resolveCliConfigPath({
      env: {
        AGENC_RUNTIME_CONFIG: "./legacy.json",
      },
      cwd: workspace,
    });
    expect(legacyEnv.configPath).toBe(join(workspace, "legacy.json"));
    expect(legacyEnv.configPathSource).toBe("env:AGENC_RUNTIME_CONFIG");

    const fallback = resolveCliConfigPath({
      env: {},
      cwd: workspace,
    });
    expect(fallback.configPath).toBe(getCanonicalDefaultConfigPath());
    expect(fallback.configPathSource).toBe("canonical");
  });

  it("parses canonical gateway config into the CLI contract view", () => {
    workspace = mkdtempSync(join(tmpdir(), "agenc-config-contract-"));
    const configPath = join(workspace, "config.json");
    writeJson(configPath, {
      gateway: { port: 3100 },
      agent: { name: "test-agent" },
      connection: {
        rpcUrl: "https://rpc.example",
        programId: "AGENT1111111111111111111111111111111111111",
      },
      logging: { level: "info" },
      replay: {
        traceId: "trace-123",
        store: {
          type: "sqlite",
          sqlitePath: "/tmp/replay.sqlite",
        },
      },
      cli: {
        strictMode: true,
        idempotencyWindow: 321,
        outputFormat: "jsonl",
      },
    });

    const contract = loadCliConfigContract(configPath, {
      configPathSource: "canonical",
    });

    expect(contract.shape).toBe("canonical-gateway");
    expect(contract.fileConfig.rpcUrl).toBe("https://rpc.example");
    expect(contract.fileConfig.programId).toBe(
      "AGENT1111111111111111111111111111111111111",
    );
    expect(contract.fileConfig.storeType).toBe("sqlite");
    expect(contract.fileConfig.sqlitePath).toBe("/tmp/replay.sqlite");
    expect(contract.fileConfig.traceId).toBe("trace-123");
    expect(contract.fileConfig.strictMode).toBe(true);
    expect(contract.fileConfig.idempotencyWindow).toBe(321);
    expect(contract.fileConfig.outputFormat).toBe("jsonl");
    expect(contract.fileConfig.logLevel).toBe("info");
  });

  it("rejects legacy flat config when AGENC_CONFIG points at it", () => {
    workspace = mkdtempSync(join(tmpdir(), "agenc-config-contract-"));
    const configPath = join(workspace, "legacy.json");
    writeJson(configPath, {
      rpcUrl: "https://rpc.example",
      storeType: "memory",
    });

    expect(() =>
      loadCliConfigContract(configPath, {
        configPathSource: "env:AGENC_CONFIG",
      }),
    ).toThrow(/must point to a canonical gateway config/i);
  });

  it("accepts legacy flat config when selected through legacy compatibility input", () => {
    workspace = mkdtempSync(join(tmpdir(), "agenc-config-contract-"));
    const configPath = join(workspace, "legacy.json");
    writeJson(configPath, {
      rpcUrl: "https://rpc.example",
      storeType: "memory",
      idempotencyWindow: 123,
    });

    const contract = loadCliConfigContract(configPath, {
      configPathSource: "env:AGENC_RUNTIME_CONFIG",
    });

    expect(contract.shape).toBe("legacy-flat");
    expect(contract.fileConfig.rpcUrl).toBe("https://rpc.example");
    expect(contract.fileConfig.storeType).toBe("memory");
    expect(contract.fileConfig.idempotencyWindow).toBe(123);
  });
});
