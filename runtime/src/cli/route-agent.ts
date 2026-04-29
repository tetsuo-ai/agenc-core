import type { CliRouteDescriptor } from "./route-types.js";

const routeAgent: CliRouteDescriptor = {
  name: "agent",
  matches(parsed) {
    return parsed.positional[0] === "agent";
  },
  load: () =>
    import("./route-agent.impl.js").then((module) => module.routeModule),
};

export default routeAgent;
