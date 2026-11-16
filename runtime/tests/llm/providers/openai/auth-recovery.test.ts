import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import { DeepSeekProvider } from "../../../../src/llm/providers/deepseek/index.js";
import type { OpenAIProviderConfig } from "../../../../src/llm/providers/openai/types.js";
import { runAdmittedModelCall } from "../../../../src/budget/admitted-model-call.js";
import { createAllowAdmissionHarness } from "../../../budget/admission-test-harness.js";
import type { Session } from "../../../../src/session/session.js";
import type { LLMChatOptions, LLMMessage } from "../../../../src/llm/types.js";
import { AdmissionDeniedError } from "../../../../src/budget/admission-client.js";
import { taskBudgetOf } from "../../../../src/session/task-budget.js";

const MODEL = "gpt-6.1-sol";
const messages: LLMMessage[] = [{ role: "user", content: "hello" }];
const serverMessage = "Your access token has expired.\nPlease sign in again.";
const completed = {
  type: "response.completed",
  response: {
    id: "resp_auth_fixture", status: "completed", model: MODEL,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  },
};
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(transport: "http" | "websocket" | "upgrade", oauth = true) {
  let accepted = "fresh";
  let failAfterStart = false;
  let stored: { accessToken: string; refreshToken: string; accountId: string } | undefined;
  const tokens: string[] = [];
  const frames: string[] = [];
  const accounts: Array<string | undefined> = [];
  const targets: unknown[] = [];
  const captureTarget = (req: IncomingMessage) => {
    // The ephemeral listener port and random RFC 6455 nonce are not provider payload.
    const { host: _host, "sec-websocket-key": _nonce, ...headers } = req.headers;
    targets.push({ method: req.method, path: req.url, headers });
  };
  const sockets: WebSocket[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const refused = () => ({ error: { message: serverMessage, code: "token_expired" } });
  const server = createServer((req, res) => {
    captureTarget(req);
    const body: Buffer[] = [];
    req.on("data", chunk => body.push(chunk));
    req.on("end", () => {
      frames.push(Buffer.concat(body).toString());
      tokens.push(req.headers.authorization ?? "");
      accounts.push(req.headers["chatgpt-account-id"] as string | undefined);
      if (req.headers.authorization !== `Bearer ${accepted}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify(refused(), null, 2));
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(failAfterStart
          ? `data: ${JSON.stringify({ type: "response.created", response: { id: "started" } })}\n\ndata: ${JSON.stringify({ type: "error", status: 401, ...refused() })}\n\n`
          : `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`);
      }
    });
  });
  server.on("upgrade", (req, socket, head) => {
    captureTarget(req);
    if (transport === "upgrade" && req.headers.authorization !== `Bearer ${accepted}`) {
      tokens.push(req.headers.authorization ?? "");
      const body = JSON.stringify(refused(), null, 2);
      socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, client => {
      sockets.push(client);
      client.on("message", data => {
        frames.push(data.toString());
        tokens.push(req.headers.authorization ?? "");
        accounts.push(req.headers["chatgpt-account-id"] as string | undefined);
        if (failAfterStart) client.send(JSON.stringify({ type: "response.created", response: { id: "started" } }));
        client.send(JSON.stringify(req.headers.authorization === `Bearer ${accepted}` && !failAfterStart
          ? completed : { type: "error", status: 401, ...refused() }));
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const refresh = vi.fn(async () => ({ kind: "refreshed" as const, accessToken: "fresh" }));
  const reload = vi.fn(async () => stored);
  const provider = new OpenAIProvider({
    model: MODEL,
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    chatgptBackend: oauth,
    useResponsesApi: true,
    responsesTransport: transport === "http" ? "http" : "websocket",
    ...(oauth ? {
      authMode: "oauth",
      defaultHeaders: { "ChatGPT-Account-ID": "fixture-account", originator: "agenc" },
      oauth: { accessToken: "stale", refreshToken: "refresh-fixture", accountId: "fixture-account", refreshAccessToken: refresh,
        reloadCredentials: reload },
    } : { apiKey: "stale" }),
  } as OpenAIProviderConfig);
  cleanup.push(() => provider.dispose());
  const state = createAllowAdmissionHarness();
  const originalAcquire = state.acquire.getMockImplementation()!;
  state.acquire.mockImplementation(async input => {
    const lease = await originalAcquire(input);
    return { ...lease, reservation: { ...lease.reservation, reservationId: input.stepId } };
  });
  const session = { conversationId: "auth-fixture", services: {
    executionAdmission: state.admission, admissionRequired: true,
    agentControl: { shutdownAgentTree: vi.fn() },
  } } as unknown as Session;
  const call = (options: LLMChatOptions = {}) => runAdmittedModelCall({
    session, provider, messages, options: { maxOutputTokens: 128, promptCacheKey: "auth-fixture", ...options },
    stepId: "model:auth", model: MODEL, providerName: "openai",
    signal: options.signal,
    invoke: admitted => provider.chatStream(messages, () => {}, admitted),
  });
  return { call, provider, state, session, refresh, reload, tokens, frames, accounts, targets,
    failAfterStart: () => { failAfterStart = true; },
    accept: (token: string) => { accepted = token; },
    signIn: (token: string) => { stored = { accessToken: token, refreshToken: "new-refresh", accountId: "new-account" }; },
  };
}

test.each(["http", "websocket", "upgrade"] as const)("%s: a rejected token refreshes once under separate admissions", async transport => {
  const f = await fixture(transport);
  await expect(f.call()).resolves.toMatchObject({ content: "ok" });
  expect(f.tokens).toEqual(["Bearer stale", "Bearer fresh"]);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.state.acquire).toHaveBeenCalledTimes(2);
  expect(f.state.reconcile).toHaveBeenNthCalledWith(1, "model:auth", { inputTokens: 0, outputTokens: 0, costUsd: 0 });
  expect(f.state.reconcile).toHaveBeenNthCalledWith(2, "model:auth:openai-auth:1", expect.objectContaining({ inputTokens: 10, outputTokens: 2 }));
  expect(f.state.acknowledgeCompletion).toHaveBeenCalledTimes(2);
  expect(f.state.acknowledgeCompletion.mock.invocationCallOrder[0]).toBeLessThan(f.state.acquire.mock.invocationCallOrder[1]!);
  expect(f.state.holdUnknown).not.toHaveBeenCalled();
  if (transport !== "upgrade") expect(f.frames[1]).toBe(f.frames[0]);
});

test.each(["http", "websocket"] as const)("%s: a persistent 401 reloads a newer sign-in before giving up", async transport => {
  const f = await fixture(transport);
  f.accept("new-login");
  f.signIn("new-login");
  await expect(f.call()).resolves.toMatchObject({ content: "ok" });
  expect(f.tokens).toEqual(["Bearer stale", "Bearer fresh", "Bearer new-login"]);
  expect(f.accounts.at(-1)).toBe("new-account");
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.state.acquire).toHaveBeenCalledTimes(3);
  expect(f.state.holdUnknown).not.toHaveBeenCalled();
});

test.each(["http", "websocket", "upgrade"] as const)("%s: exhausted auth is one line and a later login revives the same provider", async transport => {
  const f = await fixture(transport);
  f.accept("new-login");
  const error = await f.call().catch(error => error as Error);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Expected an authentication failure");
  expect(error.message).toContain("Your access token has expired. Please sign in again.");
  expect(error.message).toContain("Run agenc openai-login to sign in again.");
  expect(error.message).not.toMatch(/[\r\n{}]/);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.state.holdUnknown).not.toHaveBeenCalled();
  const requestsBeforeLogin = f.tokens.length;
  await expect(f.call()).rejects.toThrow("Run agenc openai-login to sign in again.");
  expect(f.tokens).toHaveLength(requestsBeforeLogin);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.state.holdUnknown).not.toHaveBeenCalled();
  f.signIn("new-login");
  await expect(f.call()).resolves.toMatchObject({ content: "ok" });
  expect(f.tokens.at(-1)).toBe("Bearer new-login");
});

test("a refreshed request still needs permission from admission", async () => {
  const f = await fixture("http");
  const acquire = f.state.acquire.getMockImplementation()!;
  f.state.acquire.mockImplementationOnce(acquire).mockRejectedValueOnce(new AdmissionDeniedError("model_call_budget_exceeded"));
  await expect(f.call()).rejects.toThrow("model_call_budget_exceeded");
  expect(f.tokens).toEqual(["Bearer stale"]);
  expect(f.state.reconcile).toHaveBeenCalledWith("model:auth", { inputTokens: 0, outputTokens: 0, costUsd: 0 });
});

test("task token accounting uses durable zero usage before admitting the recovered attempt", async () => {
  const f = await fixture("http");
  Object.assign(f.session, { config: { taskTokenBudget: 1_000 } });
  let tokens = 0;
  let calls = 0;
  Object.assign(f.state.admission, { getTaskBudgetUsage: () => ({ tokens, calls }) });
  const acquire = f.state.acquire.getMockImplementation()!;
  f.state.acquire.mockImplementation(async input => {
    calls += 1;
    return acquire(input);
  });
  const reconcile = f.state.admission.reconcile;
  Object.assign(f.state.admission, { reconcile: (id: string, usage: Parameters<typeof reconcile>[1]) => {
    tokens += usage.inputTokens + usage.outputTokens;
    return reconcile(id, usage);
  } });
  await expect(f.call()).resolves.toMatchObject({ content: "ok" });
  expect(taskBudgetOf(f.session)).toMatchObject({ tokens: 12, calls: 2 });
});

test("cancellation during refresh never dispatches a replacement request", async () => {
  const f = await fixture("http");
  const controller = f.state.leaseController;
  f.refresh.mockImplementation(async () => {
    controller.abort(new DOMException("cancelled refresh", "AbortError"));
    return { kind: "refreshed", accessToken: "fresh" };
  });
  await expect(f.call({ signal: controller.signal })).rejects.toThrow();
  expect(f.tokens).toEqual(["Bearer stale"]);
  expect(f.state.acquire).toHaveBeenCalledTimes(1);
});

test.each(["http", "websocket"] as const)("%s: non-admitted ChatGPT calls also refresh only once", async transport => {
  const f = await fixture(transport);
  await expect(f.provider.chatStream(messages, () => {}, { maxOutputTokens: 128 }))
    .resolves.toMatchObject({ content: "ok" });
  expect(f.tokens).toEqual(["Bearer stale", "Bearer fresh"]);
  expect(f.refresh).toHaveBeenCalledTimes(1);
});

test.each(["websocket", "upgrade"] as const)("%s: a stale preconnect recovers on the same provider", async transport => {
  const f = await fixture(transport);
  f.provider.prewarmStartup!({ conversationId: "auth-fixture", threadId: "auth-fixture", lightSession: true });
  await expect.poll(() => f.targets.length).toBe(1);
  await expect(f.call()).resolves.toMatchObject({ content: "ok" });
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.tokens.at(-1)).toBe("Bearer fresh");
  expect(f.state.acquire).toHaveBeenCalledTimes(2);
});

test("simultaneous rejected HTTP calls share one refresh", async () => {
  const f = await fixture("http");
  const values = await Promise.all([f.call(), f.call()]);
  expect(values.map(value => value.content)).toEqual(["ok", "ok"]);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.tokens.filter(token => token === "Bearer stale")).toHaveLength(2);
  expect(f.tokens.filter(token => token === "Bearer fresh")).toHaveLength(2);
});

test.each(["http", "websocket"] as const)("%s: an in-stream 401 is never replayed or refunded", async transport => {
  const f = await fixture(transport);
  f.accept("stale");
  f.failAfterStart();
  await expect(f.call()).rejects.toThrow();
  expect(f.tokens).toEqual(["Bearer stale"]);
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.state.acquire).toHaveBeenCalledTimes(1);
  expect(f.state.reconcile).not.toHaveBeenCalled();
  expect(f.state.holdUnknown).toHaveBeenCalledTimes(1);
});

test("an unreadable stored record still reports the server message and sign-in command", async () => {
  const f = await fixture("http");
  f.accept("never");
  f.reload.mockRejectedValue(new Error("native storage unavailable"));
  await expect(f.call()).rejects.toThrow("Your access token has expired. Please sign in again. ChatGPT sign-in recovery failed. Run agenc openai-login to sign in again.");
});

test("a failed refresh still checks a new stored login", async () => {
  const f = await fixture("http");
  f.accept("new-login");
  f.signIn("new-login");
  f.refresh.mockRejectedValue(new Error("refresh token revoked"));
  await expect(f.call()).resolves.toMatchObject({ content: "ok" });
  expect(f.tokens).toEqual(["Bearer stale", "Bearer new-login"]);
  expect(f.refresh).toHaveBeenCalledTimes(1);
});

test.each(["http", "websocket", "upgrade"] as const)("%s: API-key rejection keeps its existing behavior", async transport => {
  const f = await fixture(transport, false);
  await expect(f.call()).rejects.toMatchObject({ statusCode: 401 });
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.state.acquire).toHaveBeenCalledTimes(1);
});

test.each([
  ["http", true], ["websocket", true], ["http", false], ["websocket", false],
] as const)("successful wire snapshot: %s, ChatGPT=%s", async (transport, oauth) => {
  const f = await fixture(transport, oauth);
  f.accept("stale");
  await expect(f.call()).resolves.toMatchObject({ content: "ok" });
  expect({ frames: f.frames, targets: f.targets }).toMatchSnapshot();
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.state.acquire).toHaveBeenCalledTimes(1);
});

test.each(["http", "websocket"] as const)("successful wire snapshot: DeepSeek ignores %s selection", async responsesTransport => {
  const wires: unknown[] = [];
  const provider = new DeepSeekProvider({
    model: "deepseek-v4-pro", apiKey: "fixture-api-key", responsesTransport,
    fetchImpl: async (url, init) => {
      wires.push({ url: String(url), method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body });
      return Response.json({ id: "fixture", model: "deepseek-v4-pro",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    },
  });
  await provider.chat(messages, { maxOutputTokens: 128, singleWireAttempt: true });
  expect(wires).toMatchSnapshot();
  provider.dispose();
});
