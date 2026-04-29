import type { CliRouteModule } from "./route-types.js";
import { dispatchConfigCommands } from "./route-support.js";

export const routeModule: CliRouteModule = {
  run: ({ parsed, context }) => dispatchConfigCommands(parsed, context),
};

export default routeModule;
