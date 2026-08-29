import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadCanonicalConfig } from "../../src/config/repository.js";
import { applyEnvOverrides } from "../../src/config/env.js";
import {
  defaultConfig,
  InvalidTransactionGuardConfigError,
  validateAgenCConfigBlocks,
  validateTransactionGuardConfig,
  type TransactionGuardConfig,
} from "../../src/config/schema.js";
import {
  createTransactionGuardContext,
  resetDefaultTransactionGuardContextForTests,
  resolveTransactionGuardPolicy,
  TRANSACTION_GUARD_UNAVAILABLE,
} from "../../src/transaction-guard/index.js";
import { runToolUse } from "../../src/tools/execution.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import type { Tool } from "../../src/tools/types.js";

const GUARD_ENV_KEYS = [
  "AGENC_TRANSACTION_GUARD",
  "AGENC_TRANSACTION_GUARD_MODEL",
  "AGENC_TRANSACTION_GUARD_OLLAMA_URL",
  "AGENC_TRANSACTION_GUARD_FAIL_MODE",
  "AGENC_TRANSACTION_GUARD_TIMEOUT_MS",
  "AGENC_TRANSACTION_GUARD_MAX_DOCKET_BYTES",
] as const;

const savedEnv = new Map<string, string | undefined>();
const tempDirs: string[] = [];

function stripGuardEnv(): void {
  for (const key of GUARD_ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  resetDefaultTransactionGuardContextForTests();
});

function writeConfigToml(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agenc-guard-cfg-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "config.toml"), `config_version = 2\n${contents}`);
  return dir;
}

function loadTestConfig(home: string, onWarn: (message: string) => void = () => {}) {
  return loadCanonicalConfig({
    home,
    env: { AGENC_HOME: home, HOME: home },
    cwd: home,
    projectRoot: home,
    projectTrusted: true,
    onWarn,
  });
}

/** A 127.0.0.1 URL with no listener behind it (grab a port, release it). */
async function unreachableLocalUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return `http://127.0.0.1:${port}`;
}

function makeInvocation(
  callId: string,
  toolName: string,
  transactionGuardConfig?: TransactionGuardConfig,
): ToolInvocation {
  const services =
    transactionGuardConfig === undefined
      ? { admissionRequired: false }
      : {
          admissionRequired: false,
          configStore: {
            current: () => ({
              transaction_guard: Object.freeze({ ...transactionGuardConfig }),
            }),
          },
        };
  return {
    session: { services } as never,
    turn: {
      cwd: "/repo",
      sandboxPolicy: { value: "workspace_write" },
      approvalPolicy: { value: "on_request" },
    } as never,
    tracker: {
      appendFileDiff: () => {},
      snapshot: () => [],
      clear: () => {},
    },
    callId,
    toolName: { name: toolName },
    payload: { kind: "function", arguments: "" },
    source: "direct",
  };
}

function makeTool(name: string, onExecute: () => void): Tool {
  return {
    name,
    description: "test tool",
    inputSchema: {
      type: "object",
      additionalProperties: true,
    },
    metadata: {
      family: "terminal",
      source: "builtin",
      mutating: true,
      hiddenByDefault: false,
      deferred: false,
    },
    async execute() {
      onExecute();
      return { content: "executed" };
    },
  };
}

