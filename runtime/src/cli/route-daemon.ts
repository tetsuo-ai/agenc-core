import type { CliRouteDescriptor } from "./route-types.js";

const DAEMON_ROOTS = new Set([
  "shell",
  "start",
  "stop",
  "restart",
  "status",
  "service",
]);

const routeDaemon: CliRouteDescriptor = {
  name: "daemon",
  matches(parsed) {
    const root = parsed.positional[0];
    return root !== undefined && DAEMON_ROOTS.has(root);
  },
  load: () =>
    import("./route-daemon.impl.js").then((module) => module.routeModule),
};

export default routeDaemon;
