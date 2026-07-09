// WebChat channel adapter (TODO task 8). Drives the real HTTP server with
// fetch — no browser — to prove: token auth-gating, unauth rejection,
// loopback-only default, a turn round-trip over SSE, and the approval render.

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  renderWebChatHtml,
  WebChatChannelAdapter,
} from "../../src/gateway/webchat-channel.js";
import type {
  ChannelAdapterContext,
  InboundChannelMessage,
} from "../../src/gateway/types.js";

const TOKEN = "test-token-0123456789abcdef";

function collector(): {
  ctx: ChannelAdapterContext;
  messages: InboundChannelMessage[];
} {
  const messages: InboundChannelMessage[] = [];
  return {
    messages,
    ctx: {
      async onMessage(message) {
        messages.push(message);
      },
    },
  };
}

describe("WebChatChannelAdapter", () => {
  let adapter: WebChatChannelAdapter;
  let base: string;
  let messages: InboundChannelMessage[];

  beforeEach(async () => {
    adapter = new WebChatChannelAdapter({ token: TOKEN });
    const c = collector();
    messages = c.messages;
    await adapter.start(c.ctx);
    base = `http://127.0.0.1:${adapter.port}`;
  });
  afterEach(async () => {
    await adapter.stop();
  });

  test("refuses a non-loopback host without the override", () => {
    expect(
      () => new WebChatChannelAdapter({ token: TOKEN, host: "0.0.0.0" }),
    ).toThrow(/non-loopback/);
    // ...but allows it with the explicit override.
    expect(
      () =>
        new WebChatChannelAdapter({
          token: TOKEN,
          host: "0.0.0.0",
          allowNonLoopback: true,
        }),
    ).not.toThrow();
  });

  test("rejects a short token", () => {
    expect(() => new WebChatChannelAdapter({ token: "short" })).toThrow(
      /at least 16/,
    );
  });

  test("GET / without a token is 401", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(401);
  });

  test("GET / with the token serves the app", async () => {
    const res = await fetch(`${base}/?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("AgenC");
    expect(html).toContain("/events");
  });

  test("POST /message without a token is 401 and delivers nothing", async () => {
    const res = await fetch(`${base}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "sneak in" }),
    });
    expect(res.status).toBe(401);
    expect(messages).toHaveLength(0);
  });

  test("POST /message with a bearer token delivers to the gateway", async () => {
    const res = await fetch(`${base}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ conversation: "web", text: "hello agent" }),
    });
    expect(res.status).toBe(202);
    // onMessage is fired async; give it a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      channelId: "webchat",
      sender: { peerId: "web" },
      conversation: { kind: "dm", id: "web" },
      text: "hello agent",
    });
  });

  test("send() streams to a matching SSE subscriber and edits in place", async () => {
    // Open an SSE connection for the "web" conversation.
    const controller = new AbortController();
    const events: string[] = [];
    const streamDone = (async () => {
      const res = await fetch(`${base}/events?conversation=web&token=${TOKEN}`, {
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          events.push(decoder.decode(value));
        }
      } catch {
        /* aborted */
      }
    })();
    await new Promise((r) => setTimeout(r, 20));

    const id = await adapter.send({ conversationId: "web", text: "part one" });
    await adapter.send({ conversationId: "web", text: "part one two", editMessageId: id });
    // A message for a different conversation must NOT reach this subscriber.
    await adapter.send({ conversationId: "other", text: "not for you" });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await streamDone;

    const all = events.join("");
    expect(all).toContain("event: message");
    expect(all).toContain("event: edit");
    expect(all).toContain("part one");
    expect(all).toContain("part one two");
    expect(all).not.toContain("not for you");
  });

  test("manifest is served without a token (no secrets)", async () => {
    const res = await fetch(`${base}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    const manifest = await res.json();
    expect(manifest.name).toBe("AgenC");
  });

  test("an oversized body is rejected and never delivered", async () => {
    // The server caps the body and cuts the connection: fetch may throw
    // (connection reset) or return a 4xx — either is a valid refusal. The
    // load-bearing assertion is that nothing was delivered to the gateway.
    let status: number | "threw" = "threw";
    try {
      const res = await fetch(`${base}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ text: "x".repeat(100 * 1024) }),
      });
      status = res.status;
    } catch {
      status = "threw";
    }
    expect(status === "threw" || status >= 400).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(messages).toHaveLength(0);
  });
});

describe("renderWebChatHtml", () => {
  test("embeds the token and renders approval buttons for approve/deny replies", () => {
    const html = renderWebChatHtml("tok-1234567890abcdef");
    expect(html).toContain("tok-1234567890abcdef");
    // The client detects an "approve <token>" agent reply and offers buttons
    // that POST the EXACT token reply — preserving the approval round-trip.
    expect(html).toContain("approve");
    expect(html).toContain("EventSource");
  });
});
