import type { CliRouteModule } from "./route-types.js";
import { dispatchPhase3ShellCommands } from "./route-support.js";

export const routeModule: CliRouteModule = {
  run: ({ parsed, context }) => dispatchPhase3ShellCommands(parsed, context),
};

export default routeModule;
