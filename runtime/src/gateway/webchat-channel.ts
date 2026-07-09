/**
 * WebChat channel adapter (TODO task 8).
 *
 * A minimal browser chat surface served by the gateway itself. This is the
 * FIRST gateway component that opens a listener (Telegram was outbound
 * long-poll), so the security posture is load-bearing:
 *
 *  - Binds loopback (127.0.0.1) by default and REFUSES a non-loopback host
 *    unless `allowNonLoopback` is explicitly set. Exposed agent surfaces are
 *    the exact disaster class the security audit exists to prevent.
 *  - Every request is gated by a shared token compared with `timingSafeEqual`.
 *    The token authenticates the operator; combined with the loopback bind it
 *    is the auth boundary (which is why the run loop treats the web sender as
 *    allowlisted rather than making the operator pair with their own browser).
 *
 * Transport: Server-Sent Events (server→client stream) + POST (client→
 * server). No extra dependency, works in every browser, and streaming replies
 * edit in place via keyed SSE events (`supportsEdit`).
 *
 * Inbound web messages still flow through the full gateway pipeline (DM
 * policy, binding, and the task-11 sanitize+frame), so nothing here bypasses
 * the untrusted-content hardening.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";

import type {
  ChannelAdapter,
  ChannelAdapterContext,
  OutboundChannelMessage,
} from "./types.js";

export const WEBCHAT_CHANNEL_ID = "webchat";
export const WEBCHAT_PEER_ID = "web";
export const WEBCHAT_CONVERSATION_ID = "web";

export interface WebChatChannelOptions {
  readonly token: string;
  readonly id?: string;
  readonly host?: string;
  readonly port?: number;
  readonly allowNonLoopback?: boolean;
  readonly log?: (line: string) => void;
}

interface SseClient {
  readonly conversationId: string;
  readonly response: ServerResponse;
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  const fam = isIP(h);
  if (fam === 4) return h.startsWith("127.");
  return false;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function sseEscape(value: string): string {
  // SSE data lines cannot contain raw newlines; encode as JSON so the client
  // reconstructs the exact text.
  return JSON.stringify(value);
}

export class WebChatChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly supportsEdit = true;
  readonly #token: string;
  readonly #host: string;
  readonly #port: number;
  readonly #log: (line: string) => void;
  #server: Server | null = null;
  #context: ChannelAdapterContext | null = null;
  #clients = new Set<SseClient>();
  #boundPort = 0;
  #outCounter = 0;

  constructor(options: WebChatChannelOptions) {
    this.id = options.id ?? WEBCHAT_CHANNEL_ID;
    this.#token = options.token;
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 0;
    this.#log = options.log ?? (() => {});
    if (!isLoopbackHost(this.#host) && options.allowNonLoopback !== true) {
      throw new Error(
        `webchat: refusing non-loopback host '${this.#host}' without allowNonLoopback (prefer a tailnet/SSH tunnel)`,
      );
    }
    if (this.#token.length < 16) {
      throw new Error("webchat: token must be at least 16 characters");
    }
  }

  get port(): number {
    return this.#boundPort;
  }

  /** Operator-facing URL with the token; available after start(). */
  get url(): string {
    return `http://${this.#host}:${this.#boundPort}/?token=${this.#token}`;
  }

  async start(context: ChannelAdapterContext): Promise<void> {
    this.#context = context;
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch((error: unknown) => {
        this.#writeText(res, 500, `error: ${String(error)}`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.#server;
      if (server === null) return reject(new Error("server not created"));
      server.once("error", reject);
      server.listen(this.#port, this.#host, () => {
        const addr = server.address() as AddressInfo | null;
        this.#boundPort = addr?.port ?? this.#port;
        server.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.#clients) {
      try {
        client.response.end();
      } catch {
        /* already closed */
      }
    }
    this.#clients.clear();
    const server = this.#server;
    this.#server = null;
    this.#context = null;
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async send(message: OutboundChannelMessage): Promise<string> {
    const id = message.editMessageId ?? `${this.id}-out-${++this.#outCounter}`;
    const event = message.editMessageId !== undefined ? "edit" : "message";
    const payload = `event: ${event}\ndata: ${sseEscape(
      JSON.stringify({ id, conversationId: message.conversationId, text: message.text }),
    )}\n\n`;
    for (const client of this.#clients) {
      if (client.conversationId === message.conversationId) {
        try {
          client.response.write(payload);
        } catch {
          /* dropped client */
        }
      }
    }
    return id;
  }

  // ---- request handling ---------------------------------------------------

  #authed(req: IncomingMessage, url: URL): boolean {
    const header = req.headers["authorization"];
    const bearer =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice(7)
        : undefined;
    const query = url.searchParams.get("token") ?? undefined;
    const provided = bearer ?? query;
    return provided !== undefined && safeEqual(provided, this.#token);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${this.#host}`);

    // The PWA manifest is safe to serve unauthenticated (no secrets).
    if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
      return this.#writeJson(res, 200, WEBCHAT_MANIFEST);
    }

    if (!this.#authed(req, url)) {
      return this.#writeText(res, 401, "unauthorized: valid token required");
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderWebChatHtml(this.#token));
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      return this.#handleSse(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/message") {
      return this.#handleMessage(req, res);
    }

    this.#writeText(res, 404, "not found");
  }

  #handleSse(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const conversationId =
      url.searchParams.get("conversation") ?? WEBCHAT_CONVERSATION_ID;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const client: SseClient = { conversationId, response: res };
    this.#clients.add(client);
    req.on("close", () => {
      this.#clients.delete(client);
    });
  }

  async #handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req, 64 * 1024);
    let parsed: { conversation?: unknown; text?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      return this.#writeText(res, 400, "invalid JSON");
    }
    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (text.trim().length === 0) {
      return this.#writeText(res, 400, "empty message");
    }
    const conversationId =
      typeof parsed.conversation === "string" && parsed.conversation.length > 0
        ? parsed.conversation
        : WEBCHAT_CONVERSATION_ID;
    if (this.#context === null) {
      return this.#writeText(res, 503, "adapter not started");
    }
    // Accept immediately; the reply arrives over SSE. The gateway pipeline
    // (DM policy + task-11 sanitize/frame) runs on this text.
    void this.#context
      .onMessage({
        channelId: this.id,
        sender: { peerId: WEBCHAT_PEER_ID, displayName: "web" },
        conversation: { kind: "dm", id: conversationId },
        text,
      })
      .catch((error: unknown) => {
        this.#log(`webchat: onMessage failed: ${String(error)}`);
      });
    this.#writeJson(res, 202, { accepted: true });
  }

  #writeText(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(text);
  }

  #writeJson(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const WEBCHAT_MANIFEST = {
  name: "AgenC",
  short_name: "AgenC",
  display: "standalone",
  background_color: "#0b0b0f",
  theme_color: "#0b0b0f",
  start_url: "/",
  icons: [],
} as const;

