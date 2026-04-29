import type { CliRouteModule } from "./route-types.js";
import { dispatchMarketCommands } from "./route-support.js";

export const routeModule: CliRouteModule = {
  run: ({ parsed, context, stdout, stderr }) =>
    dispatchMarketCommands(parsed, stdout, stderr, context),
};

export default routeModule;
