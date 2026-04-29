import type { CliRouteModule } from "./route-types.js";
import { dispatchSessionCommands } from "./route-support.js";

export const routeModule: CliRouteModule = {
  run: ({ parsed, context }) => dispatchSessionCommands(parsed, context),
};

export default routeModule;
