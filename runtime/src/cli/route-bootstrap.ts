import type { CliRouteDescriptor } from "./route-types.js";

const BOOTSTRAP_ROOTS = new Set(["onboard", "init", "health", "doctor"]);

const routeBootstrap: CliRouteDescriptor = {
  name: "bootstrap",
  matches(parsed) {
    const root = parsed.positional[0];
    return root !== undefined && BOOTSTRAP_ROOTS.has(root);
  },
  load: () =>
    import("./route-bootstrap.impl.js").then((module) => module.routeModule),
};

export default routeBootstrap;
