// `agenc remote` — link this Mac to the AgenC phone app and bridge the relay to the local daemon.
//
// Pairing replaces account-as-room routing: the backend mints a per-pair `pairingId` (the relay
// room), a single-use human code, and a 256-bit hostSecret held ONLY by this Mac. The phone redeems
// the code; both sides then reach the same isolated relay room. The backend is the sole holder of the
// relay signing secret and mints every host ticket — this Mac never holds it. The connector dials OUT
// to the relay (no inbound ports) and transparently pipes the app-server JSON-RPC to/from the local
// daemon, injecting the loopback cookie into the phone's `initialize` so the phone never holds it.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import WebSocket from "ws";

import { remoteAuthSessionTokenSync } from "../auth/session-state.js";

const DEFAULT_BACKEND = "https://id.agenc.ag";
const REMOTE_LOGIN_REQUIRED_MESSAGE =
  "Not logged in. Run `/login` in the TUI or `AGENC_AUTH_BACKEND=remote agenc login` before using remote pairing.";

export interface RemoteCliCommand {
  readonly kind: "on" | "off" | "status" | "help";
}

export function parseAgenCRemoteCliArgs(argv: readonly string[]): RemoteCliCommand | null {
  if (argv[0] !== "remote") return null;
  const sub = argv[1];
  // Require an explicit subcommand so a bare `agenc remote` or `--help` never starts pairing.
  if (sub === "on") return { kind: "on" };
  if (sub === "off") return { kind: "off" };
  if (sub === "status") return { kind: "status" };
  return { kind: "help" };
}

export function formatAgenCRemoteCliHelpText(): string {
  return [
    "agenc remote — control this Mac from the AgenC phone app, from anywhere.",
    "",
    "Usage:",
    "  agenc remote on        Pair (first run shows a code) then keep this Mac reachable.",
    "  agenc remote status    Show whether this Mac is linked to a phone.",
    "  agenc remote off       Forget this Mac's pairing locally.",
    "",
    "Environment:",
    "  AGENC_BACKEND_URL   Identity backend (default https://id.agenc.ag).",
    "  AGENC_DAEMON_URL    Local daemon (default ws://127.0.0.1:7766).",
  ].join("\n");
}

interface PairFile {
  pairingId: string;
  hostSecret: string;
  machineName: string;
  relayUrl: string;
  backendUrl: string;
  createdAt: string;
}

function remoteDir(): string {
  return join(homedir(), ".agenc", "remote");
}
function pairPath(): string {
  return join(remoteDir(), "pair.json");
}
function cookiePath(): string {
  return join(homedir(), ".agenc", "daemon.cookie");
}
function backendUrl(): string {
  const env = process.env.AGENC_BACKEND_URL;
  return env && env.trim() ? env.trim().replace(/\/$/, "") : DEFAULT_BACKEND;
}
function daemonUrl(): string {
  const env = process.env.AGENC_DAEMON_URL;
  return env && env.trim() ? env.trim() : "ws://127.0.0.1:7766";
}

function readPairFile(): PairFile | null {
  try {
    const raw = readFileSync(pairPath(), "utf8");
    const obj = JSON.parse(raw) as Partial<PairFile>;
    if (obj.pairingId && obj.hostSecret && obj.relayUrl) return obj as PairFile;
  } catch {
    /* absent or malformed */
  }
  return null;
}
function writePairFile(p: PairFile): void {
  mkdirSync(remoteDir(), { recursive: true, mode: 0o700 });
  writeFileSync(pairPath(), JSON.stringify(p, null, 2), { mode: 0o600 });
  try {
    chmodSync(pairPath(), 0o600);
  } catch {
    /* best effort */
  }
}
function readCookie(): string {
  try {
    return readFileSync(cookiePath(), "utf8").trim();
  } catch {
    return "";
  }
}

