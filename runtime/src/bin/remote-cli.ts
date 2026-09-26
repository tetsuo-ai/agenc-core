// `agenc remote` — link this computer to the AgenC phone app and bridge the relay to the local daemon.
//
// Pairing replaces account-as-room routing: the backend mints a per-pair `pairingId` (the relay
// room), a single-use human code, and a 256-bit hostSecret held ONLY by this computer. The phone redeems
// the code; both sides then reach the same isolated relay room. The backend is the sole holder of the
// relay signing secret and mints every host ticket — this computer never holds it. The connector dials OUT
// to the relay (no inbound ports) and transparently pipes the app-server JSON-RPC to/from the local
// daemon, injecting the loopback cookie into the phone's `initialize` so the phone never holds it.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  watch,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import WebSocket from "ws";

import {
  remoteAuthSessionTokenSync,
  type RemoteAuthSessionReadContext,
} from "../auth/session-state.js";
import {
  readDaemonRuntimeInfo,
  resolveAgenCDaemonRuntimeInfoPath,
} from "../app-server/daemon-runtime-info.js";
import type { EnvSnapshot } from "../config/env.js";
import { captureSecureStorageIngress } from "../utils/secureStorage/home.js";

const DEFAULT_BACKEND = "https://id.agenc.ag";
const REMOTE_LOGIN_REQUIRED_MESSAGE =
  "Not logged in. Run `/login` in the TUI or `AGENC_AUTH_BACKEND=remote agenc login` before using remote pairing.";

export interface RemoteCliCommand {
  readonly kind: "on" | "off" | "status" | "help";
  /** `agenc remote on --full-control`: the operator accepted what a paired phone can do. */
  readonly fullControl?: boolean;
}

/** The flag and the environment key that turn phone remote control on. */
export const REMOTE_FULL_CONTROL_FLAG = "--full-control";
export const REMOTE_FULL_CONTROL_ENV = "AGENC_REMOTE_FULL_CONTROL";

export function parseAgenCRemoteCliArgs(argv: readonly string[]): RemoteCliCommand | null {
  if (argv[0] !== "remote") return null;
  const sub = argv[1];
  const rest = argv.slice(2);
  // Require an explicit subcommand so a bare `agenc remote` or `--help` never starts pairing.
  if (sub === "on") {
    const fullControl = rest.includes(REMOTE_FULL_CONTROL_FLAG);
    // Anything else after `on` is a mistake, not a request to pair.
    if (rest.some((arg) => arg !== REMOTE_FULL_CONTROL_FLAG)) return { kind: "help" };
    return { kind: "on", fullControl };
  }
  if (sub === "off") return { kind: "off" };
  if (sub === "status") return { kind: "status" };
  return { kind: "help" };
}

/** `/remote [on|off|status] [--full-control]` as typed in the TUI. */
export function parseRemoteSlashArgs(argsRaw: string): { readonly sub: string; readonly fullControl: boolean } {
  const tokens = (argsRaw || "").trim().split(/\s+/u).filter(Boolean);
  const fullControl = tokens.includes(REMOTE_FULL_CONTROL_FLAG);
  const sub = tokens.find((token) => token !== REMOTE_FULL_CONTROL_FLAG) ?? "on";
  return { sub, fullControl };
}

/**
 * Phone remote control is off unless the operator turned it on for this run
 * with the flag, or persistently with the environment key. Off means no code,
 * no backend call and no relay socket. The check reads no credential.
 */
