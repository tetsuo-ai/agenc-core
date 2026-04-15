import type { CliRouteDescriptor } from "./route-types.js";

const routeFallback: CliRouteDescriptor = {
  name: "fallback",
  matches() {
    return true;
  },
  load: () =>
    import("./route-fallback.impl.js").then((module) => module.routeModule),
};

export default routeFallback;
