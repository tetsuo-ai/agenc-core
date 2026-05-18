import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { trustProjectSync } from "../permissions/trust/project-trust.js";
import { openStateDatabases } from "../state/sqlite-driver.js";
import {
  createAgenCJsonLineDaemonRequestClient,
  createConnectedAgenCJsonLineDaemonTuiClient,
} from "./agent-cli.js";
import {
  readAgenCDaemonPid,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonPidPath,
  resolveAgenCDaemonSocketPath,
} from "./daemon-cli.js";
import type { AgentSummary, JsonObject } from "./protocol/index.js";

const execFileAsync = promisify(execFile);
const MODEL = "compiler-e2e-model";
const OBJECTIVE = "build a small c compiler";
const WRITE_CALL_ID = "call_write_smallcc";
const TEST_TIMEOUT_MS = 60_000;
const requireForTest = createRequire(import.meta.url);

type AgencInvocation = {
  readonly command: string;
  readonly argsPrefix: readonly string[];
  readonly source: "source-dispatcher";
};

type RunningDaemon = {
  readonly child: ChildProcess;
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
};

type PermissionRequest = {
  readonly requestId: string;
  readonly toolName?: string;
  readonly input?: JsonObject;
};

type AgentRunRecord = {
  readonly status: string;
  readonly currentSessionId: string | null;
};

function createDeferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value?: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null> | T | null,
  timeoutMs = 5_000,
): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await fn();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(
    `timed out waiting for ${label}` +
      (lastError instanceof Error ? `: ${lastError.message}` : ""),
  );
}

async function withTimeout<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function assertPackageBinIsBuildShim(runtimeRoot: string): Promise<void> {
  const bin = await readFile(join(runtimeRoot, "bin/agenc"), "utf8");
  expect(bin).toContain("../dist/bin/agenc.js");
}

