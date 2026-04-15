import routeAgent from "./route-agent.js";
import routeBootstrap from "./route-bootstrap.js";
import routeConfig from "./route-config.js";
import routeConnectors from "./route-connectors.js";
import routeDaemon from "./route-daemon.js";
import routeFallback from "./route-fallback.js";
import routeJobs from "./route-jobs.js";
import routeMarket from "./route-market.js";
import routeSessions from "./route-sessions.js";
import routeShell from "./route-shell.js";
import routeSkill from "./route-skill.js";

export const CLI_ROUTES = [
  routeBootstrap,
  routeShell,
  routeDaemon,
  routeConfig,
  routeConnectors,
  routeSessions,
  routeJobs,
  routeAgent,
  routeMarket,
  routeSkill,
  routeFallback,
];
