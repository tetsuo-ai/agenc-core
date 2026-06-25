import type { CliRouteDescriptor } from "./route-types.js";

const routePortal: CliRouteDescriptor = {
  name: "portal",
  matches(parsed) {
    return parsed.positional[0] === "portal";
  },
  load: () =>
    import("./route-portal.impl.js").then((module) => module.routeModule),
};

export default routePortal;
