import type { CliRouteContext, CliRouteModule, RoutedStatus } from "./route-types.js";
import { startPortalServer } from "../portal/portal-server.js";
import { startPortalRelayClient } from "../portal/portal-relay-client.js";
import { signRelayTicket } from "../portal/portal-ticket.js";
import {
  PORTAL_DEFAULT_DAEMON_URL,
  PORTAL_DEFAULT_HOST,
  PORTAL_DEFAULT_PORT,
} from "../portal/portal-protocol.js";

function flagString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
function flagNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

const USAGE = [
  "usage: agenc portal serve [--host <h>] [--port <n>] [--daemon-url <ws-url>]",
  "   or: agenc portal serve --relay --relay-url <wss-url> --account <id> [--machine <name>] [--ttl-hours <n>]   (signs a host ticket from AGENC_RELAY_TICKET_SECRET)",
  "   or: agenc portal serve --relay --relay-url <wss-url> --ticket <signed-or-dev-ticket>",
  "   or: agenc portal pair --account <id> [--ttl-hours <n>]   (mint a client ticket for the app; needs AGENC_RELAY_TICKET_SECRET)",
].join("\n");

/** wss:// required; cleartext only to loopback (M6). */
function isSecureRelayUrl(url: string): boolean {
  return /^wss:\/\//.test(url) || /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
}

function waitForShutdown(close: () => void | Promise<void>): Promise<RoutedStatus> {
  return new Promise<RoutedStatus>((resolve) => {
    const shutdown = (): void => {
      void Promise.resolve(close()).then(() => resolve(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

/** `agenc portal pair` — mint a signed CLIENT ticket the user pastes into the app's relay host. */
function runPair(
  parsed: CliRouteContext["parsed"],
  context: CliRouteContext["context"],
): RoutedStatus {
  const account = flagString(parsed.flags.account, "");
  if (!account) {
    context.output("usage: agenc portal pair --account <id> [--ttl-hours <n>]");
    return 2;
  }
  const secret = process.env.AGENC_RELAY_TICKET_SECRET ?? "";
  if (!secret) {
    context.output("agenc portal pair requires AGENC_RELAY_TICKET_SECRET in the environment");
    return 2;
  }
  const ttlHours = flagNumber(parsed.flags["ttl-hours"], 24);
  const ticket = signRelayTicket({
    secret,
    accountId: account,
    role: "client",
    ttlMs: ttlHours * 3_600_000,
  });
  context.output(ticket);
  context.output(`# signed client ticket for "${account}", valid ${ttlHours}h — paste as the app's relay host ticket= value`);
  return 0;
}

async function run({ parsed, context }: CliRouteContext): Promise<RoutedStatus> {
  const sub = parsed.positional[1];
  if (sub === "pair") return runPair(parsed, context);
  if (sub !== "serve") {
    context.output(USAGE);
    return 2;
  }

  const daemonUrl = flagString(parsed.flags["daemon-url"], PORTAL_DEFAULT_DAEMON_URL);
  const relayMode =
    parsed.flags.relay === true || typeof parsed.flags["relay-url"] === "string";

  if (relayMode) {
    const relayUrl = flagString(parsed.flags["relay-url"], "");
    if (!relayUrl) {
      context.output("agenc portal serve --relay requires --relay-url <wss-url>");
      return 2;
    }
    if (!isSecureRelayUrl(relayUrl)) {
      context.output(`agenc portal serve --relay requires a wss:// URL (got "${relayUrl}"); ws:// is only allowed to loopback`);
      return 2;
    }

    // Prefer an explicit --ticket; otherwise sign a fresh short-lived host ticket on each (re)connect
    // from AGENC_RELAY_TICKET_SECRET + --account (never a forgeable public-id ticket).
    let ticket: string | (() => string);
    const explicit = flagString(parsed.flags.ticket, "");
    if (explicit) {
      if (explicit.startsWith("dev:")) {
        context.output("WARNING: a 'dev:' ticket is forgeable — local testing only. Production uses a signed ticket (AGENC_RELAY_TICKET_SECRET + --account).");
      }
      ticket = explicit;
    } else {
      const secret = process.env.AGENC_RELAY_TICKET_SECRET ?? "";
      const account = flagString(parsed.flags.account, "");
      if (!secret || !account) {
        context.output("agenc portal serve --relay needs either --ticket <signed-ticket> or AGENC_RELAY_TICKET_SECRET + --account <id>");
        return 2;
      }
      const hostId = flagString(parsed.flags.machine, "mac");
      // Short TTL is fine: the host re-signs a fresh ticket on every (re)connect, so 2h only needs
      // to cover the connect window + clock skew.
      const ttlMs = flagNumber(parsed.flags["ttl-hours"], 2) * 3_600_000;
      ticket = () => signRelayTicket({ secret, accountId: account, role: "host", hostId, ttlMs });
    }

    const handle = startPortalRelayClient({
      relayUrl,
      ticket,
      daemonUrl,
      logger: (m) => context.output(m),
    });
    context.output(`agenc portal serve --relay: dialing ${relayUrl} -> daemon ${daemonUrl}`);
    return await waitForShutdown(() => handle.close());
  }

  const host = flagString(parsed.flags.host, PORTAL_DEFAULT_HOST);
  const port = flagNumber(parsed.flags.port, PORTAL_DEFAULT_PORT);
  const handle = await startPortalServer({
    host,
    port,
    daemonUrl,
    logger: (m) => context.output(m),
  });
  context.output(
    `agenc portal serve: ready on ws://${handle.host}:${handle.port} -> ${daemonUrl}`,
  );
  return await waitForShutdown(() => handle.close());
}

export const routeModule: CliRouteModule = { run };