/**
 * The web client. Deliberately dependency-free, inline, and CSP-friendly (the
 * token is embedded so the operator's link works; the app keeps it only in
 * memory). Streaming replies arrive as `message`/`edit` SSE events; a reply
 * asking for an approval renders approve/deny buttons that POST the exact
 * token reply — so the approval still settles only via the exact round-trip.
 */
export function renderWebChatHtml(token: string): string {
  const tokenJson = JSON.stringify(token);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="manifest" href="/manifest.webmanifest" />
<title>AgenC</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:15px/1.5 system-ui,sans-serif; background:#0b0b0f; color:#e7e7ea; }
  #log { padding:16px; max-width:760px; margin:0 auto; }
  .msg { margin:10px 0; padding:10px 12px; border-radius:10px; white-space:pre-wrap; word-break:break-word; }
  .me { background:#1c2b45; }
  .agent { background:#16161c; }
  .sys { color:#9aa0aa; font-size:13px; }
  form { position:sticky; bottom:0; display:flex; gap:8px; padding:12px; max-width:760px; margin:0 auto; background:#0b0b0f; }
  input { flex:1; padding:10px 12px; border-radius:10px; border:1px solid #2a2a33; background:#111; color:#e7e7ea; }
  button { padding:10px 14px; border-radius:10px; border:0; background:#2c5cff; color:#fff; cursor:pointer; }
  .approve { background:#1f7a4d; margin-right:6px; }
  .deny { background:#7a2f2f; }
</style>
</head>
<body>
<div id="log"><div class="msg sys">Connecting…</div></div>
<form id="f"><input id="t" autocomplete="off" placeholder="Message your agent…" /><button>Send</button></form>
<script>
const TOKEN = ${tokenJson};
const CONV = "web";
const log = document.getElementById("log");
const nodes = new Map();
function el(id, cls, text){ const d=document.createElement("div"); d.className="msg "+cls; d.textContent=text; if(id) nodes.set(id,d); log.appendChild(d); window.scrollTo(0,document.body.scrollHeight); return d; }
function approvalButtons(text){
  const m = /\\b(approve|deny)\\s+([A-Za-z0-9]+)\\b/.exec(text);
  if(!m) return null;
  const tok = m[2];
  const wrap = document.createElement("div"); wrap.className="msg sys";
  const a=document.createElement("button"); a.className="approve"; a.textContent="Approve"; a.onclick=()=>send("approve "+tok);
  const d=document.createElement("button"); d.className="deny"; d.textContent="Deny"; d.onclick=()=>send("deny "+tok);
  wrap.appendChild(a); wrap.appendChild(d); log.appendChild(wrap); return wrap;
}
const es = new EventSource("/events?conversation="+CONV+"&token="+encodeURIComponent(TOKEN));
es.onopen = ()=>{ log.innerHTML=""; el(null,"sys","Connected. Messages are sanitized and framed before your agent sees them."); };
es.addEventListener("message", e=>{ const p=JSON.parse(JSON.parse(e.data)); el(p.id,"agent",p.text); approvalButtons(p.text); });
es.addEventListener("edit", e=>{ const p=JSON.parse(JSON.parse(e.data)); const n=nodes.get(p.id); if(n){ n.textContent=p.text; } else { el(p.id,"agent",p.text); } });
async function send(text){
  el(null,"me",text);
  await fetch("/message",{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+TOKEN},body:JSON.stringify({conversation:CONV,text})});
}
document.getElementById("f").addEventListener("submit",e=>{ e.preventDefault(); const t=document.getElementById("t"); const v=t.value.trim(); if(v){ send(v); t.value=""; } });
</script>
</body>
</html>`;
}
