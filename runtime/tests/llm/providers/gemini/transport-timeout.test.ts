import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, test, vi } from "vitest";

import { GeminiProvider } from "../../../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../../../src/llm/providers/gemini/endpoint-plan.js";
import { ProviderHttpClientSession } from "../../../../src/llm/client-session.js";
import { geminiTransportFetch } from "../../../../src/llm/providers/gemini/transport.js";
import { armRunDeadline } from "../../../../src/session/run-deadline.js";
import type { LLMChatOptions } from "../../../../src/llm/types.js";

const models = ["gemini-4-argon", "gemini-4-carbon"] as const;
const modes = ["chat", "stream"] as const;
const phases = ["headers", "body"] as const;
const messages = [{ role: "user" as const, content: "hello" }];
const answer = {
  candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
};
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function provider(baseURL: string, model: string, extra: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return new GeminiProvider({
    model,
    endpointPlan: createGeminiEndpointPlan({ baseURL }),
    credentialPlan: { kind: "api-key", credential: "local-test-only", source: "factory" },
    ...extra,
  });
}

function invoke(client: GeminiProvider, mode: typeof modes[number], options: LLMChatOptions = {}) {
  const bounded = { singleWireAttempt: true, ...options };
  return mode === "chat" ? client.chat(messages, bounded)
    : client.chatStream(messages, () => {}, bounded);
}

async function listen(server: Server): Promise<string> {
  const sockets = new Set<import("node:net").Socket>();
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
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
}

async function silentServer(phase: typeof phases[number], delayMs: number) {
  let started!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const baseURL = await listen(createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const streaming = request.url!.includes("streamGenerateContent");
      const payload = streaming ? `data: ${JSON.stringify(answer)}\n\n` : JSON.stringify(answer);
      if (phase === "body") {
        response.writeHead(200, { "content-type": streaming ? "text/event-stream" : "application/json" });
        response.write(streaming ? ": ready\n\n" : " ");
      }
      started();
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (phase === "headers") response.writeHead(200, {
          "content-type": streaming ? "text/event-stream" : "application/json",
        });
        response.end(payload);
      }, delayMs);
      timers.add(timer);
    });
  }));
  cleanup.push(async () => { for (const timer of timers) clearTimeout(timer); });
  return { baseURL, received };
}

function shortTransport() {
  const previous = getGlobalDispatcher();
  const agent = new Agent({ headersTimeout: 30, bodyTimeout: 30 });
  setGlobalDispatcher(agent);
  cleanup.push(async () => { setGlobalDispatcher(previous); await agent.destroy(); });
  return agent;
}

function poolFetch(agent: Agent | EnvHttpProxyAgent): typeof fetch {
  // Native fetch's global dispatcher lives outside Vitest's VM global.
  // Supply this test pool explicitly, while allowing the adapter to wrap it.
  return (input, init) => fetch(input, { dispatcher: agent, ...init } as RequestInit);
}

describe("Gemini 4 silent transport", () => {
  for (const model of models) for (const mode of modes) for (const phase of phases) {
    test(`${model} ${mode} survives ${phase} silence beyond the pool limit`, async () => {
      const server = await silentServer(phase, 1_600);
      const agent = shortTransport();
      await expect(invoke(provider(server.baseURL, model, { fetchImpl: poolFetch(agent) }), mode))
        .resolves.toMatchObject({ content: "ok" });
      expect(getGlobalDispatcher()).toBe(agent);
    });
  }

  test.each(modes)("selects transport from the effective per-call model for %s", async mode => {
    const server = await silentServer("headers", 1_600);
    const agent = shortTransport();
    const oldDefault = provider(server.baseURL, "gemini-3.8-flash", { fetchImpl: poolFetch(agent) });
    await expect(invoke(oldDefault, mode, { model: "gemini-4-carbon" })).resolves.toMatchObject({ content: "ok" });
    const newDefault = provider(server.baseURL, "gemini-4-carbon", { fetchImpl: poolFetch(agent) });
    await expect(invoke(newDefault, mode, { model: "gemini-3.8-flash" })).rejects.toThrow();
  });
});

