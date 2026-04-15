import type { CliRouteModule } from "./route-types.js";
import { dispatchJobsCommands } from "./route-support.js";

export const routeModule: CliRouteModule = {
  run: ({ parsed, context }) => dispatchJobsCommands(parsed, context),
};

export default routeModule;
