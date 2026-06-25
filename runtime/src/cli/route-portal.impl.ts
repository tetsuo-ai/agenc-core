import type { CliRouteContext, CliRouteModule, RoutedStatus } from "./route-types.js";
import { startPortalServer } from "../portal/portal-server.js";
import { startPortalRelayClient } from "../portal/portal-relay-client.js";
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
  "   or: agenc portal serve --relay --relay-url <wss-url> --ticket <ticket> [--daemon-url <ws-url>]",
].join("\n");

/** wss:// required; cleartext only to loopback (M6). */
function isSecureRelayUrl(url: string): boolean {
  return /^wss:\/\//.test(url) || /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
}

/** Resolve only on SIGINT/SIGTERM so the long-running server stays up. */
function waitForShutdown(close: () => void | Promise<void>): Promise<RoutedStatus> {
  return new Promise<RoutedStatus>((resolve) => {
    const shutdown = (): void => {
      void Promise.resolve(close()).then(() => resolve(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function run({ parsed, context }: CliRouteContext): Promise<RoutedStatus> {
  if (parsed.positional[1] !== "serve") {
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
    // M4: the ticket must be a relay-verified secret token — never auto-derive a bearer from public
    // identifiers (account id / machine name), which anyone could forge to hijack the host channel.
    const ticket = flagString(parsed.flags.ticket, "");
    if (!ticket) {
      context.output("agenc portal serve --relay requires --ticket <ticket> (a relay-verified secret token; do not derive it from public identifiers)");
      return 2;
    }
    if (ticket.startsWith("dev:")) {
      context.output("WARNING: a 'dev:' ticket is a forgeable shared secret — use it only for local testing against a dev-mode relay. Production needs a relay-verified signed ticket (see PORTAL_SERVE_P2A_SECURITY.md M4).");
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