interface PostResult {
  status: number;
  json: Record<string, unknown>;
}
async function postJson(
  url: string,
  body: Record<string, unknown>,
  authToken?: string,
): Promise<PostResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authToken !== undefined ? { authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Render the pairing box + QR as a string. `qrType: "utf8"` is plain block chars (renders in any
 *  text surface like the agent TUI); "terminal" is the compact ANSI variant for a real terminal. */
async function renderCodeBox(
  code: string,
  deepLink: string,
  expiresAt: string | undefined,
  opts: { color: boolean; qrType: "terminal" | "utf8" },
): Promise<string> {
  const c = (seq: string) => (opts.color ? seq : "");
  const bold = c("\x1b[1m");
  const dim = c("\x1b[2m");
  const accent = c("\x1b[35m"); // AgenC purple
  const reset = c("\x1b[0m");

  let qr = "";
  try {
    qr = await QRCode.toString(deepLink, { type: opts.qrType, small: true });
  } catch {
    /* QR is optional — the code still links the Mac */
  }

  const out: string[] = ["", `  ${accent}${bold}⬡  Link this Mac to the AgenC app${reset}`, ""];
  if (qr) {
    for (const qrLine of qr.replace(/\n+$/, "").split("\n")) out.push("  " + qrLine);
    out.push("");
  }
  const pad = 3;
  const bar = "─".repeat(code.length + pad * 2);
  out.push(
    `  ${dim}1.${reset} Scan the QR with your phone's camera, or`,
    `  ${dim}2.${reset} open the app → ${bold}Link a Mac${reset} ${dim}→ enter the code:${reset}`,
    "",
    `      ┌${bar}┐`,
    `      │${" ".repeat(pad)}${bold}${code}${reset}${" ".repeat(pad)}│`,
    `      └${bar}┘`,
    "",
  );
  if (expiresAt) {
    out.push(`  ${dim}Expires ${new Date(expiresAt).toLocaleTimeString()} · waiting for your phone…${reset}`, "");
  }
  return out.join("\n");
}

async function printCodeBox(code: string, deepLink: string, expiresAt?: string): Promise<void> {
  const text = await renderCodeBox(code, deepLink, expiresAt, {
    color: process.stdout.isTTY === true,
    qrType: "terminal",
  });
  process.stdout.write(text + "\n");
}

/** agenc://pair?c=<code> — code-only so the QR stays small + easily scannable. */
function pairingDeepLink(code: string): string {
  return `agenc://pair?c=${encodeURIComponent(code.replace(/-/g, ""))}`;
}

export async function runAgenCRemoteCli(command: RemoteCliCommand): Promise<number> {
  const backend = backendUrl();

  if (command.kind === "help") {
    process.stdout.write(formatAgenCRemoteCliHelpText() + "\n");
    return 0;
  }

  if (command.kind === "status") {
    const pair = readPairFile();
    if (!pair) {
      process.stdout.write("Not linked. Run `agenc remote on` to link a phone.\n");
      return 0;
    }
    process.stdout.write(
      `Linked to “${pair.machineName}” (pairing ${pair.pairingId}).\nBackend ${pair.backendUrl} · relay ${pair.relayUrl}\n`,
    );
    return 0;
  }

  if (command.kind === "off") {
    if (existsSync(pairPath())) {
      rmSync(pairPath(), { force: true });
      process.stdout.write("Forgot this Mac's pairing. Stop a running `agenc remote on` with Ctrl-C.\n");
    } else {
      process.stdout.write("This Mac is not linked.\n");
    }
    return 0;
  }

  // command.kind === "on"
  const authToken = remoteAuthSessionTokenSync();
  if (authToken === undefined) {
    process.stderr.write(`${REMOTE_LOGIN_REQUIRED_MESSAGE}\n`);
    return 1;
  }

  let pair = readPairFile();
  let pairingId: string;
  let hostSecret: string;
  let relayUrl: string;
  let machineName: string;
  let hostTicket: string;

  if (pair) {
    // Re-use the stored pairing: ask the backend for a fresh host ticket.
    const { status, json } = await postJson(`${backend}/v1/pair/host-poll`, {
      pairingId: pair.pairingId,
      hostSecret: pair.hostSecret,
    }, authToken);
    if (status === 410) {
      rmSync(pairPath(), { force: true });
      process.stdout.write("This Mac was unlinked from the phone — re-pairing.\n");
      pair = null;
    } else if (status === 200 && typeof json.hostTicket === "string") {
      pairingId = pair.pairingId;
      hostSecret = pair.hostSecret;
      relayUrl = (json.relayUrl as string) ?? pair.relayUrl;
      machineName = pair.machineName;
      hostTicket = json.hostTicket;
      process.stdout.write(`Remote access: linked to “${machineName}” — connecting…\n`);
    } else {
      process.stderr.write(`Could not reach pairing backend (${status}). Check your connection.\n`);
      return 1;
    }
  }

  if (!pair) {
    const name = hostname() || "A Mac";
    const { status, json } = await postJson(`${backend}/v1/pair/start`, { machineName: name }, authToken);
    if (status !== 200 || typeof json.pairingId !== "string") {
      process.stderr.write(`Could not start pairing (${status}).\n`);
      return 1;
    }
    pairingId = json.pairingId as string;
    hostSecret = json.hostSecret as string;
    relayUrl = json.relayUrl as string;
    hostTicket = json.hostTicket as string;
    machineName = name;
    writePairFile({
      pairingId,
      hostSecret,
      machineName: name,
      relayUrl,
      backendUrl: backend,
      createdAt: new Date().toISOString(),
    });
    const code = String(json.code ?? "");
    await printCodeBox(code, pairingDeepLink(code), json.expiresAt as string | undefined);

    // Wait for the phone to redeem the code.
    for (;;) {
      await sleep(2000);
      const poll = await postJson(`${backend}/v1/pair/host-poll`, { pairingId, hostSecret }, authToken);
      if (poll.status === 410) {
        process.stderr.write("Pairing was revoked. Run `agenc remote on` to try again.\n");
        return 1;
      }
      if (poll.status === 200 && poll.json.status === "active") {
        hostTicket = (poll.json.hostTicket as string) ?? hostTicket;
        const who = (poll.json.appLabel as string) ?? "your phone";
        process.stdout.write(`✓ Linked with ${who}. Keeping this Mac reachable…\n`);
        break;
      }
      // still pending — the code may expire; the backend returns 403 once the row is gone.
      if (poll.status === 403) {
        process.stderr.write("The code expired. Run `agenc remote on` for a new one.\n");
        return 1;
      }
    }
  }

  return runConnector({
    relayUrl: relayUrl!,
    pairingId: pairingId!,
    hostSecret: hostSecret!,
    backend,
    initialHostTicket: hostTicket!,
    machineName: machineName!,
    authToken,
  });
}

interface ConnectorArgs {
  relayUrl: string;
  pairingId: string;
  hostSecret: string;
  backend: string;
  initialHostTicket: string;
  machineName: string;
  authToken: string;
  /** True when run inside the agent TUI (the /remote surface): suppress all stdout/stderr (raw
   *  writes corrupt the Ink render) and never process.exit (it would kill the session). */
  quiet?: boolean;
}

/** Port of the portal connector: one daemon socket per phone (cid), transparent JSON-RPC pipe, with
 *  the loopback cookie injected into `initialize`. The host ticket is re-minted from the backend (via
 *  hostSecret) on every reconnect, so it stays short-lived and this Mac never signs its own.
 *  Fire-and-forget: starts the relay connection + reconnect loop and returns immediately. */
function startBridge(args: ConnectorArgs): void {
  const { relayUrl, pairingId, hostSecret, backend, machineName, authToken } = args;
  const DAEMON = daemonUrl();
  const out = (msg: string) => { if (!args.quiet) process.stdout.write(msg); };
  const dbg = (msg: string) => { if (!args.quiet && process.env.AGENC_REMOTE_DEBUG) process.stderr.write(msg); };
  const cookie = readCookie();
  if (!cookie) {
    out("Warning: no daemon cookie found — is the daemon running? Start it with `agenc daemon`.\n");
  }
  const peers = new Map<string, WebSocket>();
  let relay: WebSocket | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let ticket = args.initialHostTicket;

  function openDaemon(cid: string): WebSocket {
    const existing = peers.get(cid);
    if (existing) return existing;
    const ws = new WebSocket(DAEMON);
    const queue: string[] = [];
    (ws as unknown as { _queue: string[] })._queue = queue;
    ws.on("open", () => {
      for (const m of queue) ws.send(m);
      queue.length = 0;
    });
    ws.on("open", () => {
      dbg(`[dbg] daemon-open cid=${cid}\n`);
    });
    ws.on("message", (data: WebSocket.RawData) => {
      const payload = data.toString();
      dbg(`[dbg] daemon->relay ${payload.length}b cid=${cid} relayOpen=${relay?.readyState === WebSocket.OPEN}\n`);
      try {
        relay?.send(JSON.stringify({ t: "data", cid, payload }));
      } catch {
        /* relay gone */
      }
    });
    ws.on("close", () => {
      peers.delete(cid);
      try {
        relay?.send(JSON.stringify({ t: "peer", cid, event: "close" }));
      } catch {
        /* relay gone */
      }
    });
    ws.on("error", (e: Error) => {
      dbg(`[dbg] daemon-error cid=${cid} ${e?.message}\n`);
    });
    peers.set(cid, ws);
    return ws;
  }

  function toDaemon(cid: string, payloadStr: string): void {
    const ws = openDaemon(cid);
    let out = payloadStr;
    try {
      const msg = JSON.parse(payloadStr);
      // The phone authenticated to the RELAY (ticket), never to the daemon — inject the real cookie.
      if (msg && msg.method === "initialize" && msg.params && typeof msg.params === "object") {
        msg.params.authCookie = cookie;
        out = JSON.stringify(msg);
      }
    } catch {
      /* not JSON — forward verbatim */
    }
    const queue = (ws as unknown as { _queue: string[] })._queue;
    dbg(`[dbg] ->daemon cid=${cid} rs=${ws.readyState} (OPEN=${WebSocket.OPEN}) ${out.slice(0, 40)}\n`);
    if (ws.readyState === WebSocket.OPEN) ws.send(out);
    else queue.push(out);
  }

  async function freshTicket(): Promise<string | null> {
    try {
      const { status, json } = await postJson(`${backend}/v1/pair/host-poll`, {
        pairingId,
        hostSecret,
      }, authToken);
      if (status === 410) return null; // unlinked
      if (status === 200 && typeof json.hostTicket === "string") return json.hostTicket;
    } catch {
      /* offline — reuse the last ticket */
    }
    return ticket;
  }

  function connect(): void {
    relay = new WebSocket(`${relayUrl}/v1/host?ticket=${encodeURIComponent(ticket)}`);
    relay.on("open", () => {
      out(`● Remote access ON — “${machineName}” reachable from your phone (pairing ${pairingId}).\n`);
      if (keepalive) clearInterval(keepalive);
      keepalive = setInterval(() => {
        try {
          relay?.send(JSON.stringify({ t: "ping" }));
        } catch {
          /* gone */
        }
      }, 25000);
    });
    relay.on("message", (data: WebSocket.RawData) => {
      let m: { t?: string; event?: string; cid?: string; payload?: string };
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (m.t === "peer" && m.event === "open" && m.cid) {
        openDaemon(m.cid);
        out("  • phone connected\n");
      } else if (m.t === "peer" && m.event === "close" && m.cid) {
        const ws = peers.get(m.cid);
        if (ws) {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
          peers.delete(m.cid);
        }
      } else if (m.t === "data" && m.cid && typeof m.payload === "string") {
        dbg(`[dbg] relay->data cid=${m.cid} ${m.payload.slice(0, 40)}\n`);
        toDaemon(m.cid, m.payload);
      } else {
        dbg(`[dbg] relay-msg t=${m.t} event=${m.event ?? ""}\n`);
      }
    });
    relay.on("close", () => {
      if (keepalive) clearInterval(keepalive);
      for (const ws of peers.values()) {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
      peers.clear();
      void freshTicket().then((t) => {
        if (t === null) {
          out("This Mac was unlinked from the phone. Run `agenc remote on` to re-pair.\n");
          if (!args.quiet) process.exit(0);
          return; // quiet (TUI): stop reconnecting, but keep the agent session alive
        }
        ticket = t;
        setTimeout(connect, 2000);
      });
    });
    relay.on("error", () => {
      /* close handler drives the reconnect */
    });
  }

  connect();
}

/** Blocking wrapper for the foreground CLI: start the bridge, then never resolve (Ctrl-C exits). */
function runConnector(args: ConnectorArgs): Promise<number> {
  startBridge(args);
  return new Promise<number>(() => {});
}

/**
 * Slash-command entry (`/remote [on|off|status]`): returns text to show in the agent session. For
 * `on` it links + starts the bridge in the background (fire-and-forget) and returns the code + QR;
 * the bridge lives for as long as the agent session does.
 */
export async function runRemoteSlash(argsRaw: string): Promise<string> {
  const sub = (argsRaw || "").trim() || "on";

  if (sub === "status") {
    const pair = readPairFile();
    return pair
      ? `Linked to “${pair.machineName}” (pairing ${pair.pairingId}).\nBackend ${pair.backendUrl} · relay ${pair.relayUrl}`
      : "Not linked. Run `/remote on` to link a phone.";
  }
  if (sub === "off") {
    if (existsSync(pairPath())) {
      rmSync(pairPath(), { force: true });
      return "Forgot this Mac's pairing. (A bridge started this session keeps running until the session ends.)";
    }
    return "This Mac is not linked.";
  }

  // "on" — delegate to the shared starter.
  const started = await startRemoteOn();
  if ("message" in started) return started.message;
  return `${started.box}\n  This Mac is now reachable for this session — pair, then talk to this agent from your phone.`;
}

export interface RemoteOnStarted {
  /** The rendered code + QR box (utf8, no ANSI). */
  readonly box: string;
  /** Long-poll until the phone pairs. Resolves with the phone's label, or "" on expiry/revoke. */
  readonly waitForConnect: () => Promise<string>;
}

/**
 * Start remote access: reuse an existing pairing (just (re)connect), else run the pairing ceremony.
 * Always brings up the bridge. Returns the code/QR box + a `waitForConnect` poller, or a `message`
 * for the reuse/error cases. Shared by the `/remote` TUI surface and `runRemoteSlash`.
 */
export async function startRemoteOn(): Promise<RemoteOnStarted | { message: string }> {
  const backend = backendUrl();
  const authToken = remoteAuthSessionTokenSync();
  if (authToken === undefined) {
    return { message: REMOTE_LOGIN_REQUIRED_MESSAGE };
  }

  const existing = readPairFile();
  if (existing) {
    const { status, json } = await postJson(`${backend}/v1/pair/host-poll`, {
      pairingId: existing.pairingId,
      hostSecret: existing.hostSecret,
    }, authToken);
    if (status === 200 && typeof json.hostTicket === "string") {
      startBridge({
        relayUrl: (json.relayUrl as string) ?? existing.relayUrl,
        pairingId: existing.pairingId,
        hostSecret: existing.hostSecret,
        backend,
        initialHostTicket: json.hostTicket,
        machineName: existing.machineName,
        authToken,
        quiet: true,
      });
      return { message: `● Remote access ON — already linked to “${existing.machineName}”. Drive this Mac from your phone.` };
    }
    if (status === 410) rmSync(pairPath(), { force: true }); // revoked — fall through to re-pair
  }

  const name = hostname() || "A Mac";
  const { status, json } = await postJson(`${backend}/v1/pair/start`, { machineName: name }, authToken);
  if (status !== 200 || typeof json.pairingId !== "string") {
    return { message: `Could not start pairing (${status}). Check your connection.` };
  }
  const pairingId = json.pairingId as string;
  const hostSecret = json.hostSecret as string;
  const relayUrl = json.relayUrl as string;
  const hostTicket = json.hostTicket as string;
  writePairFile({
    pairingId,
    hostSecret,
    machineName: name,
    relayUrl,
    backendUrl: backend,
    createdAt: new Date().toISOString(),
  });
  startBridge({ relayUrl, pairingId, hostSecret, backend, initialHostTicket: hostTicket, machineName: name, authToken, quiet: true });

  const code = String(json.code ?? "");
  const box = await renderCodeBox(code, pairingDeepLink(code), json.expiresAt as string | undefined, {
    color: false,
    qrType: "utf8",
  });
  const waitForConnect = async (): Promise<string> => {
    // Poll up to ~3 min (the code TTL). Resolves with the phone label on claim, "" on expiry/revoke.
    // A transient network error must NOT reject — that would leave the QR surface hanging.
    for (let i = 0; i < 90; i += 1) {
      await sleep(2000);
      try {
        const poll = await postJson(`${backend}/v1/pair/host-poll`, { pairingId, hostSecret }, authToken);
        if (poll.status === 200 && poll.json.status === "active") {
          return (poll.json.appLabel as string) || "your phone";
        }
        if (poll.status === 410 || poll.status === 403) return "";
      } catch {
        /* transient — keep polling */
      }
    }
    return "";
  };
  return { box, waitForConnect };
}
