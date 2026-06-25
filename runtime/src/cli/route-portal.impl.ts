import type { CliRouteContext, CliRouteModule, RoutedStatus } from "./route-types.js";
import { startPortalServer } from "../portal/portal-server.js";
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

async function run({ parsed, context }: CliRouteContext): Promise<RoutedStatus> {
  const sub = parsed.positional[1];
  if (sub !== "serve") {
    context.output(
      "usage: agenc portal serve [--host <h>] [--port <n>] [--daemon-url <ws-url>]",
    );
    return 2;
  }

  const host = flagString(parsed.flags.host, PORTAL_DEFAULT_HOST);
  const port = flagNumber(parsed.flags.port, PORTAL_DEFAULT_PORT);
  const daemonUrl = flagString(parsed.flags["daemon-url"], PORTAL_DEFAULT_DAEMON_URL);

  const handle = await startPortalServer({
    host,
    port,
    daemonUrl,
    logger: (m) => context.output(m),
  });
  context.output(
    `agenc portal serve: ready on ws://${handle.host}:${handle.port} -> ${daemonUrl}`,
  );

  // Long-running: resolve only on shutdown signal.
  return await new Promise<RoutedStatus>((resolve) => {
    const shutdown = (): void => {
      void handle.close().then(() => resolve(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export const routeModule: CliRouteModule = { run };