async function createAgencInvocation(
  workspace: string,
): Promise<AgencInvocation> {
  const runtimeRoot = process.cwd();
  await assertPackageBinIsBuildShim(runtimeRoot);

  // Vitest runs the TypeScript entrypoint so this suite does not require a
  // prebuilt package. The bin assertion above keeps that substitute tied to the
  // package shim covered by the full build verification.
  const shimDir = join(workspace, ".agenc-test-bin", "bin");
  await mkdir(shimDir, { recursive: true });
  const shimPath = join(shimDir, "agenc-source-entry.mjs");
  const loaderPath = join(shimDir, "md-loader.mjs");
  const sourceEntrypoint = join(runtimeRoot, "src/bin/agenc.ts");

  await writeFile(
    loaderPath,
    [
      "import { pathToFileURL } from 'node:url';",
      `const bunBundleFeatureUrl = pathToFileURL(${JSON.stringify(
        join(runtimeRoot, "src/build/feature.ts"),
      )}).href;`,
      "export async function resolve(specifier, context, nextResolve) {",
      "  if (specifier === 'bun:bundle') {",
      "    return { url: bunBundleFeatureUrl, shortCircuit: true };",
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      "export async function load(url, context, nextLoad) {",
      "  if (url.endsWith('.md')) {",
      "    return { format: 'module', source: 'export default \"\";', shortCircuit: true };",
      "  }",
      "  return nextLoad(url, context);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    shimPath,
    [
      "import { pathToFileURL } from 'node:url';",
      `const mod = await import(pathToFileURL(${JSON.stringify(
        sourceEntrypoint,
      )}).href);`,
      "process.exit(await mod.main());",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    command: process.execPath,
    argsPrefix: [
      "--loader",
      loaderPath,
      "--import",
      requireForTest.resolve("tsx"),
      shimPath,
    ],
    source: "source-dispatcher",
  };
}

function createChildEnv(params: {
  readonly agencHome: string;
  readonly fakeProviderBaseUrl: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENC_HOME: params.agencHome,
    AGENC_PROVIDER: "openai-compatible",
    AGENC_MODEL: MODEL,
    OPENAI_COMPATIBLE_BASE_URL: params.fakeProviderBaseUrl,
    OPENAI_COMPATIBLE_MODEL: MODEL,
    AGENC_DAEMON_AUTOSTART: "0",
    AGENC_DAEMON_REQUEST_TIMEOUT_MS: "10000",
    AGENC_DAEMON_WEBSOCKET_PORT: "0",
    HOME: params.agencHome,
    NODE_OPTIONS: "--no-warnings",
    NO_COLOR: "1",
    TSX_TSCONFIG_PATH: join(process.cwd(), "tsconfig.json"),
  };
  delete env.AGENC_CLI_ENTRY_DISABLE;
  return env;
}

async function runAgencProcess(params: {
  readonly invocation: AgencInvocation;
  readonly workspace: string;
  readonly env: NodeJS.ProcessEnv;
  readonly args: readonly string[];
}): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(
    params.invocation.command,
    [...params.invocation.argsPrefix, ...params.args],
    {
      cwd: params.workspace,
      env: params.env,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

async function startDaemonProcess(params: {
  readonly invocation: AgencInvocation;
  readonly workspace: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<RunningDaemon> {
  const child = spawn(
    params.invocation.command,
    [...params.invocation.argsPrefix, "daemon", "start", "--foreground"],
    {
      cwd: params.workspace,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exited = once(child, "exit").then(([code, signal]) => {
    throw new Error(
      `daemon exited before ready: code=${String(code)} signal=${String(
        signal,
      )} stdout=${stdout} stderr=${stderr}`,
    );
  });
  await Promise.race([
    waitFor("daemon pid", async () => {
      const pid = await readAgenCDaemonPid(
        resolveAgenCDaemonPidPath(params.env),
      );
      return pid === child.pid ? pid : null;
    }),
    exited,
  ]);
  await waitFor("daemon socket", async () =>
    (await pathExists(resolveAgenCDaemonSocketPath(params.env)))
      ? true
      : null,
  );

  return {
    child,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

async function crashDaemon(daemon: RunningDaemon): Promise<void> {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) return;
  daemon.child.kill("SIGKILL");
  await once(daemon.child, "exit");
}

async function stopDaemon(daemon: RunningDaemon): Promise<void> {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) return;
  daemon.child.kill("SIGTERM");
  const [code, signal] = await once(daemon.child, "exit");
  expect({ code, signal }).toEqual({ code: 0, signal: null });
}

async function daemonAuthCookie(agencHome: string): Promise<string> {
  return (
    await readFile(
      resolveAgenCDaemonCookiePath({ AGENC_HOME: agencHome }),
      "utf8",
    )
  ).trim();
}

function requestClient(agencHome: string) {
  return createAgenCJsonLineDaemonRequestClient({
    socketPath: resolveAgenCDaemonSocketPath({ AGENC_HOME: agencHome }),
    authCookie: daemonAuthCookie(agencHome),
    timeoutMs: 2_000,
  });
}

async function attachedTuiClient(params: {
  readonly agencHome: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly clientId: string;
}) {
  const client = await createConnectedAgenCJsonLineDaemonTuiClient({
    socketPath: resolveAgenCDaemonSocketPath({ AGENC_HOME: params.agencHome }),
    authCookie: await daemonAuthCookie(params.agencHome),
    timeoutMs: 2_000,
  });
  await client.request("agent.attach", {
    agentId: params.agentId,
    clientId: params.clientId,
  });
  return client;
}

function waitForPermissionRequest(
  client: Awaited<ReturnType<typeof attachedTuiClient>>,
  sessionId: string,
): Promise<PermissionRequest> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      if (unsubscribe === undefined) {
        queueMicrotask(() => unsubscribe?.());
        return;
      }
      unsubscribe();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for permission request"));
    }, 5_000);
    unsubscribe = client.subscribeToSessionEvents(sessionId, (message) => {
      const params = message.params;
      if (
        message.method !== "event.permission_request" ||
        params === null ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        typeof params.requestId !== "string"
      ) {
        return;
      }
      cleanup();
      const input = params.input;
      resolve({
        requestId: params.requestId,
        ...(typeof params.toolName === "string" ? { toolName: params.toolName } : {}),
        ...(input !== undefined &&
        input !== null &&
        typeof input === "object" &&
        !Array.isArray(input)
          ? { input: input as JsonObject }
          : {}),
      });
    });
  });
}

async function approvePermission(params: {
  readonly client: Awaited<ReturnType<typeof attachedTuiClient>>;
  readonly sessionId: string;
  readonly requestId: string;
}): Promise<void> {
  await params.client.request("tool.approve", {
    sessionId: params.sessionId,
    requestId: params.requestId,
    scope: "once",
  });
}

async function waitForAgent(
  agencHome: string,
  agentId: string,
  predicate: (agent: AgentSummary) => boolean,
  timeoutMs = 5_000,
): Promise<AgentSummary> {
  return waitFor(`agent ${agentId}`, async () => {
    const list = await requestClient(agencHome).request("agent.list", {});
    const agent = list.agents.find((candidate) => candidate.agentId === agentId);
    return agent && predicate(agent) ? agent : null;
  }, timeoutMs);
}

function readAgentRunRecord(
  agencHome: string,
  cwd: string,
  runId: string,
): AgentRunRecord | null {
  const driver = openStateDatabases({ cwd, agencHome });
  try {
    const row =
      driver
        .prepareState<
          [string],
          { status: string; current_session_id: string | null }
        >(
          `SELECT status, current_session_id
           FROM agent_runs
           WHERE id = ?`,
        )
        .get(runId) ?? null;
    return row === null
      ? null
      : {
          status: row.status,
          currentSessionId: row.current_session_id,
        };
  } finally {
    driver.close();
  }
}

function getActiveSessionIds(agent: AgentSummary): readonly string[] {
  return agent.activeSessionIds ?? [];
}

function snapshotCount(
  agencHome: string,
  cwd: string,
  sessionId: string,
): number {
  const driver = openStateDatabases({ cwd, agencHome });
  try {
    return (
      driver
        .prepareState<[string], { count: number }>(
          `SELECT COUNT(*) AS count
           FROM session_state_snapshots
           WHERE session_id = ?`,
        )
        .get(sessionId)?.count ?? 0
    );
  } finally {
    driver.close();
  }
}

async function waitForSnapshotCount(
  agencHome: string,
  cwd: string,
  sessionId: string,
  minimum: number,
): Promise<void> {
  await waitFor(`snapshot count ${minimum}`, () =>
    snapshotCount(agencHome, cwd, sessionId) >= minimum ? true : null,
  );
}

async function waitForAgentRunStatus(params: {
  readonly agencHome: string;
  readonly workspace: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly status: string;
}): Promise<AgentRunRecord> {
  return waitFor(`agent run ${params.status}`, () => {
    const record = readAgentRunRecord(
      params.agencHome,
      params.workspace,
      params.runId,
    );
    return record?.status === params.status &&
      record.currentSessionId === params.sessionId
      ? record
      : null;
  });
}

function stableCompilerSource(): string {
  return String.raw`const { readFileSync, writeFileSync } = require("node:fs");

function fail(message) {
  console.error(message);
  process.exit(65);
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function tokenize(expr) {
  const compact = expr.replace(/\s+/g, "");
  const tokens = compact.match(/\d+|[()+\-*/]/g) || [];
  if (tokens.join("") !== compact) fail("unsupported expression: " + expr.trim());
  return tokens;
}

function parseIntegerExpression(expr) {
  const tokens = tokenize(expr);
  let index = 0;

  function peek() {
    return tokens[index];
  }

  function take() {
    return tokens[index++];
  }

  function factor() {
    const token = take();
    if (token === "-") return -factor();
    if (token === "(") {
      const value = expression();
      if (take() !== ")") fail("missing ) in expression");
      return value;
    }
    if (!/^\d+$/.test(token || "")) fail("expected integer");
    return Number(token);
  }

  function term() {
    let value = factor();
    while (peek() === "*" || peek() === "/") {
      const op = take();
      const rhs = factor();
      if (op === "*") {
        value *= rhs;
      } else {
        if (rhs === 0) fail("division by zero");
        value = Math.trunc(value / rhs);
      }
    }
    return value;
  }

  function expression() {
    let value = term();
    while (peek() === "+" || peek() === "-") {
      const op = take();
      const rhs = term();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  const result = expression();
  if (index !== tokens.length) fail("trailing expression tokens");
  return result;
}

function compile(source) {
  const clean = stripComments(source);
  const main = /int\s+main\s*\(\s*void\s*\)\s*\{([\s\S]*)\}\s*$/.exec(clean);
  if (!main) fail("expected int main(void)");
  const body = main[1];
  const statements = body.split(";").map((part) => part.trim()).filter(Boolean);
  for (const statement of statements) {
    const branch = /^if\s*\(([^)]+)\)\s*return\s+(.+)$/.exec(statement);
    if (branch) {
      if (parseIntegerExpression(branch[1]) !== 0) {
        return parseIntegerExpression(branch[2]);
      }
      continue;
    }
    const direct = /^return\s+(.+)$/.exec(statement);
    if (direct) return parseIntegerExpression(direct[1]);
  }
  fail("expected a reachable return statement");
}

const args = process.argv.slice(2);
const inputPath = args[0];
const outputFlag = args.indexOf("-o");
const outputPath = outputFlag >= 0 ? args[outputFlag + 1] : "a.out";
if (!inputPath || !outputPath) {
  console.error("usage: smallcc <source.c> -o <program>");
  process.exit(64);
}

const exitCode = ((compile(readFileSync(inputPath, "utf8")) % 256) + 256) % 256;
writeFileSync(
  outputPath,
  "#!/usr/bin/env node\nprocess.exit(" + JSON.stringify(exitCode) + ");\n",
);
`;
}

function compilerWriteArguments(): JsonObject {
  return {
    file_path: "smallcc",
    content: stableCompilerSource(),
  };
}

function sse(res: ServerResponse, payload: Record<string, unknown> | "[DONE]"): void {
  res.write(
    `data: ${payload === "[DONE]" ? "[DONE]" : JSON.stringify(payload)}\n\n`,
  );
}

function requestContainsObjective(body: JsonObject): boolean {
  return JSON.stringify(body.messages ?? "").includes(OBJECTIVE);
}

async function readJsonBody(req: IncomingMessage): Promise<JsonObject> {
  let raw = "";
  req.setEncoding("utf8");
  for await (const chunk of req) {
    raw += String(chunk);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body was not a JSON object");
  }
  return parsed as JsonObject;
}

class ScriptedOpenAICompatibleServer {
  readonly #server = createServer((req, res) => {
    void this.#handle(req, res).catch((error) => {
      res.statusCode = 500;
      res.end(String(error instanceof Error ? error.message : error));
    });
  });
  readonly #initialToolRequest = createDeferred<void>();
  readonly #firstPostToolRequest = createDeferred<void>();
  readonly #secondPostToolRequest = createDeferred<void>();
  readonly #releaseFinal = createDeferred<void>();
  readonly #finalResponseSent = createDeferred<void>();
  #baseUrl = "";
  #issuedToolCall = false;
  #postToolRequestCount = 0;
  #sawObjective = false;

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get sawObjective(): boolean {
    return this.#sawObjective;
  }

  async start(): Promise<void> {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    const address = this.#server.address() as AddressInfo;
    this.#baseUrl = `http://127.0.0.1:${address.port}/v1`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async waitForInitialToolRequest(): Promise<void> {
    await withTimeout("initial tool request", this.#initialToolRequest.promise);
  }

  async waitForFirstPostToolRequest(): Promise<void> {
    await withTimeout(
      "first post-tool request",
      this.#firstPostToolRequest.promise,
    );
  }

  async waitForSecondPostToolRequest(): Promise<void> {
    await withTimeout(
      "second post-tool request",
      this.#secondPostToolRequest.promise,
      30_000,
    );
  }

  releaseFinalResponse(): void {
    this.#releaseFinal.resolve();
  }

  async waitForFinalResponse(): Promise<void> {
    await withTimeout("final response", this.#finalResponseSent.promise);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: MODEL, object: "model" }] }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    const body = await readJsonBody(req);
    this.#sawObjective ||= requestContainsObjective(body);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    if (!this.#issuedToolCall) {
      this.#issuedToolCall = true;
      this.#initialToolRequest.resolve();
      this.#writeToolCall(res);
      return;
    }

    this.#postToolRequestCount += 1;
    if (this.#postToolRequestCount === 1) {
      this.#firstPostToolRequest.resolve();
      await new Promise<void>((resolve) => req.once("close", resolve));
      return;
    }
    if (this.#postToolRequestCount !== 2) {
      throw new Error(
        `unexpected post-tool request ${this.#postToolRequestCount}`,
      );
    }
    this.#secondPostToolRequest.resolve();
    await this.#releaseFinal.promise;
    this.#writeFinalResponse(res);
  }

  #writeToolCall(res: ServerResponse): void {
    sse(res, {
      id: "chatcmpl_tool",
      model: MODEL,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: WRITE_CALL_ID,
                type: "function",
                function: {
                  name: "Write",
                  arguments: JSON.stringify(compilerWriteArguments()),
                },
              },
            ],
          },
        },
      ],
    });
    sse(res, {
      id: "chatcmpl_tool_done",
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    });
    sse(res, "[DONE]");
    res.end();
  }

  #writeFinalResponse(res: ServerResponse): void {
    sse(res, {
      id: "chatcmpl_final",
      model: MODEL,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "compiler built" },
        },
      ],
    });
    sse(res, {
      id: "chatcmpl_final_done",
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 17, completion_tokens: 2, total_tokens: 19 },
    });
    sse(res, "[DONE]");
    res.end();
    this.#finalResponseSent.resolve();
  }
}