describe("[transaction_guard] config block", () => {
  test("config.toml block reaches AgenCConfig.transaction_guard (not _unknown)", async () => {
    // Revert-sensitive: without the KNOWN_CONFIG_KEYS/schema wiring the
    // block lands on `_unknown` and `transaction_guard` stays undefined.
    const home = writeConfigToml(
      [
        "[transaction_guard]",
        "enabled = true",
        'model = "guard-model-from-config"',
        'endpoint = "http://127.0.0.1:14434"',
        'fail_mode = "open"',
        "",
      ].join("\n"),
    );
    const loaded = await loadTestConfig(home);
    expect(loaded.config.transaction_guard).toEqual({
      enabled: true,
      model: "guard-model-from-config",
      endpoint: "http://127.0.0.1:14434",
      fail_mode: "open",
    });
    expect(loaded.config._unknown?.transaction_guard).toBeUndefined();
  });

  test("config block enables the guard without any env vars", async () => {
    const home = writeConfigToml(
      [
        "[transaction_guard]",
        "enabled = true",
        'model = "config-model"',
        'endpoint = "http://127.0.0.1:14434"',
        "",
      ].join("\n"),
    );
    const loaded = await loadTestConfig(home);
    const policy = resolveTransactionGuardPolicy(
      loaded.config.transaction_guard,
    );
    expect(policy.enabled).toBe(true);
    expect(policy.model).toBe("config-model");
    expect(policy.ollamaUrl).toBe("http://127.0.0.1:14434");
    // fail_mode omitted → default "closed".
    expect(policy.failClosed).toBe(true);

    const context = createTransactionGuardContext(
      loaded.config.transaction_guard,
    );
    expect(context).not.toBeNull();
    expect(context?.policy.model).toBe("config-model");
    // Env-only resolution with no env vars stays disabled — the config
    // block is what activated the guard.
    expect(createTransactionGuardContext(undefined)).toBeNull();
  });

  test("canonical environment layer overrides the config block", () => {
    const config: TransactionGuardConfig = {
      enabled: true,
      model: "config-model",
      endpoint: "http://config.example:1",
      fail_mode: "open",
    };
    const layered = applyEnvOverrides(
      { ...defaultConfig(), transaction_guard: config },
      {
        AGENC_TRANSACTION_GUARD: "slm",
        AGENC_TRANSACTION_GUARD_MODEL: "env-model",
        AGENC_TRANSACTION_GUARD_OLLAMA_URL: "http://env.example:2",
        AGENC_TRANSACTION_GUARD_FAIL_MODE: "closed",
        AGENC_TRANSACTION_GUARD_TIMEOUT_MS: "5000",
        AGENC_TRANSACTION_GUARD_MAX_DOCKET_BYTES: "8192",
      },
    );
    const policy = resolveTransactionGuardPolicy(layered.transaction_guard);
    expect(policy).toMatchObject({
      enabled: true,
      model: "env-model",
      ollamaUrl: "http://env.example:2",
      failClosed: true,
      timeoutMs: 5_000,
      maxDocketBytes: 8_192,
    });
  });

  test("canonical environment layer applies a non-slm kill switch", () => {
    const config: TransactionGuardConfig = { enabled: true };
    const layered = applyEnvOverrides(
      { ...defaultConfig(), transaction_guard: config },
      { AGENC_TRANSACTION_GUARD: "off" },
    );
    expect(resolveTransactionGuardPolicy(layered.transaction_guard).enabled)
      .toBe(false);
    expect(resolveTransactionGuardPolicy(config).enabled).toBe(true);
  });

  test("transaction guard mode is case-insensitive", () => {
    const layered = applyEnvOverrides(
      defaultConfig(),
      { AGENC_TRANSACTION_GUARD: "SLM" },
    );
    expect(() => validateAgenCConfigBlocks(layered)).not.toThrow();
    expect(resolveTransactionGuardPolicy(layered.transaction_guard).enabled)
      .toBe(true);
  });

  test("invalid transaction guard mode warns and preserves TOML", () => {
    const warnings: string[] = [];
    const config: TransactionGuardConfig = { enabled: true };
    const layered = applyEnvOverrides(
      { ...defaultConfig(), transaction_guard: config },
      { AGENC_TRANSACTION_GUARD: "typo" },
      (message) => warnings.push(message),
    );
    expect(resolveTransactionGuardPolicy(layered.transaction_guard).enabled)
      .toBe(true);
    expect(warnings).toEqual([
      expect.stringContaining("invalid AGENC_TRANSACTION_GUARD"),
    ]);
  });

  test("defaults apply when the resolved block is absent", () => {
    expect(resolveTransactionGuardPolicy()).toMatchObject({
      enabled: false,
      provider: "ollama",
      model: "gemma4:e4b",
      ollamaUrl: "http://127.0.0.1:11434",
      failClosed: true,
    });
  });

  test("validateTransactionGuardConfig rejects unknown fields and bad values", () => {
    expect(validateTransactionGuardConfig(undefined)).toBeUndefined();
    expect(
      validateTransactionGuardConfig({
        enabled: true,
        model: "m",
        endpoint: "http://e",
        fail_mode: "open",
        timeout_ms: 5_000,
        max_docket_bytes: 8_192,
      }),
    ).toEqual({
      enabled: true,
      model: "m",
      endpoint: "http://e",
      fail_mode: "open",
      timeout_ms: 5_000,
      max_docket_bytes: 8_192,
    });
    expect(() => validateTransactionGuardConfig({ ollama_url: "x" })).toThrow(
      InvalidTransactionGuardConfigError,
    );
    expect(() =>
      validateTransactionGuardConfig({ fail_mode: "sideways" }),
    ).toThrow('Invalid transaction_guard.fail_mode: expected "open" or "closed"');
    expect(() => validateTransactionGuardConfig({ enabled: "yes" })).toThrow(
      InvalidTransactionGuardConfigError,
    );
    expect(() => validateTransactionGuardConfig({ timeout_ms: 0 })).toThrow(
      InvalidTransactionGuardConfigError,
    );
    expect(() => validateTransactionGuardConfig("slm")).toThrow(
      InvalidTransactionGuardConfigError,
    );
  });

  test("an invalid [transaction_guard] block fails closed", async () => {
    const home = writeConfigToml(
      ["[transaction_guard]", 'fail_mode = "sideways"', ""].join("\n"),
    );
    await expect(loadTestConfig(home)).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringContaining("transaction_guard.fail_mode"),
    });
  });
});