for (const mode of modes) for (const phase of phases) {
  test.each(["provider", "per-call", "user", "run deadline"] as const)(
    `${mode} ${phase} silence still obeys %s cancellation`, async limit => {
      const server = await silentServer(phase, 10_000);
      const agent = shortTransport();
      const controller = new AbortController();
      cleanup.push(async () => { controller.abort(); });
      const client = provider(server.baseURL, "gemini-4-carbon", {
        fetchImpl: poolFetch(agent),
        timeoutMs: limit === "provider" ? 100 : limit === "per-call" ? 5_000 : undefined,
      });
      const pending = invoke(client, mode, {
        signal: controller.signal,
        timeoutMs: limit === "per-call" ? 100 : limit === "provider" ? 5_000 : undefined,
      });
      const assertion = expect(pending).rejects.toThrow(
        limit === "user" ? /user stopped/ : limit === "run deadline" ? /run deadline reached/ : /timed out after 100ms/,
      );
      await server.received;
      if (limit === "user") controller.abort(new Error("user stopped"));
      // Arm immediately after the server has accepted the request.
      if (limit === "run deadline") armRunDeadline({
        services: { runtimeOptions: { deadlineAt: Date.now() - 1 } },
      }, controller)();
      await assertion;
    },
  );
}

test("the Core stream watchdog still stops a Gemini 4 body inside the longer transport silence limit", async () => {
  const server = await silentServer("body", 10_000);
  const agent = shortTransport();
  const session = new ProviderHttpClientSession({
    providerName: "gemini", baseURL: server.baseURL, streamIdleTimeoutMs: 50,
    fetchImpl: geminiTransportFetch("gemini-4-argon", poolFetch(agent)),
  });
  const stream = await session.requestStream({
    path: "/models/gemini-4-argon:streamGenerateContent", singleWireAttempt: true,
  });
  await expect((async () => { for await (const _chunk of stream) { /* consume */ } })())
    .rejects.toThrow(/gemini stream idle for 50ms/);
});

for (const mode of modes) for (const phase of phases) for (const proxyTunnel of [false, true]) {
  test(`${mode} retains a custom proxy with tunnel=${proxyTunnel} across ${phase} silence`, async () => {
    const server = await silentServer(phase, 1_600);
    const proxy = createServer();
    let proxied = 0;
    proxy.on("request", (request, response) => {
      proxied += 1;
      const upstream = httpRequest(new URL(request.url!), {
        method: request.method, headers: request.headers,
      }, incoming => {
        response.writeHead(incoming.statusCode!, incoming.headers);
        incoming.pipe(response);
      });
      upstream.on("error", () => response.destroy());
      request.pipe(upstream);
    });
    proxy.on("connect", (request, socket, head) => {
      proxied += 1;
      const target = new URL(`http://${request.url}`);
      const upstream = connect(Number(target.port), target.hostname, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    });
    const proxyURL = await listen(proxy);
    const previous = getGlobalDispatcher();
    const agent = new EnvHttpProxyAgent({
      httpProxy: new URL(proxyURL).origin, httpsProxy: new URL(proxyURL).origin,
      noProxy: "", proxyTunnel, headersTimeout: 30, bodyTimeout: 30,
    });
    setGlobalDispatcher(agent);
    cleanup.push(async () => { setGlobalDispatcher(previous); await agent.destroy(); });
    const client = provider(server.baseURL, "gemini-4-carbon", { fetchImpl: poolFetch(agent) });
    await expect(invoke(client, mode)).resolves.toMatchObject({ content: "ok" });
    expect(proxied).toBeGreaterThan(0);
    expect(getGlobalDispatcher()).toBe(agent);
  });
}