async function writeProgram(
  workspace: string,
  name: string,
  source: string,
): Promise<{ sourcePath: string; programPath: string }> {
  const sourcePath = join(workspace, `${name}.c`);
  const programPath = join(workspace, name);
  await writeFile(sourcePath, source, "utf8");
  return { sourcePath, programPath };
}

async function expectProgramExit(params: {
  readonly compilerPath: string;
  readonly workspace: string;
  readonly name: string;
  readonly source: string;
  readonly code: number;
}): Promise<void> {
  const program = await writeProgram(params.workspace, params.name, params.source);
  await expect(
    execFileAsync(process.execPath, [
      params.compilerPath,
      program.sourcePath,
      "-o",
      program.programPath,
    ]),
  ).resolves.toMatchObject({ stderr: "" });
  await expect(execFileAsync(process.execPath, [program.programPath]))
    .rejects.toMatchObject({ code: params.code });
}

async function expectCompilerError(params: {
  readonly compilerPath: string;
  readonly workspace: string;
}): Promise<void> {
  const program = await writeProgram(
    params.workspace,
    "bad",
    "int main(void) { puts(1); }\n",
  );
  await expect(
    execFileAsync(process.execPath, [
      params.compilerPath,
      program.sourcePath,
      "-o",
      program.programPath,
    ]),
  ).rejects.toMatchObject({ code: 65 });
  await expect(pathExists(program.programPath)).resolves.toBe(false);
}

