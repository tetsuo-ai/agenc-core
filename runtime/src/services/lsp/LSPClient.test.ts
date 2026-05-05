import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { createLSPClient } from "./LSPClient.js";

const EXITING_SERVER = "setTimeout(() => process.exit(1), 10)";
const CLEAN_EXIT_SERVER = "setTimeout(() => process.exit(0), 10)";
const CLOSE_CONNECTION_SERVER = `
setTimeout(() => {
  process.stdout.end();
}, 10);
setInterval(() => {}, 1000);
`;
const JSON_RPC_SERVER = `
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    setTimeout(() => send({ jsonrpc: "2.0", method: "custom/event", params: { ok: true } }), 5);
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") {
    process.exit(0);
  }
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length: (\\d+)/i.exec(header);
    if (!match) throw new Error("missing content length");
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});
`;

describe("createLSPClient", () => {
  test("clears closed process state so a crashed server can be started again", async () => {
    let crashCount = 0;
    const client = createLSPClient("crashy", {
      onCrash: () => {
        crashCount += 1;
      },
    });

    await client.start(process.execPath, ["-e", EXITING_SERVER]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(crashCount).toBe(1);

    await client.start(process.execPath, ["-e", EXITING_SERVER]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(crashCount).toBe(2);
  });

  test("reports unexpected clean exits and can be started again", async () => {
    const terminalEvents: string[] = [];
    const client = createLSPClient("clean-exit", {
      onCrash: (error) => {
        terminalEvents.push(error.message);
      },
    });

    await client.start(process.execPath, ["-e", CLEAN_EXIT_SERVER]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(terminalEvents).toEqual([
      "LSP server clean-exit connection closed unexpectedly",
    ]);

    await client.start(process.execPath, ["-e", CLEAN_EXIT_SERVER]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(terminalEvents).toHaveLength(2);
  });

  test("reports unexpected JSON-RPC connection close", async () => {
    const terminalEvents: string[] = [];
    const client = createLSPClient("close", {
      onCrash: (error) => {
        terminalEvents.push(error.message);
      },
    });

    await client.start(process.execPath, ["-e", CLOSE_CONNECTION_SERVER]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(terminalEvents).toEqual([
      "LSP server close connection closed unexpectedly",
    ]);
    expect(client.isInitialized).toBe(false);
  });

  test("scrubs inherited secrets while preserving explicit config env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-lsp-env-"));
    const output = join(dir, "env.json");
    try {
      const client = createLSPClient("env", {
        baseEnv: {
          PATH: process.env.PATH,
          HOME: "/home/test",
          OPENAI_API_KEY: "secret",
          OPENROUTER_API_KEY: "openrouter-secret",
          GOOGLE_API_KEY: "google-secret",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc",
          INPUT_OPENAI_API_KEY: "duplicated",
          INPUT_GEMINI_API_KEY: "duplicated-gemini",
        },
      });

      await client.start(process.execPath, [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env));`,
      ], {
        env: { LSP_EXPLICIT_ENV: "kept" },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const env = JSON.parse(await readFile(output, "utf8")) as Record<
        string,
        string | undefined
      >;
      expect(env.HOME).toBe("/home/test");
      expect(env.LSP_EXPLICIT_ENV).toBe("kept");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.GOOGLE_API_KEY).toBeUndefined();
      expect(env.INPUT_OPENAI_API_KEY).toBeUndefined();
      expect(env.INPUT_GEMINI_API_KEY).toBeUndefined();
      expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-registers handlers after restart", async () => {
    const client = createLSPClient("jsonrpc");
    let notificationCount = 0;
    client.onNotification("custom/event", () => {
      notificationCount += 1;
    });

    await client.start(process.execPath, ["-e", JSON_RPC_SERVER]);
    await client.initialize({
      processId: process.pid,
      capabilities: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.stop();

    await client.start(process.execPath, ["-e", JSON_RPC_SERVER]);
    await client.initialize({
      processId: process.pid,
      capabilities: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.stop();

    expect(notificationCount).toBe(2);
  });
});