describe("config-driven guard activation through runToolUse", () => {
  test("session config block guards transaction-like calls without env vars", async () => {
    // Revert-sensitive end-to-end proof: no env vars, no explicit
    // transactionGuardContext — only the session ConfigStore's
    // [transaction_guard] block. The endpoint is unreachable and
    // fail_mode defaults to "closed", so the call must be blocked
    // before the tool executes.
    stripGuardEnv();
    process.env.AGENC_TRANSACTION_GUARD_TIMEOUT_MS = "2000";
    const endpoint = await unreachableLocalUrl();
    let executed = false;
    const out = await runToolUse(
      JSON.stringify({
        cmd: "solana transfer recipient 0.001 --url https://api.devnet.solana.com",
      }),
      {
        currentTurnId: "turn-config-guard",
        invocation: makeInvocation("config-guard-blocked", "exec_command", {
          enabled: true,
          endpoint,
        }),
        tool: makeTool("exec_command", () => {
          executed = true;
        }),
      },
    );
    expect(executed).toBe(false);
    expect(out.isError).toBe(true);
    expect(out.content).toContain(TRANSACTION_GUARD_UNAVAILABLE);
  });

  test("without the config block (and no env) the same call executes", async () => {
    stripGuardEnv();
    let executed = false;
    const out = await runToolUse(
      JSON.stringify({
        cmd: "solana transfer recipient 0.001 --url https://api.devnet.solana.com",
      }),
      {
        currentTurnId: "turn-config-guard",
        invocation: makeInvocation("config-guard-disabled", "exec_command"),
        tool: makeTool("exec_command", () => {
          executed = true;
        }),
      },
    );
    expect(executed).toBe(true);
    expect(out.isError).not.toBe(true);
  });

  test("fail_mode=open cannot bypass the admission kernel", async () => {
    stripGuardEnv();
    process.env.AGENC_TRANSACTION_GUARD_TIMEOUT_MS = "2000";
    const endpoint = await unreachableLocalUrl();
    let executed = false;
    const out = await runToolUse(
      JSON.stringify({
        cmd: "solana transfer recipient 0.001 --url https://api.devnet.solana.com",
      }),
      {
        currentTurnId: "turn-config-guard",
        invocation: makeInvocation("config-guard-fail-open", "exec_command", {
          enabled: true,
          endpoint,
          fail_mode: "open",
        }),
        tool: makeTool("exec_command", () => {
          executed = true;
        }),
      },
    );
    expect(executed).toBe(false);
    expect(out.isError).toBe(true);
    expect(out.content).toContain(TRANSACTION_GUARD_UNAVAILABLE);
    expect(out.content).toContain("legacy_ollama_courtguard_model_path_disabled");
  });
});