describe("canonical agent c-compiler e2e", () => {
  it(
    "runs agenc agent start through real daemon restarts and produces a working compiler",
    async () => {
      const agencHome = await mkdtemp(join(tmpdir(), "agenc-c-compiler-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "agenc-c-compiler-work-"));
      const server = new ScriptedOpenAICompatibleServer();
      const runningDaemons = new Set<RunningDaemon>();
      let firstClient: Awaited<ReturnType<typeof attachedTuiClient>> | null = null;
      let thirdDaemon: RunningDaemon | null = null;

      try {
        await mkdir(join(workspace, ".git"));
        await server.start();
        const invocation = await createAgencInvocation(workspace);
        expect(invocation.source).toBe("source-dispatcher");
        const env = createChildEnv({
          agencHome,
          fakeProviderBaseUrl: server.baseUrl,
        });
        trustProjectSync({
          agencHome,
          projectRoot: workspace,
          env,
        });

        const firstDaemon = await startDaemonProcess({
          invocation,
          workspace,
          env,
        });
        runningDaemons.add(firstDaemon);
        const start = await runAgencProcess({
          invocation,
          workspace,
          env,
          args: ["agent", "start", OBJECTIVE],
        });
        expect(start.stderr).toBe("");
        const agentId = start.stdout.trim();
        expect(agentId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );

        await server.waitForInitialToolRequest();
        expect(server.sawObjective).toBe(true);

        const firstAgent = await waitForAgent(
          agencHome,
          agentId,
          (agent) => getActiveSessionIds(agent).length === 1,
        );
        expect(firstAgent).toEqual(
          expect.objectContaining({
            agentId,
            objective: OBJECTIVE,
            status: "running",
          }),
        );
        const sessionId = getActiveSessionIds(firstAgent)[0];
        expect(sessionId).toBeDefined();
        await waitForSnapshotCount(agencHome, workspace, sessionId!, 1);
        expect(readAgentRunRecord(agencHome, workspace, agentId)).toMatchObject({
          status: "running",
          currentSessionId: sessionId,
        });

        firstClient = await attachedTuiClient({
          agencHome,
          agentId,
          sessionId: sessionId!,
          clientId: "compiler-e2e-first",
        });
        const firstPermission = await waitForPermissionRequest(
          firstClient,
          sessionId!,
        );
        expect(firstPermission).toMatchObject({
          requestId: WRITE_CALL_ID,
          toolName: "Write",
          input: expect.objectContaining({ file_path: "smallcc" }),
        });
        await approvePermission({
          client: firstClient,
          sessionId: sessionId!,
          requestId: firstPermission.requestId,
        });
        const compilerPath = join(workspace, "smallcc");
        await waitFor("compiler file", async () =>
          (await pathExists(compilerPath)) ? true : null,
        );
        await server.waitForFirstPostToolRequest();
        await waitForSnapshotCount(agencHome, workspace, sessionId!, 2);
        await firstClient.close();
        firstClient = null;

        await crashDaemon(firstDaemon);
        runningDaemons.delete(firstDaemon);

        const secondDaemon = await startDaemonProcess({
          invocation,
          workspace,
          env,
        });
        runningDaemons.add(secondDaemon);
        const recoveredSecond = await waitForAgent(
          agencHome,
          agentId,
          (agent) => getActiveSessionIds(agent).includes(sessionId!),
          30_000,
        );
        expect(["idle", "running"]).toContain(recoveredSecond.status);
        expect(recoveredSecond.metadata).toEqual(
          expect.objectContaining({
            recovery: expect.objectContaining({
              runtimeRestore: "available",
              runnable: true,
            }),
          }),
        );
        await server.waitForSecondPostToolRequest();
        server.releaseFinalResponse();
        await server.waitForFinalResponse();
        await waitForAgentRunStatus({
          agencHome,
          workspace,
          runId: agentId,
          sessionId: sessionId!,
          status: "completed",
        });

        await expectProgramExit({
          compilerPath,
          workspace,
          name: "literal",
          source: "int main(void) {\n  return 7;\n}\n",
          code: 7,
        });
        await expectProgramExit({
          compilerPath,
          workspace,
          name: "expression",
          source: [
            "/* comments and whitespace are ignored */",
            "int main(void) {",
            "  return 2 + 3 * (4 - 1);",
            "}",
            "",
          ].join("\n"),
          code: 11,
        });
        await expectProgramExit({
          compilerPath,
          workspace,
          name: "branch",
          source: "int main(void) { if (0) return 3; return 9; }\n",
          code: 9,
        });
        await expectCompilerError({ compilerPath, workspace });

        expect(readAgentRunRecord(agencHome, workspace, agentId)).toMatchObject({
          status: "completed",
          currentSessionId: sessionId,
        });

        await crashDaemon(secondDaemon);
        runningDaemons.delete(secondDaemon);

        thirdDaemon = await startDaemonProcess({
          invocation,
          workspace,
          env,
        });
        runningDaemons.add(thirdDaemon);
        await waitFor("daemon RPC after second restart", async () => {
          const list = await requestClient(agencHome).request("agent.list", {});
          return Array.isArray(list.agents) ? true : null;
        });
        expect(readAgentRunRecord(agencHome, workspace, agentId)).toMatchObject({
          status: "completed",
          currentSessionId: sessionId,
        });

        await stopDaemon(thirdDaemon);
        runningDaemons.delete(thirdDaemon);
        thirdDaemon = null;
      } finally {
        await firstClient?.close().catch(() => {});
        for (const daemon of runningDaemons) {
          await crashDaemon(daemon).catch(() => {});
        }
        if (thirdDaemon !== null) {
          await crashDaemon(thirdDaemon).catch(() => {});
        }
        await server.stop().catch(() => {});
        await rm(workspace, { recursive: true, force: true });
        await rm(agencHome, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
