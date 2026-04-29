import type { CliRouteModule } from "./route-types.js";
import { dispatchConnectorCommands } from "./route-support.js";

export const routeModule: CliRouteModule = {
  run: ({ parsed, context }) => dispatchConnectorCommands(parsed, context),
};

export default routeModule;
