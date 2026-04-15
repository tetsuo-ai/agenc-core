import type { CliRouteDescriptor } from "./route-types.js";

const routeConfig: CliRouteDescriptor = {
  name: "config",
  matches(parsed) {
    return parsed.positional[0] === "config";
  },
  load: () =>
    import("./route-config.impl.js").then((module) => module.routeModule),
};

export default routeConfig;
