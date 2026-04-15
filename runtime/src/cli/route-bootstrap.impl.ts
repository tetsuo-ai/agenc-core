import type { CliRouteModule } from "./route-types.js";
import { dispatchBootstrapCommands } from "./route-support.js";

export const routeModule: CliRouteModule = {
  run: ({ parsed, context, stdout }) =>
    dispatchBootstrapCommands(parsed, context, stdout),
};

export default routeModule;