export function remoteFullControlEnabled(context: RemoteCliRuntimeContext, flag: boolean | undefined): boolean {
  if (flag === true) return true;
  const raw = context.environment[REMOTE_FULL_CONTROL_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** One line the operator reads before the code: what enabling this means. */
export const REMOTE_FULL_CONTROL_WARNING =
  "Warning: a paired phone gets full control of this computer's AgenC.";

export function remoteFullControlRefusal(surface: "cli" | "tui"): string {
  const how = surface === "cli"
    ? `Turn it on for this run with \`agenc remote on ${REMOTE_FULL_CONTROL_FLAG}\`, or set ${REMOTE_FULL_CONTROL_ENV}=1 to keep it on.`
    : `Turn it on with \`/remote on ${REMOTE_FULL_CONTROL_FLAG}\`, or set ${REMOTE_FULL_CONTROL_ENV}=1 before starting agenc to keep it on.`;
  return [
    "Phone remote control is off.",
    "A paired phone gets full control of this computer's AgenC: it can start agents in any folder, run tools and change permission modes.",
    how,
  ].join("\n");
}

export function formatAgenCRemoteCliHelpText(): string {
  return [
    "agenc remote — control this computer from the AgenC phone app, from anywhere.",
    "",
    "Usage:",
    "  agenc remote on --full-control",
    "                         Pair (first run shows a code) then keep this computer reachable.",
    "                         A paired phone gets full control of this computer's AgenC,",
    "                         so the flag or AGENC_REMOTE_FULL_CONTROL=1 is required.",
    "  agenc remote status    Show whether this computer is linked to a phone.",
    "  agenc remote off       Forget this computer's pairing locally.",
    "",
    "Environment:",
    "  AGENC_REMOTE_FULL_CONTROL=1",
    "                      Keep phone remote control on without the flag.",
    "  AGENC_BACKEND_URL   Identity backend (default https://id.agenc.ag).",
    "  AGENC_DAEMON_URL    Local daemon (default: the URL the running daemon",
    "                      recorded, else ws://127.0.0.1:7766).",
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

export type RemoteCliRuntimeContext = RemoteAuthSessionReadContext;

/** Capture one-shot CLI environment/home authority before asynchronous work. */
export function captureRemoteCliRuntimeContext(
  environment: EnvSnapshot,
): RemoteCliRuntimeContext {
  const ingress = captureSecureStorageIngress(environment);
  return Object.freeze({
    home: ingress.home,
    environment: ingress.environment,
  });
}
function remoteDir(context: RemoteCliRuntimeContext): string {
  return join(context.home.path, "remote");
}
function pairPath(context: RemoteCliRuntimeContext): string {
  return join(remoteDir(context), "pair.json");
}
const activeLegacyBridges = new Map<string, () => void>();
function stopMarker(context: RemoteCliRuntimeContext): string {
  try { return readFileSync(join(remoteDir(context), "stopped"), "utf8"); } catch { return ""; }
}
function stopLegacyRemote(context: RemoteCliRuntimeContext): void {
  mkdirSync(remoteDir(context), { recursive: true, mode: 0o700 });
  writeFileSync(join(remoteDir(context), "stopped"), randomUUID(), { mode: 0o600 });
  activeLegacyBridges.get(context.home.path)?.();
  rmSync(pairPath(context), { force: true });
}
function cookiePath(context: RemoteCliRuntimeContext): string {
  return join(context.home.path, "daemon.cookie");
}
function backendUrl(context: RemoteCliRuntimeContext): string {
  const env = context.environment.AGENC_BACKEND_URL;
  return env && env.trim() ? env.trim().replace(/\/$/, "") : DEFAULT_BACKEND;
}
function daemonUrl(context: RemoteCliRuntimeContext): string {
  const env = context.environment.AGENC_DAEMON_URL;
  if (env && env.trim()) return env.trim();
  // The running daemon records the port it actually bound, which is not the
  // default when that port was already taken and the listener fell back.
  // Falling back to the fixed default keeps older daemons reachable.
  const recorded = readDaemonRuntimeInfo(
    resolveAgenCDaemonRuntimeInfoPath(context.home.path),
  )?.webSocketUrl;
  return recorded !== undefined && recorded.length > 0
    ? recorded
    : "ws://127.0.0.1:7766";
}

function readPairFile(context: RemoteCliRuntimeContext): PairFile | null {
  try {
    const raw = readFileSync(pairPath(context), "utf8");
    const obj = JSON.parse(raw) as Partial<PairFile>;
    if (obj.pairingId && obj.hostSecret && obj.relayUrl) return obj as PairFile;
  } catch {
    /* absent or malformed */
  }
  return null;
}
function writePairFile(context: RemoteCliRuntimeContext, p: PairFile): void {
  mkdirSync(remoteDir(context), { recursive: true, mode: 0o700 });
  writeFileSync(pairPath(context), JSON.stringify(p, null, 2), { mode: 0o600 });
  try {
    chmodSync(pairPath(context), 0o600);
  } catch {
    /* best effort */
  }
}
function readCookie(context: RemoteCliRuntimeContext): string {
  try {
    return readFileSync(cookiePath(context), "utf8").trim();
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
      process.stdout.write("This computer was unlinked from the phone — re-pairing.\n");
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
    out("Warning: no daemon cookie found — is the daemon running? Start it with `agenc daemon`.\n");
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

  function toDaemon(cid: string, payloadStr: string): void {
    checkRevocation();
    if (stopped) return;
    try {
      const request = JSON.parse(payloadStr) as { id?: unknown; method?: unknown };
      if (typeof request.method === "string" && legacyBridgeDeniesMethod(request.method)) {
        // Answer the phone instead of letting its request time out.
        if (typeof request.id === "string" || typeof request.id === "number") {
          try {
            relay?.send(JSON.stringify({ t: "data", cid, payload: JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "REMOTE_METHOD_DENIED", data: { code: "REMOTE_METHOD_DENIED" } } }) }));
          } catch {
            /* relay gone */
          }
        }
        return;
      }
    } catch { return; }
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

/**
 * Requests the bridge never forwards for a legacy phone. The phone drives
 * sessions through the daemon protocol; it does not administer the daemon,
 * the account, project trust, standing configuration, MCP servers, routines,
 * remote-device management or an interactive shell. A relay peer that holds
 * a phone's ticket gets exactly what the phone gets, so these stay host-local.
 */
const LEGACY_BRIDGE_DENIED_METHODS: ReadonlySet<string> = new Set([
  "daemon.shutdown",
  "daemon.reload",
  "auth.login",
  "auth.logout",
  "project.trust",
  "plugin.settings.set",
  "plugin.settings.reset",
  "session.applyConfig",
  "session.permissions.mutateRule",
  "session.hooks.setDisabled",
  "session.mcp.addServer",
  "session.mcp.enableServer",
  "routine.create",
  "routine.update",
  "routine.delete",
  "routine.run",
  "routine.cancel",
  "routine.session.prepare.respond",
]);
const LEGACY_BRIDGE_DENIED_PREFIXES: readonly string[] = ["remote.", "telegram.", "commandExec."];

/** True when a legacy phone request must be answered with REMOTE_METHOD_DENIED instead of forwarded. */
export function legacyBridgeDeniesMethod(method: string): boolean {
  return LEGACY_BRIDGE_DENIED_METHODS.has(method) || LEGACY_BRIDGE_DENIED_PREFIXES.some((prefix) => method.startsWith(prefix));
}

/** Subprotocol name under which a legacy host offers its relay ticket. */
export const LEGACY_HOST_PROTOCOL = "agenc-relay-v1";

/**
 * How a legacy host presents its ticket to the relay. The ticket rides in the
 * `Sec-WebSocket-Protocol` header, base64url-encoded because `s1` tickets
 * contain ":" which is not a valid subprotocol token character, so it never
 * appears in a request URL that edge observability logs record. `fallback`
 * selects the old query form for relays that predate the subprotocol.
 */
export function legacyHostHandshake(
  relayUrl: string,
  ticket: string,
  fallback: boolean,
): { readonly url: string; readonly protocols: string[] } {
  if (fallback) {
    return { url: `${relayUrl}/v1/host?ticket=${encodeURIComponent(ticket)}`, protocols: [] };
  }
  return {
    url: `${relayUrl}/v1/host`,
    protocols: [LEGACY_HOST_PROTOCOL, Buffer.from(ticket, "utf8").toString("base64url")],
  };
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

  // "on" — delegate to the shared starter.
  const started = await startRemoteOn(context, { fullControl });
  if ("message" in started) return started.message;
  return `${started.box}\n  This computer is now reachable for this session — pair, then talk to this agent from your phone.`;
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
