import type { CliRouteDescriptor } from "./route-types.js";

const routeConnectors: CliRouteDescriptor = {
  name: "connectors",
  matches(parsed) {
    return parsed.positional[0] === "connector";
  },
  load: () =>
    import("./route-connectors.impl.js").then((module) => module.routeModule),
};

export default routeConnectors;
