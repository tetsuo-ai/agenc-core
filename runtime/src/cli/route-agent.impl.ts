import type { CliRouteModule } from "./route-types.js";
import { dispatchAgentCommands } from "./route-support.js";

export const routeModule: CliRouteModule = {
  run: ({ parsed, context, stdout, stderr }) =>
    dispatchAgentCommands(parsed, stdout, stderr, context),
};

export default routeModule;
