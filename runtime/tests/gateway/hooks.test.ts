/**
 * Inbound webhooks (TODO task 17): POST /hooks/agent over a REAL loopback
 * HTTP listener against a fake daemon client.
 *
 * Acceptance matrix: authed POST triggers a framed turn (with channel
 * delivery via `deliver` or the final message in the response); missing,
 * wrong, and QUERY-STRING tokens are rejected; non-loopback binds are
 * refused; daemon admission refusal is a visible 429; sessionKey/agent give
 * session continuity/isolation through the SessionRouter.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { HooksServer, HOOKS_PATH } from "../../src/gateway/hooks.js";
import { loadGatewayConfig } from "../../src/gateway/config.js";
import { InMemoryChannelAdapter } from "../../src/gateway/test-channel.js";
import type {
  GatewayDaemonClient,
  GatewayPromptHandlers,
  GatewayPromptResult,
  GatewaySession,
  GatewaySessionCreateOptions,
} from "../../src/gateway/types.js";
import type { AgenCConfig } from "../../src/config/schema.js";

const TOKEN = "hooks-test-token-0123456789";

class EchoSession implements GatewaySession {
  readonly sessionId: string;
  readonly prompts: string[] = [];
  constructor(id: string) {
    this.sessionId = id;
  }
  async prompt(
    text: string,
    handlers: GatewayPromptHandlers,
  ): Promise<GatewayPromptResult> {
    this.prompts.push(text);
    const reply = `echo: ${text.slice(-40)}`;
    await handlers.onEvent({ type: "text", delta: reply });
    return {
      stopReason: "completed",
      finalMessage: reply,
      usage: { inputTokens: 5, outputTokens: 5 },
    };
  }
}

class FakeClient implements GatewayDaemonClient {
  readonly sessions: EchoSession[] = [];
  readonly labels: (string | undefined)[] = [];
  /** When set, createSession returns a session whose prompt throws. */
  throwOnPrompt: Error | null = null;
  #n = 0;
  async createSession(
    options?: GatewaySessionCreateOptions,
  ): Promise<GatewaySession> {
    this.labels.push(options?.label);
    if (this.throwOnPrompt !== null) {
      const err = this.throwOnPrompt;
      return {
        sessionId: `s-throw-${++this.#n}`,
        prompt: async () => {
          throw err;
        },
      } as GatewaySession;
    }
    const s = new EchoSession(`s${++this.#n}`);
    this.sessions.push(s);
    return s;
  }
  async attachSession(id: string): Promise<GatewaySession> {
    const s = new EchoSession(id);
    this.sessions.push(s);
    return s;
  }
  async close(): Promise<void> {}
}

