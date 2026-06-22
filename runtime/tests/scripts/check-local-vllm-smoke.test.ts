import { createServer, type IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { runtimeRootPath } from "../helpers/source-path.ts";

const scriptPath = resolve(runtimeRootPath, "scripts", "check-local-vllm-smoke.mjs");

type SmokeModule = {
  assertLocalBaseUrl(baseUrl: string, allowNonLocal?: boolean): void;
  buildChatRequest(model: string): unknown;
  isLoopbackUrl(baseUrl: string): boolean;
  resolveSmokeConfig(options: { argv?: string[]; env?: NodeJS.ProcessEnv }): {
    readonly baseUrl: string;
    readonly requestedModel?: string;
    readonly modelsOnly: boolean;
    readonly timeoutMs: number;
  };
  selectModel(modelsResponse: unknown, requestedModel?: string): string;
};

async function loadSmokeModule(): Promise<SmokeModule> {
  return await import(pathToFileURL(scriptPath).href) as SmokeModule;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => resolveBody(body));
  });
}

function runScript(args: string[], env: NodeJS.ProcessEnv): Promise<{
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: runtimeRootPath,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolveRun({ status, stdout, stderr });
    });
  });
}

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  const closing = servers.splice(0);
  await Promise.all(closing.map((server) => server.close()));
});

async function startFakeOpenAiCompatibleServer() {
  const requests: Array<{
    readonly method: string | undefined;
    readonly url: string | undefined;
    readonly body: unknown;
    readonly authorization: string | undefined;
  }> = [];
  const server = createServer(async (request, response) => {
    const rawBody = await readBody(request);
    const body = rawBody.length > 0 ? JSON.parse(rawBody) : null;
    requests.push({
      method: request.method,
      url: request.url,
      body,
      authorization: request.headers.authorization,
    });

    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: [{ id: "fake-local-model", object: "model" }],
      }));
      return;
    }

    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-local",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "LOCAL_VLLM_SMOKE_OK",
            },
            finish_reason: "stop",
          },
        ],
      }));
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake server did not bind to a TCP port");
  }
  servers.push({
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolveClose();
      });
    }),
  });
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
}

describe("check-local-vllm-smoke helpers", () => {
  test("accepts loopback URLs and rejects nonlocal URLs by default", async () => {
    const smoke = await loadSmokeModule();

    expect(smoke.isLoopbackUrl("http://127.0.0.1:8000/v1")).toBe(true);
    expect(smoke.isLoopbackUrl("http://localhost:8000/v1")).toBe(true);
    expect(smoke.isLoopbackUrl("https://api.openai.com/v1")).toBe(false);
    expect(() => smoke.assertLocalBaseUrl("https://api.openai.com/v1")).toThrow(
      /refusing non-local/i,
    );
    expect(() => smoke.assertLocalBaseUrl(
      "https://api.openai.com/v1",
      true,
    )).not.toThrow();
  });

  test("prefers an explicit model and otherwise uses the first discovered model", async () => {
    const smoke = await loadSmokeModule();
    const response = { data: [{ id: "first-local" }, { id: "second-local" }] };

    expect(smoke.selectModel(response)).toBe("first-local");
    expect(smoke.selectModel(response, " explicit-local ")).toBe("explicit-local");
    expect(() => smoke.selectModel({ data: [] })).toThrow(/no models/i);
  });

  test("resolves safe defaults without carrying remote provider settings", async () => {
    const smoke = await loadSmokeModule();

    const config = smoke.resolveSmokeConfig({
      argv: ["--models-only"],
      env: {
        OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
        AGENC_MODEL: "local-model",
      },
    });

    expect(config.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(config.requestedModel).toBe("local-model");
    expect(config.modelsOnly).toBe(true);
    expect(config.timeoutMs).toBe(30_000);
  });

  test("rejects malformed CLI values before network access", async () => {
    const smoke = await loadSmokeModule();

    expect(() => smoke.resolveSmokeConfig({
      argv: ["--base-url"],
      env: {},
    })).toThrow(/requires a value/i);
    expect(() => smoke.resolveSmokeConfig({
      argv: ["--timeout-ms", "10seconds"],
      env: {},
    })).toThrow(/positive integer/i);
  });

  test("builds a minimal non-streaming chat-completions request", async () => {
    const smoke = await loadSmokeModule();

    expect(smoke.buildChatRequest("fake-local-model")).toMatchObject({
      model: "fake-local-model",
      max_tokens: 16,
      stream: false,
      messages: [
        {
          role: "user",
        },
      ],
    });
  });
});

describe("check-local-vllm-smoke script", () => {
  test("checks /models and /chat/completions on a local endpoint", async () => {
    const server = await startFakeOpenAiCompatibleServer();
    const result = await runScript(
      [
        scriptPath,
        "--base-url",
        server.baseUrl,
        "--api-key",
        "test-local-key",
      ],
      {
        ...process.env,
        AGENC_LOCAL_OPENAI_MODEL: "",
        AGENC_LOCAL_VLLM_MODEL: "",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        AGENC_MODEL: "",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Local vLLM/OpenAI-compatible smoke passed");
    expect(result.stdout).toContain("fake-local-model");
    expect(server.requests.map((request) => request.url)).toEqual([
      "/v1/models",
      "/v1/chat/completions",
    ]);
    expect(server.requests[1]?.authorization).toBe("Bearer test-local-key");
    expect(server.requests[1]?.body).toMatchObject({
      model: "fake-local-model",
      stream: false,
    });
  });
});
