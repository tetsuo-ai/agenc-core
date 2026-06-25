// Dev smoke entry: run the portal directly (via tsx) against a live daemon, without building the
// full CLI. The supported entrypoint is `agenc portal serve`; this is only for fast local testing.
//   loopback: PORTAL_PORT=7766 PORTAL_DAEMON_URL=ws://127.0.0.1:9101 tsx portal-dev-entry.ts
//   relay:    RELAY_URL=wss://… ACCT=acct-smoke-1 PORTAL_DAEMON_URL=ws://127.0.0.1:9101 tsx portal-dev-entry.ts
import { startPortalServer } from "./portal-server.js";
import { startPortalRelayClient } from "./portal-relay-client.js";

const daemonUrl = process.env.PORTAL_DAEMON_URL ?? "ws://127.0.0.1:9101";

if (process.env.RELAY_URL) {
  const account = process.env.ACCT ?? "acct-smoke-1";
  const ticket = process.env.TICKET ?? `dev:${account}:host:mac-dev`;
  startPortalRelayClient({ relayUrl: process.env.RELAY_URL, ticket, daemonUrl, logger: (m) => console.log(m) });
  console.log(`[portal-dev] relay mode -> ${process.env.RELAY_URL} (ticket ${ticket}) -> ${daemonUrl}`);
} else {
  const port = Number(process.env.PORTAL_PORT ?? 7766);
  startPortalServer({ port, daemonUrl, logger: (m) => console.log(m) })
    .then((h) => console.log(`[portal-dev] up on ws://${h.host}:${h.port} -> ${daemonUrl}`))
    .catch((e) => {
      console.error("[portal-dev] failed to start:", e);
      process.exit(1);
    });
}
