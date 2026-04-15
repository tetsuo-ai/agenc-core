import type { CliRouteDescriptor } from "./route-types.js";

const routeMarket: CliRouteDescriptor = {
  name: "market",
  matches(parsed) {
    return parsed.positional[0] === "market";
  },
  load: () =>
    import("./route-market.impl.js").then((module) => module.routeModule),
};

export default routeMarket;
