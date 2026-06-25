// Dev smoke entry: run the portal directly (via tsx) against a live daemon, without building the
// full CLI. The supported entrypoint is `agenc portal serve`; this is only for fast local testing.
//   PORTAL_PORT=7766 PORTAL_DAEMON_URL=ws://127.0.0.1:9101 tsx portal-dev-entry.ts
import { startPortalServer } from "./portal-server.js";

const port = Number(process.env.PORTAL_PORT ?? 7766);
const daemonUrl = process.env.PORTAL_DAEMON_URL ?? "ws://127.0.0.1:9101";

startPortalServer({ port, daemonUrl, logger: (m) => console.log(m) })
  .then((h) => console.log(`[portal-dev] up on ws://${h.host}:${h.port} -> ${daemonUrl}`))
  .catch((e) => {
    console.error("[portal-dev] failed to start:", e);
    process.exit(1);
  });
