import type { CliRouteModule } from "./route-types.js";
import { dispatchPluginOrReplayCommand } from "./route-support.js";

export const routeModule: CliRouteModule = {
  run: ({ parsed, context, stdout, stderr }) =>
    dispatchPluginOrReplayCommand(parsed, stdout, stderr, context),
};

export default routeModule;
