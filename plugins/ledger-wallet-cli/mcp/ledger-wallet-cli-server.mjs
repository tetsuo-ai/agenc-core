#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_INFO = { name: "ledger-wallet-cli", version: "0.1.0" };
const MAX_OUTPUT_BYTES = 1_048_576;
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARNESS = join(PLUGIN_ROOT, "scripts", "wallet_cli_harness.py");
const WORKFLOW = join(PLUGIN_ROOT, "scripts", "wallet_cli_workflow.py");

let executionQueue = Promise.resolve();

function pythonExecutable() {
  const configured = process.env.WALLET_CLI_HARNESS_PYTHON?.trim();
  return configured && configured.length > 0 ? configured : "python3";
}

function boundedString(value, label, maxLength = 4096) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new Error(`${label} must be a bounded single-line string`);
  }
  return value;
}

function walletArgs(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error("args must be a non-empty array with at most 64 entries");
  }
  return value.map((entry, index) => boundedString(entry, `args[${index}]`));
}

function appendBounded(current, chunk) {
  if (Buffer.byteLength(current, "utf8") >= MAX_OUTPUT_BYTES) return current;
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current, "utf8");
  return current + Buffer.from(chunk).subarray(0, remaining).toString("utf8");
}

function runScript(script, args) {
  return new Promise((resolve) => {
    const child = spawn(pythonExecutable(), [script, ...args], {
      cwd: PLUGIN_ROOT,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        error: { message: error.message },
        executable: pythonExecutable(),
        script,
        stderr,
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      let payload;
      try {
        payload = JSON.parse(stdout);
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          throw new Error("harness JSON must be an object");
        }
      } catch {
        payload = {
          ok: false,
          error: { message: "wallet-cli harness did not return one JSON document" },
          stdout,
          stderr,
        };
      }
      resolve({
        ...payload,
        harnessExitCode: code ?? -1,
        ...(signal ? { harnessSignal: signal } : {}),
        ...(stderr.trim().length > 0 && payload.stderr === undefined
          ? { stderr: stderr.trim() }
          : {}),
      });
    });
  });
}

function serialize(task) {
  const next = executionQueue.then(task, task);
  executionQueue = next.then(() => undefined, () => undefined);
  return next;
}

function workflowArgs(value) {
  const workflow = boundedString(value?.workflow, "workflow", 64);
  if (workflow === "balance-all") {
    return value?.includeZeroAssets === true
      ? ["balance-all", "--include-zero-assets"]
      : ["balance-all"];
  }
  if (workflow === "discover") {
    const network = boundedString(value?.network, "network", 32);
    if (!new Set(["bitcoin", "ethereum", "solana"]).has(network)) {
      throw new Error("network must be bitcoin, ethereum, or solana");
    }
    return ["discover", "--network", network];
  }
  if (workflow === "device-check") return ["device-check"];
  throw new Error(`unsupported workflow: ${workflow}`);
}

function textResult(payload) {
  const isError = payload?.ok === false;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

const TOOLS = [
  {
    name: "ledger_wallet_cli_run",
    description:
      "Run the strict Wallet CLI Harness. It validates the official wallet-cli 1.0.2 command flags and parses the final JSON object.",
    inputSchema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: { type: "string" },
        },
      },
      required: ["args"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "ledger_wallet_cli_workflow",
    description:
      "Run a Wallet CLI Harness workflow: balance-all, account discovery, or bounded genuine-device check.",
    inputSchema: {
      type: "object",
      properties: {
        workflow: {
          type: "string",
          enum: ["balance-all", "discover", "device-check"],
        },
        network: {
          type: "string",
          enum: ["bitcoin", "ethereum", "solana"],
        },
        includeZeroAssets: { type: "boolean" },
      },
      required: ["workflow"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
];

async function handle(request) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = request.params?.name;
      if (name === "ledger_wallet_cli_run") {
        const args = walletArgs(request.params?.arguments?.args);
        return textResult(await serialize(() => runScript(HARNESS, ["--", ...args])));
      }
      if (name === "ledger_wallet_cli_workflow") {
        const args = workflowArgs(request.params?.arguments);
        return textResult(await serialize(() => runScript(WORKFLOW, args)));
      }
      throw new Error(`unknown tool: ${String(name)}`);
    }
    default:
      throw new Error(`method not found: ${request.method}`);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", async (line) => {
  if (line.trim().length === 0) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined || request.method?.startsWith("notifications/")) {
    return;
  }
  try {
    const result = await handle(request);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32602,
        message: error instanceof Error ? error.message : String(error),
      },
    })}\n`);
  }
});