describe("HooksServer", () => {
  let home: string;
  let client: FakeClient;
  let mem: InMemoryChannelAdapter;
  let server: HooksServer | null = null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-hooks-"));
    client = new FakeClient();
    mem = new InMemoryChannelAdapter({ id: "mem" });
  });
  afterEach(async () => {
    await server?.stop();
    server = null;
    rmSync(home, { recursive: true, force: true });
  });

  async function startServer(
    overrides: Partial<ConstructorParameters<typeof HooksServer>[0]> = {},
  ): Promise<string> {
    server = new HooksServer({
      agencHome: home,
      token: TOKEN,
      client,
      adapters: [mem],
      config: {} as unknown as AgenCConfig,
      env: {},
      port: 0, // ephemeral for tests
      ...overrides,
    });
    await server.start();
    return `http://127.0.0.1:${server.port}${HOOKS_PATH}`;
  }

  function post(
    url: string,
    body: unknown,
    headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
  ): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  test("authed POST runs a framed turn and returns the final message", async () => {
    const url = await startServer();
    const res = await post(url, { message: "deploy finished, summarize" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.finalMessage).toContain("echo:");
    expect(body.stopReason).toBe("completed");

    // The payload went through the task-11 untrusted framing — never raw.
    expect(client.sessions).toHaveLength(1);
    const prompt = client.sessions[0].prompts[0];
    expect(prompt).toContain("deploy finished, summarize");
    expect(prompt).toContain('trust="external"');
    expect(prompt).toContain('channel="hooks"');
  });

  test("deliver routes the admitted turn to the channel and responds 202", async () => {
    const url = await startServer();
    const res = await post(url, {
      message: "post the release notes",
      name: "ci",
      deliver: { channel: "mem", to: "ops-room" },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);

    // The turn streams to the channel asynchronously.
    await new Promise((r) => setTimeout(r, 30));
    expect(mem.lastText("ops-room")).toContain("echo:");
  });

  test("unknown deliver channel is a 400 before any turn runs", async () => {
    const url = await startServer();
    const res = await post(url, {
      message: "x",
      deliver: { channel: "nope", to: "y" },
    });
    expect(res.status).toBe(400);
    expect(client.sessions).toHaveLength(0);
  });

  test("missing and wrong bearer tokens are 401; no turn runs", async () => {
    const url = await startServer();
    expect((await post(url, { message: "x" }, {})).status).toBe(401);
    expect(
      (await post(url, { message: "x" }, { authorization: "Bearer nope-nope-nope-nope" }))
        .status,
    ).toBe(401);
    expect(client.sessions).toHaveLength(0);
  });

  test("a query-string token is rejected outright — even alongside a valid header", async () => {
    const url = await startServer();
    for (const param of ["token", "access_token", "api_key"]) {
      const res = await post(`${url}?${param}=${TOKEN}`, { message: "x" });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.error)).toContain("never in the query string");
    }
    expect(client.sessions).toHaveLength(0);
  });

  test("wrong path is 404, wrong method is 405", async () => {
    const url = await startServer();
    const base = url.replace(HOOKS_PATH, "");
    expect(
      (
        await fetch(`${base}/hooks/other`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(url, {
          method: "GET",
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(405);
  });

  test("malformed bodies are 400s: bad JSON, missing message, bad identifiers", async () => {
    const url = await startServer();
    const raw = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: "{not json",
    });
    expect(raw.status).toBe(400);
    expect((await post(url, {})).status).toBe(400);
    expect((await post(url, { message: "x", name: "bad name!" })).status).toBe(400);
    expect(
      (await post(url, { message: "x", deliver: { channel: "mem" } })).status,
    ).toBe(400);
    expect(client.sessions).toHaveLength(0);
  });

  test("sessionKey continuity: same key = same session; different agent isolates", async () => {
    const url = await startServer();
    await post(url, { message: "one", sessionKey: "deploys" });
    await post(url, { message: "two", sessionKey: "deploys" });
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0].prompts).toHaveLength(2);

    await post(url, { message: "three", sessionKey: "deploys", agent: "ops" });
    expect(client.sessions).toHaveLength(2);
  });

  test("daemon execution-admission refusal is a visible 429", async () => {
    client.throwOnPrompt = new Error(
      "execution admission deny: budget_exceeded",
    );
    const url = await startServer();
    const res = await post(url, { message: "expensive" });
    expect(res.status).toBe(429);
    expect(String(((await res.json()) as Record<string, unknown>).error)).toContain(
      "budget_exceeded",
    );
    expect(client.labels).toHaveLength(1);
    expect(existsSync(join(home, "budget", "ledger.json"))).toBe(false);
  });

  test("deliver does not hide daemon execution-admission refusal behind 202", async () => {
    client.throwOnPrompt = new Error(
      "execution admission deny: budget_exceeded",
    );
    const url = await startServer();
    const res = await post(url, {
      message: "expensive delivery",
      deliver: { channel: "mem", to: "ops-room" },
    });

    expect(res.status).toBe(429);
    expect(String(((await res.json()) as Record<string, unknown>).error)).toContain(
      "budget_exceeded",
    );
    expect(mem.lastText("ops-room")).toBeUndefined();
  });

  test("turn failure does not create the retired surface budget ledger", async () => {
    client.throwOnPrompt = new Error("turn exploded");
    const url = await startServer({
      config: {
        budget: { enabled: true, daily_tokens: 1_000_000 },
      } as unknown as AgenCConfig,
    });
    const res = await post(url, { message: "will explode", name: "ci" });
    expect(res.status).toBe(500);
    expect(existsSync(join(home, "budget", "ledger.json"))).toBe(false);
  });

  test("non-loopback host is refused without allowNonLoopback", () => {
    expect(
      () =>
        new HooksServer({
          agencHome: home,
          token: TOKEN,
          client,
          adapters: [],
          config: {} as unknown as AgenCConfig,
          host: "0.0.0.0",
        }),
    ).toThrow(/non-loopback/);
  });

  test("short tokens are refused at construction", () => {
    expect(
      () =>
        new HooksServer({
          agencHome: home,
          token: "short",
          client,
          adapters: [],
          config: {} as unknown as AgenCConfig,
        }),
    ).toThrow(/16 characters/);
  });

  test("oversized bodies are 413", async () => {
    const url = await startServer();
    const res = await post(url, { message: "z".repeat(70 * 1024) });
    expect(res.status).toBe(413);
  });
});

describe("gateway config hooks section", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-hooks-cfg-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function write(config: unknown): void {
    mkdirSync(join(home, "gateway"), { recursive: true });
    writeFileSync(join(home, "gateway", "config.json"), JSON.stringify(config));
  }

  test("valid hooks section parses; absent section stays undefined", () => {
    write({ hooks: { enabled: true, host: "127.0.0.1", port: 9911 } });
    expect(loadGatewayConfig({ agencHome: home }).hooks).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 9911,
    });
    write({});
    expect(loadGatewayConfig({ agencHome: home }).hooks).toBeUndefined();
  });

  test("malformed hooks sections fail CLOSED (disabled, never coerced on)", () => {
    write({ hooks: "yes please" });
    expect(loadGatewayConfig({ agencHome: home }).hooks).toBeUndefined();
    write({ hooks: { enabled: "true" } }); // string, not boolean
    expect(loadGatewayConfig({ agencHome: home }).hooks).toEqual({ enabled: false });
    write({ hooks: { enabled: true, port: 99999 } }); // invalid port dropped
    expect(loadGatewayConfig({ agencHome: home }).hooks).toEqual({ enabled: true });
  });
});
