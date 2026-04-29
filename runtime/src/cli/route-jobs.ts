import type { CliRouteDescriptor } from "./route-types.js";

const routeJobs: CliRouteDescriptor = {
  name: "jobs",
  matches(parsed) {
    return parsed.positional[0] === "jobs";
  },
  load: () =>
    import("./route-jobs.impl.js").then((module) => module.routeModule),
};

export default routeJobs;
