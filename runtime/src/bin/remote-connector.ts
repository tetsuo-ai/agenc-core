// Loaded only after the owner admitted remote control in home/managed config.
import { existsSync, rmSync, watch } from "node:fs";
import { hostname } from "node:os";
import WebSocket from "ws";
import { remoteAuthSessionTokenSync } from "../auth/session-state.js";
import { activeLegacyBridges, backendUrl, daemonUrl, pairPath, readCookie, readPairFile, remoteDir, stopLegacyRemote, stopMarker, writePairFile, type RemoteCliRuntimeContext } from "./remote-state.js";
import { formatAgenCRemoteCliHelpText, parseRemoteSlashArgs, remoteFullControlEnabled, remoteFullControlRefusal, REMOTE_FULL_CONTROL_WARNING, type RemoteCliCommand } from "./remote-cli.js";
import { legacyBridgeDeniesMethod, legacyHostHandshake } from "./remote-protocol.js";
const REMOTE_LOGIN_REQUIRED_MESSAGE = "Not logged in. Run `/login` in the TUI or `AGENC_AUTH_BACKEND=remote agenc login` before using remote pairing.";
interface PostResult {
  status: number;
  json: Record<string, unknown>;
}
async function postJson(
  url: string,
  body: Record<string, unknown>,
  authToken?: string,
  signal?: AbortSignal,
): Promise<PostResult> {
  const res = await fetch(url, {
    method: "POST",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
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
    const { default: QRCode } = await import("qrcode");
    qr = await QRCode.toString(deepLink, { type: opts.qrType, small: true });
  } catch {
    /* QR is optional — the code still links the computer */
  }

  const out: string[] = ["", `  ${accent}${bold}⬡  Link this computer to the AgenC app${reset}`, ""];
  if (qr) {
    for (const qrLine of qr.replace(/\n+$/, "").split("\n")) out.push("  " + qrLine);
    out.push("");
  }
  const pad = 3;
  const bar = "─".repeat(code.length + pad * 2);
  out.push(
    `  ${dim}1.${reset} Scan the QR with your phone's camera, or`,
    `  ${dim}2.${reset} open the app → ${bold}Link a computer${reset} ${dim}→ enter the code:${reset}`,
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

export async function runAgenCRemoteCli(
  command: RemoteCliCommand,
  context: RemoteCliRuntimeContext,
): Promise<number> {
  const backend = backendUrl(context);

  if (command.kind === "help") {
    process.stdout.write(formatAgenCRemoteCliHelpText() + "\n");
    return 0;
  }

  if (command.kind === "status") {
    const pair = readPairFile(context);
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
    if (existsSync(pairPath(context))) {
      stopLegacyRemote(context);
      process.stdout.write("Remote access stopped and the local pairing was removed.\n");
    } else {
      stopLegacyRemote(context);
      process.stdout.write("This computer is not linked.\n");
    }
    return 0;
  }

  // command.kind === "on"
  if (!remoteFullControlEnabled(context, command.fullControl)) {
    process.stderr.write(`${remoteFullControlRefusal("cli")}\n`);
    return 1;
  }
  process.stdout.write(`${REMOTE_FULL_CONTROL_WARNING}\n`);
  const activationMarker = stopMarker(context);
  const authToken = remoteAuthSessionTokenSync(context);
  if (authToken === undefined) {
    process.stderr.write(`${REMOTE_LOGIN_REQUIRED_MESSAGE}\n`);
    return 1;
  }

  let pair = readPairFile(context);
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
      rmSync(pairPath(context), { force: true });
      process.stdout.write("This computer was unlinked from the phone. Re-pairing.\n");
      pair = null;
    } else if (status === 200 && typeof json.hostTicket === "string") {
      pairingId = pair.pairingId;
      hostSecret = pair.hostSecret;
      relayUrl = (json.relayUrl as string) ?? pair.relayUrl;
      machineName = pair.machineName;
      hostTicket = json.hostTicket;
      process.stdout.write(`Remote access: linked to “${machineName}”. Connecting…\n`);
    } else {
      process.stderr.write(`Could not reach pairing backend (${status}). Check your connection.\n`);
      return 1;
    }
  }

  if (!pair) {
    const name = hostname() || "A computer";
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
    if (activationMarker !== stopMarker(context)) return 0;
    writePairFile(context, {
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
      if (activationMarker !== stopMarker(context)) return 0;
      const poll = await postJson(`${backend}/v1/pair/host-poll`, { pairingId, hostSecret }, authToken);
      if (poll.status === 410) {
        process.stderr.write("Pairing was revoked. Run `agenc remote on` to try again.\n");
        return 1;
      }
      if (poll.status === 200 && poll.json.status === "active") {
        hostTicket = (poll.json.hostTicket as string) ?? hostTicket;
        const who = (poll.json.appLabel as string) ?? "your phone";
        process.stdout.write(`✓ Linked with ${who}. Keeping this computer reachable…\n`);
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
    context,
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
  context: RemoteCliRuntimeContext;
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
 *  hostSecret) on every reconnect, so it stays short-lived and this computer never signs its own.
 *  Fire-and-forget: starts the relay connection + reconnect loop and returns immediately. */
function startBridge(args: ConnectorArgs): void {
  activeLegacyBridges.get(args.context.home.path)?.();
  const activationMarker = stopMarker(args.context);
  let stopped = false;
  const controller = new AbortController();
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  const { relayUrl, pairingId, hostSecret, backend, machineName, authToken } = args;
  const DAEMON = daemonUrl(args.context);
  const out = (msg: string) => { if (!args.quiet) process.stdout.write(msg); };
  const dbg = (msg: string) => { if (!args.quiet && args.context.environment.AGENC_REMOTE_DEBUG) process.stderr.write(msg); };
  const cookie = readCookie(args.context);
  if (!cookie) {
    out("Warning: no daemon cookie found. Is the daemon running? Start it with `agenc daemon`.\n");
  }
  const peers = new Map<string, WebSocket>();
  let relay: WebSocket | null = null;
  // Relays deployed before the subprotocol transport select no protocol, which
  // `ws` treats as a failed handshake; fall back to the query form once.
  let queryFallback = false;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let ticket = args.initialHostTicket;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    watcher.close();
    clearInterval(revocationCheck);
    if (keepalive) clearInterval(keepalive);
    if (reconnect) clearTimeout(reconnect);
    for (const socket of peers.values()) socket.terminate();
    peers.clear();
    relay?.terminate();
    if (activeLegacyBridges.get(args.context.home.path) === stop) activeLegacyBridges.delete(args.context.home.path);
  };
  const checkRevocation = () => {
    if (activationMarker !== stopMarker(args.context) || !existsSync(pairPath(args.context))) stop();
  };
  const watcher = watch(remoteDir(args.context), { persistent: false }, checkRevocation);
  watcher.on("error", stop);
  const revocationCheck = setInterval(checkRevocation, 250);
  revocationCheck.unref();
  activeLegacyBridges.set(args.context.home.path, stop);

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

  interface PhoneRequest { id?: unknown; method?: unknown; params?: unknown }

  /** Answer a refused request on the relay so the phone does not wait for a timeout. */
  function refuseForPhone(cid: string, request: PhoneRequest): void {
    if (typeof request.id !== "string" && typeof request.id !== "number") return;
    const error = { code: -32000, message: "REMOTE_METHOD_DENIED", data: { code: "REMOTE_METHOD_DENIED" } };
    try {
      relay?.send(JSON.stringify({ t: "data", cid, payload: JSON.stringify({ jsonrpc: "2.0", id: request.id, error }) }));
    } catch {
      /* relay gone */
    }
  }

  /** The phone authenticated to the RELAY (ticket), never to the daemon: `initialize` carries the real cookie. */
  function withLoopbackCookie(request: PhoneRequest, payloadStr: string): string {
    if (request.method !== "initialize" || !request.params || typeof request.params !== "object") return payloadStr;
    return JSON.stringify({ ...request, params: { ...(request.params as Record<string, unknown>), authCookie: cookie, remoteControlBridge: true } });
  }

  function toDaemon(cid: string, payloadStr: string): void {
    checkRevocation();
    if (stopped) return;
    let request: PhoneRequest;
    try {
      request = JSON.parse(payloadStr) as PhoneRequest;
    } catch {
      return;
    }
    if (typeof request.method === "string" && legacyBridgeDeniesMethod(request.method)) {
      refuseForPhone(cid, request);
      return;
    }
    const ws = openDaemon(cid);
    const out = request && typeof request === "object" ? withLoopbackCookie(request, payloadStr) : payloadStr;
    const queue = (ws as unknown as { _queue: string[] })._queue;
    dbg(`[dbg] ->daemon cid=${cid} rs=${ws.readyState} bytes=${out.length}\n`);
    if (ws.readyState === WebSocket.OPEN) ws.send(out);
    else if (queue.length < 32 && payloadStr.length < 512 * 1024) queue.push(out);
    else ws.terminate();
  }

  async function freshTicket(): Promise<string | null> {
    try {
      const { status, json } = await postJson(`${backend}/v1/pair/host-poll`, {
        pairingId,
        hostSecret,
      }, authToken, controller.signal);
      if (status === 410) return null; // unlinked
      if (status === 200 && typeof json.hostTicket === "string") return json.hostTicket;
    } catch {
      /* offline — reuse the last ticket */
    }
    return ticket;
  }

  function connect(): void {
    checkRevocation();
    if (stopped) return;
    const handshake = legacyHostHandshake(relayUrl, ticket, queryFallback);
    relay = new WebSocket(handshake.url, handshake.protocols);
    let opened = false;
    let subprotocolRefused = false;
    relay.on("open", () => {
      opened = true;
      if (stopped) { relay?.terminate(); return; }
      out(`● Remote access ON: “${machineName}” reachable from your phone (pairing ${pairingId}).\n`);
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
      checkRevocation();
      if (stopped || data.toString().length > 512 * 1024) return;
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
        dbg(`[dbg] relay->data cid=${m.cid} bytes=${m.payload.length}\n`);
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
      if (stopped) return;
      if (!opened && subprotocolRefused && !queryFallback) {
        queryFallback = true;
        reconnect = setTimeout(connect, 500);
        return;
      }
      void freshTicket().then((t) => {
        checkRevocation();
        if (stopped) return;
        if (t === null) {
          out("This computer was unlinked from the phone. Run `agenc remote on` to re-pair.\n");
          if (!args.quiet) process.exit(0);
          return; // quiet (TUI): stop reconnecting, but keep the agent session alive
        }
        ticket = t;
        reconnect = setTimeout(connect, 2000);
      });
    });
    relay.on("error", (error: Error) => {
      // `ws` aborts the handshake when the server selects no subprotocol; the
      // close handler then retries once with the query form.
      if (!opened && /subprotocol/i.test(error.message)) subprotocolRefused = true;
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
export async function runRemoteSlash(
  argsRaw: string,
  context: RemoteCliRuntimeContext,
): Promise<string> {
  const { sub, fullControl } = parseRemoteSlashArgs(argsRaw);

  if (sub === "status") {
    const pair = readPairFile(context);
    return pair
      ? `Linked to “${pair.machineName}” (pairing ${pair.pairingId}).\nBackend ${pair.backendUrl} · relay ${pair.relayUrl}`
      : "Not linked. Run `/remote on` to link a phone.";
  }
  if (sub === "off") {
    if (existsSync(pairPath(context))) {
      stopLegacyRemote(context);
      return "Remote access stopped and the local pairing was removed.";
    }
    stopLegacyRemote(context);
    return "This computer is not linked.";
  }

  if (sub !== "on") return "Usage: /remote [on|off|status] [--full-control]";

  // "on" — delegate to the shared starter.
  const started = await startRemoteOn(context, { fullControl });
  if ("message" in started) return started.message;
  return `${started.box}\n  This computer is now reachable for this session. Pair, then talk to this agent from your phone.`;
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
export async function startRemoteOn(
  context: RemoteCliRuntimeContext,
  options: { readonly fullControl?: boolean } = {},
): Promise<RemoteOnStarted | { message: string }> {
  if (!remoteFullControlEnabled(context, options.fullControl)) {
    return { message: remoteFullControlRefusal("tui") };
  }
  const activationMarker = stopMarker(context);
  const backend = backendUrl(context);
  const authToken = remoteAuthSessionTokenSync(context);
  if (authToken === undefined) {
    return { message: REMOTE_LOGIN_REQUIRED_MESSAGE };
  }

  const existing = readPairFile(context);
  if (existing) {
    const { status, json } = await postJson(`${backend}/v1/pair/host-poll`, {
      pairingId: existing.pairingId,
      hostSecret: existing.hostSecret,
    }, authToken);
    if (status === 200 && typeof json.hostTicket === "string") {
      if (activationMarker !== stopMarker(context)) return { message: "Remote access stopped." };
      startBridge({
        context,
        relayUrl: (json.relayUrl as string) ?? existing.relayUrl,
        pairingId: existing.pairingId,
        hostSecret: existing.hostSecret,
        backend,
        initialHostTicket: json.hostTicket,
        machineName: existing.machineName,
        authToken,
        quiet: true,
      });
      return { message: `${REMOTE_FULL_CONTROL_WARNING}\n● Remote access ON: already linked to “${existing.machineName}”. Drive this computer from your phone.` };
    }
    if (status === 410) rmSync(pairPath(context), { force: true }); // revoked — fall through to re-pair
  }

  const name = hostname() || "A computer";
  const { status, json } = await postJson(`${backend}/v1/pair/start`, { machineName: name }, authToken);
  if (status !== 200 || typeof json.pairingId !== "string") {
    return { message: `Could not start pairing (${status}). Check your connection.` };
  }
  const pairingId = json.pairingId as string;
  const hostSecret = json.hostSecret as string;
  const relayUrl = json.relayUrl as string;
  const hostTicket = json.hostTicket as string;
  if (activationMarker !== stopMarker(context)) return { message: "Remote access stopped." };
  writePairFile(context, {
    pairingId,
    hostSecret,
    machineName: name,
    relayUrl,
    backendUrl: backend,
    createdAt: new Date().toISOString(),
  });
  startBridge({ context, relayUrl, pairingId, hostSecret, backend, initialHostTicket: hostTicket, machineName: name, authToken, quiet: true });

  const code = String(json.code ?? "");
  const box = `  ${REMOTE_FULL_CONTROL_WARNING}\n${await renderCodeBox(code, pairingDeepLink(code), json.expiresAt as string | undefined, {
    color: false,
    qrType: "utf8",
  })}`;
  const waitForConnect = async (): Promise<string> => {
    // Poll up to ~3 min (the code TTL). Resolves with the phone label on claim, "" on expiry/revoke.
    // A transient network error must NOT reject — that would leave the QR surface hanging.
    for (let i = 0; i < 90; i += 1) {
      await sleep(2000);
      if (activationMarker !== stopMarker(context)) return "";
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
