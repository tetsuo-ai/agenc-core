import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ProviderHttpClient } from "../../../../src/llm/client.js";
import { MetaProvider } from "../../../../src/llm/providers/meta/index.js";
import { armRunDeadline } from "../../../../src/session/run-deadline.js";
import type { LLMChatOptions } from "../../../../src/llm/types.js";

const cases = [
  { model: "muse-spark-1.3", mode: "chat" },
  { model: "muse-spark-1.3", mode: "stream" },
  { model: "muse-wonder-1.0", mode: "chat" },
  { model: "muse-wonder-1.0", mode: "stream" },
] as const;
const phases = ["headers", "body"] as const;
const messages = [{ role: "user" as const, content: "hello" }];
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function provider(baseURL: string, model: string, extra: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return new MetaProvider({ model, baseURL, apiKey: "local-test-only", ...extra });
}

function invoke(client: MetaProvider, mode: "chat" | "stream", options: LLMChatOptions = {}) {
  const bounded = { singleWireAttempt: true, ...options };
  return mode === "chat" ? client.chat(messages, bounded)
    : client.chatStream(messages, () => {}, bounded);
}

async function listen(server: Server): Promise<string> {
  const sockets = new Set<Socket>();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function silentServer(phase: typeof phases[number], delayMs: number) {
  let started!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const paths: string[] = [];
  const baseURL = await listen(createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      paths.push(request.url!);
      const { model, stream: streaming } = JSON.parse(body);
      const responses = request.url!.endsWith("/responses");
      const answer = responses ? {
        id: "resp_test", object: "response", status: "completed", model,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      } : { model, choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
      const payload = !streaming ? JSON.stringify(answer) : responses
        ? `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: answer })}\n\n`
        : `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      const headers = { "content-type": streaming ? "text/event-stream" : "application/json" };
      if (phase === "body") {
        response.writeHead(200, headers);
        response.write(streaming ? ": ready\n\n" : " ");
      }
      started();
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (phase === "headers") response.writeHead(200, headers);
        response.end(payload);
      }, delayMs);
      timers.add(timer);
    });
  }));
  cleanup.push(async () => { for (const timer of timers) clearTimeout(timer); });
  return { baseURL, received, paths };
}

function shortTransport() {
  const previous = getGlobalDispatcher();
  const agent = new Agent({ headersTimeout: 30, bodyTimeout: 30 });
  setGlobalDispatcher(agent);
  cleanup.push(async () => { setGlobalDispatcher(previous); await agent.destroy(); });
  // Node fetch lives outside Vitest's VM global. Allow the adapter's
  // dispatcher to override this explicit fallback to the test pool.
  const fetchImpl: typeof fetch = (input, init) => fetch(input, { dispatcher: agent, ...init } as RequestInit);
  return { agent, fetchImpl };
}

describe("Meta silent transport", () => {
  for (const { model, mode } of cases) for (const phase of phases) {
    test(`${model} ${mode} survives ${phase} silence beyond the pool limit`, async () => {
      const server = await silentServer(phase, 1_600);
      const { agent, fetchImpl } = shortTransport();
      await expect(invoke(provider(server.baseURL, model, { fetchImpl }), mode))
        .resolves.toMatchObject({ content: "ok" });
      expect(server.paths).toEqual([model === "muse-wonder-1.0" ? "/v1/responses" : "/v1/chat/completions"]);
      expect(getGlobalDispatcher()).toBe(agent);
    });
  }

  test.each(["chat", "stream"] as const)("selects transport from the effective per-call model for %s", async mode => {
    const server = await silentServer("headers", 1_600);
    const { fetchImpl } = shortTransport();
    const unknownDefault = provider(server.baseURL, "muse-spark-unknown", { fetchImpl });
    await expect(invoke(unknownDefault, mode, { model: "muse-spark-1.3" })).resolves.toMatchObject({ content: "ok" });
    const registeredDefault = provider(server.baseURL, "muse-spark-1.3", { fetchImpl });
    await expect(invoke(registeredDefault, mode, { model: "muse-spark-unknown" })).rejects.toThrow();
  });
});

for (const { model, mode } of cases) for (const phase of phases) {
  test.each(["provider", "per-call", "user", "run deadline"] as const)(
    `${model} ${mode} ${phase} silence still obeys %s cancellation`, async limit => {
      const server = await silentServer(phase, 10_000);
      const { fetchImpl } = shortTransport();
      const controller = new AbortController();
      cleanup.push(async () => { controller.abort(); });
      const client = provider(server.baseURL, model, {
        fetchImpl, timeoutMs: limit === "provider" ? 100 : limit === "per-call" ? 5_000 : undefined,
      });
      const pending = invoke(client, mode, {
        signal: controller.signal, timeoutMs: limit === "per-call" ? 100 : undefined,
      });
      const assertion = expect(pending).rejects.toThrow(
        limit === "user" ? /user stopped/ : limit === "run deadline" ? /run deadline reached/ : /(?:timed out after 100ms|stream idle for 100ms)/,
      );
      await server.received;
      if (limit === "user") controller.abort(new Error("user stopped"));
      if (limit === "run deadline") armRunDeadline({
        services: { runtimeOptions: { deadlineAt: Date.now() - 1 } },
      }, controller)();
      await assertion;
    },
  );
}

for (const model of ["muse-spark-1.3", "muse-wonder-1.0"]) {
  test(`the Core stream watchdog still stops ${model} inside the longer transport silence limit`, async () => {
    const server = await silentServer("body", 10_000);
    const { fetchImpl } = shortTransport();
    const createSession = ProviderHttpClient.prototype.createTurnSession;
    vi.spyOn(ProviderHttpClient.prototype, "createTurnSession").mockImplementation(function (overrides) {
      return createSession.call(this, { ...overrides, streamIdleTimeoutMs: 50 });
    });
    await expect(invoke(provider(server.baseURL, model, { fetchImpl }), "stream"))
      .rejects.toThrow(/meta stream idle for 50ms/);
  });
}
