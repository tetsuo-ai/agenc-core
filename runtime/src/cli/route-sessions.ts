import type { CliRouteDescriptor } from "./route-types.js";

const SESSION_ROOTS = new Set(["sessions", "logs"]);

const routeSessions: CliRouteDescriptor = {
  name: "sessions",
  matches(parsed) {
    const root = parsed.positional[0];
    return root !== undefined && SESSION_ROOTS.has(root);
  },
  load: () =>
    import("./route-sessions.impl.js").then((module) => module.routeModule),
};

export default routeSessions;
