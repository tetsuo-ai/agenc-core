import type { CliRouteModule } from "./route-types.js";
import { dispatchDaemonCommands } from "./route-support.js";

export const routeModule: CliRouteModule = {
  run: ({ parsed, context }) => dispatchDaemonCommands(parsed, context),
};

export default routeModule;
